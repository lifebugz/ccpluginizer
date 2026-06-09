import { checkMarketplaceGuard } from "./marketplaceGuard.ts";
import { detectMarkerFile, isFreezeOnlyMarker, markerSuppressesSplit } from "./markerFile.ts";
import { detectConventions } from "./conventions.ts";
import { detectNonStandardManifest } from "./nonStandardManifest.ts";
import { detectContentSniff, type SniffCaches } from "./contentSniff.ts";
import { normalizePathsAgainstRepo } from "./normalize.ts";
import { createLayoutResolver, type ContainerRef, type SourceLayout } from "./sourceLayout.ts";
import { enumerateSkills } from "./skillMeta.ts";
import {
  partitionSkills,
  type ClusterStrategy,
  type GroupSkillsFn,
  type Grouping,
  type LlmOutcome,
  type ResolvedStrategy,
} from "./partition.ts";
import { byCodeUnit, slugify, uniqueSlugs } from "./slugify.ts";
import type { Finding, ComponentKind } from "./types.ts";
import type { MarketplaceEntry, Source } from "../schemas/marketplaceEntry.ts";
import type { MarkerFile } from "../schemas/markerFile.ts";
import type { NonStandardManifest } from "../schemas/nonStandardManifest.ts";

export interface SynthesizeInput {
  readonly repoRoot: string;
  readonly sourceRepo: string;
}

/** Default threshold: only attempt a split when a repo has at least this many skills. */
const DEFAULT_MIN_SKILLS_TO_SPLIT = 25;

const LLM_NOT_INVOKED: LlmOutcome = { step: "not-invoked" };

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
}

export interface SplitInfo {
  readonly strategy: ResolvedStrategy;
  readonly groupCount: number;
}

/** A `.ccpluginizer.json`-shaped freeze of the emitted split (for `--write-marker`). */
export interface MarkerDraft {
  readonly name: string;
  readonly core: boolean;
  readonly umbrella: boolean;
  readonly groups: { readonly slug: string; readonly skills: string[] }[];
}

export interface SynthesizeEntriesResult {
  readonly entries: MarketplaceEntry[];
  /** Non-null when a split was emitted; carries the strategy + group count for the notice. */
  readonly split: SplitInfo | null;
  /** Non-null when a split was emitted; the freezable marker draft. */
  readonly marker: MarkerDraft | null;
  /** The committed marker this scan parsed (so callers never re-read the file). */
  readonly existingMarker: MarkerFile | null;
  /** Advisory messages for the caller to surface (e.g. dropped artifacts, placeholder URLs). */
  readonly warnings: string[];
  /** True iff `partitionSkills` was called and returned null (above-threshold, no clean partition). */
  readonly splitAttemptedButEmpty: boolean;
  /** Provenance of the LLM step, reported by the partition orchestrator. */
  readonly llm: LlmOutcome;
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
  const marker = detectMarkerFile(input.repoRoot);

  // A committed marker WITHOUT groups is an explicit single-entry curation — honor
  // it rather than auto-splitting (the single-entry path applies marker.name/skills).
  const attempt =
    wantSplit && (marker === null || !markerSuppressesSplit(marker))
      ? await attemptSplit(input, marker)
      : null;
  const fulfilled = attempt?.fulfilled ?? null;
  if (fulfilled !== null) {
    return fulfilled;
  }

  // Fall through: a single entry, identical to today. The guard runs here (not at
  // the top) to preserve the abort for non-sliceable already-marketplace repos while
  // still allowing a value-adding re-curation split above.
  checkMarketplaceGuard(input.repoRoot);
  return {
    entries: [synthesizeEntryWithMarker(input, marker, attempt?.caches)],
    split: null,
    marker: null,
    existingMarker: marker,
    warnings: attempt?.warnings ?? [],
    splitAttemptedButEmpty: attempt?.attemptedButEmpty ?? false,
    llm: attempt?.llm ?? LLM_NOT_INVOKED,
  };
}

interface SplitAttempt {
  /** Set when the split fired; the complete result. */
  readonly fulfilled: SynthesizeEntriesResult | null;
  /** True when partitionSkills ran and found no acceptable grouping. */
  readonly attemptedButEmpty: boolean;
  readonly llm: LlmOutcome;
  readonly warnings: string[];
  /** Walk/parse caches, reusable by the fall-through detection. */
  readonly caches: SniffCaches;
}

async function attemptSplit(
  input: SynthesizeEntriesInput,
  marker: MarkerFile | null,
): Promise<SplitAttempt> {
  const minSkills = input.minSkillsToSplit ?? DEFAULT_MIN_SKILLS_TO_SPLIT;
  // Two-phase layout: only the skills container is resolved up front; the rest
  // (agents/mcp/pluginRoot/artifacts) resolves after the partition succeeds, so
  // sub-threshold scans never pay for a repo-wide .md parse.
  const resolver = createLayoutResolver(input.repoRoot);
  const caches: SniffCaches = { list: resolver.list, readFrontmatter: resolver.readFrontmatter };
  const none = (attemptedButEmpty: boolean, llm: LlmOutcome, warnings: string[]): SplitAttempt => ({
    fulfilled: null,
    attemptedButEmpty,
    llm,
    warnings,
    caches,
  });

  const markerGroups = marker?.groups;
  const frozen = markerGroups !== undefined && markerGroups.length > 0;
  if (resolver.skillsContainer === null) {
    return none(
      false,
      LLM_NOT_INVOKED,
      frozen
        ? ['.ccpluginizer.json freezes a split, but no skills container was found; ignoring the frozen groups and emitting a single entry.']
        : [],
    );
  }

  const skills = enumerateSkills(resolver.skillsContainer.absDir, resolver.list, resolver.readFrontmatter);
  if (!frozen && skills.length < minSkills) {
    return none(false, LLM_NOT_INVOKED, []);
  }

  const { result, llm } = await partitionSkills(skills, {
    strategy: input.strategy ?? "auto",
    ...(frozen ? { markerGroups } : {}),
    ...(input.group !== undefined ? { group: input.group } : {}),
  });
  if (result === null) {
    return none(
      true,
      llm,
      frozen
        ? ['the committed .ccpluginizer.json "groups" matched no skill directory and no fallback partition was found; emitting a single entry — re-run scan --write-marker to refresh the frozen split.']
        : [],
    );
  }

  const layout = resolver.full();
  const { entries, marker: markerDraft, agentsDropped } = buildSplitEntries(
    result.groups,
    layout,
    resolver.skillsContainer,
    input.sourceRepo,
    {
      // Opt-in/additive: an explicit --umbrella OR a marker umbrella:true.
      umbrella: (input.umbrella ?? false) || (marker?.umbrella ?? false),
      emitCore: marker?.core ?? true,
      ...(marker?.name !== undefined ? { markerName: marker.name } : {}),
    },
  );
  return {
    fulfilled: {
      entries,
      split: { strategy: result.strategy, groupCount: result.groups.length },
      marker: markerDraft,
      existingMarker: marker,
      warnings: [
        ...(result.warnings ?? []),
        ...collectSplitWarnings(layout, input.sourceRepo, markerDraft.core, markerDraft.umbrella, agentsDropped),
      ],
      splitAttemptedButEmpty: false,
      llm,
    },
    attemptedButEmpty: false,
    llm,
    warnings: [],
    caches,
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
        `The MCP server in "${layout.mcp.relPath}" is not carried by any emitted entry (core is disabled and no umbrella was emitted); it will be dropped. Use --umbrella, or a marker with "core": true, to retain it.`,
      );
    }
  }

  // Agents ride along in the core entry; they are dropped when core is absent, or
  // when their container had to be refused as the core root (it would auto-load a
  // skills tree). Either way an umbrella still carries them.
  if (layout.agentsContainer !== null && !umbrellaEmitted) {
    if (agentsDropped) {
      warnings.push(
        `The agents in "${layout.agentsContainer.relPath}" are not carried by the core entry (rooting core at their container would auto-load its skills/ tree always-on); they will be dropped. Use --umbrella to retain them.`,
      );
    } else if (!coreEmitted) {
      warnings.push(
        `The agents in "${layout.agentsContainer.relPath}" are not carried by any emitted entry (core is disabled and no umbrella was emitted); they will be dropped. Use --umbrella, or a marker with "core": true, to retain them.`,
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
  caches?: SniffCaches,
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
        ...(marker.description !== undefined ? { description: marker.description } : {}),
        ...(marker.license !== undefined ? { license: marker.license } : {}),
        ...(marker.homepage !== undefined ? { homepage: marker.homepage } : {}),
        ...(marker.repository !== undefined ? { repository: marker.repository } : {}),
      };
    }
    return buildEntryFromMarker(marker, input.sourceRepo, input.repoRoot);
  }
  return synthesizeEntryFromDetection(input, caches);
}

function synthesizeEntryFromDetection(input: SynthesizeInput, caches?: SniffCaches): MarketplaceEntry {
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
    ...(marker.description !== undefined ? { description: marker.description } : {}),
    ...(marker.license !== undefined ? { license: marker.license } : {}),
    ...(marker.homepage !== undefined ? { homepage: marker.homepage } : {}),
    ...(marker.repository !== undefined ? { repository: marker.repository } : {}),
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

function makeGithubSource(repo: string): Source {
  return { source: "url", url: `https://github.com/${repo}.git` };
}

function makeGitSubdirSource(repo: string, path: string): Source {
  return { source: "git-subdir", url: `https://github.com/${repo}.git`, path };
}

function defaultEntryName(sourceRepo: string): string {
  return sourceRepo.replace("/", "-").toLowerCase();
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
): { entries: MarketplaceEntry[]; marker: MarkerDraft; agentsDropped: boolean } {
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
    marker: { name: base, core: core.entry !== null, umbrella: options.umbrella, groups: markerGroups },
    agentsDropped: core.agentsDropped,
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
  // Refuse an agents root with ANY direct `skills/` child: Claude Code auto-discovers
  // `<root>/skills`, so such a core would load skills always-on and defeat the split —
  // whether or not that child happens to be the chosen container.
  const carriesAgents = agents !== null && !agents.hasSkillsChild;
  // Root at the agents container when safe; otherwise the skills container, which
  // has no `skills/` subdir to auto-load.
  const rootPath = carriesAgents ? agents.relPath : skillsContainer.relPath;
  if (!carriesAgents && mcp === null) {
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
