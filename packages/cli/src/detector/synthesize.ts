import { checkMarketplaceGuard } from "./marketplaceGuard.ts";
import { detectMarkerFile } from "./markerFile.ts";
import { detectConventions } from "./conventions.ts";
import { normalizePathsAgainstRepo } from "./normalize.ts";
import type { Finding, ComponentKind } from "./types.ts";
import type { MarketplaceEntry, Source } from "../schemas/marketplaceEntry.ts";
import type { MarkerFile } from "../schemas/markerFile.ts";

// TODO: Task 8.3+ Layer 2.5 + Layer 3 merge
// import { detectNonStandardManifest } from "./nonStandardManifest.ts";
// import { detectContentSniff } from "./contentSniff.ts";

export interface SynthesizeInput {
  readonly repoRoot: string;
  readonly sourceRepo: string;
}

export function synthesizeEntry(input: SynthesizeInput): MarketplaceEntry {
  checkMarketplaceGuard(input.repoRoot);

  const marker = detectMarkerFile(input.repoRoot);
  if (marker !== null) {
    return buildEntryFromMarker(marker, input.sourceRepo);
  }

  const findings: Finding[] = [...detectConventions(input.repoRoot)];
  // Layer 2.5 + Layer 3 merge in later tasks
  return buildEntryFromFindings(findings, input.repoRoot, input.sourceRepo);
}

function buildEntryFromMarker(marker: MarkerFile, sourceRepo: string): MarketplaceEntry {
  const entry: MarketplaceEntry = {
    name: marker.name,
    source: makeGithubSource(sourceRepo),
    strict: false,
    ...(marker.description !== undefined ? { description: marker.description } : {}),
    ...(marker.license !== undefined ? { license: marker.license } : {}),
    ...(marker.skills !== undefined ? { skills: marker.skills } : {}),
    ...(marker.agents !== undefined ? { agents: marker.agents } : {}),
    ...(marker.commands !== undefined ? { commands: marker.commands } : {}),
  };

  return entry;
}

function buildEntryFromFindings(
  findings: readonly Finding[],
  repoRoot: string,
  sourceRepo: string,
): MarketplaceEntry {
  const byKind = groupByKind(findings);
  const entry: Record<string, unknown> = {
    name: defaultEntryName(sourceRepo),
    source: makeGithubSource(sourceRepo),
    strict: false,
  };
  for (const [kind, kindFindings] of byKind) {
    const allPaths = kindFindings.flatMap((f) => f.paths);
    const { kept } = normalizePathsAgainstRepo(repoRoot, allPaths);
    if (kept.length > 0) {
      entry[kind] = kept;
    }
  }
  return entry as MarketplaceEntry;
}

function groupByKind(findings: readonly Finding[]): Map<ComponentKind, readonly Finding[]> {
  const map = new Map<ComponentKind, Finding[]>();
  for (const f of findings) {
    const list = map.get(f.kind) ?? [];
    list.push(f);
    map.set(f.kind, list);
  }
  return map;
}

function makeGithubSource(repo: string): Source {
  return { source: "github", repo };
}

function defaultEntryName(sourceRepo: string): string {
  return sourceRepo.replace("/", "-").toLowerCase();
}
