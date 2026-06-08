import { Crust } from "@crustjs/core";
import { confirm } from "@crustjs/prompts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSource, inferSourceRepo, parseSourceInput } from "../sources/index.ts";
import {
  synthesizeEntries,
  type MarkerDraft,
  type SynthesizeEntriesResult,
} from "../detector/synthesize.ts";
import type { ClusterStrategy, ResolvedStrategy } from "../detector/partition.ts";
import type { MarketplaceEntry } from "../schemas/marketplaceEntry.ts";
import { resolveGrouper, type ResolvedGrouper } from "./llmGrouper.ts";

const STRATEGIES: readonly ClusterStrategy[] = ["auto", "auto-llm", "llm", "metadata", "directory", "name-prefix"];

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
    const resolved: ResolvedGrouper | null = wantSplit && usesLlm ? resolveGrouper(llmConfig) : null;

    // Decision B: an explicitly-configured LLM command is ignored under deterministic `auto`
    // (NOT auto-llm, which uses it as a rescue; NOT merely because `claude` is on PATH).
    if (requestedCluster === "auto" && llmConfig.cmd !== undefined) {
      console.error(
        "ccpluginizer: an LLM is configured (CCPLUGINIZER_LLM_CMD) but auto is deterministic-only; pass --cluster=llm or --cluster=auto-llm to use it.",
      );
    }

    let result = await synthesizeEntries({
      repoRoot: repoPath,
      sourceRepo,
      split: wantSplit,
      umbrella: flags.umbrella,
      strategy: requestedCluster,
      minSkillsToSplit: flags.minSkills,
      ...(resolved !== null ? { group: resolved.fn } : {}),
    });

    if (flags.interactive && result.split !== null) {
      result = await reviewSplit(result, { repoPath, sourceRepo, minSkills: flags.minSkills, requestedCluster, resolved });
    }

    if (result.split !== null) {
      printSplitNotice(result, requestedCluster, resolved);
    } else if (result.splitAttemptedButEmpty && usesLlm) {
      printNoSplitNotice(requestedCluster, resolved);
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
        writeFileSync(markerPath, JSON.stringify(toMarkerFile(result.marker), null, 2) + "\n", "utf8");
        console.error(`ccpluginizer: wrote frozen split to ${markerPath}`);
      }
    }

    emitOutput(result.entries, flags);
  });

function normalizeStrategy(value: string): ClusterStrategy {
  if ((STRATEGIES as readonly string[]).includes(value)) {
    return value as ClusterStrategy;
  }
  console.error(`ccpluginizer: unknown --cluster "${value}"; using auto.`);
  return "auto";
}

export interface LlmConfig {
  readonly cmd?: string;
  readonly cmdFromEnv: boolean;
  readonly timeoutMs: number;
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

/** Render the resolved-strategy clause for a notice or the review screen. */
function describeStrategy(
  strategy: ResolvedStrategy,
  requestedCluster: ClusterStrategy,
  resolved: ResolvedGrouper | null,
): string {
  if (strategy === "marker") {
    return "via committed marker (.ccpluginizer.json)";
  }
  if (strategy === "llm") {
    const kind = resolved?.kind ?? "subprocess";
    return `via ${kind} clustering`;
  }
  // A deterministic strategy under --cluster=llm (LLM-first) means the model failed and we fell back.
  if (requestedCluster === "llm") {
    const reason =
      resolved !== null
        ? "LLM backend produced no acceptable grouping or was unreachable"
        : "no LLM backend found; set --llm-cmd or install the `claude` CLI";
    return `via ${strategy} clustering (${reason})`;
  }
  // auto, a named deterministic strategy, or auto-llm where deterministic won outright (a success).
  return `via ${strategy} clustering`;
}

export function printSplitNotice(
  result: SynthesizeEntriesResult,
  requestedCluster: ClusterStrategy,
  resolved: ResolvedGrouper | null,
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
  const via = describeStrategy(result.split.strategy, requestedCluster, resolved);
  console.error(
    `ccpluginizer: split into ${String(entryCount)} ${entryCount === 1 ? "entry" : "entries"} (${parts.join(" + ")}) ${via}. Use --no-split for a single entry.`,
  );
}

export function printNoSplitNotice(requestedCluster: ClusterStrategy, resolved: ResolvedGrouper | null): void {
  const reason =
    resolved !== null
      ? "no acceptable LLM grouping and no clean deterministic partition"
      : "no clean deterministic partition and no LLM backend available";
  console.error(
    `ccpluginizer: --cluster=${requestedCluster} produced no split — ${reason}; emitting a single entry.`,
  );
}

function toMarkerFile(draft: MarkerDraft): Record<string, unknown> {
  return {
    name: draft.name,
    // Emit `core` explicitly, even when false: synthesize reads `marker.core ?? true`,
    // so omitting a false would silently re-enable the core entry on the next scan and
    // a coreless split would not round-trip through the frozen marker.
    core: draft.core,
    ...(draft.umbrella ? { umbrella: true } : {}),
    groups: draft.groups,
  };
}

interface ReviewContext {
  readonly repoPath: string;
  readonly sourceRepo: string;
  readonly minSkills: number;
  readonly requestedCluster: ClusterStrategy;
  readonly resolved: ResolvedGrouper | null;
}

type ConfirmFn = (opts: { message: string; default: boolean }) => Promise<boolean>;

export async function reviewSplit(
  result: SynthesizeEntriesResult,
  ctx: ReviewContext,
  confirmFn: ConfirmFn = (opts) => confirm(opts),
): Promise<SynthesizeEntriesResult> {
  const via =
    result.split !== null ? ` — ${describeStrategy(result.split.strategy, ctx.requestedCluster, ctx.resolved)}` : "";
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

function emitOutput(entries: readonly MarketplaceEntry[], flags: OutputFlags): void {
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
