import { describe, expect, test, beforeEach } from "bun:test";
import {
  buildClusterPrompt,
  parseClusterResponse,
  validateRawGroups,
  resolveGrouper,
  type SpawnRun,
} from "../src/commands/llmGrouper.ts";
import type { SkillMeta } from "../src/detector/skillMeta.ts";
import { captureStderr, mk, tempDir } from "./helpers.ts";
import { chmodSync, readdirSync } from "node:fs";

describe("validateRawGroups (disk-cache shape guard)", () => {
  test("accepts a well-formed cache", () => {
    expect(validateRawGroups([{ slug: "x", members: ["a", "b"] }])).toEqual([
      { slug: "x", members: ["a", "b"] },
    ]);
  });

  test("rejects a poisoned cache (null element, non-array, wrong shape)", () => {
    expect(validateRawGroups([null, { slug: "x", members: ["a"] }])).toBeNull();
    expect(validateRawGroups("not an array")).toBeNull();
    expect(validateRawGroups([{ slug: 5, members: ["a"] }])).toBeNull();
    expect(validateRawGroups([{ slug: "x", members: "nope" }])).toBeNull();
  });
});

const SKILLS = [mk("telnyx-voice-curl", "voice"), mk("telnyx-messaging-curl", "messaging")];

describe("buildClusterPrompt", () => {
  test("includes each skill dir and asks for a JSON array of groups", () => {
    const prompt = buildClusterPrompt(SKILLS);
    expect(prompt).toContain("telnyx-voice-curl");
    expect(prompt).toContain("telnyx-messaging-curl");
    expect(prompt.toLowerCase()).toContain("json");
    expect(prompt).toContain("members");
  });
});

describe("buildClusterPrompt: newline hygiene", () => {
  test("flattens literal-block-scalar newlines so each skill stays on one line", () => {
    const skill: SkillMeta = {
      path: "./multi/",
      dir: "multi",
      name: "multi",
      description: "line one\nline two\n- not a skill entry",
    };
    const prompt = buildClusterPrompt([skill]);
    expect(prompt).toContain("- multi: line one line two - not a skill entry");
  });
});

describe("parseClusterResponse", () => {
  const validDirs = new Set(["telnyx-voice-curl", "telnyx-messaging-curl"]);

  test("survives brackets in leading prose (does not anchor on the first '[')", () => {
    const text = `Here are the groups [1]:\n[{"slug":"voice","members":["telnyx-voice-curl"]}]`;
    const groups = parseClusterResponse(text, validDirs);
    expect(groups?.length).toBe(1);
    expect(groups?.[0]?.slug).toBe("voice");
  });

  test("extracts a JSON array embedded in prose", () => {
    const text = `Here are the groups:\n[{"slug":"voice","members":["telnyx-voice-curl"]},{"slug":"messaging","members":["telnyx-messaging-curl"]}]\nDone.`;
    const groups = parseClusterResponse(text, validDirs);
    expect(groups).not.toBeNull();
    expect(groups?.length).toBe(2);
    expect(groups?.[0]?.slug).toBe("voice");
  });

  test("drops members that are not real skill dirs", () => {
    const text = `[{"slug":"voice","members":["telnyx-voice-curl","hallucinated-skill"]}]`;
    const groups = parseClusterResponse(text, validDirs);
    expect(groups?.[0]?.members).toEqual(["telnyx-voice-curl"]);
  });

  test("returns null when there is no JSON array", () => {
    expect(parseClusterResponse("I cannot help with that.", validDirs)).toBeNull();
  });

  test("drops groups with no valid members", () => {
    const text = `[{"slug":"ghost","members":["nope"]},{"slug":"voice","members":["telnyx-voice-curl"]}]`;
    const groups = parseClusterResponse(text, validDirs);
    expect(groups?.length).toBe(1);
    expect(groups?.[0]?.slug).toBe("voice");
  });
});

const VALID_JSON = JSON.stringify([
  { slug: "voice", members: ["telnyx-voice-curl"] },
  { slug: "messaging", members: ["telnyx-messaging-curl"] },
]);

/** A fake spawn that returns a fixed result and records how often it ran. */
function fakeRun(result: ReturnType<SpawnRun>): { run: SpawnRun; calls: () => number } {
  let n = 0;
  const run: SpawnRun = (): ReturnType<SpawnRun> => {
    n += 1;
    return result;
  };
  return { run, calls: (): number => n };
}

const ok = (stdout: string): ReturnType<SpawnRun> => ({ signal: null, status: 0, stdout });

function fnOf(r: ReturnType<typeof resolveGrouper>): NonNullable<ReturnType<typeof resolveGrouper>>["fn"] {
  if (r === null) {
    throw new Error("expected a resolved grouper");
  }
  return r.fn;
}

describe("resolveGrouper: two-tier precedence", () => {
  test("cmd present uses the subprocess backend, never consulting claude", () => {
    const which = (): string | null => "/usr/bin/claude"; // would be found, must be ignored
    const r = resolveGrouper(
      { cmd: "my-grouper", cmdFromEnv: false, timeoutMs: 1000 },
      { run: fakeRun(ok(VALID_JSON)).run, which, cacheDir: () => tempDir("ccp-c-") },
    );
    expect(r?.kind).toBe("subprocess");
    expect(r?.backendId).toBe("my-grouper");
  });

  test("no cmd but claude on PATH uses the claude backend", () => {
    const r = resolveGrouper(
      { cmdFromEnv: false, timeoutMs: 1000 },
      { run: fakeRun(ok(VALID_JSON)).run, which: () => "/usr/bin/claude", cacheDir: () => tempDir("ccp-c-") },
    );
    expect(r?.kind).toBe("claude");
    expect(r?.backendId).toBe("claude");
  });

  test("no cmd and no claude returns null", () => {
    const r = resolveGrouper({ cmdFromEnv: false, timeoutMs: 1000 }, { which: () => null });
    expect(r).toBeNull();
  });
});

describe("subprocess backend: execution, failure, provenance, cache", () => {
  let cacheRoot: string;
  beforeEach(() => {
    cacheRoot = tempDir("ccp-cache-"); // fresh per test; removed by the shared exit hook
  });

  test("parses stdout into RawGroups with a cache-commit hook", async () => {
    const r = resolveGrouper(
      { cmd: "x", cmdFromEnv: false, timeoutMs: 1000 },
      { run: fakeRun(ok(VALID_JSON)).run, cacheDir: () => cacheRoot },
    );
    const run = await fnOf(r)(SKILLS);
    expect(run.groups.length).toBe(2);
    expect(run.commit).toBeDefined(); // committed by the orchestrator iff the gate passes
  });

  test("returns [] on the corrected failure set (error / signal / non-zero status / unparseable)", async () => {
    const cases: ReturnType<SpawnRun>[] = [
      { error: new Error("ETIMEDOUT"), signal: "SIGTERM", status: null, stdout: null }, // timeout shape
      { signal: "SIGKILL", status: null, stdout: "" },
      { signal: null, status: 1, stdout: "" },
      { signal: null, status: 0, stdout: "not json" },
    ];
    for (const c of cases) {
      const r = resolveGrouper(
        { cmd: "x", cmdFromEnv: false, timeoutMs: 1000 },
        { run: fakeRun(c).run, cacheDir: () => cacheRoot },
      );
      expect((await fnOf(r)(SKILLS)).groups).toEqual([]);
    }
  });

  test("emits the provenance notice iff fromEnv", async () => {
    const fromEnvOut = await captureStderr(async () => {
      const fromEnv = resolveGrouper(
        { cmd: "secret-cmd", cmdFromEnv: true, timeoutMs: 1000 },
        { run: fakeRun(ok(VALID_JSON)).run, cacheDir: () => cacheRoot },
      );
      await fnOf(fromEnv)(SKILLS);
    });
    expect(fromEnvOut).toContain("secret-cmd");

    const fromFlagOut = await captureStderr(async () => {
      const fromFlag = resolveGrouper(
        { cmd: "secret-cmd", cmdFromEnv: false, timeoutMs: 1000 },
        { run: fakeRun(ok(VALID_JSON)).run, cacheDir: () => cacheRoot },
      );
      await fnOf(fromFlag)(SKILLS);
    });
    expect(fromFlagOut).toBe("");
  });

  test("committed results are cached and served without re-running", async () => {
    const f = fakeRun(ok(VALID_JSON));
    const r = resolveGrouper({ cmd: "x", cmdFromEnv: false, timeoutMs: 1000 }, { run: f.run, cacheDir: () => cacheRoot });
    (await fnOf(r)(SKILLS)).commit?.(); // the orchestrator commits gate-passing runs
    const second = await fnOf(r)(SKILLS);
    expect(f.calls()).toBe(1); // second call served from cache
    expect(second.commit).toBeUndefined(); // cache hits never re-commit
  });

  test("a different backendId (cmd string) is a cache miss", async () => {
    const a = fakeRun(ok(VALID_JSON));
    const b = fakeRun(ok(VALID_JSON));
    (await fnOf(resolveGrouper({ cmd: "a", cmdFromEnv: false, timeoutMs: 1000 }, { run: a.run, cacheDir: () => cacheRoot }))(SKILLS)).commit?.();
    await fnOf(resolveGrouper({ cmd: "b", cmdFromEnv: false, timeoutMs: 1000 }, { run: b.run, cacheDir: () => cacheRoot }))(SKILLS);
    expect(b.calls()).toBe(1); // distinct cmd -> not served from a's cache entry
  });

  test("--llm-cmd 'claude' and the built-in claude backend never share a cache entry", async () => {
    const viaCmd = fakeRun(ok(VALID_JSON));
    const viaCli = fakeRun(ok(VALID_JSON));
    (await fnOf(resolveGrouper({ cmd: "claude", cmdFromEnv: false, timeoutMs: 1000 }, { run: viaCmd.run, cacheDir: () => cacheRoot }))(SKILLS)).commit?.();
    await fnOf(resolveGrouper({ cmdFromEnv: false, timeoutMs: 1000 }, { run: viaCli.run, which: () => "/usr/bin/claude", cacheDir: () => cacheRoot }))(SKILLS);
    expect(viaCli.calls()).toBe(1); // namespaced ids: the shell command's entry is not replayed
  });

  test("does not cache an empty/failed result", async () => {
    const f = fakeRun(ok("not json"));
    const r = resolveGrouper({ cmd: "x", cmdFromEnv: false, timeoutMs: 1000 }, { run: f.run, cacheDir: () => cacheRoot });
    await fnOf(r)(SKILLS);
    await fnOf(r)(SKILLS);
    expect(f.calls()).toBe(2); // empty result never cached -> re-runs
  });

  test("an uncommitted (gate-rejected) grouping is never cached — the LLM retries", async () => {
    const rejected = JSON.stringify([
      { slug: "all", members: ["telnyx-voice-curl", "telnyx-messaging-curl"] },
    ]); // K=1 fails the acceptance gate, so the orchestrator never calls commit
    const f = fakeRun(ok(rejected));
    const r = resolveGrouper({ cmd: "x", cmdFromEnv: false, timeoutMs: 1000 }, { run: f.run, cacheDir: () => cacheRoot });
    await fnOf(r)(SKILLS); // commit deliberately NOT invoked
    await fnOf(r)(SKILLS);
    expect(f.calls()).toBe(2); // uncached -> the stochastic LLM retries
  });

  test("the claude backend sends the prompt on stdin, not argv (avoids E2BIG)", async () => {
    let seenArgs: readonly string[] = [];
    let seenInput: string | undefined;
    const run: SpawnRun = (_cmd, args, options): ReturnType<SpawnRun> => {
      seenArgs = args;
      seenInput = options.input;
      return ok(VALID_JSON);
    };
    const r = resolveGrouper(
      { cmdFromEnv: false, timeoutMs: 1000 },
      { run, which: () => "/usr/bin/claude", cacheDir: () => cacheRoot },
    );
    await fnOf(r)(SKILLS);
    expect(seenArgs).toEqual(["-p"]);
    expect(seenInput).toContain("Skills:");
  });

  test("refuses a group/other-accessible cache dir (stat-and-refuse guard)", async () => {
    if (process.getuid === undefined) {
      return; // POSIX-only guard; skip on platforms without uid semantics
    }
    chmodSync(cacheRoot, 0o777);
    const f = fakeRun(ok(VALID_JSON));
    const r = resolveGrouper({ cmd: "x", cmdFromEnv: false, timeoutMs: 1000 }, { run: f.run, cacheDir: () => cacheRoot });
    (await fnOf(r)(SKILLS)).commit?.();
    expect(readdirSync(cacheRoot).length).toBe(0); // nothing written into a world-accessible dir
  });
});
