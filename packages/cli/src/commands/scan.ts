import { Crust } from "@crustjs/core";
import { confirm } from "@crustjs/prompts";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSource, inferSourceRepo, parseSourceInput } from "../sources/index.ts";
import {
  synthesizeEntries,
  type MarkerDraft,
  type SynthesizeEntriesResult,
} from "../detector/synthesize.ts";
import {
  CLUSTER_STRATEGIES,
  type ClusterStrategy,
  type GroupSkillsFn,
  type LlmOutcome,
  type ResolvedStrategy,
} from "../detector/partition.ts";
import type { MarketplaceEntry } from "../schemas/marketplaceEntry.ts";
import type { MarkerFile } from "../schemas/markerFile.ts";
import { resolveGrouper, type ResolvedGrouper, type ResolveGrouperOpts } from "./llmGrouper.ts";

export const scanCommand = new Crust("scan")
  .meta({ description: "Scan a non-plugin repo and emit a marketplace entry (auto-splits bloated plugins)" })
  .args([{ name: "repo", type: "string", required: true, description: "owner/repo, URL, or local path" }] as const)
  .flags({
    output: { type: "string", short: "o", description: "Write the entry/entries JSON to a single file" },
    outDir: { type: "string", aliases: ["out-dir"], description: "Write one JSON file per entry into this directory" },
    split: { type: "boolean", default: true, description: "Auto-split bloated plugins (use --no-split to force one entry)" },
    umbrella: { type: "boolean", default: false, description: "Also emit the everything-in-one umbrella entry" },
    cluster: { type: "string", default: "auto", description: "Clustering strategy: auto (deterministic, default) | auto-llm (deterministic, then BYO LLM on no clean partition) | llm (opt-in BYO subprocess/claude) | metadata | directory | name-prefix" },
    llmCmd: { type: "string", aliases: ["llm-cmd"], description: "BYO LLM grouper command (prompt on stdin, JSON groups on stdout); used by --cluster=llm/auto-llm" },
    llmTimeout: { type: "number", aliases: ["llm-timeout"], description: "LLM backend timeout in seconds (default 120)" },
    writeMarker: { type: "boolean", default: false, aliases: ["write-marker"], description: "Freeze the grouping into .ccpluginizer.json" },
    interactive: { type: "boolean", default: false, description: "Review the proposed split before emitting" },
    minSkills: { type: "number", default: 25, aliases: ["min-skills"], description: "Minimum skill count to attempt a split" },
  })
  .run(async ({ args, flags }): Promise<void> => {
    const repoPath = await resolveSource(args.repo);
    const sourceRepo = inferSourceRepo(args.repo);

    const requestedCluster = normalizeStrategy(flags.cluster);
    const wantSplit = flags.split;
    const llmConfig = resolveLlmConfig({
      ...(flags.llmCmd !== undefined ? { llmCmd: flags.llmCmd } : {}),
      ...(flags.llmTimeout !== undefined ? { llmTimeout: flags.llmTimeout } : {}),
    });
    // Lazy: the backend (and its which("claude") PATH probe) resolves only if the
    // partition actually invokes the grouper — marker wins, deterministic wins, and
    // sub-threshold scans never pay for it.
    const group: GroupSkillsFn | null =
      wantSplit && (requestedCluster === "llm" || requestedCluster === "auto-llm")
        ? makeLazyGrouper(llmConfig)
        : null;

    // Decision B: an explicitly-configured LLM command is ignored under deterministic
    // `auto` (NOT auto-llm, which uses it as a rescue; NOT merely because `claude` is
    // on PATH). Only worth saying when a split could actually have used it.
    if (wantSplit && requestedCluster === "auto" && llmConfig.cmd !== undefined) {
      const source = llmConfig.cmdFromEnv ? "CCPLUGINIZER_LLM_CMD" : "--llm-cmd";
      console.error(
        `ccpluginizer: an LLM is configured (${source}) but auto is deterministic-only; pass --cluster=llm or --cluster=auto-llm to use it.`,
      );
    }

    let result = await synthesizeEntries({
      repoRoot: repoPath,
      sourceRepo,
      split: wantSplit,
      umbrella: flags.umbrella,
      strategy: requestedCluster,
      minSkillsToSplit: flags.minSkills,
      ...(group !== null ? { group } : {}),
    });

    if (flags.interactive && result.split !== null) {
      result = await reviewSplit(result, { repoPath, sourceRepo });
    }

    if (result.split !== null) {
      printSplitNotice(result, result.llm);
    } else if (result.splitAttemptedButEmpty && result.llm.step !== "not-invoked") {
      printNoSplitNotice(requestedCluster, result.llm);
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
        const merged = toMarkerFile(result.marker, result.existingMarker);
        writeFileSync(markerPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
        console.error(`ccpluginizer: wrote frozen split to ${markerPath}`);
      }
    }

    emitOutput(result.entries, flags, result.marker?.name ?? result.entries[0]?.name, sourceRepo);
  });

function normalizeStrategy(value: string): ClusterStrategy {
  if ((CLUSTER_STRATEGIES as readonly string[]).includes(value)) {
    return value as ClusterStrategy;
  }
  console.error(`ccpluginizer: unknown --cluster "${value}"; using auto.`);
  return "auto";
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
  const safeSeconds =
    Number.isFinite(resolvedSeconds) && resolvedSeconds > 0 ? resolvedSeconds : DEFAULT_TIMEOUT_SECONDS;

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
    return { kind: backend.kind, groups: await backend.fn(skills) };
  };
}

/** Render the resolved-strategy clause for a notice or the review screen. */
function describeStrategy(strategy: ResolvedStrategy, llm: LlmOutcome): string {
  if (strategy === "marker") {
    return "via committed marker (.ccpluginizer.json)";
  }
  if (strategy === "llm") {
    return `via ${llm.step === "won" ? llm.kind : "subprocess"} clustering`;
  }
  if (llm.step === "not-invoked") {
    return `via ${strategy} clustering`;
  }
  // A deterministic strategy after the LLM step ran means the LLM step failed —
  // the partition orchestrator reported exactly how.
  return `via ${strategy} clustering (${llmFailureReason(llm)})`;
}

/** The single renderer of the LLM-failure taxonomy; both notices compose it. */
function llmFailureReason(llm: LlmOutcome): string {
  if (llm.step === "gate-rejected") {
    return "the LLM grouping was rejected by the acceptance gate";
  }
  if (llm.step === "no-output") {
    return "the LLM backend was unreachable or produced no output";
  }
  return "no LLM backend found; set --llm-cmd or install the `claude` CLI";
}

export function printSplitNotice(result: SynthesizeEntriesResult, llm: LlmOutcome): void {
  if (result.split === null) {
    return;
  }
  const slices = result.split.groupCount;
  const parts = [`${String(slices)} skill slice${slices === 1 ? "" : "s"}`];
  if (result.marker?.core === true) {
    parts.push("1 core");
  }
  if (result.marker?.umbrella === true) {
    parts.push("1 umbrella");
  }
  const entryCount = result.entries.length;
  const via = describeStrategy(result.split.strategy, llm);
  console.error(
    `ccpluginizer: split into ${String(entryCount)} ${entryCount === 1 ? "entry" : "entries"} (${parts.join(" + ")}) ${via}. Use --no-split for a single entry.`,
  );
}

export function printNoSplitNotice(requestedCluster: ClusterStrategy, llm: LlmOutcome): void {
  console.error(
    `ccpluginizer: --cluster=${requestedCluster} produced no split — ${llmFailureReason(llm)}, and no clean deterministic partition; emitting a single entry.`,
  );
}

/** Merge the fresh draft over the existing marker, preserving hand-curated fields. */
function toMarkerFile(draft: MarkerDraft, existing: MarkerFile | null): Record<string, unknown> {
  // The draft owns exactly its own keys; every other field (description, license,
  // homepage, repository, single-entry component lists, ...) is curation that a
  // --write-marker refresh must not destroy. Deriving the set from the draft keeps
  // future MarkerDraft fields refreshed instead of silently shadowed by stale values.
  const draftOwned = new Set(Object.keys(draft));
  const preserved: Record<string, unknown> = {};
  if (existing !== null) {
    for (const [key, value] of Object.entries(existing)) {
      if (!draftOwned.has(key) && value !== undefined) {
        preserved[key] = value;
      }
    }
  }
  return {
    // `core` is emitted explicitly even when false: synthesize reads `marker.core ?? true`,
    // so omitting a false would silently re-enable the core entry on the next scan and a
    // coreless split would not round-trip. `umbrella: false` is omitted (JSON.stringify
    // drops undefined) to keep the file minimal — absence already means false.
    ...draft,
    ...(draft.umbrella ? {} : { umbrella: undefined }),
    ...preserved,
  };
}

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
  const via = result.split !== null ? ` — ${describeStrategy(result.split.strategy, result.llm)}` : "";
  console.error(`ccpluginizer: proposed split${via}`);
  for (const g of result.marker?.groups ?? []) {
    console.error(`  ${g.slug}: ${String(g.skills.length)} skills`);
  }
  const proceed = await confirmFn({
    message: `Emit this ${String(result.split?.groupCount ?? 0)}-way split?`,
    default: true,
  });
  if (proceed) {
    return result;
  }
  // Re-synthesize as a single entry BEFORE announcing it: an already-marketplace repo aborts
  // here (checkMarketplaceGuard), so we must not promise a single entry we then fail to emit.
  const single = await synthesizeEntries({
    repoRoot: ctx.repoPath,
    sourceRepo: ctx.sourceRepo,
    split: false,
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
  basePrefix: string | undefined,
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
    warnAboutStaleEntries(entries, flags.outDir, basePrefix, sourceRepo);
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
 * entries/ dir. Warn, never delete. Filenames alone are ambiguous (a sibling repo's
 * base can extend ours), so only files whose JSON references THIS repo's source URL
 * count as stale.
 */
function warnAboutStaleEntries(
  entries: readonly MarketplaceEntry[],
  outDir: string,
  basePrefix: string | undefined,
  sourceRepo: string,
): void {
  if (basePrefix === undefined) {
    return;
  }
  const current = new Set(entries.map((e) => `${e.name}.json`));
  const expectedUrl = `https://github.com/${sourceRepo}.git`;
  const stale = readdirSync(outDir)
    .filter((f) => f.endsWith(".json") && !current.has(f))
    .filter((f) => f === `${basePrefix}.json` || f.startsWith(`${basePrefix}-`))
    .filter((f) => {
      try {
        return entryReferencesUrl(JSON.parse(readFileSync(join(outDir, f), "utf8")), expectedUrl);
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
