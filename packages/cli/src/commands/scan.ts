import { Crust } from "@crustjs/core";
import { confirm } from "@crustjs/prompts";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSource, inferSourceRepo, parseSourceInput } from "../sources/index.ts";
import {
  DEFAULT_MIN_SKILLS_TO_SPLIT,
  serializeMarkerDraft,
  sourceRepoUrl,
  synthesizeEntries,
  type SynthesizeEntriesResult,
} from "../detector/synthesize.ts";
import { readJsonFile } from "../detector/fsWalk.ts";
import {
  CLUSTER_STRATEGIES,
  DEFAULT_STRATEGY,
  strategyUsesLlm,
  type ClusterStrategy,
  type GroupSkillsFn,
  type LlmFailure,
  type SplitProvenance,
} from "../detector/partition.ts";
import type { MarketplaceEntry } from "../schemas/marketplaceEntry.ts";
import { resolveGrouper, type ResolvedGrouper, type ResolveGrouperOpts } from "./llmGrouper.ts";

export const scanCommand = new Crust("scan")
  .meta({ description: "Scan a non-plugin repo and emit a marketplace entry (auto-splits bloated plugins)" })
  .args([{ name: "repo", type: "string", required: true, description: "owner/repo, URL, or local path" }] as const)
  .flags({
    output: { type: "string", short: "o", description: "Write the entry/entries JSON to a single file" },
    outDir: { type: "string", aliases: ["out-dir"], description: "Write one JSON file per entry into this directory" },
    split: { type: "boolean", default: true, description: "Auto-split bloated plugins (use --no-split to force one entry)" },
    umbrella: { type: "boolean", default: false, description: "Also emit the everything-in-one umbrella entry" },
    cluster: { type: "string", default: DEFAULT_STRATEGY, description: "Clustering strategy: auto (deterministic, default) | auto-llm (deterministic, then BYO LLM on no clean partition) | llm (opt-in BYO subprocess/claude) | metadata | directory | name-prefix" },
    llmCmd: { type: "string", aliases: ["llm-cmd"], description: "BYO LLM grouper command (prompt on stdin, JSON groups on stdout); used by --cluster=llm/auto-llm" },
    llmTimeout: { type: "number", aliases: ["llm-timeout"], description: "LLM backend timeout in seconds (default 120)" },
    writeMarker: { type: "boolean", default: false, aliases: ["write-marker"], description: "Freeze the grouping into .ccpluginizer.json" },
    interactive: { type: "boolean", default: false, description: "Review the proposed split before emitting" },
    minSkills: { type: "number", default: DEFAULT_MIN_SKILLS_TO_SPLIT, aliases: ["min-skills"], description: "Minimum skill count to attempt a split" },
  })
  .run(async ({ args, flags }): Promise<void> => {
    // Validate every flag BEFORE resolving the source: a bad --cluster must not
    // cost a full remote clone first.
    const requestedCluster = normalizeStrategy(flags.cluster);
    const wantSplit = flags.split;
    if (!wantSplit && flags.umbrella) {
      console.error("ccpluginizer: --umbrella is ignored with --no-split (the umbrella only exists on the split path).");
    }
    const minSkills =
      Number.isFinite(flags.minSkills) && flags.minSkills >= 0 ? flags.minSkills : DEFAULT_MIN_SKILLS_TO_SPLIT;
    if (minSkills !== flags.minSkills) {
      console.error(`ccpluginizer: invalid --min-skills ${String(flags.minSkills)}; using ${String(DEFAULT_MIN_SKILLS_TO_SPLIT)}.`);
    }
    const llmConfig = resolveLlmConfig({
      ...(flags.llmCmd !== undefined ? { llmCmd: flags.llmCmd } : {}),
      ...(flags.llmTimeout !== undefined ? { llmTimeout: flags.llmTimeout } : {}),
    });
    // Empty-string flag values behave like the other env/flag merges: as absent.
    const outputFlags: OutputFlags = {
      output: trimOrUndefined(flags.output),
      outDir: trimOrUndefined(flags.outDir),
    };

    const repoPath = await resolveSource(args.repo);
    const sourceRepo = inferSourceRepo(args.repo);
    // Lazy: the backend (and its which("claude") PATH probe) resolves only if the
    // partition actually invokes the grouper — marker wins, deterministic wins, and
    // sub-threshold scans never pay for it.
    const group: GroupSkillsFn | null =
      wantSplit && strategyUsesLlm(requestedCluster) ? makeLazyGrouper(llmConfig) : null;

    let result = await synthesizeEntries({
      repoRoot: repoPath,
      sourceRepo,
      split: wantSplit,
      umbrella: flags.umbrella,
      strategy: requestedCluster,
      minSkillsToSplit: minSkills,
      ...(group !== null ? { group } : {}),
    });

    // Decision B: an explicitly-configured LLM command is ignored under deterministic
    // `auto` (NOT auto-llm, which uses it as a rescue; NOT merely because `claude` is
    // on PATH). Only worth saying when this scan's split could actually have used it —
    // sub-threshold and marker-frozen runs never consult any strategy.
    const splitCouldHaveUsedLlm = result.attempted && result.provenance.kind !== "marker";
    if (wantSplit && requestedCluster === "auto" && llmConfig.cmd !== undefined && splitCouldHaveUsedLlm) {
      const source = llmConfig.cmdFromEnv ? "CCPLUGINIZER_LLM_CMD" : "--llm-cmd";
      console.error(
        `ccpluginizer: an LLM is configured (${source}) but auto is deterministic-only; pass --cluster=llm or --cluster=auto-llm to use it.`,
      );
    }

    if (flags.interactive && result.split !== null) {
      result = await reviewSplit(result, { repoPath, sourceRepo });
    }

    if (result.split !== null) {
      printSplitNotice(result);
    } else if (result.attempted && result.provenance.kind === "none") {
      // Explain every attempted-but-empty outcome the user explicitly steered:
      // an LLM step that ran and failed, or a forced (non-default) strategy.
      // The default `auto` stays silent by design.
      if (result.provenance.llmFailure !== undefined || requestedCluster !== DEFAULT_STRATEGY) {
        printNoSplitNotice(requestedCluster, result.provenance.llmFailure);
      }
    }

    for (const warning of result.warnings) {
      console.error(`ccpluginizer: warning: ${warning}`);
    }

    if (flags.writeMarker) {
      if (result.marker === null) {
        console.error(
          "ccpluginizer: --write-marker ignored — no split was emitted, so there is no grouping to freeze.",
        );
      } else if (parseSourceInput(args.repo).kind !== "local") {
        console.error(
          "ccpluginizer: --write-marker only works on a local path; a github/URL source is cloned to a temp dir that is discarded. Clone the repo locally, re-run `scan <path> --write-marker`, then commit .ccpluginizer.json.",
        );
      } else {
        const markerPath = join(repoPath, ".ccpluginizer.json");
        const merged = serializeMarkerDraft(result.marker, result.existingMarker);
        writeFileSync(markerPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
        console.error(`ccpluginizer: wrote frozen split to ${markerPath}`);
      }
    }

    emitOutput(result.entries, outputFlags, sourceRepo);
  });

function normalizeStrategy(value: string): ClusterStrategy {
  if ((CLUSTER_STRATEGIES as readonly string[]).includes(value)) {
    return value as ClusterStrategy;
  }
  // A typo like --cluster=auot must fail loudly: silently degrading to auto would
  // disable the LLM rescue the user explicitly asked for.
  throw new Error(`unknown --cluster "${value}"; expected one of: ${CLUSTER_STRATEGIES.join(", ")}`);
}

const DEFAULT_TIMEOUT_SECONDS = 120;

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The single reader of process.env (Crust's command context exposes no environment).
 * The optional `env` param exists purely so unit tests can pass a fake. Per-setting merge is
 * flag-over-env, trimmed, with empty/whitespace coerced to undefined.
 */
export function resolveLlmConfig(
  flags: { readonly llmCmd?: string; readonly llmTimeout?: number },
  env: NodeJS.ProcessEnv = process.env,
): ResolveGrouperOpts {
  const flagCmd = trimOrUndefined(flags.llmCmd);
  const envCmd = trimOrUndefined(env["CCPLUGINIZER_LLM_CMD"]);
  const cmd = flagCmd ?? envCmd;
  const cmdFromEnv = flagCmd === undefined && envCmd !== undefined;

  const envTimeout = trimOrUndefined(env["CCPLUGINIZER_LLM_TIMEOUT"]);
  const resolvedSeconds =
    flags.llmTimeout ?? (envTimeout !== undefined ? Number(envTimeout) : undefined) ?? DEFAULT_TIMEOUT_SECONDS;
  // Upper clamp: past 2^31-1 ms setTimeout overflows and fires at ~1ms, which would
  // SIGTERM the backend immediately on every run.
  const MAX_TIMEOUT_SECONDS = 2_147_483;
  const safeSeconds =
    Number.isFinite(resolvedSeconds) && resolvedSeconds > 0
      ? Math.min(resolvedSeconds, MAX_TIMEOUT_SECONDS)
      : DEFAULT_TIMEOUT_SECONDS;

  return {
    ...(cmd !== undefined ? { cmd } : {}),
    cmdFromEnv,
    timeoutMs: Math.round(safeSeconds * 1000),
  };
}

/**
 * Wrap resolveGrouper in a lazily-resolving GroupSkillsFn: the backend (and its
 * which("claude") PATH probe) resolves on first invocation only, and the GrouperRun
 * contract carries the backend identity so partitionSkills can report the outcome.
 */
export function makeLazyGrouper(
  config: ResolveGrouperOpts,
  resolve: (opts: ResolveGrouperOpts) => ResolvedGrouper | null = resolveGrouper,
): GroupSkillsFn {
  let backend: ResolvedGrouper | null | undefined;
  return async (skills) => {
    if (backend === undefined) {
      backend = resolve(config);
    }
    if (backend === null) {
      return null;
    }
    const run = await backend.fn(skills);
    return {
      kind: backend.kind,
      groups: run.groups,
      ...(run.commit !== undefined ? { commit: run.commit } : {}),
    };
  };
}

/** Render the provenance clause for a notice or the review screen. */
function describeProvenance(provenance: Exclude<SplitProvenance, { kind: "none" }>): string {
  if (provenance.kind === "marker") {
    return "via committed marker (.ccpluginizer.json)";
  }
  if (provenance.kind === "llm") {
    return `via ${provenance.backend} clustering`;
  }
  return provenance.llmFailure !== undefined
    ? `via ${provenance.strategy} clustering (${llmFailureReason(provenance.llmFailure)})`
    : `via ${provenance.strategy} clustering`;
}

/** The single renderer of the LLM-failure taxonomy; both notices compose it. */
function llmFailureReason(failure: LlmFailure): string {
  if (failure.step === "gate-rejected") {
    return "the LLM grouping was rejected by the acceptance gate";
  }
  if (failure.step === "no-output") {
    return "the LLM backend was unreachable or produced no output";
  }
  return "no LLM backend found; set --llm-cmd or install the `claude` CLI";
}

export function printSplitNotice(result: SynthesizeEntriesResult): void {
  if (result.split === null || result.provenance.kind === "none") {
    return;
  }
  const slices = result.split.groupCount;
  const parts = [`${String(slices)} skill slice${slices === 1 ? "" : "s"}`];
  if (result.split.coreEmitted) {
    parts.push("1 core");
  }
  if (result.split.umbrellaEmitted) {
    parts.push("1 umbrella");
  }
  const entryCount = result.entries.length;
  const via = describeProvenance(result.provenance);
  console.error(
    `ccpluginizer: split into ${String(entryCount)} ${entryCount === 1 ? "entry" : "entries"} (${parts.join(" + ")}) ${via}. Use --no-split for a single entry.`,
  );
}

export function printNoSplitNotice(requestedCluster: ClusterStrategy, llmFailure: LlmFailure | undefined): void {
  const reason =
    llmFailure !== undefined
      ? `${llmFailureReason(llmFailure)}, and no clean deterministic partition`
      : "no clean deterministic partition";
  console.error(
    `ccpluginizer: --cluster=${requestedCluster} produced no split — ${reason}; emitting a single entry.`,
  );
}

/** Merge the fresh draft over the existing marker, preserving hand-curated fields. */
interface ReviewContext {
  readonly repoPath: string;
  readonly sourceRepo: string;
}

type ConfirmFn = (opts: { message: string; default: boolean }) => Promise<boolean>;

export async function reviewSplit(
  result: SynthesizeEntriesResult,
  ctx: ReviewContext,
  confirmFn: ConfirmFn = (opts) => confirm(opts),
): Promise<SynthesizeEntriesResult> {
  if (result.split === null || result.provenance.kind === "none") {
    return result; // nothing to review — callers only invoke this on a fired split
  }
  console.error(`ccpluginizer: proposed split — ${describeProvenance(result.provenance)}`);
  for (const g of result.marker?.groups ?? []) {
    console.error(`  ${g.slug}: ${String(g.skills.length)} skills`);
  }
  const proceed = await confirmFn({
    message: `Emit this ${String(result.split.groupCount)}-way split?`,
    default: true,
  });
  if (proceed) {
    return result;
  }
  // Re-synthesize as a single entry BEFORE announcing it: an already-marketplace repo aborts
  // here (checkMarketplaceGuard), so we must not promise a single entry we then fail to emit.
  // The declined result's caches and parsed marker carry over — no second repo walk.
  const single = await synthesizeEntries({
    repoRoot: ctx.repoPath,
    sourceRepo: ctx.sourceRepo,
    split: false,
    existingMarker: result.existingMarker,
    caches: result.caches,
  });
  console.error("ccpluginizer: split declined; emitting a single entry.");
  return single;
}

interface OutputFlags {
  readonly output?: string | undefined;
  readonly outDir?: string | undefined;
}

function emitOutput(
  entries: readonly MarketplaceEntry[],
  flags: OutputFlags,
  sourceRepo: string,
): void {
  if (flags.outDir !== undefined) {
    if (flags.output !== undefined) {
      console.error(
        "ccpluginizer: both --out-dir and --output given; --output is ignored (writing one file per entry into the directory).",
      );
    }
    mkdirSync(flags.outDir, { recursive: true });
    for (const entry of entries) {
      writeFileSync(join(flags.outDir, `${entry.name}.json`), JSON.stringify(entry, null, 2) + "\n", "utf8");
    }
    warnAboutStaleEntries(entries, flags.outDir, sourceRepo);
    console.error(`ccpluginizer: wrote ${String(entries.length)} entr${entries.length === 1 ? "y" : "ies"} to ${flags.outDir}`);
    return;
  }
  // Single object when K=1 (byte-identical to pre-split output), JSON array when K>1.
  const payload: unknown = entries.length === 1 ? entries[0] : entries;
  const json = JSON.stringify(payload, null, 2);
  if (flags.output !== undefined) {
    writeFileSync(flags.output, json + "\n", "utf8");
  } else {
    console.log(json);
  }
}

/**
 * Stale-slice hygiene: a regrouped scan leaves previous slices behind in the shared
 * entries/ dir. Warn, never delete. Ownership is decided by the file's source URL —
 * filename prefixes are ambiguous (a renamed base or a sibling repo's extending
 * name would defeat any prefix rule in either direction).
 */
function warnAboutStaleEntries(
  entries: readonly MarketplaceEntry[],
  outDir: string,
  sourceRepo: string,
): void {
  const current = new Set(entries.map((e) => `${e.name}.json`));
  const expectedUrl = sourceRepoUrl(sourceRepo);
  const stale = readdirSync(outDir)
    .filter((f) => f.endsWith(".json") && !current.has(f))
    .filter((f) => {
      try {
        return entryReferencesUrl(readJsonFile(join(outDir, f)), expectedUrl);
      } catch {
        return false; // unreadable/foreign file — not provably ours, stay quiet
      }
    })
    .sort();
  if (stale.length > 0) {
    console.error(
      `ccpluginizer: warning: ${String(stale.length)} entry file(s) from a previous scan of this repo remain in ${outDir}: ${stale.join(", ")}. Delete them if this regrouping replaced them.`,
    );
  }
}

function entryReferencesUrl(parsed: unknown, url: string): boolean {
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return items.some((item) => {
    if (item === null || typeof item !== "object") {
      return false;
    }
    const source = (item as { source?: unknown }).source;
    return source !== null && typeof source === "object" && (source as { url?: unknown }).url === url;
  });
}
