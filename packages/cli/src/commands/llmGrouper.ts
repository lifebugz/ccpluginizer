import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import type { BackendKind, GrouperRun } from "../detector/partition.ts";
import { RawGroupSchema, RawGroupsSchema, type RawGroup } from "../schemas/rawGroups.ts";
import { readJsonFile } from "../detector/fsWalk.ts";
import type { SkillMeta } from "../detector/skillMeta.ts";

/** Cap a backend's stdout so a runaway/garbage response cannot exhaust memory. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface SpawnResult {
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stdout: string | null;
}

/** The runner seam the backends depend on (so tests can fake it with a sync value). */
export type SpawnRun = (
  command: string,
  args: readonly string[],
  options: { input?: string; maxBuffer: number; timeout: number },
) => SpawnResult | Promise<SpawnResult>;

/** A backend's grouping function: it returns the full GrouperRun (it knows its kind). */
export type BackendGroupFn = (skills: readonly SkillMeta[]) => Promise<GrouperRun>;

export interface ResolvedGrouper {
  readonly fn: BackendGroupFn;
  readonly backendId: string;
  readonly kind: BackendKind;
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
    // Flatten whitespace before truncating: a `|` literal block scalar keeps \n,
    // which would break the one-line-per-skill format the model relies on (stray
    // lines starting "- " would masquerade as extra skill entries).
    const desc = s.description.replace(/\s+/g, " ").trim().slice(0, 140);
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

// Leading prose often contains brackets ("Here are the groups [1]:"), so a greedy
// first-[ … last-] slice would poison JSON.parse. Scan a bounded number of balanced
// [...] candidates instead and accept the first that yields a valid group.
const MAX_ARRAY_CANDIDATES = 50;

/** Parse the model's response into validated groups, dropping hallucinated members. */
export function parseClusterResponse(text: string, validDirs: ReadonlySet<string>): RawGroup[] | null {
  let candidates = 0;
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    if (++candidates > MAX_ARRAY_CANDIDATES) {
      break;
    }
    const end = balancedArrayEnd(text, start);
    if (end === -1) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    const groups: RawGroup[] = [];
    for (const item of parsed) {
      const r = v.safeParse(RawGroupSchema, item);
      if (!r.success) {
        continue;
      }
      const members = r.output.members.filter((m) => validDirs.has(m));
      if (members.length > 0) {
        groups.push({ slug: r.output.slug, members });
      }
    }
    if (groups.length > 0) {
      return groups;
    }
  }
  return null;
}

/** Index of the ']' closing the '[' at `start`, skipping string literals; -1 if unbalanced. */
function balancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        return ch === "]" ? i : -1;
      }
      if (depth < 0) {
        return -1;
      }
    }
  }
  return -1;
}

/** Validate a value (e.g. a disk-cache file) as a RawGroup[], rejecting wrong shapes. */
export function validateRawGroups(parsed: unknown): RawGroup[] | null {
  const r = v.safeParse(RawGroupsSchema, parsed);
  return r.success ? r.output : null;
}

/**
 * Default runner: async spawn in its own process group (POSIX), so a timeout kills
 * the user's entire pipeline — spawnSync's timeout signals only the `sh -c` wrapper,
 * leaving `curl | jq` grandchildren running forever. On Windows the command goes
 * through `cmd /d /s /c` with verbatim arguments (cmd.exe does not understand
 * MSVCRT-style backslash quoting).
 */
function spawnGroupRun(
  command: string,
  args: readonly string[],
  options: { input?: string; maxBuffer: number; timeout: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "inherit"],
        detached: !win,
        windowsVerbatimArguments: win,
      });
    } catch (e) {
      resolve({ error: e instanceof Error ? e : new Error(String(e)), signal: null, status: null, stdout: null });
      return;
    }
    let stdout = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (!win && child.pid !== undefined) {
          process.kill(-child.pid, sig); // negative pid: the whole process group
        } else if (win && child.pid !== undefined) {
          // child.kill only reaches the cmd.exe wrapper; taskkill /T fells the tree.
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          child.kill(sig);
        }
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    // A detached child is outside the terminal's foreground group, so Ctrl-C /
    // terminal close / process.exit would orphan a running backend — forward them.
    const forward = (sig: NodeJS.Signals) => (): void => {
      killTree(sig);
      cleanupForwarders();
      process.kill(process.pid, sig);
    };
    const onSigint = forward("SIGINT");
    const onSighup = forward("SIGHUP");
    const onSigterm = forward("SIGTERM");
    const onExit = (): void => {
      killTree("SIGKILL");
    };
    const cleanupForwarders = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGHUP", onSighup);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("exit", onExit);
    };
    process.once("SIGINT", onSigint);
    process.once("SIGHUP", onSighup);
    process.once("SIGTERM", onSigterm);
    process.on("exit", onExit);
    const finish = (result: SpawnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const t of timers) {
        clearTimeout(t);
      }
      // Reap any process-group survivors (a grandchild holding the inherited stdout
      // pipe) and release our end of the pipe. On POSIX a kill to a dead group is a
      // caught ESRCH no-op; on Windows the reap spawns taskkill, so a clean close
      // (no timeout/overflow/error) skips it instead of paying a subprocess per run.
      if (!win || timedOut || overflowed || result.error !== undefined) {
        killTree("SIGKILL");
      }
      child.stdout?.destroy();
      cleanupForwarders();
      resolve(result);
    };
    const schedule = (fn: () => void, ms: number): void => {
      const t = setTimeout(fn, ms);
      t.unref();
      timers.push(t);
    };
    schedule(() => {
      timedOut = true;
      killTree("SIGTERM");
      schedule(() => {
        killTree("SIGKILL");
      }, 2000);
    }, options.timeout);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      // Count bytes, not UTF-16 code units: multibyte output would otherwise occupy
      // up to twice the named budget before the cap fires.
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (!overflowed && stdoutBytes > options.maxBuffer) {
        overflowed = true;
        killTree("SIGKILL");
      }
    });
    const outcome = (status: number | null, signal: NodeJS.Signals | null): SpawnResult => ({
      ...(timedOut
        ? { error: new Error("ETIMEDOUT: LLM backend timed out") }
        : overflowed
          ? { error: new Error("LLM backend exceeded the output cap") }
          : {}),
      signal,
      status,
      stdout,
    });
    child.on("error", (error) => {
      finish({ error, signal: null, status: null, stdout: null });
    });
    child.on("close", (status, signal) => {
      finish(outcome(status, signal));
    });
    // 'close' waits for all stdio pipes — a surviving grandchild holding the
    // inherited stdout would hang the scan forever. Once the child itself exits,
    // give trailing output one second and then finish regardless.
    child.on("exit", (status, signal) => {
      schedule(() => {
        finish(outcome(status, signal));
      }, 1000);
    });
    // EPIPE if the child exits before reading the prompt — swallow, the close
    // handler reports the real outcome.
    child.stdin?.on("error", () => undefined);
    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
  });
}

/**
 * Resolve a BYO grouper by precedence: explicit subprocess command → `claude` on PATH → none.
 * Backends never gate their returned output — partition.ts owns acceptance; they only
 * consult rawGroupsAcceptable to decide cache writes.
 */
export function resolveGrouper(opts: ResolveGrouperOpts, deps: GrouperDeps = {}): ResolvedGrouper | null {
  const run: SpawnRun = deps.run ?? spawnGroupRun;
  const whichFn = deps.which ?? which;
  const cacheDirFn = deps.cacheDir ?? defaultCacheDir;

  if (opts.cmd !== undefined) {
    const cmd = opts.cmd;
    // Mirror Node's own shell:true argv for each platform.
    const [shell, shellArgs] =
      process.platform === "win32"
        ? (["cmd", ["/d", "/s", "/c", `"${cmd}"`]] as const)
        : (["sh", ["-c", cmd]] as const);
    // Trust/provenance: an env-sourced command is shell-executed; announce it once, on
    // first actual run (not at construction), so a committed-marker win — which never
    // invokes the grouper — never triggers it. Cache hits also skip it: the command
    // genuinely did not run.
    let noticeShown = false;
    const onRun =
      opts.cmdFromEnv
        ? (): void => {
            if (!noticeShown) {
              noticeShown = true;
              console.error(`ccpluginizer: running LLM grouper from CCPLUGINIZER_LLM_CMD: ${cmd}`);
            }
          }
        : undefined;
    return {
      fn: makeCachedGrouper(
        "subprocess",
        // Namespaced: --llm-cmd "claude" (a shell command) must not share cache
        // entries with the built-in claude backend (direct argv invocation).
        `cmd:${cmd}`,
        cacheDirFn,
        (prompt) =>
          run(shell, shellArgs, {
            input: prompt,
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: opts.timeoutMs,
          }),
        onRun,
      ),
      backendId: cmd,
      kind: "subprocess",
    };
  }

  const claude = whichFn("claude");
  if (claude !== null) {
    // npm-installed Windows shims (.cmd/.bat) cannot be spawned directly
    // (Node >= 20 throws EINVAL); route them through cmd.exe like a shell would.
    const winShim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(claude);
    // Outer quote wrap mirrors Node's shell:true /S /C handling, protecting a
    // claude path that itself contains spaces.
    const [cmd, cmdArgs] = winShim
      ? (["cmd", ["/d", "/s", "/c", `""${claude}" -p"`]] as const)
      : ([claude, ["-p"]] as const);
    return {
      // The prompt goes on stdin, not argv: one line per skill at hundreds of skills
      // exceeds the OS per-argument limit (E2BIG), which would silently disable the
      // claude backend on exactly the repos that most need the rescue.
      fn: makeCachedGrouper("claude", "claude-cli", cacheDirFn, (prompt) =>
        run(cmd, cmdArgs, {
          input: prompt,
          maxBuffer: MAX_BUFFER_BYTES,
          timeout: opts.timeoutMs,
        }),
      ),
      backendId: "claude",
      kind: "claude",
    };
  }

  return null;
}

/** The shared backend pipeline: cache read → invoke → parse → commit-on-acceptance. */
function makeCachedGrouper(
  kind: BackendKind,
  cacheId: string,
  cacheDir: () => string,
  invoke: (prompt: string) => SpawnResult | Promise<SpawnResult>,
  onRun?: () => void,
): BackendGroupFn {
  return async (skills: readonly SkillMeta[]): Promise<GrouperRun> => {
    // The cache dir is created/verified once per invocation, shared by read and commit.
    const dir = ensureCacheDir(cacheDir);
    const cacheKey = hashSkills(skills, cacheId);
    const cached = dir === null ? null : readCacheFile(join(dir, `${cacheKey}.json`));
    if (cached !== null) {
      return { kind, groups: cached }; // already gate-passing when written — no re-commit
    }
    onRun?.();
    const result = await invoke(buildClusterPrompt(skills));
    const stdout = result.stdout;
    if (isSpawnFailure(result) || stdout === null) {
      return { kind, groups: [] };
    }
    const validDirs = new Set(skills.map((s) => s.dir));
    // partitionSkills re-validates and gates whatever crosses the GroupSkillsFn seam
    // (it must — the seam accepts arbitrary BYO functions); the filtering here only
    // keeps the cached artifact and the empty-output signal clean.
    const groups = parseClusterResponse(stdout, validDirs) ?? [];
    if (groups.length === 0 || dir === null) {
      return { kind, groups };
    }
    // Caching is committed by the orchestrator iff the acceptance gate passes: a
    // parseable-but-rejected response (e.g. one giant group) replayed from cache
    // would permanently disable the stochastic LLM rescue for this skill set.
    return {
      kind,
      groups,
      commit: (): void => {
        writeCacheFile(join(dir, `${cacheKey}.json`), groups);
      },
    };
  };
}

/**
 * Did the PROCESS fail: errored, signalled (e.g. SIGTERM on timeout), or exited
 * non-zero. On timeout the runner reports { signal: "SIGTERM", error: ETIMEDOUT } —
 * so we key on error/signal, not status. Output presence is the caller's check.
 */
function isSpawnFailure(result: SpawnResult): boolean {
  return (
    result.error !== undefined ||
    result.signal !== null ||
    (result.status !== null && result.status !== 0)
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
  // JSON framing keeps entry boundaries unambiguous: "\n"-joining raw fields would
  // let distinct skill sets collide once a description itself contains newlines.
  const material = JSON.stringify([
    backendId,
    [...skills].map((s) => [s.dir, s.product ?? "", s.description]).sort(),
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
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

function readCacheFile(file: string): RawGroup[] | null {
  try {
    return validateRawGroups(readJsonFile(file)); // missing/unreadable/invalid -> null
  } catch {
    return null;
  }
}

function writeCacheFile(file: string, groups: RawGroup[]): void {
  try {
    writeFileSync(file, JSON.stringify(groups), "utf8");
  } catch {
    // best-effort cache; ignore write failures
  }
}
