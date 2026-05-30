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
import type { ClusterStrategy, GroupSkillsFn } from "../detector/partition.ts";
import type { MarketplaceEntry } from "../schemas/marketplaceEntry.ts";
import { makeClaudeGrouper } from "./llmGrouper.ts";

const STRATEGIES: readonly ClusterStrategy[] = ["auto", "llm", "metadata", "directory", "name-prefix"];

export const scanCommand = new Crust("scan")
  .meta({ description: "Scan a non-plugin repo and emit a marketplace entry (auto-splits bloated plugins)" })
  .args([{ name: "repo", type: "string", required: true, description: "owner/repo, URL, or local path" }] as const)
  .flags({
    output: { type: "string", short: "o", description: "Write the entry/entries JSON to a single file" },
    outDir: { type: "string", aliases: ["out-dir"], description: "Write one JSON file per entry into this directory" },
    split: { type: "boolean", default: true, description: "Auto-split bloated plugins (use --no-split to force one entry)" },
    umbrella: { type: "boolean", default: false, description: "Also emit the everything-in-one umbrella entry" },
    cluster: { type: "string", default: "auto", description: "Clustering strategy: auto|llm|metadata|directory|name-prefix" },
    writeMarker: { type: "boolean", default: false, aliases: ["write-marker"], description: "Freeze the grouping into .ccpluginizer.json" },
    interactive: { type: "boolean", default: false, description: "Review the proposed split before emitting" },
    minSkills: { type: "number", default: 25, aliases: ["min-skills"], description: "Minimum skill count to attempt a split" },
  })
  .run(async ({ args, flags }): Promise<void> => {
    const repoPath = await resolveSource(args.repo);
    const sourceRepo = inferSourceRepo(args.repo);

    const requestedCluster = normalizeStrategy(flags.cluster);
    const wantSplit = flags.split;
    const group = wantSplit && (requestedCluster === "auto" || requestedCluster === "llm") ? makeClaudeGrouper() : null;

    // If --cluster=llm was requested but the claude CLI is absent, actually cascade
    // through deterministic strategies so the "falling back" message is truthful.
    let cluster = requestedCluster;
    if (wantSplit && requestedCluster === "llm" && group === null) {
      console.error("ccpluginizer: --cluster=llm requested but the `claude` CLI was not found; falling back to deterministic clustering.");
      cluster = "auto";
    }

    let result = await synthesizeEntries({
      repoRoot: repoPath,
      sourceRepo,
      split: wantSplit,
      umbrella: flags.umbrella,
      strategy: cluster,
      minSkillsToSplit: flags.minSkills,
      ...(group !== null ? { group } : {}),
    });

    if (flags.interactive && result.split !== null) {
      result = await reviewSplit(result, { repoPath, sourceRepo, minSkills: flags.minSkills });
    }

    if (result.split !== null) {
      printSplitNotice(result, cluster, group);
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

function printSplitNotice(
  result: SynthesizeEntriesResult,
  cluster: ClusterStrategy,
  group: GroupSkillsFn | null,
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
  const fellBack = cluster === "auto" && group === null;
  const via = fellBack
    ? `${result.split.strategy} (deterministic; claude CLI not found)`
    : result.split.strategy;
  console.error(
    `ccpluginizer: split into ${String(result.entries.length)} entries (${parts.join(" + ")}) via ${via} clustering. Use --no-split for a single entry.`,
  );
}

function toMarkerFile(draft: MarkerDraft): Record<string, unknown> {
  return {
    name: draft.name,
    ...(draft.core ? { core: true } : {}),
    ...(draft.umbrella ? { umbrella: true } : {}),
    groups: draft.groups,
  };
}

interface ReviewContext {
  readonly repoPath: string;
  readonly sourceRepo: string;
  readonly minSkills: number;
}

async function reviewSplit(
  result: SynthesizeEntriesResult,
  ctx: ReviewContext,
): Promise<SynthesizeEntriesResult> {
  console.error("ccpluginizer: proposed split —");
  for (const g of result.marker?.groups ?? []) {
    console.error(`  ${g.slug}: ${String(g.skills.length)} skills`);
  }
  const proceed = await confirm({
    message: `Emit this ${String(result.split?.groupCount ?? 0)}-way split?`,
    default: true,
  });
  if (proceed) {
    return result;
  }
  console.error("ccpluginizer: split declined; emitting a single entry.");
  return synthesizeEntries({
    repoRoot: ctx.repoPath,
    sourceRepo: ctx.sourceRepo,
    split: false,
    minSkillsToSplit: ctx.minSkills,
  });
}

interface OutputFlags {
  readonly output?: string | undefined;
  readonly outDir?: string | undefined;
}

function emitOutput(entries: readonly MarketplaceEntry[], flags: OutputFlags): void {
  if (flags.outDir !== undefined) {
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
