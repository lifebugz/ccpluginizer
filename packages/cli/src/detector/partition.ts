import * as v from "valibot";
import { byCodeUnit, slugify, stripCommonPrefix, uniqueSlugs } from "./slugify.ts";
import { RawGroupSchema, type RawGroup } from "../schemas/rawGroups.ts";
import type { SkillMeta } from "./skillMeta.ts";

export interface SkillGroup {
  readonly slug: string;
  readonly skills: SkillMeta[];
}
export type Grouping = SkillGroup[];

/**
 * Strategies a caller may request (single source of truth for the flag validator).
 * - `auto` (default): deterministic-only cascade (metadata → directory → name-prefix); the injected grouper is never invoked.
 * - `auto-llm`: deterministic-first; the injected grouper rescues only when deterministic finds no clean partition.
 * - `llm`: prefer the injected grouper, then cascade to deterministic if it yields nothing acceptable.
 */
export const CLUSTER_STRATEGIES = ["auto", "auto-llm", "llm", "metadata", "directory", "name-prefix"] as const;
export type ClusterStrategy = (typeof CLUSTER_STRATEGIES)[number];
/** Strategy actually used to produce a result. */
export type ResolvedStrategy = "marker" | "llm" | "metadata" | "directory" | "name-prefix";

export interface PartitionResult {
  readonly strategy: ResolvedStrategy;
  readonly groups: Grouping;
  /** Advisory messages (e.g. stale committed-marker paths) for the caller to surface. */
  readonly warnings?: readonly string[];
}

/** Injected LLM grouper — returns slugged buckets of skill dir names. */
export type GroupSkillsFn = (skills: readonly SkillMeta[]) => Promise<RawGroup[]>;

/** A frozen group from a committed marker file: skill *paths* (e.g. "./foo/"). */
export interface MarkerGroup {
  readonly slug: string;
  readonly skills: readonly string[];
}

export interface PartitionOptions {
  readonly strategy?: ClusterStrategy;
  readonly markerGroups?: readonly MarkerGroup[];
  readonly group?: GroupSkillsFn;
}

// Acceptance gate constants.
const MIN_K = 2;
const MAX_K = 12;
const MAX_FRACTION = 0.7;
const MIN_GROUP_SIZE = 3;
const MISC = "misc";

const LANGUAGES = new Set([
  "curl", "go", "golang", "java", "javascript", "js", "node", "nodejs", "typescript", "ts",
  "python", "py", "ruby", "rb", "php", "csharp", "dotnet", "cs", "rust", "rs", "kotlin", "swift",
  "bash", "shell", "sh", "cpp", "c",
]);

// ---------------------------------------------------------------------------
// Deterministic strategies (pure, sync). Each returns a gated Grouping or null.
// ---------------------------------------------------------------------------

export function partitionByMetadata(skills: readonly SkillMeta[]): Grouping | null {
  if (!skills.some((s) => s.product !== undefined)) {
    return null;
  }
  const byKey = groupByKey(skills, (s) => s.product ?? MISC);
  return normalizeAndGate(byKey, skills.length);
}

export function partitionByNamePrefix(skills: readonly SkillMeta[]): Grouping | null {
  const keyOf = strippedKeyResolver(skills, (name) => dropTrailingLanguage(name));
  return normalizeAndGate(groupByKey(skills, keyOf), skills.length);
}

export function partitionByDirectory(skills: readonly SkillMeta[]): Grouping | null {
  const keyOf = strippedKeyResolver(skills, (name) => name.split("-")[0] ?? name);
  return normalizeAndGate(groupByKey(skills, keyOf), skills.length);
}

/** Build a `dir -> key` resolver after stripping the global common prefix from dir names. */
function strippedKeyResolver(
  skills: readonly SkillMeta[],
  keyFromStripped: (stripped: string) => string,
): (s: SkillMeta) => string {
  const dirs = skills.map((s) => s.dir);
  const stripped = stripCommonPrefix(dirs);
  const keyByDir = new Map<string, string>();
  skills.forEach((s, i) => {
    const name = stripped[i] ?? s.dir;
    const key = keyFromStripped(name);
    keyByDir.set(s.dir, key === "" ? name : key);
  });
  return (s) => keyByDir.get(s.dir) ?? s.dir;
}

function dropTrailingLanguage(name: string): string {
  const parts = name.split("-");
  if (parts.length > 1 && LANGUAGES.has(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }
  return parts.join("-");
}

// ---------------------------------------------------------------------------
// Gate + normalization
// ---------------------------------------------------------------------------

interface KeyedBucket {
  key: string;
  skills: SkillMeta[];
}

function groupByKey(
  skills: readonly SkillMeta[],
  keyOf: (s: SkillMeta) => string,
): Map<string, SkillMeta[]> {
  const m = new Map<string, SkillMeta[]>();
  for (const s of skills) {
    const k = keyOf(s);
    const list = m.get(k) ?? [];
    list.push(s);
    m.set(k, list);
  }
  return m;
}

function normalizeAndGate(rawByKey: Map<string, SkillMeta[]>, total: number): Grouping | null {
  let groups: KeyedBucket[] = [...rawByKey].map(([key, skills]) => ({ key, skills }));
  if (groups.length === 0) {
    return null;
  }
  groups = collapseToFit(groups, MAX_K);
  groups = coalesceTiny(groups, MIN_GROUP_SIZE);
  if (groups.length < MIN_K || groups.length > MAX_K) {
    return null;
  }
  if (groups.some((g) => g.skills.length > MAX_FRACTION * total)) {
    return null;
  }
  return finalizeGroups(groups.map((g) => ({ slug: slugify(g.key), skills: g.skills })));
}

function collapseToFit(groups: KeyedBucket[], maxK: number): KeyedBucket[] {
  if (groups.length <= maxK) {
    return groups;
  }
  const collapsed = collapseByLeadingSegment(groups);
  if (collapsed.length <= maxK) {
    return collapsed;
  }
  return mergeSmallestIntoMisc(collapsed, maxK);
}

function collapseByLeadingSegment(groups: readonly KeyedBucket[]): KeyedBucket[] {
  const m = new Map<string, SkillMeta[]>();
  for (const g of groups) {
    const lead = g.key.split("-")[0] ?? g.key;
    const list = m.get(lead) ?? [];
    list.push(...g.skills);
    m.set(lead, list);
  }
  return [...m].map(([key, skills]) => ({ key, skills }));
}

function mergeSmallestIntoMisc(groups: readonly KeyedBucket[], maxK: number): KeyedBucket[] {
  if (groups.length <= maxK) {
    return [...groups];
  }
  const sorted = [...groups].sort(
    (a, b) => a.skills.length - b.skills.length || byCodeUnit(a.key, b.key),
  );
  const removeCount = groups.length - maxK + 1;
  const toMerge = sorted.slice(0, removeCount);
  const keep = sorted.slice(removeCount);
  const miscSkills = toMerge.flatMap((g) => g.skills);
  const existingMisc = keep.find((g) => g.key === MISC);
  if (existingMisc !== undefined) {
    existingMisc.skills.push(...miscSkills);
    return keep;
  }
  return [...keep, { key: MISC, skills: miscSkills }];
}

function coalesceTiny(groups: readonly KeyedBucket[], minSize: number): KeyedBucket[] {
  const big = groups.filter((g) => g.skills.length >= minSize);
  const tiny = groups.filter((g) => g.skills.length < minSize);
  if (tiny.length === 0) {
    return [...groups];
  }
  const miscSkills = tiny.flatMap((g) => g.skills);
  const existingMisc = big.find((g) => g.key === MISC);
  if (existingMisc !== undefined) {
    existingMisc.skills.push(...miscSkills);
    return big;
  }
  return [...big, { key: MISC, skills: miscSkills }];
}

function finalizeGroups(groups: readonly { slug: string; skills: SkillMeta[] }[]): Grouping {
  const slugs = uniqueSlugs(groups.map((g) => g.slug));
  return groups
    .map((g, i) => ({
      slug: slugs[i] ?? g.slug,
      skills: [...g.skills].sort((a, b) => byCodeUnit(a.dir, b.dir)),
    }))
    .sort((a, b) => byCodeUnit(a.slug, b.slug));
}

// ---------------------------------------------------------------------------
// Verbatim acceptance (marker / llm): no collapse, but disjoint + total cover.
// ---------------------------------------------------------------------------

function acceptRawGroups(groups: readonly SkillGroup[], total: number): Grouping | null {
  if (groups.length < MIN_K || groups.length > MAX_K) {
    return null;
  }
  const covered = groups.flatMap((g) => g.skills.map((s) => s.dir));
  if (new Set(covered).size !== covered.length) {
    return null; // not disjoint
  }
  if (covered.length !== total) {
    return null; // not total cover
  }
  if (groups.some((g) => g.skills.length > MAX_FRACTION * total)) {
    return null;
  }
  return finalizeGroups(groups);
}

/** Map schema-validated raw buckets onto SkillMeta groups, dropping hallucinated/duplicate members. */
function mapRawGroups(skills: readonly SkillMeta[], raw: readonly RawGroup[]): SkillGroup[] {
  const byDir = new Map(skills.map((s) => [s.dir, s]));
  const assigned = new Set<string>();
  const out: SkillGroup[] = [];
  for (const item of raw) {
    const gs: SkillMeta[] = [];
    for (const m of item.members) {
      const s = byDir.get(m);
      if (s !== undefined && !assigned.has(s.dir)) {
        gs.push(s);
        assigned.add(s.dir);
      }
    }
    if (gs.length > 0) {
      out.push({ slug: slugify(item.slug), skills: gs });
    }
  }
  return out;
}

/** Keep only items matching the shared RawGroup schema — the injected-fn seam is untrusted. */
function validRawItems(raw: readonly unknown[]): RawGroup[] {
  return raw.filter((g): g is RawGroup => v.safeParse(RawGroupSchema, g).success);
}

/**
 * Would this raw grouping pass the verbatim acceptance gate? Backends use this to
 * avoid caching a parseable-but-rejected response, which would otherwise be replayed
 * from cache forever and permanently disable the LLM rescue for that skill set.
 */
export function rawGroupsAcceptable(skills: readonly SkillMeta[], raw: readonly RawGroup[]): boolean {
  return acceptRawGroups(mapRawGroups(skills, validRawItems(raw)), skills.length) !== null;
}

interface MarkerMatch {
  /** Matched groups only (unfinalized, no misc bucket). */
  readonly groups: SkillGroup[];
  /** Marker paths that resolved to no skill directory. */
  readonly unmatched: string[];
  /** Skills the marker does not mention. */
  readonly leftover: SkillMeta[];
}

function matchMarkerGroups(
  skills: readonly SkillMeta[],
  markerGroups: readonly MarkerGroup[],
): MarkerMatch {
  const byPath = new Map(skills.map((s) => [normalizePath(s.path), s]));
  // Second-chance lookup by final path segment: --write-marker emits container-relative
  // paths ("./<dir>/"), but hand-edited markers often use repo-root-relative paths like
  // the sibling `skills` field — the directory name resolves either convention.
  const byDir = new Map(skills.map((s) => [s.dir, s]));
  const assigned = new Set<string>();
  const out: SkillGroup[] = [];
  const unmatched: string[] = [];
  for (const mg of markerGroups) {
    const gs: SkillMeta[] = [];
    for (const p of mg.skills) {
      const norm = normalizePath(p);
      const s = byPath.get(norm) ?? byDir.get(lastSegment(norm));
      if (s === undefined) {
        unmatched.push(p);
        continue;
      }
      if (!assigned.has(s.dir)) {
        gs.push(s);
        assigned.add(s.dir);
      }
    }
    if (gs.length > 0) {
      out.push({ slug: slugify(mg.slug), skills: gs });
    }
  }
  return { groups: out, unmatched, leftover: skills.filter((s) => !assigned.has(s.dir)) };
}

function normalizePath(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

function lastSegment(p: string): string {
  const parts = p.split("/").filter((seg) => seg !== "" && seg !== ".");
  return parts[parts.length - 1] ?? p;
}

// ---------------------------------------------------------------------------
// Deterministic cascade (shared by `auto`, `auto-llm`, and the `llm` fallback).
// ---------------------------------------------------------------------------

const deterministicFns: Record<
  "metadata" | "directory" | "name-prefix",
  (skills: readonly SkillMeta[]) => Grouping | null
> = {
  metadata: partitionByMetadata,
  directory: partitionByDirectory,
  "name-prefix": partitionByNamePrefix,
};

/** Try metadata → directory → name-prefix; return the first gated grouping (tagged), else null. */
function deterministicCascade(
  skills: readonly SkillMeta[],
): { strategy: ResolvedStrategy; groups: Grouping } | null {
  for (const name of ["metadata", "directory", "name-prefix"] as const) {
    const groups = deterministicFns[name](skills);
    if (groups !== null) {
      return { strategy: name, groups };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function partitionSkills(
  skills: readonly SkillMeta[],
  options: PartitionOptions = {},
): Promise<PartitionResult | null> {
  const strategy = options.strategy ?? "auto";
  const warnings: string[] = [];
  const withWarnings = (r: PartitionResult | null): PartitionResult | null =>
    r === null || warnings.length === 0 ? r : { ...r, warnings: [...(r.warnings ?? []), ...warnings] };

  // A committed marker grouping wins verbatim — but only when it actually matches.
  if (options.markerGroups !== undefined && options.markerGroups.length > 0) {
    const { groups: matched, unmatched, leftover } = matchMarkerGroups(skills, options.markerGroups);
    if (matched.length === 0) {
      // Fully stale marker: honoring it would emit a single bogus "misc" slice
      // announced as "via committed marker" — ignore it and fall through to the
      // requested strategy instead.
      warnings.push(
        `no path in .ccpluginizer.json "groups" matched a skill directory (expected paths like "./<skill-dir>/"); ignoring the frozen split — re-run scan --write-marker to refresh it.`,
      );
    } else {
      if (unmatched.length > 0) {
        const preview = unmatched.slice(0, 3).join(", ") + (unmatched.length > 3 ? ", …" : "");
        warnings.push(
          `${String(unmatched.length)} path(s) in .ccpluginizer.json "groups" match no skill directory (${preview}); re-run scan --write-marker to refresh the frozen split.`,
        );
      }
      let groups = matched;
      if (leftover.length > 0) {
        warnings.push(
          `${String(leftover.length)} skill(s) not listed in .ccpluginizer.json "groups" were placed in a "${MISC}" slice; re-run scan --write-marker to refresh the frozen split.`,
        );
        groups = [...matched, { slug: MISC, skills: leftover }];
      }
      return withWarnings({ strategy: "marker", groups: finalizeGroups(groups) });
    }
  }

  const runLlm = async (): Promise<Grouping | null> => {
    if (options.group === undefined) {
      return null;
    }
    const raw = validRawItems(await options.group(skills));
    return acceptRawGroups(mapRawGroups(skills, raw), skills.length);
  };

  if (strategy === "auto") {
    return withWarnings(deterministicCascade(skills));
  }

  if (strategy === "llm") {
    const llm = await runLlm();
    if (llm !== null) {
      return withWarnings({ strategy: "llm", groups: llm });
    }
    return withWarnings(deterministicCascade(skills));
  }

  if (strategy === "auto-llm") {
    const deterministic = deterministicCascade(skills);
    if (deterministic !== null) {
      return withWarnings(deterministic);
    }
    const llm = await runLlm();
    return llm === null ? null : withWarnings({ strategy: "llm", groups: llm });
  }

  const groups = deterministicFns[strategy](skills);
  return groups === null ? null : withWarnings({ strategy, groups });
}
