import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as v from "valibot";
import { AgentFrontmatterSchema } from "../schemas/frontmatter.ts";
import { extractFrontmatter } from "./yaml.ts";

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

export interface SourceLayout {
  /** The dir whose direct children are skill dirs — the git-subdir root for slices. */
  readonly skillsContainer: ContainerRef | null;
  readonly agentsContainer: AgentsRef | null;
  /** The dir holding `.claude-plugin/plugin.json` — the umbrella git-subdir root. */
  readonly pluginRoot: { readonly relPath: string } | null;
  readonly mcp: McpRef | null;
  readonly hooks: { readonly relPath: string } | null;
}

export function resolveSourceLayout(repoRoot: string): SourceLayout {
  const dirs: string[] = [];
  collectDirs(repoRoot, dirs);

  const pluginRoot = resolvePluginRoot(repoRoot, dirs);
  return {
    skillsContainer: resolveSkillsContainer(repoRoot, dirs),
    agentsContainer: resolveAgentsContainer(repoRoot, dirs),
    pluginRoot,
    mcp: resolveMcp(repoRoot, dirs, pluginRoot),
    hooks: resolveHooks(repoRoot, dirs, pluginRoot),
  };
}

// Non-source directories that must never win container resolution: a repo's
// own example/fixture skills (e.g. tests/fixtures/**) or build output could
// otherwise out-count the real skills/ dir and root the split at the wrong place.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "tests", "test", "__tests__", "__mocks__",
  "dist", "build", "out", "coverage", ".next", ".cache", ".turbo", ".github", "vendor",
]);

function collectDirs(dir: string, acc: string[]): void {
  acc.push(dir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      collectDirs(full, acc);
    }
  }
}

function toRel(repoRoot: string, absDir: string): string {
  const r = relative(repoRoot, absDir);
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

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveSkillsContainer(repoRoot: string, dirs: readonly string[]): ContainerRef | null {
  const candidates = dirs.map((absDir) => {
    let count = 0;
    for (const child of safeReaddir(absDir)) {
      if (isDir(join(absDir, child)) && existsSync(join(absDir, child, "SKILL.md"))) {
        count++;
      }
    }
    return { absDir, relPath: toRel(repoRoot, absDir), count };
  });
  const best = pickBest(candidates);
  return best === null ? null : { absDir: best.absDir, relPath: best.relPath };
}

function resolveAgentsContainer(repoRoot: string, dirs: readonly string[]): AgentsRef | null {
  const candidates = dirs.map((absDir) => {
    const files = safeReaddir(absDir)
      .filter((f) => f.endsWith(".md") && f !== "SKILL.md")
      .filter((f) => isAgentFile(join(absDir, f)))
      .sort();
    return { absDir, relPath: toRel(repoRoot, absDir), count: files.length, files };
  });
  const best = pickBest(candidates);
  return best === null ? null : { absDir: best.absDir, relPath: best.relPath, files: best.files };
}

function isAgentFile(filePath: string): boolean {
  let raw: string;
  try {
    if (!statSync(filePath).isFile()) {
      return false; // a directory whose name ends in .md, etc.
    }
    raw = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const fm = extractFrontmatter(raw);
  return fm !== null && v.safeParse(AgentFrontmatterSchema, fm).success;
}

/** readdirSync that tolerates a directory vanishing/becoming unreadable mid-scan. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function resolvePluginRoot(repoRoot: string, dirs: readonly string[]): { relPath: string } | null {
  const candidates = dirs
    .filter((d) => existsSync(join(d, ".claude-plugin", "plugin.json")))
    .map((d) => ({ relPath: toRel(repoRoot, d), count: 1 }));
  const best = pickBest(candidates);
  return best === null ? null : { relPath: best.relPath };
}

function resolveMcp(
  repoRoot: string,
  dirs: readonly string[],
  pluginRoot: { relPath: string } | null,
): McpRef | null {
  const files = dirs
    .map((d) => join(d, ".mcp.json"))
    .filter((f) => existsSync(f))
    .map((f) => ({ file: f, relPath: toRel(repoRoot, f) }))
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
  pluginRoot: { relPath: string } | null,
): { relPath: string } | null {
  const files = dirs
    .flatMap((d) => [join(d, "hooks", "hooks.json"), join(d, "hooks.json")])
    .filter((f) => existsSync(f))
    .map((f) => toRel(repoRoot, f))
    .sort((a, b) => preferUnder(pluginRoot, a, b));
  const chosen = files[0];
  return chosen === undefined ? null : { relPath: chosen };
}

/** Sort comparator: paths under the plugin root come first, then shallower, then lexicographic. */
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
  return segA !== segB ? segA - segB : a.localeCompare(b);
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
    x.startsWith("./") || x.startsWith("../") || x.startsWith("/") || x.includes("${");
  if (refsLocal(cmd) || args.some(refsLocal)) {
    return "repo-local";
  }
  // A stdio command that does not reference repo-local paths is treated as a
  // self-contained package runner (npx/uvx/bunx/…) or an installed binary.
  return "package";
}
