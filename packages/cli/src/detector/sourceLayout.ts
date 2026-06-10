import { basename, join, relative, sep } from "node:path";
import {
  dirContainsDir,
  dirContainsFile,
  makeDirLister,
  readJsonFile,
  walkTree,
  type DirLister,
} from "./fsWalk.ts";
import { isAgentFile, makeFrontmatterReader, type FrontmatterReader } from "./frontmatterIo.ts";
import { ARTIFACT_DIR_FOLDERS, ARTIFACT_JSON_KINDS } from "./conventions.ts";
import { byCodeUnit } from "./slugify.ts";
import { countSkillMdDirs } from "./skillMeta.ts";
import { realpathSync } from "node:fs";
import type { ScanCaches } from "./caches.ts";

export interface ContainerRef {
  readonly absDir: string;
  /** Repo-relative path with forward slashes and no leading "./" — a git-subdir `path`. */
  readonly relPath: string;
  /** True when the dir has a direct `skills/` child — Claude Code would auto-load it, so it is unsafe as a core root. */
  readonly hasSkillsChild: boolean;
}

export interface AgentsRef extends ContainerRef {
  /** Agent `.md` filenames directly inside the container, sorted. */
  readonly files: string[];
}

export type McpServerType = "remote" | "package" | "repo-local" | "unknown";

export interface McpRef {
  readonly servers: Record<string, unknown>;
  readonly serverType: McpServerType;
  readonly relPath: string;
}

export type ArtifactKind = "hooks" | "commands" | "output-styles" | "themes" | "monitors";

/** A non-skill artifact a split cannot carry — surfaced as a warning by the caller. */
export interface ArtifactRef {
  readonly kind: ArtifactKind;
  readonly relPath: string;
}

export interface SourceLayout {
  /** The dir whose direct children are skill dirs — the git-subdir root for slices. */
  readonly skillsContainer: ContainerRef | null;
  readonly agentsContainer: AgentsRef | null;
  /** The dir holding `.claude-plugin/plugin.json` — the umbrella git-subdir root. */
  readonly pluginRoot: { readonly relPath: string } | null;
  readonly mcp: McpRef | null;
  /** Best hit per non-skill artifact kind (hooks/commands/output-styles/themes/monitors). */
  readonly artifacts: readonly ArtifactRef[];
  /** SKILL.md dirs found under non-chosen candidate containers (uncovered by a split). */
  readonly skillDirsOutsideContainer: number;
}

export interface LayoutResolver {
  readonly skillsContainer: ContainerRef | null;
  readonly skillDirsOutsideContainer: number;
  /** Advisory problems found during resolution (e.g. a symlinked container). */
  readonly warnings: readonly string[];
  /** The walk's memoized lister, shareable with enumerateSkills and the sniffer. */
  readonly list: DirLister;
  /** Memoized frontmatter reader shared across layout resolution and sniffing. */
  readonly readFrontmatter: FrontmatterReader;
  /** Resolve the rest of the layout (agents/plugin/mcp/artifacts), memoized. */
  full(): SourceLayout;
}

// Non-source directories that must never win container resolution: a repo's
// own example/fixture skills (e.g. tests/fixtures/**) or build output could
// otherwise out-count the real skills/ dir and root the split at the wrong place.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "tests", "test", "__tests__", "__mocks__",
  "dist", "build", "out", "coverage", ".next", ".cache", ".turbo", ".github", "vendor",
]);

/**
 * Two-phase resolution: the skills container (needed just to gate the split) is
 * computed eagerly from a single cached walk; agents/mcp/pluginRoot/artifacts —
 * only consumed once a split actually fires — resolve lazily on full(). This keeps
 * the common sub-threshold scan from reading and parsing every .md in the repo.
 */
export function createLayoutResolver(repoRoot: string, caches: ScanCaches = {}): LayoutResolver {
  const list = caches.list ?? makeDirLister();
  const readFm = caches.readFrontmatter ?? makeFrontmatterReader();
  const dirs: string[] = [];
  walkTree(repoRoot, { skipDirs: SKIP_DIRS, list, onDir: (d) => dirs.push(d) });

  // Dirs living INSIDE a skill (a skill's templates/examples shipping their own
  // SKILL.md files) can neither compete for the container nor count as uncovered
  // skills — they are content of the skill that carries them.
  const insideSkillMemo = new Map<string, boolean>();
  const insideSkill = (dir: string): boolean => {
    if (dir === repoRoot) {
      return false;
    }
    const memo = insideSkillMemo.get(dir);
    if (memo !== undefined) {
      return memo;
    }
    const parent = join(dir, "..");
    const result = dirContainsFile(list, parent, "SKILL.md") || insideSkill(parent);
    insideSkillMemo.set(dir, result);
    return result;
  };

  const counted = dirs
    .filter((d) => !insideSkill(d))
    .map((absDir) => ({
      absDir,
      relPath: toRel(repoRoot, absDir),
      // SKIP_DIRS children were never walked; probing them would pay fresh readdirs
      // for dirs that can never win resolution (node_modules, dist, ...).
      count: countSkillMdDirs(absDir, list, SKIP_DIRS),
    }));
  const best = pickBest(counted);
  const skillsContainer =
    best === null
      ? null
      : { absDir: best.absDir, relPath: best.relPath, hasSkillsChild: dirContainsDir(list, best.absDir, "skills") };
  const totalSkillDirs = counted.reduce((sum, c) => sum + c.count, 0);
  const skillDirsOutsideContainer = totalSkillDirs - (best?.count ?? 0);

  // A symlinked container path would make every emitted git-subdir source point
  // at a link blob instead of the skill files after a real clone+subdir checkout.
  const containerWarnings: string[] = [];
  if (best !== null) {
    try {
      const realContainer = realpathSync(best.absDir);
      const expected = join(realpathSync(repoRoot), ...(best.relPath === "." ? [] : best.relPath.split("/")));
      if (realContainer !== expected) {
        containerWarnings.push(
          `the skills container "${best.relPath}" resolves through a symlink; git-subdir checkouts would contain the link, not the skills — restructure or use --no-split.`,
        );
      }
    } catch {
      // realpath failure: container vanished mid-scan; downstream handles it
    }
  }

  let full: SourceLayout | null = null;
  return {
    skillsContainer,
    skillDirsOutsideContainer,
    warnings: containerWarnings,
    list,
    readFrontmatter: readFm,
    full(): SourceLayout {
      if (full === null) {
        const pluginRoot = resolvePluginRoot(repoRoot, dirs, list);
        full = {
          skillsContainer,
          skillDirsOutsideContainer,
          agentsContainer: resolveAgentsContainer(repoRoot, dirs, list, readFm),
          pluginRoot,
          mcp: resolveMcp(repoRoot, dirs, list, pluginRoot),
          artifacts: resolveArtifacts(repoRoot, dirs, list, pluginRoot),
        };
      }
      return full;
    },
  };
}

export function resolveSourceLayout(repoRoot: string): SourceLayout {
  return createLayoutResolver(repoRoot).full();
}

function toRel(repoRoot: string, abs: string): string {
  const r = relative(repoRoot, abs);
  return r === "" ? "." : r.split(sep).join("/");
}

/** Pick the candidate with the highest score, then shallowest, then lexicographically smallest. */
function pickBest<T extends { relPath: string; count: number }>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (c.count === 0) {
      continue;
    }
    if (best === null || isBetter(c, best)) {
      best = c;
    }
  }
  return best;
}

function isBetter(a: { relPath: string; count: number }, b: { relPath: string; count: number }): boolean {
  return a.count > b.count || (a.count === b.count && shallowerThenCodeUnit(a.relPath, b.relPath) < 0);
}

/** Shared tie-break: fewer path segments first, then code-unit order. */
function shallowerThenCodeUnit(a: string, b: string): number {
  const segA = a.split("/").length;
  const segB = b.split("/").length;
  return segA !== segB ? segA - segB : byCodeUnit(a, b);
}

function resolveAgentsContainer(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
  readFm: FrontmatterReader,
): AgentsRef | null {
  const score = (absDir: string): { absDir: string; relPath: string; count: number; files: string[]; hasSkillsChild: boolean } => {
    const files = list(absDir)
      .filter((e) => e.isFile && e.name.endsWith(".md") && e.name !== "SKILL.md")
      .map((e) => e.name)
      .filter((f) => isAgentFile(join(absDir, f), readFm))
      .sort();
    return {
      absDir,
      relPath: toRel(repoRoot, absDir),
      count: files.length,
      files,
      hasSkillsChild: dirContainsDir(list, absDir, "skills"),
    };
  };
  // Conventional `agents/` dirs outrank arbitrary agent-shaped .md collections
  // (docs/, examples/) that would otherwise win on raw count and become the core
  // entry's git-subdir root. Scoring them first also skips parsing every other
  // .md in the repo on the common conventional layout.
  const named = dirs.filter((d) => basename(d) === "agents").map(score);
  const best = pickBest(named) ?? pickBest(dirs.map(score));
  return best === null
    ? null
    : { absDir: best.absDir, relPath: best.relPath, hasSkillsChild: best.hasSkillsChild, files: best.files };
}

function resolvePluginRoot(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
): { relPath: string } | null {
  const candidates = dirs
    .filter(
      (d) =>
        // Pre-filter on the parent's cached listing: probing a non-existent
        // .claude-plugin child would pay a thrown-and-caught readdir per dir.
        dirContainsDir(list, d, ".claude-plugin") &&
        dirContainsFile(list, join(d, ".claude-plugin"), "plugin.json"),
    )
    .map((d) => ({ relPath: toRel(repoRoot, d), count: 1 }));
  const best = pickBest(candidates);
  return best === null ? null : { relPath: best.relPath };
}

/**
 * Directories whose configs count as the plugin's own: the plugin root (when one
 * exists) AND the repo root, each plus its .claude/ — the same locations the
 * single-entry conventions detector consults, so split and no-split modes see the
 * same component set. Sweeping descendants would inline a stray nested
 * examples/.mcp.json into the published core entry; preferUnder still ranks
 * plugin-root hits above repo-root ones.
 */
function anchoredDirs(
  repoRoot: string,
  dirs: readonly string[],
  pluginRoot: { relPath: string } | null,
): string[] {
  const anchors = new Set([repoRoot, join(repoRoot, ".claude")]);
  if (pluginRoot !== null && pluginRoot.relPath !== ".") {
    const root = join(repoRoot, pluginRoot.relPath);
    anchors.add(root);
    anchors.add(join(root, ".claude"));
  }
  return dirs.filter((d) => anchors.has(d));
}

function resolveMcp(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
  pluginRoot: { relPath: string } | null,
): McpRef | null {
  const files = anchoredDirs(repoRoot, dirs, pluginRoot)
    .filter((d) => dirContainsFile(list, d, ".mcp.json"))
    .map((d) => ({ file: join(d, ".mcp.json"), relPath: toRel(repoRoot, join(d, ".mcp.json")) }))
    .sort((a, b) => preferUnder(pluginRoot, a.relPath, b.relPath));
  // Walk candidates in priority order: a malformed or non-MCP highest-priority
  // .mcp.json must not shadow a valid one elsewhere (returning null would silently
  // drop the real MCP server from the emitted core).
  for (const chosen of files) {
    let parsed: unknown;
    try {
      parsed = readJsonFile(chosen.file);
    } catch {
      continue;
    }
    const servers = extractServers(parsed);
    if (servers === null) {
      continue;
    }
    return { servers, serverType: classifyServers(servers), relPath: chosen.relPath };
  }
  return null;
}

function resolveArtifacts(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
  pluginRoot: { relPath: string } | null,
): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  // Only conventional locations count: a src/commands/ code directory anywhere in
  // the tree must not be reported (or emitted) as a slash-command artifact.
  const anchored = anchoredDirs(repoRoot, dirs, pluginRoot);
  // hooks and monitors share the two-location `<kind>/<kind>.json` | `<kind>.json` probe.
  for (const kind of ARTIFACT_JSON_KINDS) {
    const hit = resolveJsonFileArtifact(repoRoot, anchored, list, pluginRoot, kind);
    if (hit !== null) {
      out.push({ kind, relPath: hit });
    }
  }
  for (const kind of ARTIFACT_DIR_FOLDERS) {
    const hits = anchored
      .filter((d) => dirContainsDir(list, d, kind))
      .map((d) => toRel(repoRoot, join(d, kind)))
      .sort((a, b) => preferUnder(pluginRoot, a, b));
    if (hits[0] !== undefined) {
      out.push({ kind, relPath: hits[0] });
    }
  }
  return out;
}

/** Best `<dir>/<kind>/<kind>.json` hit (the conventions-detector rule), preferring the plugin root. */
function resolveJsonFileArtifact(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
  pluginRoot: { relPath: string } | null,
  kind: (typeof ARTIFACT_JSON_KINDS)[number],
): string | null {
  const fileName = `${kind}.json`;
  const hits = dirs
    .filter((d) => dirContainsDir(list, d, kind) && dirContainsFile(list, join(d, kind), fileName))
    .map((d) => toRel(repoRoot, join(d, kind, fileName)))
    .sort((a, b) => preferUnder(pluginRoot, a, b));
  return hits[0] ?? null;
}

/** Sort comparator: paths under the plugin root come first, then shallower, then code-unit order. */
function preferUnder(pluginRoot: { relPath: string } | null, a: string, b: string): number {
  if (pluginRoot !== null) {
    const aUnder = a.startsWith(`${pluginRoot.relPath}/`) ? 0 : 1;
    const bUnder = b.startsWith(`${pluginRoot.relPath}/`) ? 0 : 1;
    if (aUnder !== bUnder) {
      return aUnder - bUnder;
    }
  }
  return shallowerThenCodeUnit(a, b);
}

function extractServers(parsed: unknown): Record<string, unknown> | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const hasWrapper = obj["mcpServers"] !== undefined && obj["mcpServers"] !== null;
  const raw = hasWrapper ? obj["mcpServers"] : obj;
  // Reject a non-object or array servers map (e.g. `{ "mcpServers": [...] }`), and an
  // empty one — none can be inlined as a valid mcpServers block.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const servers = raw as Record<string, unknown>;
  const entries = Object.values(servers);
  if (entries.length === 0) {
    return null;
  }
  // Without an explicit `mcpServers` wrapper we are guessing that the whole file is
  // the servers map; only accept that when every value is an object (a server config),
  // so non-MCP JSON like `{ "$schema": "...", "version": 1 }` is not misread as servers.
  if (!hasWrapper && !entries.every((e) => e !== null && typeof e === "object")) {
    return null;
  }
  return servers;
}

function classifyServers(servers: Record<string, unknown>): McpServerType {
  const types = Object.values(servers).map(classifyOne);
  if (types.length === 0) {
    return "unknown";
  }
  if (types.includes("repo-local")) {
    return "repo-local";
  }
  if (types.every((t) => t === "remote")) {
    return "remote";
  }
  if (types.every((t) => t === "remote" || t === "package")) {
    return "package";
  }
  return "unknown";
}

// A bare relative script path ("dist/server.js", "scripts/run.py") references repo
// files just as surely as "./dist/server.js" does — while package specifiers like
// "@scope/pkg" contain "/" but no script extension, keeping them classified as packages.
const SCRIPT_EXT = /\.(?:js|mjs|cjs|ts|mts|cts|py|sh|rb)$/;

function classifyOne(server: unknown): McpServerType {
  if (server === null || typeof server !== "object") {
    return "unknown";
  }
  const s = server as Record<string, unknown>;
  if (s["type"] === "http" || s["type"] === "sse" || typeof s["url"] === "string") {
    return "remote";
  }
  const cmd = s["command"];
  if (typeof cmd !== "string") {
    return "unknown";
  }
  const args = Array.isArray(s["args"]) ? s["args"].filter((a): a is string => typeof a === "string") : [];
  const refsLocal = (x: string): boolean =>
    x.startsWith("./") ||
    x.startsWith("../") ||
    x.startsWith("/") ||
    // Only path-root expansion marks a server repo-local; generic env interpolation
    // like ${API_KEY} resolves from the environment and stays portable.
    x.includes("${CLAUDE_PLUGIN_ROOT}") ||
    (x.includes("/") && SCRIPT_EXT.test(x));
  if (refsLocal(cmd) || args.some(refsLocal)) {
    return "repo-local";
  }
  // A stdio command that does not reference repo-local paths is treated as a
  // self-contained package runner (npx/uvx/bunx/…) or an installed binary.
  return "package";
}
