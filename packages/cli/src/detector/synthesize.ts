import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkMarketplaceGuard } from "./marketplaceGuard.ts";
import { detectMarkerFile } from "./markerFile.ts";
import { detectConventions } from "./conventions.ts";
import { detectNonStandardManifest } from "./nonStandardManifest.ts";
import { detectContentSniff } from "./contentSniff.ts";
import { normalizePathsAgainstRepo } from "./normalize.ts";
import { resolveSourceLayout, type SourceLayout } from "./sourceLayout.ts";
import { enumerateSkills } from "./skillMeta.ts";
import { partitionSkills, type ClusterStrategy, type GroupSkillsFn, type Grouping, type MarkerGroup, type ResolvedStrategy } from "./partition.ts";
import { slugify } from "./slugify.ts";
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

export interface SynthesizeEntriesInput extends SynthesizeInput {
  /** Attempt a guarded auto-split (default true). `false` forces a single entry. */
  readonly split?: boolean;
  /** Also emit the everything-in-one umbrella entry (default false). */
  readonly umbrella?: boolean;
  /** Clustering strategy (default "auto"). */
  readonly strategy?: ClusterStrategy;
  /** Injected (network-using) LLM grouper. */
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
  /** Advisory messages for the caller to surface (e.g. dropped artifacts, placeholder URLs). */
  readonly warnings: string[];
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
  const minSkills = input.minSkillsToSplit ?? DEFAULT_MIN_SKILLS_TO_SPLIT;
  const marker = detectMarkerFile(input.repoRoot);

  // A committed marker WITHOUT groups is an explicit single-entry curation — honor
  // it rather than auto-splitting (the single-entry path applies marker.name/skills).
  const markerSuppressesSplit =
    marker !== null && (marker.groups === undefined || marker.groups.length === 0);

  if (wantSplit && !markerSuppressesSplit) {
    const layout = resolveSourceLayout(input.repoRoot);
    if (layout.skillsContainer !== null) {
      const skills = enumerateSkills(layout.skillsContainer.absDir);
      const markerGroups: readonly MarkerGroup[] | undefined = marker?.groups;
      const attempt = (markerGroups !== undefined && markerGroups.length > 0) || skills.length >= minSkills;
      if (attempt) {
        const result = await partitionSkills(skills, {
          strategy: input.strategy ?? "auto",
          ...(markerGroups !== undefined ? { markerGroups } : {}),
          ...(input.group !== undefined ? { group: input.group } : {}),
        });
        if (result !== null) {
          const { entries, marker: markerDraft } = buildSplitEntries(
            result.groups,
            layout,
            input.sourceRepo,
            {
              // Opt-in/additive: an explicit --umbrella OR a marker umbrella:true.
              umbrella: (input.umbrella ?? false) || (marker?.umbrella ?? false),
              emitCore: marker?.core ?? true,
              ...(marker?.name !== undefined ? { markerName: marker.name } : {}),
            },
          );
          return {
            entries,
            split: { strategy: result.strategy, groupCount: result.groups.length },
            marker: markerDraft,
            warnings: collectSplitWarnings(input.repoRoot, layout, input.sourceRepo, markerDraft.core, markerDraft.umbrella),
          };
        }
      }
    }
  }

  // Fall through: a single entry, identical to today (this also runs the
  // marketplace guard, preserving the abort for non-sliceable plugin repos).
  return { entries: [synthesizeEntry(input)], split: null, marker: null, warnings: [] };
}

/** Advisory warnings for an emitted split (artifacts the slices/core cannot carry). */
function collectSplitWarnings(
  repoRoot: string,
  layout: SourceLayout,
  sourceRepo: string,
  coreEmitted: boolean,
  umbrellaEmitted: boolean,
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

  // Agents ride along in the core entry; if core is disabled and there is no
  // umbrella to carry them, they are dropped — warn, mirroring the MCP-drop case.
  if (layout.agentsContainer !== null && !coreEmitted && !umbrellaEmitted) {
    warnings.push(
      `The agents in "${layout.agentsContainer.relPath}" are not carried by any emitted entry (core is disabled and no umbrella was emitted); they will be dropped. Use --umbrella, or a marker with "core": true, to retain them.`,
    );
  }

  // The umbrella entry is a git-subdir at the plugin root, so it carries every
  // non-skill artifact beneath it — only warn about dropped artifacts when no
  // umbrella was emitted (otherwise the "Use --umbrella to retain them" advice is
  // self-contradictory, since the user already did).
  if (!umbrellaEmitted) {
    const pluginBase = layout.pluginRoot !== null ? join(repoRoot, layout.pluginRoot.relPath) : repoRoot;
    const dropped: string[] = [];
    if (layout.hooks !== null) {
      dropped.push("hooks");
    }
    for (const dir of ["commands", "output-styles", "themes"]) {
      if (existsSync(join(pluginBase, dir))) {
        dropped.push(dir);
      }
    }
    if (existsSync(join(pluginBase, "monitors", "monitors.json")) || existsSync(join(pluginBase, "monitors.json"))) {
      dropped.push("monitors");
    }
    if (dropped.length > 0) {
      warnings.push(
        `Split entries do not carry these non-skill artifacts: ${dropped.join(", ")}. Use --umbrella to retain them, or --no-split for a single entry.`,
      );
    }
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

  const marker = detectMarkerFile(input.repoRoot);
  if (marker !== null) {
    return buildEntryFromMarker(marker, input.sourceRepo, input.repoRoot);
  }

  const conventionFindings = detectConventions(input.repoRoot);
  const manifestResult = detectNonStandardManifest(input.repoRoot);
  const sniffFindings = detectContentSniff(input.repoRoot);

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
  sourceRepo: string,
  options: SplitOptions,
): { entries: MarketplaceEntry[]; marker: MarkerDraft } {
  const base = slugify(options.markerName ?? defaultEntryName(sourceRepo));
  const skillsContainer = layout.skillsContainer;
  if (skillsContainer === null) {
    return {
      entries: [synthesizeEntryFromLayoutless(sourceRepo)],
      marker: { name: base, core: false, umbrella: false, groups: [] },
    };
  }

  const used = new Set<string>();
  const entries: MarketplaceEntry[] = [];

  // Umbrella first so it reserves the bare base name.
  if (options.umbrella) {
    const umbrellaPath = layout.pluginRoot?.relPath ?? ".";
    used.add(base);
    entries.push({
      name: base,
      source: makeGitSubdirSource(sourceRepo, umbrellaPath),
      strict: true,
    });
  }

  // Core: inline MCP + enumerated agents, rooted at a skills-free container.
  const core = options.emitCore ? buildCoreEntry(`${base}-core`, layout, sourceRepo) : null;
  if (core !== null) {
    used.add(core.name);
    entries.push(core);
  }

  // One slice per group, each a git-subdir at the skills container.
  const markerGroups: { slug: string; skills: string[] }[] = [];
  for (const group of groups) {
    const name = uniqueName(used, `${base}-${group.slug}`);
    used.add(name);
    const skills = group.skills.map((s) => s.path);
    markerGroups.push({ slug: name.slice(base.length + 1), skills });
    entries.push({
      name,
      source: makeGitSubdirSource(sourceRepo, skillsContainer.relPath),
      strict: false,
      skills,
      ...(core !== null ? { dependencies: [core.name] } : {}),
    });
  }

  return {
    entries,
    marker: { name: base, core: core !== null, umbrella: options.umbrella, groups: markerGroups },
  };
}

/** Core carries the non-skill foundation: inline MCP + agents (zero always-on skills). */
function buildCoreEntry(
  name: string,
  layout: SourceLayout,
  sourceRepo: string,
): MarketplaceEntry | null {
  const agents = layout.agentsContainer;
  const mcp = layout.mcp;
  if (agents === null && mcp === null) {
    return null; // nothing to share
  }
  // Root at the agents container when present (no plugin.json, no skills/);
  // otherwise the skills container, which has no `skills/` subdir to auto-load.
  const rootPath = agents?.relPath ?? layout.skillsContainer?.relPath ?? ".";
  return {
    name,
    source: makeGitSubdirSource(sourceRepo, rootPath),
    strict: false,
    ...(agents !== null ? { agents: agents.files.map((f) => `./${f}`) } : {}),
    ...(mcp !== null ? { mcpServers: mcp.servers } : {}),
  };
}

function uniqueName(used: ReadonlySet<string>, desired: string): string {
  if (!used.has(desired)) {
    return desired;
  }
  let n = 2;
  while (used.has(`${desired}-${String(n)}`)) {
    n++;
  }
  return `${desired}-${String(n)}`;
}

/** Fallback used only if a split was requested without a resolvable skills container. */
function synthesizeEntryFromLayoutless(sourceRepo: string): MarketplaceEntry {
  return {
    name: defaultEntryName(sourceRepo),
    source: makeGithubSource(sourceRepo),
    strict: false,
  };
}
