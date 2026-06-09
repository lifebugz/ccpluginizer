import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isAgentFile, makeDirLister, walkTree, type DirLister } from "./fsWalk.ts";
import { byCodeUnit } from "./slugify.ts";

export interface ContainerRef {
  readonly absDir: string;
  /** Repo-relative path with forward slashes and no leading "./" — a git-subdir `path`. */
  readonly relPath: string;
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

export type ArtifactKind = "commands" | "output-styles" | "themes" | "monitors";

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
  readonly hooks: { readonly relPath: string } | null;
  /** Best hit per non-skill artifact kind (commands/output-styles/themes/monitors). */
  readonly artifacts: readonly ArtifactRef[];
  /** SKILL.md dirs found under non-chosen candidate containers (uncovered by a split). */
  readonly skillDirsOutsideContainer: number;
}

export interface LayoutResolver {
  readonly skillsContainer: ContainerRef | null;
  readonly skillDirsOutsideContainer: number;
  /** The walk's memoized lister, shareable with enumerateSkills. */
  readonly list: DirLister;
  /** Resolve the rest of the layout (agents/plugin/mcp/hooks/artifacts), memoized. */
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
 * computed eagerly from a single cached walk; agents/mcp/hooks/pluginRoot/artifacts
 * — only consumed once a split actually fires — resolve lazily on full(). This keeps
 * the common sub-threshold scan from reading and parsing every .md in the repo.
 */
export function createLayoutResolver(repoRoot: string): LayoutResolver {
  const list = makeDirLister();
  const dirs: string[] = [];
  walkTree(repoRoot, { skipDirs: SKIP_DIRS, list, onDir: (d) => dirs.push(d) });

  const counted = dirs.map((absDir) => ({
    absDir,
    relPath: toRel(repoRoot, absDir),
    count: countSkillChildren(absDir, list),
  }));
  const best = pickBest(counted);
  const skillsContainer = best === null ? null : { absDir: best.absDir, relPath: best.relPath };
  const totalSkillDirs = counted.reduce((sum, c) => sum + c.count, 0);
  const skillDirsOutsideContainer = totalSkillDirs - (best?.count ?? 0);

  let full: SourceLayout | null = null;
  return {
    skillsContainer,
    skillDirsOutsideContainer,
    list,
    full(): SourceLayout {
      if (full === null) {
        const pluginRoot = resolvePluginRoot(repoRoot, dirs, list);
        full = {
          skillsContainer,
          skillDirsOutsideContainer,
          agentsContainer: resolveAgentsContainer(repoRoot, dirs, list),
          pluginRoot,
          mcp: resolveMcp(repoRoot, dirs, list, pluginRoot),
          hooks: resolveHooks(repoRoot, dirs, list, pluginRoot),
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

function countSkillChildren(absDir: string, list: DirLister): number {
  let count = 0;
  for (const child of list(absDir)) {
    if (child.isDirectory && list(join(absDir, child.name)).some((e) => e.isFile && e.name === "SKILL.md")) {
      count++;
    }
  }
  return count;
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
  if (a.count !== b.count) {
    return a.count > b.count;
  }
  const segA = a.relPath.split("/").length;
  const segB = b.relPath.split("/").length;
  if (segA !== segB) {
    return segA < segB;
  }
  return a.relPath < b.relPath;
}

function lastPathSegment(relPath: string): string {
  const parts = relPath.split("/");
  return parts[parts.length - 1] ?? relPath;
}

function resolveAgentsContainer(repoRoot: string, dirs: readonly string[], list: DirLister): AgentsRef | null {
  const score = (absDir: string): { absDir: string; relPath: string; count: number; files: string[] } => {
    const files = list(absDir)
      .filter((e) => e.isFile && e.name.endsWith(".md") && e.name !== "SKILL.md")
      .map((e) => e.name)
      .filter((f) => isAgentFile(join(absDir, f)))
      .sort();
    return { absDir, relPath: toRel(repoRoot, absDir), count: files.length, files };
  };
  // Conventional `agents/` dirs outrank arbitrary agent-shaped .md collections
  // (docs/, examples/) that would otherwise win on raw count and become the core
  // entry's git-subdir root. Scoring them first also skips parsing every other
  // .md in the repo on the common conventional layout.
  const named = dirs.filter((d) => lastPathSegment(toRel(repoRoot, d)) === "agents").map(score);
  const bestNamed = pickBest(named);
  if (bestNamed !== null) {
    return { absDir: bestNamed.absDir, relPath: bestNamed.relPath, files: bestNamed.files };
  }
  const best = pickBest(dirs.map(score));
  return best === null ? null : { absDir: best.absDir, relPath: best.relPath, files: best.files };
}

function resolvePluginRoot(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
): { relPath: string } | null {
  const candidates = dirs
    .filter((d) => list(join(d, ".claude-plugin")).some((e) => e.isFile && e.name === "plugin.json"))
    .map((d) => ({ relPath: toRel(repoRoot, d), count: 1 }));
  const best = pickBest(candidates);
  return best === null ? null : { relPath: best.relPath };
}

function resolveMcp(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
  pluginRoot: { relPath: string } | null,
): McpRef | null {
  const files = dirs
    .filter((d) => list(d).some((e) => e.isFile && e.name === ".mcp.json"))
    .map((d) => ({ file: join(d, ".mcp.json"), relPath: toRel(repoRoot, join(d, ".mcp.json")) }))
    .sort((a, b) => preferUnder(pluginRoot, a.relPath, b.relPath));
  // Walk candidates in priority order: a malformed or non-MCP highest-priority
  // .mcp.json must not shadow a valid one elsewhere (returning null would silently
  // drop the real MCP server from the emitted core).
  for (const chosen of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(chosen.file, "utf8"));
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

function resolveHooks(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
  pluginRoot: { relPath: string } | null,
): { relPath: string } | null {
  const files = dirs
    .flatMap((d) => {
      const hits: string[] = [];
      if (list(join(d, "hooks")).some((e) => e.isFile && e.name === "hooks.json")) {
        hits.push(toRel(repoRoot, join(d, "hooks", "hooks.json")));
      }
      if (list(d).some((e) => e.isFile && e.name === "hooks.json")) {
        hits.push(toRel(repoRoot, join(d, "hooks.json")));
      }
      return hits;
    })
    .sort((a, b) => preferUnder(pluginRoot, a, b));
  const chosen = files[0];
  return chosen === undefined ? null : { relPath: chosen };
}

const ARTIFACT_DIR_KINDS = ["commands", "output-styles", "themes"] as const;

function resolveArtifacts(
  repoRoot: string,
  dirs: readonly string[],
  list: DirLister,
  pluginRoot: { relPath: string } | null,
): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  for (const kind of ARTIFACT_DIR_KINDS) {
    const hits = dirs
      .filter((d) => list(d).some((e) => e.isDirectory && e.name === kind))
      .map((d) => toRel(repoRoot, join(d, kind)))
      .sort((a, b) => preferUnder(pluginRoot, a, b));
    if (hits[0] !== undefined) {
      out.push({ kind, relPath: hits[0] });
    }
  }
  // monitors uses the hooks-style two-location file probe.
  const monitorHits = dirs
    .flatMap((d) => {
      const hits: string[] = [];
      if (list(join(d, "monitors")).some((e) => e.isFile && e.name === "monitors.json")) {
        hits.push(toRel(repoRoot, join(d, "monitors", "monitors.json")));
      }
      if (list(d).some((e) => e.isFile && e.name === "monitors.json")) {
        hits.push(toRel(repoRoot, join(d, "monitors.json")));
      }
      return hits;
    })
    .sort((a, b) => preferUnder(pluginRoot, a, b));
  if (monitorHits[0] !== undefined) {
    out.push({ kind: "monitors", relPath: monitorHits[0] });
  }
  return out;
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
  const segA = a.split("/").length;
  const segB = b.split("/").length;
  return segA !== segB ? segA - segB : byCodeUnit(a, b);
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
    x.includes("${") ||
    (x.includes("/") && SCRIPT_EXT.test(x));
  if (refsLocal(cmd) || args.some(refsLocal)) {
    return "repo-local";
  }
  // A stdio command that does not reference repo-local paths is treated as a
  // self-contained package runner (npx/uvx/bunx/…) or an installed binary.
  return "package";
}
