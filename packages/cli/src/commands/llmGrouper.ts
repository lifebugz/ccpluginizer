import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GroupSkillsFn } from "../detector/partition.ts";
import type { SkillMeta } from "../detector/skillMeta.ts";

export interface RawGroup {
  readonly slug: string;
  readonly members: string[];
}

/** Default backend timeout (ms); overridable per call via resolveLlmConfig's timeoutMs. */
export const CLUSTER_TIMEOUT_DEFAULT_MS = 120_000;

/** Cap a backend's stdout so a runaway/garbage response cannot exhaust memory. */
export const CLUSTER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** The single-signature subset of spawnSync the backends depend on (so tests can fake it). */
export type SpawnRun = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; input?: string; maxBuffer: number; timeout: number },
) => { error?: Error; signal: NodeJS.Signals | null; status: number | null; stdout: unknown };

export interface ResolvedGrouper {
  readonly fn: GroupSkillsFn;
  readonly backendId: string;
  readonly kind: "subprocess" | "claude";
}

export interface GrouperDeps {
  readonly run?: SpawnRun;
  readonly which?: (cmd: string) => string | null;
  readonly cacheDir?: () => string;
}

export interface ResolveGrouperOpts {
  readonly cmd?: string;
  readonly cmdFromEnv: boolean;
  readonly timeoutMs: number;
}

/** Build a one-shot clustering prompt for an LLM backend. */
export function buildClusterPrompt(skills: readonly SkillMeta[]): string {
  const lines = skills.map((s) => {
    const product = s.product !== undefined ? ` [product=${s.product}]` : "";
    const desc = s.description.slice(0, 140);
    return `- ${s.dir}${product}: ${desc}`;
  });
  return [
    "You are grouping Claude Code skills into a small number of coherent product domains.",
    "",
    "Rules:",
    "- Produce between 2 and 12 groups.",
    "- Every skill must appear in exactly one group (disjoint, total cover).",
    "- No group may contain more than ~70% of all skills.",
    "- Group by product/domain meaning, not by programming language.",
    '- Each group needs a short kebab-case "slug" (e.g. "messaging", "voice").',
    "",
    "Skills:",
    ...lines,
    "",
    'Respond with ONLY a JSON array, no prose: [{"slug":"...","members":["<skill-dir>",...]}, ...]',
  ].join("\n");
}

/** Parse the model's response into validated groups, dropping hallucinated members. */
export function parseClusterResponse(text: string, validDirs: ReadonlySet<string>): RawGroup[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const groups: RawGroup[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const slug = obj["slug"];
    const members = obj["members"];
    if (typeof slug !== "string" || !Array.isArray(members)) {
      continue;
    }
    const valid = members.filter((m): m is string => typeof m === "string" && validDirs.has(m));
    if (valid.length > 0) {
      groups.push({ slug, members: valid });
    }
  }
  return groups.length > 0 ? groups : null;
}

/** Validate a value (e.g. a disk-cache file) as a RawGroup[], rejecting wrong shapes. */
export function validateRawGroups(parsed: unknown): RawGroup[] | null {
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: RawGroup[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") {
      return null;
    }
    const obj = item as Record<string, unknown>;
    const slug = obj["slug"];
    const members = obj["members"];
    if (typeof slug !== "string" || !Array.isArray(members)) {
      return null;
    }
    out.push({ slug, members: members.filter((m): m is string => typeof m === "string") });
  }
  return out;
}

/**
 * Resolve a BYO grouper by precedence: explicit subprocess command → `claude` on PATH → none.
 * Each backend's raw output is gated by partition.ts; backends never touch the gate.
 */
export function resolveGrouper(opts: ResolveGrouperOpts, deps: GrouperDeps = {}): ResolvedGrouper | null {
  const run: SpawnRun = deps.run ?? ((c, a, o): ReturnType<SpawnRun> => spawnSync(c, a, o));
  const whichFn = deps.which ?? which;
  const cacheDirFn = deps.cacheDir ?? defaultCacheDir;

  if (opts.cmd !== undefined) {
    return {
      fn: makeSubprocessGrouper({ cmd: opts.cmd, fromEnv: opts.cmdFromEnv, timeoutMs: opts.timeoutMs }, { run, cacheDir: cacheDirFn }),
      backendId: opts.cmd,
      kind: "subprocess",
    };
  }

  const claude = whichFn("claude");
  if (claude !== null) {
    return {
      fn: claudeGrouper(claude, opts.timeoutMs, { run, cacheDir: cacheDirFn }),
      backendId: "claude",
      kind: "claude",
    };
  }

  return null;
}

interface BackendDeps {
  readonly run: SpawnRun;
  readonly cacheDir: () => string;
}

function makeSubprocessGrouper(
  opts: { cmd: string; fromEnv: boolean; timeoutMs: number },
  deps: BackendDeps,
): GroupSkillsFn {
  let noticeShown = false;
  const [shell, shellFlag] = process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];
  return (skills: readonly SkillMeta[]): Promise<RawGroup[]> => {
    const validDirs = new Set(skills.map((s) => s.dir));
    const cacheKey = hashSkills(skills, opts.cmd);
    const cached = readCache(deps.cacheDir, cacheKey);
    if (cached !== null) {
      return Promise.resolve(cached);
    }
    // Trust/provenance: an env-sourced command is shell-executed; announce it once, here
    // (not at construction), so a committed-marker win — which never invokes the grouper —
    // never triggers it. Cache hits also skip it: the command genuinely did not run.
    if (opts.fromEnv && !noticeShown) {
      noticeShown = true;
      console.error(`ccpluginizer: running LLM grouper from CCPLUGINIZER_LLM_CMD: ${opts.cmd}`);
    }
    const result = deps.run(shell, [shellFlag, opts.cmd], {
      encoding: "utf8",
      input: buildClusterPrompt(skills),
      maxBuffer: CLUSTER_MAX_BUFFER_BYTES,
      timeout: opts.timeoutMs,
    });
    if (isSpawnFailure(result)) {
      return Promise.resolve([]);
    }
    const groups = parseClusterResponse(String(result.stdout), validDirs) ?? [];
    if (groups.length > 0) {
      writeCache(deps.cacheDir, cacheKey, groups);
    }
    return Promise.resolve(groups);
  };
}

function claudeGrouper(claudePath: string, timeoutMs: number, deps: BackendDeps): GroupSkillsFn {
  return (skills: readonly SkillMeta[]): Promise<RawGroup[]> => {
    const validDirs = new Set(skills.map((s) => s.dir));
    const cacheKey = hashSkills(skills, "claude");
    const cached = readCache(deps.cacheDir, cacheKey);
    if (cached !== null) {
      return Promise.resolve(cached);
    }
    const result = deps.run(claudePath, ["-p", buildClusterPrompt(skills)], {
      encoding: "utf8",
      maxBuffer: CLUSTER_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
    });
    if (isSpawnFailure(result)) {
      return Promise.resolve([]);
    }
    const groups = parseClusterResponse(String(result.stdout), validDirs) ?? [];
    if (groups.length > 0) {
      writeCache(deps.cacheDir, cacheKey, groups);
    }
    return Promise.resolve(groups);
  };
}

/**
 * Treat a run as failed when the process errored, was signalled (e.g. SIGTERM on timeout),
 * exited non-zero, or produced no string stdout. On timeout spawnSync returns
 * { status: null, signal: "SIGTERM", error: ETIMEDOUT } — so we key on error/signal, not status.
 */
function isSpawnFailure(result: ReturnType<SpawnRun>): boolean {
  return (
    result.error !== undefined ||
    result.signal !== null ||
    (result.status !== null && result.status !== 0) ||
    typeof result.stdout !== "string"
  );
}

function which(cmd: string): string | null {
  if (typeof Bun !== "undefined") {
    return Bun.which(cmd);
  }
  const finder = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(finder, [cmd], { encoding: "utf8" });
  const out = typeof r.stdout === "string" ? (r.stdout.split("\n")[0] ?? "").trim() : "";
  return r.status === 0 && out !== "" ? out : null;
}

function hashSkills(skills: readonly SkillMeta[], backendId: string): string {
  const material = [...skills]
    .map((s) => `${s.dir}\x00${s.product ?? ""}\x00${s.description}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(backendId).update("\x00").update(material).digest("hex").slice(0, 32);
}

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "ccpluginizer");
}

/** Create (0700) and verify the cache dir is user-private; return it, or null to skip caching. */
function ensureCacheDir(dirFn: () => string): string | null {
  const dir = dirFn();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  // mkdir({mode}) is a no-op on a pre-existing dir, so verify perms after the fact (POSIX).
  let st;
  try {
    st = statSync(dir);
  } catch {
    return null;
  }
  if (!st.isDirectory()) {
    return null;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && (st.uid !== uid || (st.mode & 0o077) !== 0)) {
    return null;
  }
  return dir;
}

function readCache(dirFn: () => string, key: string): RawGroup[] | null {
  const dir = ensureCacheDir(dirFn);
  if (dir === null) {
    return null;
  }
  const file = join(dir, `${key}.json`);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return validateRawGroups(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeCache(dirFn: () => string, key: string, groups: RawGroup[]): void {
  const dir = ensureCacheDir(dirFn);
  if (dir === null) {
    return;
  }
  try {
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(groups), "utf8");
  } catch {
    // best-effort cache; ignore write failures
  }
}
