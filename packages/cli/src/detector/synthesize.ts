import * as v from "valibot";
import { checkMarketplaceGuard, isAlreadyMarketplace } from "./marketplaceGuard.ts";
import { detectMarkerFile, isFreezeOnlyMarker, markerSuppressesSplit } from "./markerFile.ts";
import { detectConventions } from "./conventions.ts";
import { detectNonStandardManifest } from "./nonStandardManifest.ts";
import { detectContentSniff } from "./contentSniff.ts";
import { makeScanCaches, type ScanCaches } from "./caches.ts";
import { normalizePathsAgainstRepo } from "./normalize.ts";
import { createLayoutResolver, type ContainerRef, type SourceLayout } from "./sourceLayout.ts";
import { countSkillMdDirs, enumerateSkills } from "./skillMeta.ts";
import {
  DEFAULT_STRATEGY,
  partitionSkills,
  type ClusterStrategy,
  type GroupSkillsFn,
  type Grouping,
  type SplitProvenance,
} from "./partition.ts";
import { byCodeUnit, slugify, uniqueSlugs } from "./slugify.ts";
import type { Finding, ComponentKind } from "./types.ts";
import type { MarketplaceEntry, Source } from "../schemas/marketplaceEntry.ts";
import { MarkerFileSchema, type MarkerFile } from "../schemas/markerFile.ts";
import type { NonStandardManifest } from "../schemas/nonStandardManifest.ts";

export interface SynthesizeInput {
  readonly repoRoot: string;
  readonly sourceRepo: string;
}

/** Default threshold: only attempt a split when a repo has at least this many skills. */
export const DEFAULT_MIN_SKILLS_TO_SPLIT = 25;

const NO_SPLIT: SplitProvenance = { kind: "none" };

export interface SynthesizeEntriesInput extends SynthesizeInput {
  /** Attempt a guarded auto-split (default true). `false` forces a single entry. */
  readonly split?: boolean;
  /** Also emit the everything-in-one umbrella entry (default false). */
  readonly umbrella?: boolean;
  /** Clustering strategy (default "auto"). */
  readonly strategy?: ClusterStrategy;
  /** Injected LLM grouper. */
  readonly group?: GroupSkillsFn;
  /** Minimum skill count to attempt a split (default 25). */
  readonly minSkillsToSplit?: number;
  /** Already-parsed marker from a previous synthesis (null = known absent), to skip re-reading. */
  readonly existingMarker?: MarkerFile | null;
  /** Walk/parse caches from a previous synthesis over the same repo. */
  readonly caches?: ScanCaches;
}

/** Shape facts of an emitted split (the notice's data source). */
export interface SplitInfo {
  readonly groupCount: number;
  readonly coreEmitted: boolean;
  readonly umbrellaEmitted: boolean;
}

/** A `.ccpluginizer.json`-shaped freeze of the emitted split (for `--write-marker`). */
export interface MarkerDraft {
  readonly name: string;
  /** The core INTENT (curated or default), not whether a core happened to be emittable this scan. */
  readonly core: boolean;
  readonly umbrella: boolean;
  readonly groups: { readonly slug: string; readonly skills: string[] }[];
}

export interface SynthesizeEntriesResult {
  readonly entries: MarketplaceEntry[];
  /** Non-null exactly when provenance.kind !== "none": the emitted split's shape. */
  readonly split: SplitInfo | null;
  /** Where the grouping came from — or kind "none", carrying the LLM failure detail. */
  readonly provenance: SplitProvenance;
  /** Did partitioning actually run (above threshold, or a frozen marker forced it)? */
  readonly attempted: boolean;
  /** Non-null when a split was emitted; the freezable marker draft. */
  readonly marker: MarkerDraft | null;
  /** The committed marker this scan parsed (so callers never re-read the file). */
  readonly existingMarker: MarkerFile | null;
  /** Advisory messages for the caller to surface (e.g. dropped artifacts, placeholder URLs). */
  readonly warnings: string[];
  /** Walk/parse caches, reusable by a follow-up synthesis (e.g. interactive decline). */
  readonly caches: ScanCaches;
}

/**
 * Default entry point. Attempts a guarded auto-split into core + on-demand skill
 * slices; when the split does not fire (sub-threshold or no clean partition) it
 * returns a single entry byte-identical to {@link synthesizeEntry}.
 */
export async function synthesizeEntries(
  input: SynthesizeEntriesInput,
): Promise<SynthesizeEntriesResult> {
  const wantSplit = input.split ?? true;
  const marker =
    input.existingMarker !== undefined ? input.existingMarker : detectMarkerFile(input.repoRoot);

  // Walk/parse caches and the permission-skip channel are owned here so BOTH the
  // split attempt and the fall-through detection report an incomplete walk. The
  // skip array travels INSIDE the caches, so a follow-up synthesis (interactive
  // decline) re-reports the original skips instead of silently dropping them.
  const caches: ScanCaches = input.caches ?? makeScanCaches();
  const skippedPaths = caches.skippedPaths ?? [];
  const skipWarnings = (): string[] =>
    skippedPaths.length > 0
      ? [
          `${String(skippedPaths.length)} unreadable path(s) were skipped during detection (permission denied), e.g. "${skippedPaths[0] ?? ""}" — the emitted entries may be incomplete.`,
        ]
      : [];

  // A committed marker WITHOUT groups is an explicit single-entry curation — honor
  // it rather than auto-splitting (the single-entry path applies marker.name/skills).
  const attempt =
    wantSplit && (marker === null || !markerSuppressesSplit(marker))
      ? await attemptSplit(input, marker, caches, skipWarnings)
      : null;
  if (attempt !== null && attempt.fulfilled !== null) {
    return attempt.fulfilled;
  }

  // Fall through: a single entry, identical to today. The guard runs here (not at
  // the top) to preserve the abort for non-sliceable already-marketplace repos while
  // still allowing a value-adding re-curation split above.
  checkMarketplaceGuard(input.repoRoot);
  const entries = [synthesizeEntryWithMarker(input, marker, caches)];
  return {
    entries,
    split: null,
    provenance: attempt?.provenance ?? NO_SPLIT,
    attempted: attempt?.attempted ?? false,
    marker: null,
    existingMarker: marker,
    // Computed after the fall-through detection ran, so sniff-time skips count too.
    warnings: [...(attempt?.warnings ?? []), ...skipWarnings()],
    caches,
  };
}

type SplitAttempt =
  /** The split fired; the complete result. */
  | { readonly fulfilled: SynthesizeEntriesResult }
  /** No split: what happened, for the fall-through result. */
  | {
      readonly fulfilled: null;
      readonly attempted: boolean;
      readonly provenance: SplitProvenance;
      readonly warnings: string[];
    };

async function attemptSplit(
  input: SynthesizeEntriesInput,
  marker: MarkerFile | null,
  caches: ScanCaches,
  skipWarnings: () => string[],
): Promise<SplitAttempt> {
  const minSkills = input.minSkillsToSplit ?? DEFAULT_MIN_SKILLS_TO_SPLIT;
  // Two-phase layout: only the skills container is resolved up front; the rest
  // (agents/mcp/pluginRoot/artifacts) resolves after the partition succeeds, so
  // sub-threshold scans never pay for a repo-wide .md parse.
  const resolver = createLayoutResolver(input.repoRoot, caches);
  const none = (attempted: boolean, provenance: SplitProvenance, warnings: string[]): SplitAttempt => ({
    fulfilled: null,
    attempted,
    provenance,
    warnings,
  });

  const frozen = marker !== null && !markerSuppressesSplit(marker);
  const markerGroups = marker?.groups;
  if (resolver.skillsContainer === null) {
    return none(
      false,
      NO_SPLIT,
      frozen
        ? ['.ccpluginizer.json freezes a split, but no skills container was found; ignoring the frozen groups and emitting a single entry.']
        : [],
    );
  }

  const skills = enumerateSkills(resolver.skillsContainer.absDir, resolver.list, resolver.readFrontmatter);
  if (!frozen && skills.length < minSkills) {
    return none(false, NO_SPLIT, []);
  }
  // SKILL.md dirs the container holds but enumeration could not parse would vanish
  // from every slice — the one dropped-content class with no other warning channel.
  // Counted by the same unfiltered child set enumerateSkills walks.
  const unparsed = countSkillMdDirs(resolver.skillsContainer.absDir, resolver.list) - skills.length;
  const unparsedWarnings =
    unparsed > 0
      ? [
          `${String(unparsed)} skill ${unparsed === 1 ? "directory" : "directories"} inside "${resolver.skillsContainer.relPath}" ${unparsed === 1 ? "has" : "have"} missing or invalid SKILL.md frontmatter and ${unparsed === 1 ? "is" : "are"} not covered by any emitted slice; fix the frontmatter so they are detected.`,
        ]
      : [];

  // Below the threshold, only a marker-driven grouping can be honored — skip the
  // LLM step entirely rather than paying for a rescue that would be discarded.
  const onlyMarkerCanWin = frozen && skills.length < minSkills;
  const { groups, provenance, warnings: partitionWarnings } = await partitionSkills(skills, {
    strategy: input.strategy ?? DEFAULT_STRATEGY,
    ...(frozen && markerGroups !== undefined ? { markerGroups } : {}),
    ...(input.group !== undefined ? { group: input.group } : {}),
    ...(onlyMarkerCanWin ? { suppressLlm: true } : {}),
  });
  if (groups === null) {
    // partitionWarnings already explains a voided marker ("ignoring the frozen split").
    return none(!onlyMarkerCanWin, provenance, [...partitionWarnings, ...unparsedWarnings]);
  }
  // A voided marker authorized this attempt but did not win; without it the repo
  // never cleared the min-skills gate — honor the threshold.
  if (onlyMarkerCanWin && provenance.kind !== "marker") {
    return none(false, NO_SPLIT, [...partitionWarnings, ...unparsedWarnings]);
  }

  const layout = resolver.full();
  // A voided marker must not keep steering the split it no longer defines.
  const markerDrives = provenance.kind === "marker";
  const { entries, marker: markerDraft, agentsDropped, coreEmitted } = buildSplitEntries(
    groups,
    layout,
    resolver.skillsContainer,
    input.sourceRepo,
    {
      // Opt-in/additive: an explicit --umbrella OR a marker umbrella:true.
      umbrella: (input.umbrella ?? false) || (markerDrives && (marker?.umbrella ?? false)),
      emitCore: markerDrives ? (marker?.core ?? true) : true,
      ...(markerDrives && marker?.name !== undefined ? { markerName: marker.name } : {}),
    },
  );
  // Re-curating a repo that already publishes a marketplace is deliberate (the
  // split adds value the existing catalog lacks) but must never be silent.
  const recurationWarnings = isAlreadyMarketplace(input.repoRoot)
    ? [
        'this repo already publishes a marketplace (.claude-plugin/marketplace.json); the split re-curates it. Install via `/plugin marketplace add` instead if you just want the existing catalog.',
      ]
    : [];
  return {
    fulfilled: {
      entries,
      split: { groupCount: groups.length, coreEmitted, umbrellaEmitted: markerDraft.umbrella },
      provenance,
      attempted: true,
      marker: markerDraft,
      existingMarker: marker,
      warnings: [
        ...partitionWarnings,
        ...unparsedWarnings,
        ...recurationWarnings,
        ...collectSplitWarnings(layout, input.sourceRepo, coreEmitted, markerDraft.umbrella, agentsDropped),
        ...skipWarnings(),
      ],
      caches,
    },
  };
}

/** Advisory warnings for an emitted split (artifacts the slices/core cannot carry). */
function collectSplitWarnings(
  layout: SourceLayout,
  sourceRepo: string,
  coreEmitted: boolean,
  umbrellaEmitted: boolean,
  agentsDropped: boolean,
): string[] {
  const warnings: string[] = [];

  if (layout.mcp !== null) {
    if (coreEmitted && layout.mcp.serverType === "repo-local") {
      warnings.push(
        `The MCP server in "${layout.mcp.relPath}" references repo-local files; inlined into core it may not resolve at install time. Review its command/args paths, or keep the MCP via --umbrella.`,
      );
    } else if (!coreEmitted && !umbrellaEmitted) {
      warnings.push(
        `The MCP server in "${layout.mcp.relPath}" is not carried by any emitted entry (no core entry was emitted and no umbrella was requested); it will be dropped. Use --umbrella, or a marker with "core": true, to retain it.`,
      );
    }
  }

  // Agents ride along in the core entry; they are dropped when core is absent, or
  // when their container had to be refused as the core root (it would auto-load a
  // skills tree). Either way an umbrella still carries them.
  if (layout.agentsContainer !== null && !umbrellaEmitted) {
    if (agentsDropped) {
      warnings.push(
        `The agents in "${layout.agentsContainer.relPath}" are not carried by the core entry (no safe core root exists — rooting it would auto-load a skills/ tree always-on); they will be dropped. Use --umbrella to retain them.`,
      );
    } else if (!coreEmitted) {
      warnings.push(
        `The agents in "${layout.agentsContainer.relPath}" are not carried by any emitted entry (no core entry was emitted and no umbrella was requested); they will be dropped. Use --umbrella, or a marker with "core": true, to retain them.`,
      );
    }
  }

  // Non-skill artifacts, uniformly enumerated by sourceLayout. The umbrella entry
  // carries the artifacts under its root (explicitly when there is no plugin root).
  const umbrellaRoot = layout.pluginRoot?.relPath ?? ".";
  const underUmbrella = (rel: string): boolean =>
    umbrellaRoot === "." || rel === umbrellaRoot || rel.startsWith(`${umbrellaRoot}/`);
  const carriable = layout.artifacts.filter((a) => underUmbrella(a.relPath));
  const outside = layout.artifacts.filter((a) => !underUmbrella(a.relPath));
  if (!umbrellaEmitted && carriable.length > 0) {
    warnings.push(
      `Split entries do not carry these non-skill artifacts: ${carriable.map((a) => a.kind).join(", ")}. Use --umbrella to retain them, or --no-split for a single entry.`,
    );
  }
  if (outside.length > 0) {
    warnings.push(
      `These non-skill artifacts sit outside the plugin root, so no emitted entry (umbrella included) carries them: ${outside.map((a) => a.kind).join(", ")}. Use --no-split for a single entry.`,
    );
  }

  // Skills living outside the chosen container are invisible to every slice.
  if (layout.skillDirsOutsideContainer > 0 && layout.skillsContainer !== null) {
    const n = layout.skillDirsOutsideContainer;
    warnings.push(
      `${String(n)} skill ${n === 1 ? "directory" : "directories"} outside "${layout.skillsContainer.relPath}" ${n === 1 ? "is" : "are"} not covered by the split; use --no-split for a single entry that detects the whole repo.`,
    );
  }

  if (sourceRepo.startsWith("local/")) {
    warnings.push(
      `Source is a local path; emitted git-subdir URLs are placeholders ("https://github.com/${sourceRepo}.git"). Set the real repository before publishing.`,
    );
  }

  return warnings;
}

export function synthesizeEntry(input: SynthesizeInput): MarketplaceEntry {
  checkMarketplaceGuard(input.repoRoot);
  return synthesizeEntryWithMarker(input, detectMarkerFile(input.repoRoot));
}

/** Internal variant taking the already-parsed marker, so a scan parses it once. */
function synthesizeEntryWithMarker(
  input: SynthesizeInput,
  marker: MarkerFile | null,
  caches?: ScanCaches,
): MarketplaceEntry {
  if (marker !== null) {
    // A freeze-only marker (groups, no component fields) curates the SPLIT, not the
    // single entry: under --no-split or an interactive decline it must not shortcut
    // detection — that would emit a bare {name, source} entry and silently drop every
    // skill. Run detection and overlay the marker's identity metadata instead.
    if (isFreezeOnlyMarker(marker)) {
      return {
        ...synthesizeEntryFromDetection(input, caches),
        name: marker.name,
        ...markerIdentity(marker),
      };
    }
    return buildEntryFromMarker(marker, input.sourceRepo, input.repoRoot);
  }
  return synthesizeEntryFromDetection(input, caches);
}

/**
 * The marker's identity metadata (sans name), shared by the freeze-only overlay and
 * buildEntryFromMarker so a new identity field cannot be applied in one path and
 * silently dropped in the other.
 */
function markerIdentity(marker: MarkerFile): Partial<MarketplaceEntry> {
  return {
    ...(marker.description !== undefined ? { description: marker.description } : {}),
    ...(marker.license !== undefined ? { license: marker.license } : {}),
    ...(marker.homepage !== undefined ? { homepage: marker.homepage } : {}),
    ...(marker.repository !== undefined ? { repository: marker.repository } : {}),
  };
}

function synthesizeEntryFromDetection(input: SynthesizeInput, caches?: ScanCaches): MarketplaceEntry {
  const conventionFindings = detectConventions(input.repoRoot);
  const manifestResult = detectNonStandardManifest(input.repoRoot);
  const sniffFindings = detectContentSniff(input.repoRoot, caches);

  const findings: Finding[] = [...conventionFindings];
  const manifestKindsWithFindings = new Set<ComponentKind>();

  if (manifestResult !== null) {
    addManifestFindings(findings, manifestResult.manifest, manifestKindsWithFindings);
  }

  // Remove convention findings for kinds that have manifest findings
  let mergedFindings = findings.filter((f) => {
    if (f.source === "convention" && manifestKindsWithFindings.has(f.kind)) {
      return false;
    }
    return true;
  });

  // Layer 3 sniff: fill gaps for kinds NOT yet covered by any prior layer
  for (const sniffF of sniffFindings) {
    if (!hasKind(mergedFindings, sniffF.kind)) {
      mergedFindings = [...mergedFindings, sniffF];
    }
  }

  const entry = buildEntryFromFindings(mergedFindings, input.repoRoot, input.sourceRepo);
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
    ...(manifest.author !== undefined
      ? { author: typeof manifest.author === "string" ? { name: manifest.author } : manifest.author }
      : {}),
  };
}

function buildEntryFromMarker(
  marker: MarkerFile,
  sourceRepo: string,
  repoRoot: string,
): MarketplaceEntry {
  const normalizeIfPresent = (paths: readonly string[] | undefined): string[] | undefined => {
    if (paths === undefined) {
      return undefined;
    }
    const { kept } = normalizePathsAgainstRepo(repoRoot, paths);
    return kept.length > 0 ? [...kept] : undefined;
  };

  const skills = normalizeIfPresent(marker.skills);
  const agents = normalizeIfPresent(marker.agents);
  const commands = normalizeIfPresent(marker.commands);
  const outputStyles = normalizeIfPresent(marker.outputStyles);
  const themes = normalizeIfPresent(marker.themes);

  // Note: hooks, mcpServers, monitors are scalar string paths (not arrays),
  // so they are not run through normalizePathsAgainstRepo in v0.1.1.
  return {
    name: marker.name,
    source: makeGithubSource(sourceRepo),
    strict: false,
    ...markerIdentity(marker),
    ...(skills !== undefined ? { skills } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(marker.hooks !== undefined ? { hooks: marker.hooks } : {}),
    ...(marker.mcpServers !== undefined ? { mcpServers: marker.mcpServers } : {}),
    ...(outputStyles !== undefined ? { outputStyles } : {}),
    ...(themes !== undefined ? { themes } : {}),
    ...(marker.monitors !== undefined ? { monitors: marker.monitors } : {}),
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

function hasKind(findings: readonly Finding[], kind: ComponentKind): boolean {
  for (const f of findings) {
    if (f.kind === kind) {
      return true;
    }
  }
  return false;
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

/** The canonical git URL every emitted entry references for a given source repo. */
export function sourceRepoUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function makeGithubSource(repo: string): Source {
  return { source: "url", url: sourceRepoUrl(repo) };
}

function makeGitSubdirSource(repo: string, path: string): Source {
  return { source: "git-subdir", url: sourceRepoUrl(repo), path };
}

function defaultEntryName(sourceRepo: string): string {
  return sourceRepo.replace("/", "-").toLowerCase();
}

// ---------------------------------------------------------------------------
// Marker serialization (round-trips with the parse semantics defined above).
// ---------------------------------------------------------------------------

/**
 * Merge the fresh draft over the existing marker, preserving hand-curated fields.
 * Lives beside MarkerDraft and the `marker.core ?? true` consumer so the
 * serialize/parse semantics stay adjacent; the result is validated against
 * MarkerFileSchema so any drift fails loudly at write time, not on the next scan.
 */
export function serializeMarkerDraft(draft: MarkerDraft, existing: MarkerFile | null): Record<string, unknown> {
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
  // `core` is emitted explicitly even when false: this module reads `marker.core ?? true`,
  // so omitting a false would silently re-enable the core entry on the next scan and a
  // coreless split would not round-trip. `umbrella: false` is omitted (JSON.stringify
  // drops undefined) to keep the file minimal — absence already means false.
  const merged: Record<string, unknown> = {
    ...draft,
    ...(draft.umbrella ? {} : { umbrella: undefined }),
    ...preserved,
  };
  v.parse(MarkerFileSchema, JSON.parse(JSON.stringify(merged)));
  return merged;
}

// ---------------------------------------------------------------------------
// Split emission: core + on-demand skill slices (+ optional umbrella).
// ---------------------------------------------------------------------------

interface SplitOptions {
  readonly umbrella: boolean;
  readonly emitCore: boolean;
  /** Frozen marker name, preferred over the source-derived base when present. */
  readonly markerName?: string;
}

function buildSplitEntries(
  groups: Grouping,
  layout: SourceLayout,
  skillsContainer: ContainerRef,
  sourceRepo: string,
  options: SplitOptions,
): { entries: MarketplaceEntry[]; marker: MarkerDraft; agentsDropped: boolean; coreEmitted: boolean } {
  const base = slugify(options.markerName ?? defaultEntryName(sourceRepo));
  const entries: MarketplaceEntry[] = [];

  // Umbrella first so it reserves the bare base name.
  if (options.umbrella) {
    entries.push(buildUmbrellaEntry(base, groups, layout, skillsContainer, sourceRepo));
  }

  // Core: inline MCP + enumerated agents, rooted at a skills-free container.
  const core = options.emitCore
    ? buildCoreEntry(`${base}-core`, layout, skillsContainer, sourceRepo)
    : { entry: null, agentsDropped: false };
  if (core.entry !== null) {
    entries.push(core.entry);
  }

  // Slug-first naming: disambiguate slugs against the reserved core slug, then derive
  // names from slugs — never slugs back out of formatted names. Keeps the frozen
  // marker decoupled from the `${base}-${slug}` name template.
  const reservedSlugs = core.entry !== null ? ["core"] : [];
  const slugs = uniqueSlugs([...reservedSlugs, ...groups.map((g) => g.slug)]).slice(reservedSlugs.length);
  const markerGroups: { slug: string; skills: string[] }[] = [];
  groups.forEach((group, i) => {
    const slug = slugs[i] ?? group.slug;
    const skills = group.skills.map((s) => s.path);
    markerGroups.push({ slug, skills });
    entries.push({
      name: `${base}-${slug}`,
      source: makeGitSubdirSource(sourceRepo, skillsContainer.relPath),
      strict: false,
      skills,
      ...(core.entry !== null ? { dependencies: [core.entry.name] } : {}),
    });
  });

  return {
    entries,
    // The draft freezes INTENT: emitCore stays true when a core merely was not
    // possible this scan, so a later scan that gains agents/MCP emits one again.
    marker: { name: base, core: options.emitCore, umbrella: options.umbrella, groups: markerGroups },
    agentsDropped: core.agentsDropped,
    coreEmitted: core.entry !== null,
  };
}

/**
 * The everything-in-one entry. With a plugin manifest it is a strict git-subdir at
 * the plugin root. Without one, a bare git-subdir at "." would rely on root-level
 * auto-discovery and install nothing for nested layouts — so carry every detected
 * component explicitly (and stay strict:false, since there is no plugin.json).
 */
function buildUmbrellaEntry(
  base: string,
  groups: Grouping,
  layout: SourceLayout,
  skillsContainer: ContainerRef,
  sourceRepo: string,
): MarketplaceEntry {
  if (layout.pluginRoot !== null) {
    return {
      name: base,
      source: makeGitSubdirSource(sourceRepo, layout.pluginRoot.relPath),
      strict: true,
    };
  }
  const artifact = (kind: string): string | undefined =>
    layout.artifacts.find((a) => a.kind === kind)?.relPath;
  const skills = groups
    .flatMap((g) => g.skills)
    .map((s) => repoRelPath(skillsContainer.relPath, s.path))
    .sort(byCodeUnit);
  const agents = layout.agentsContainer;
  const hooks = artifact("hooks");
  const commands = artifact("commands");
  const outputStyles = artifact("output-styles");
  const themes = artifact("themes");
  const monitors = artifact("monitors");
  return {
    name: base,
    source: makeGitSubdirSource(sourceRepo, "."),
    strict: false,
    ...(skills.length > 0 ? { skills } : {}),
    ...(agents !== null ? { agents: agents.files.map((f) => repoRelPath(agents.relPath, f)) } : {}),
    ...(layout.mcp !== null ? { mcpServers: layout.mcp.servers } : {}),
    ...(hooks !== undefined ? { hooks: `./${hooks}` } : {}),
    ...(commands !== undefined ? { commands: [`./${commands}/`] } : {}),
    ...(outputStyles !== undefined ? { outputStyles: [`./${outputStyles}/`] } : {}),
    ...(themes !== undefined ? { themes: [`./${themes}/`] } : {}),
    ...(monitors !== undefined ? { monitors: `./${monitors}` } : {}),
  };
}

/** Turn a container-relative "./x/" (or bare filename) into a repo-root "./<container>/x/". */
function repoRelPath(containerRel: string, p: string): string {
  const inner = p.startsWith("./") ? p.slice(2) : p;
  return containerRel === "." ? `./${inner}` : `./${containerRel}/${inner}`;
}

/** Core carries the non-skill foundation: inline MCP + agents (zero always-on skills). */
function buildCoreEntry(
  name: string,
  layout: SourceLayout,
  skillsContainer: ContainerRef,
  sourceRepo: string,
): { entry: MarketplaceEntry | null; agentsDropped: boolean } {
  const agents = layout.agentsContainer;
  const mcp = layout.mcp;
  if (agents === null && mcp === null) {
    return { entry: null, agentsDropped: false }; // nothing to share
  }
  // Refuse ANY root with a direct `skills/` child — Claude Code auto-discovers
  // `<root>/skills`, so such a core would load skills always-on and defeat the
  // split. That applies to the agents container and the fallback alike.
  const carriesAgents = agents !== null && !agents.hasSkillsChild;
  const rootPath = carriesAgents
    ? agents.relPath
    : skillsContainer.hasSkillsChild
      ? null
      : skillsContainer.relPath;
  if (rootPath === null || (!carriesAgents && mcp === null)) {
    return { entry: null, agentsDropped: agents !== null };
  }
  return {
    entry: {
      name,
      source: makeGitSubdirSource(sourceRepo, rootPath),
      strict: false,
      ...(carriesAgents ? { agents: agents.files.map((f) => `./${f}`) } : {}),
      ...(mcp !== null ? { mcpServers: mcp.servers } : {}),
    },
    agentsDropped: agents !== null && !carriesAgents,
  };
}
