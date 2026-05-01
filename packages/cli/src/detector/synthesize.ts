import { checkMarketplaceGuard } from "./marketplaceGuard.ts";
import { detectMarkerFile } from "./markerFile.ts";
import { detectConventions } from "./conventions.ts";
import { detectNonStandardManifest } from "./nonStandardManifest.ts";
// import { detectContentSniff } from "./contentSniff.ts"; // Re-add in Task 8.4
import { normalizePathsAgainstRepo } from "./normalize.ts";
import type { Finding, ComponentKind } from "./types.ts";
import type { MarketplaceEntry, Source } from "../schemas/marketplaceEntry.ts";
import type { MarkerFile } from "../schemas/markerFile.ts";
import type { NonStandardManifest } from "../schemas/nonStandardManifest.ts";

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

  const conventionFindings = detectConventions(input.repoRoot);
  const manifestResult = detectNonStandardManifest(input.repoRoot);

  const findings: Finding[] = [...conventionFindings];
  const manifestKindsWithFindings = new Set<ComponentKind>();

  if (manifestResult !== null) {
    addManifestFindings(findings, manifestResult.manifest, manifestKindsWithFindings);
  }

  // Remove convention findings for kinds that have manifest findings
  const finalFindings = findings.filter((f) => {
    if (f.source === "convention" && manifestKindsWithFindings.has(f.kind)) {
      return false;
    }
    return true;
  });

  const entry = buildEntryFromFindings(finalFindings, input.repoRoot, input.sourceRepo);
  if (manifestResult !== null) {
    return mergeManifestMetadata(entry, manifestResult.manifest);
  }
  return entry;
}

function addManifestFindings(
  findings: Finding[],
  manifest: NonStandardManifest,
  manifestKindsWithFindings: Set<ComponentKind>,
): void {
  const kinds: readonly { key: keyof NonStandardManifest; kind: ComponentKind }[] = [
    { key: "skills", kind: "skills" },
    { key: "agents", kind: "agents" },
    { key: "commands", kind: "commands" },
  ];
  for (const { key, kind } of kinds) {
    const value = manifest[key];
    if (Array.isArray(value)) {
      findings.push({
        kind,
        paths: value,
        confidence: "high",
        source: "manifest",
      });
      manifestKindsWithFindings.add(kind);
    }
  }
}

function mergeManifestMetadata(
  entry: MarketplaceEntry,
  manifest: NonStandardManifest,
): MarketplaceEntry {
  return {
    ...entry,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
    ...(manifest.repository !== undefined ? { repository: manifest.repository } : {}),
    ...(manifest.license !== undefined ? { license: manifest.license } : {}),
    ...(manifest.author !== undefined ? { author: manifest.author } : {}),
  };
}

function buildEntryFromMarker(marker: MarkerFile, sourceRepo: string): MarketplaceEntry {
  return {
    name: marker.name,
    source: makeGithubSource(sourceRepo),
    strict: false,
    ...(marker.description !== undefined ? { description: marker.description } : {}),
    ...(marker.license !== undefined ? { license: marker.license } : {}),
    ...(marker.skills !== undefined ? { skills: marker.skills } : {}),
    ...(marker.agents !== undefined ? { agents: marker.agents } : {}),
    ...(marker.commands !== undefined ? { commands: marker.commands } : {}),
  };
}

function buildEntryFromFindings(
  findings: readonly Finding[],
  repoRoot: string,
  sourceRepo: string,
): MarketplaceEntry {
  const byKind = groupByKind(findings);
  const componentEntries: Record<string, readonly string[]> = {};
  for (const [kind, kindFindings] of byKind) {
    const allPaths = kindFindings.flatMap((f) => f.paths);
    const { kept } = normalizePathsAgainstRepo(repoRoot, allPaths);
    if (kept.length > 0) {
      componentEntries[kind] = kept;
    }
  }
  return {
    name: defaultEntryName(sourceRepo),
    source: makeGithubSource(sourceRepo),
    strict: false,
    ...componentEntries,
  };
}

function groupByKind(findings: readonly Finding[]): Map<ComponentKind, Finding[]> {
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
