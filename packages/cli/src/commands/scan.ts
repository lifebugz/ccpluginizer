import { Crust } from "@crustjs/core";
import { confirm } from "@crustjs/prompts";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSource, inferSourceRepo, parseSourceInput } from "../sources/index.ts";
import {
  synthesizeEntries,
  type MarkerDraft,
  type SynthesizeEntriesResult,
} from "../detector/synthesize.ts";
import { detectMarkerFile } from "../detector/markerFile.ts";
import { CLUSTER_STRATEGIES, type ClusterStrategy, type GroupSkillsFn, type ResolvedStrategy } from "../detector/partition.ts";
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
    const usesLlm = requestedCluster === "llm" || requestedCluster === "auto-llm";
    // Lazy: the backend (and its which("claude") PATH probe) resolves only if the
    // partition actually invokes the grouper — marker wins, deterministic wins, and
    // sub-threshold scans never pay for it. The runtime records what happened so
    // notices report facts instead of re-inferring them.
    const llm: LlmRuntime | null = wantSplit && usesLlm ? makeLazyGrouper(llmConfig) : null;

    // Decision B: an explicitly-configured LLM command is ignored under deterministic
    // `auto` (NOT auto-llm, which uses it as a rescue; NOT merely because `claude` is
    // on PATH).
    if (requestedCluster === "auto" && llmConfig.cmd !== undefined) {
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
      ...(llm !== null ? { group: llm.fn } : {}),
    });

    if (flags.interactive && result.split !== null) {
      result = await reviewSplit(result, { repoPath, sourceRepo, minSkills: flags.minSkills, requestedCluster, llm });
    }

    if (result.split !== null) {
      printSplitNotice(result, requestedCluster, llm);
    } else if (result.splitAttemptedButEmpty && usesLlm) {
      printNoSplitNotice(requestedCluster, llm);
    }

    for (const warning of result.warnings) {
      console.error(`ccpluginizer: warning: ${warning}`);
    }

    if (flags.writeMarker && result.marker !== null) {
      if (parseSourceInput(args.repo).kind !== "local") {
        console.error(
          "ccpluginizer: --write-marker only works on a local path; a github/URL source is cloned to a temp dir that is discarded. Clone the repo locally, re-run `scan <path> --write-marker`, then commit .ccpluginizer.json.",
        );
      } else {
        const markerPath = join(repoPath, ".ccpluginizer.json");
        const merged = toMarkerFile(result.marker, detectMarkerFile(repoPath));
        writeFileSync(markerPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
        console.error(`ccpluginizer: wrote frozen split to ${markerPath}`);
      }
    }

    emitOutput(result.entries, flags, result.marker?.name ?? result.entries[0]?.name);
  });

function normalizeStrategy(value: string): ClusterStrategy {
  if ((CLUSTER_STRATEGIES as readonly string[]).includes(value)) {
    return value as ClusterStrategy;
  }
  console.error(`ccpluginizer: unknown --cluster "${value}"; using auto.`);
  return "auto";
}

/** Back-compat alias: the LLM config IS the grouper-resolution options. */
export type LlmConfig = ResolveGrouperOpts;

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
): LlmConfig {
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

export interface LlmRuntimeState {
  /** True once the grouper was actually invoked by partitioning. */
  attempted: boolean;
  /** Backend resolved on first invocation; null = none found (or never invoked). */
  resolved: ResolvedGrouper | null;
  /** True when the backend returned at least one parseable group. */
  produced: boolean;
}

export interface LlmRuntime {
  readonly fn: GroupSkillsFn;
  readonly state: LlmRuntimeState;
}

/**
 * Wrap resolveGrouper in a lazy, outcome-recording GroupSkillsFn: resolution (incl.
 * the `claude` PATH probe) happens on first invocation only, and the recorded state
 * lets the split notices state exactly what the LLM step did.
 */
export function makeLazyGrouper(
  config: ResolveGrouperOpts,
  resolve: (opts: ResolveGrouperOpts) => ResolvedGrouper | null = resolveGrouper,
): LlmRuntime {
  const state: LlmRuntimeState = { attempted: false, resolved: null, produced: false };
  const fn: GroupSkillsFn = async (skills) => {
    if (!state.attempted) {
      state.attempted = true;
      state.resolved = resolve(config);
    }
    if (state.resolved === null) {
      return [];
    }
    const groups = await state.resolved.fn(skills);
    if (groups.length > 0) {
      state.produced = true;
    }
    return groups;
  };
  return { fn, state };
}

/** Render the resolved-strategy clause for a notice or the review screen. */
function describeStrategy(
  strategy: ResolvedStrategy,
  requestedCluster: ClusterStrategy,
  llm: LlmRuntime | null,
): string {
  if (strategy === "marker") {
    return "via committed marker (.ccpluginizer.json)";
  }
  if (strategy === "llm") {
    return `via ${llm?.state.resolved?.kind ?? "subprocess"} clustering`;
  }
  // A deterministic strategy under --cluster=llm (LLM-first) means the LLM step
  // failed; the runtime recorded exactly how.
  if (requestedCluster === "llm") {
    return `via ${strategy} clustering (${llmFailureReason(llm)})`;
  }
  // auto, a named deterministic strategy, or auto-llm where deterministic won outright (a success).
  return `via ${strategy} clustering`;
}

function llmFailureReason(llm: LlmRuntime | null): string {
  if ((llm?.state.resolved ?? null) === null) {
    return "no LLM backend found; set --llm-cmd or install the `claude` CLI";
  }
  return llm?.state.produced === true
    ? "the LLM grouping was rejected by the acceptance gate"
    : "the LLM backend was unreachable or produced no output";
}

export function printSplitNotice(
  result: SynthesizeEntriesResult,
  requestedCluster: ClusterStrategy,
  llm: LlmRuntime | null,
): void {
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
  const via = describeStrategy(result.split.strategy, requestedCluster, llm);
  console.error(
    `ccpluginizer: split into ${String(entryCount)} ${entryCount === 1 ? "entry" : "entries"} (${parts.join(" + ")}) ${via}. Use --no-split for a single entry.`,
  );
}

export function printNoSplitNotice(requestedCluster: ClusterStrategy, llm: LlmRuntime | null): void {
  const reason =
    (llm?.state.resolved ?? null) === null
      ? "no clean deterministic partition and no LLM backend available"
      : llm?.state.produced === true
        ? "the LLM grouping was rejected by the acceptance gate and no clean deterministic partition"
        : "the LLM backend was unreachable or produced no output, and no clean deterministic partition";
  console.error(
    `ccpluginizer: --cluster=${requestedCluster} produced no split — ${reason}; emitting a single entry.`,
  );
}

/** Merge the fresh draft over the existing marker, preserving hand-curated fields. */
function toMarkerFile(draft: MarkerDraft, existing: MarkerFile | null): Record<string, unknown> {
  // The draft owns name/core/umbrella/groups; every other field (description, license,
  // homepage, repository, single-entry component lists, ...) is curation that a
  // --write-marker refresh must not destroy.
  const draftOwned = new Set(["name", "core", "umbrella", "groups"]);
  const preserved: Record<string, unknown> = {};
  if (existing !== null) {
    for (const [key, value] of Object.entries(existing)) {
      if (!draftOwned.has(key) && value !== undefined) {
        preserved[key] = value;
      }
    }
  }
  return {
    name: draft.name,
    // Emit `core` explicitly, even when false: synthesize reads `marker.core ?? true`,
    // so omitting a false would silently re-enable the core entry on the next scan and
    // a coreless split would not round-trip through the frozen marker.
    core: draft.core,
    ...(draft.umbrella ? { umbrella: true } : {}),
    groups: draft.groups,
    ...preserved,
  };
}

interface ReviewContext {
  readonly repoPath: string;
  readonly sourceRepo: string;
  readonly minSkills: number;
  readonly requestedCluster: ClusterStrategy;
  readonly llm: LlmRuntime | null;
}

type ConfirmFn = (opts: { message: string; default: boolean }) => Promise<boolean>;

export async function reviewSplit(
  result: SynthesizeEntriesResult,
  ctx: ReviewContext,
  confirmFn: ConfirmFn = (opts) => confirm(opts),
): Promise<SynthesizeEntriesResult> {
  const via =
    result.split !== null ? ` — ${describeStrategy(result.split.strategy, ctx.requestedCluster, ctx.llm)}` : "";
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
    minSkillsToSplit: ctx.minSkills,
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
    // Stale-slice hygiene: a regrouped scan leaves previous slices behind in the
    // shared entries/ dir. Warn, never delete — the dir may hold other repos' entries.
    if (basePrefix !== undefined) {
      const current = new Set(entries.map((e) => `${e.name}.json`));
      const stale = readdirSync(flags.outDir)
        .filter((f) => f.endsWith(".json") && !current.has(f))
        .filter((f) => f === `${basePrefix}.json` || f.startsWith(`${basePrefix}-`))
        .sort();
      if (stale.length > 0) {
        console.error(
          `ccpluginizer: warning: ${String(stale.length)} entry file(s) from a previous scan of this repo remain in ${flags.outDir}: ${stale.join(", ")}. Delete them if this regrouping replaced them.`,
        );
      }
    }
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
