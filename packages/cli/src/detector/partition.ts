import { basename } from "node:path";
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

export const DEFAULT_STRATEGY: ClusterStrategy = "auto";

/** Does this strategy ever consult the injected LLM grouper? */
export function strategyUsesLlm(strategy: ClusterStrategy): boolean {
  return strategy === "llm" || strategy === "auto-llm";
}
export type DeterministicStrategy = "metadata" | "directory" | "name-prefix";

export type BackendKind = "subprocess" | "claude";

/** One invocation of a resolved LLM backend: its identity plus its raw groups. */
export interface GrouperRun {
  readonly kind: BackendKind;
  readonly groups: RawGroup[];
  /** Invoked by the orchestrator when the grouping passes the gate (e.g. to commit a cache write). */
  readonly commit?: () => void;
}

/** Injected LLM grouper; resolves its backend lazily — null means none was found. */
export type GroupSkillsFn = (skills: readonly SkillMeta[]) => Promise<GrouperRun | null>;

/** How the LLM step failed, when it ran and lost. */
export type LlmFailure =
  | { readonly step: "no-backend" }
  | { readonly step: "errored" }
  | { readonly step: "no-output"; readonly backend: BackendKind }
  | { readonly step: "gate-rejected"; readonly backend: BackendKind };

/**
 * The single provenance fact for an outcome — owned here, where every step runs, so
 * notices pattern-match reported facts instead of re-deriving them from field pairs.
 */
export type SplitProvenance =
  | { readonly kind: "skipped" }
  | { readonly kind: "marker" }
  | { readonly kind: "llm"; readonly backend: BackendKind }
  | { readonly kind: "deterministic"; readonly strategy: DeterministicStrategy; readonly llmFailure?: LlmFailure }
  | { readonly kind: "none"; readonly llmFailure?: LlmFailure };

export interface PartitionOutcome {
  /** Non-null exactly when provenance.kind !== "none". */
  readonly groups: Grouping | null;
  readonly provenance: SplitProvenance;
  /** Advisory messages (e.g. stale committed-marker paths) — surfaced even when groups is null. */
  readonly warnings: readonly string[];
}

/** A frozen group from a committed marker file: skill *paths* (e.g. "./foo/"). */
export interface MarkerGroup {
  readonly slug: string;
  readonly skills: readonly string[];
}

export interface PartitionOptions {
  readonly strategy?: ClusterStrategy;
  readonly markerGroups?: readonly MarkerGroup[];
  readonly group?: GroupSkillsFn;
  /**
   * Only a marker-driven grouping may be honored (the caller's threshold was not
   * met on its own): a voided marker returns no result instead of cascading, and
   * the LLM step is never consulted.
   */
  readonly markerMandatory?: boolean;
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

// Memoized per skills array: the cascade runs directory and name-prefix back to
// back over the same array, and the prefix-strip is identical for both.
const strippedCache = new WeakMap<readonly SkillMeta[], string[]>();

/** Build a `dir -> key` resolver after stripping the global common prefix from dir names. */
function strippedKeyResolver(
  skills: readonly SkillMeta[],
  keyFromStripped: (stripped: string) => string,
): (s: SkillMeta) => string {
  let stripped = strippedCache.get(skills);
  if (stripped === undefined) {
    stripped = stripCommonPrefix(skills.map((s) => s.dir));
    strippedCache.set(skills, stripped);
  }
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

/** The shared gate bounds: K within [MIN_K, MAX_K] and no group above the size cap. */
function passesGateBounds(groups: readonly { skills: readonly SkillMeta[] }[], total: number): boolean {
  return (
    groups.length >= MIN_K &&
    groups.length <= MAX_K &&
    !groups.some((g) => g.skills.length > MAX_FRACTION * total)
  );
}

function normalizeAndGate(rawByKey: Map<string, SkillMeta[]>, total: number): Grouping | null {
  let groups: KeyedBucket[] = [...rawByKey].map(([key, skills]) => ({ key, skills }));
  if (groups.length === 0) {
    return null;
  }
  groups = collapseToFit(groups, MAX_K);
  groups = coalesceTiny(groups, MIN_GROUP_SIZE);
  if (!passesGateBounds(groups, total)) {
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

/** Fold `extra` into an existing misc bucket, or append a fresh one. */
function appendToMisc(keep: readonly KeyedBucket[], extra: SkillMeta[]): KeyedBucket[] {
  const existingMisc = keep.find((g) => g.key === MISC);
  if (existingMisc !== undefined) {
    existingMisc.skills.push(...extra);
    return [...keep];
  }
  return [...keep, { key: MISC, skills: extra }];
}

/** Precondition: groups.length > maxK (only called from collapseToFit's tail). */
function mergeSmallestIntoMisc(groups: readonly KeyedBucket[], maxK: number): KeyedBucket[] {
  const sorted = [...groups].sort(
    (a, b) => a.skills.length - b.skills.length || byCodeUnit(a.key, b.key),
  );
  const removeCount = groups.length - maxK + 1;
  const toMerge = sorted.slice(0, removeCount);
  const keep = sorted.slice(removeCount);
  return appendToMisc(keep, toMerge.flatMap((g) => g.skills));
}

function coalesceTiny(groups: readonly KeyedBucket[], minSize: number): KeyedBucket[] {
  const tiny = groups.filter((g) => g.skills.length < minSize);
  if (tiny.length === 0) {
    return [...groups];
  }
  const big = groups.filter((g) => g.skills.length >= minSize);
  return appendToMisc(big, tiny.flatMap((g) => g.skills));
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
// Verbatim acceptance (llm): no collapse — K bounds, disjoint, total cover.
// ---------------------------------------------------------------------------

function acceptRawGroups(groups: readonly SkillGroup[], total: number): Grouping | null {
  if (!passesGateBounds(groups, total)) {
    return null;
  }
  const covered = groups.flatMap((g) => g.skills.map((s) => s.dir));
  if (new Set(covered).size !== covered.length) {
    return null; // not disjoint
  }
  if (covered.length !== total) {
    return null; // not total cover
  }
  return finalizeGroups(groups);
}

/**
 * Map schema-validated raw buckets onto SkillMeta groups. Hallucinated members are
 * dropped; duplicated members flow through untouched so acceptRawGroups' disjointness
 * check — not a silent rewrite — decides the grouping's fate.
 */
function mapRawGroups(skills: readonly SkillMeta[], raw: readonly RawGroup[]): SkillGroup[] {
  const byDir = new Map(skills.map((s) => [s.dir, s]));
  const out: SkillGroup[] = [];
  for (const item of raw) {
    const gs = item.members
      .map((m) => byDir.get(m))
      .filter((s): s is SkillMeta => s !== undefined);
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

/** The single gate pipeline, shared by acceptance and the backends' cache predicate. */
function gateRaw(skills: readonly SkillMeta[], raw: readonly RawGroup[]): Grouping | null {
  return acceptRawGroups(mapRawGroups(skills, raw), skills.length);
}

interface MarkerMatch {
  /** Matched groups only (unfinalized, no misc bucket). */
  readonly groups: SkillGroup[];
  /** Marker paths that resolved to no skill directory. */
  readonly unmatched: string[];
  /** Marker paths whose skill was already claimed by an earlier group (first wins). */
  readonly duplicates: string[];
  /** Marker paths resolved only by their final segment (exact path did not match). */
  readonly fuzzyMatched: string[];
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
  const duplicates: string[] = [];
  const fuzzyMatched: string[] = [];
  for (const mg of markerGroups) {
    const gs: SkillMeta[] = [];
    for (const p of mg.skills) {
      const norm = normalizePath(p);
      const exact = byPath.get(norm);
      const s = exact ?? byDir.get(basename(norm));
      if (s === undefined) {
        unmatched.push(p);
        continue;
      }
      if (exact === undefined) {
        fuzzyMatched.push(p); // resolved by directory name only — surfaced as a warning
      }
      if (assigned.has(s.dir)) {
        duplicates.push(p);
        continue;
      }
      gs.push(s);
      assigned.add(s.dir);
    }
    if (gs.length > 0) {
      out.push({ slug: slugify(mg.slug), skills: gs });
    }
  }
  return { groups: out, unmatched, duplicates, fuzzyMatched, leftover: skills.filter((s) => !assigned.has(s.dir)) };
}

/** First three items, with an ellipsis when more were elided. */
function preview(items: readonly string[]): string {
  return items.slice(0, 3).join(", ") + (items.length > 3 ? ", …" : "");
}

function normalizePath(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
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
): { strategy: DeterministicStrategy; groups: Grouping } | null {
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
): Promise<PartitionOutcome> {
  const strategy = options.strategy ?? DEFAULT_STRATEGY;
  const warnings: string[] = [];
  let llmFailure: LlmFailure | undefined;
  const deterministic = (
    d: { strategy: DeterministicStrategy; groups: Grouping } | null,
  ): PartitionOutcome =>
    d === null
      ? { groups: null, provenance: { kind: "none", ...(llmFailure !== undefined ? { llmFailure } : {}) }, warnings }
      : {
          groups: d.groups,
          provenance: { kind: "deterministic", strategy: d.strategy, ...(llmFailure !== undefined ? { llmFailure } : {}) },
          warnings,
        };

  // A committed marker grouping wins verbatim — but only when it actually matches.
  if (options.markerGroups !== undefined && options.markerGroups.length > 0) {
    const { groups: matched, unmatched, duplicates, fuzzyMatched, leftover } = matchMarkerGroups(skills, options.markerGroups);
    if (matched.length === 0) {
      // Fully stale marker: honoring it would emit a single bogus "misc" slice
      // announced as "via committed marker" — ignore it and fall through to the
      // requested strategy instead. When only the marker could have been honored
      // (caller below its threshold), stop here: no cascade, no LLM.
      warnings.push(
        `no path in .ccpluginizer.json "groups" matched a skill directory (expected paths like "./<skill-dir>/"); ignoring the frozen split — re-run scan --write-marker to refresh it.`,
      );
      if (options.markerMandatory === true) {
        return { groups: null, provenance: { kind: "none" }, warnings };
      }
    } else {
      if (unmatched.length > 0) {
        warnings.push(
          `${String(unmatched.length)} path(s) in .ccpluginizer.json "groups" match no skill directory (${preview(unmatched)}); re-run scan --write-marker to refresh the frozen split.`,
        );
      }
      if (fuzzyMatched.length > 0) {
        warnings.push(
          `${String(fuzzyMatched.length)} path(s) in .ccpluginizer.json "groups" matched a skill by directory name only (${preview(fuzzyMatched)}); update the marker paths or re-run scan --write-marker.`,
        );
      }
      if (duplicates.length > 0) {
        warnings.push(
          `${String(duplicates.length)} path(s) in .ccpluginizer.json "groups" appear in more than one group; the first occurrence wins (${preview(duplicates)}) — fix the marker or re-run scan --write-marker.`,
        );
      }
      let groups = matched;
      if (leftover.length > 0) {
        warnings.push(
          `${String(leftover.length)} skill(s) not listed in .ccpluginizer.json "groups" were placed in a "${MISC}" slice; re-run scan --write-marker to refresh the frozen split.`,
        );
        groups = [...matched, { slug: MISC, skills: leftover }];
      }
      return { groups: finalizeGroups(groups), provenance: { kind: "marker" }, warnings };
    }
  }

  const runLlm = async (): Promise<{ backend: BackendKind; groups: Grouping } | null> => {
    if (options.group === undefined) {
      llmFailure = { step: "no-backend" };
      return null;
    }
    let run;
    try {
      run = await options.group(skills);
    } catch {
      // A rejecting BYO grouper must cascade to the deterministic fallback, not
      // abort the scan — the seam accepts arbitrary functions.
      llmFailure = { step: "errored" };
      return null;
    }
    if (run === null) {
      llmFailure = { step: "no-backend" };
      return null;
    }
    const raw = validRawItems(run.groups);
    if (raw.length === 0) {
      llmFailure = { step: "no-output", backend: run.kind };
      return null;
    }
    const gated = gateRaw(skills, raw);
    if (gated === null) {
      llmFailure = { step: "gate-rejected", backend: run.kind };
      return null;
    }
    run.commit?.();
    return { backend: run.kind, groups: gated };
  };

  if (strategy === "auto") {
    return deterministic(deterministicCascade(skills));
  }

  if (strategy === "llm") {
    const won = await runLlm();
    if (won !== null) {
      return { groups: won.groups, provenance: { kind: "llm", backend: won.backend }, warnings };
    }
    return deterministic(deterministicCascade(skills));
  }

  if (strategy === "auto-llm") {
    const d = deterministicCascade(skills);
    if (d !== null) {
      return deterministic(d);
    }
    const won = await runLlm();
    if (won !== null) {
      return { groups: won.groups, provenance: { kind: "llm", backend: won.backend }, warnings };
    }
    return deterministic(null);
  }

  const groups = deterministicFns[strategy](skills);
  return deterministic(groups === null ? null : { strategy, groups });
}
