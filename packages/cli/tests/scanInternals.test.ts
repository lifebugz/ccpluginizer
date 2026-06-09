import { describe, expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import {
  resolveLlmConfig,
  printSplitNotice,
  printNoSplitNotice,
  reviewSplit,
  makeLazyGrouper,
} from "../src/commands/scan.ts";
import type { ResolvedGrouper } from "../src/commands/llmGrouper.ts";
import type { LlmOutcome } from "../src/detector/partition.ts";
import type { SynthesizeEntriesResult } from "../src/detector/synthesize.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

const SUBPROCESS: ResolvedGrouper = { fn: () => Promise.resolve([]), backendId: "x", kind: "subprocess" };

const NOT_INVOKED: LlmOutcome = { step: "not-invoked" };
const NO_BACKEND: LlmOutcome = { step: "no-backend" };
const NO_OUTPUT: LlmOutcome = { step: "no-output", kind: "subprocess" };
const GATE_REJECTED: LlmOutcome = { step: "gate-rejected", kind: "subprocess" };

function splitResult(
  strategy: "marker" | "llm" | "metadata" | "directory" | "name-prefix",
  llm: LlmOutcome = NOT_INVOKED,
): SynthesizeEntriesResult {
  return {
    entries: [
      { name: "x-core", source: { source: "url", url: "https://github.com/local/x.git" }, strict: false },
      { name: "x-a", source: { source: "git-subdir", url: "https://github.com/local/x.git", path: "." }, strict: false, skills: ["./a/"] },
    ],
    split: { strategy, groupCount: 1 },
    marker: { name: "x", core: true, umbrella: false, groups: [{ slug: "a", skills: ["./a/"] }] },
    existingMarker: null,
    warnings: [],
    splitAttemptedButEmpty: false,
    llm,
  };
}

function capture(fn: () => void): string {
  const spy = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    fn();
    return spy.mock.calls.map((c) => c.map((a) => String(a)).join(" ")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

describe("resolveLlmConfig", () => {
  test("flag wins over env per setting", () => {
    const c = resolveLlmConfig({ llmCmd: "flag-cmd" }, { CCPLUGINIZER_LLM_CMD: "env-cmd" });
    expect(c.cmd).toBe("flag-cmd");
    expect(c.cmdFromEnv).toBe(false);
  });

  test("whitespace-only flag falls through to env", () => {
    const c = resolveLlmConfig({ llmCmd: "   " }, { CCPLUGINIZER_LLM_CMD: "env-cmd" });
    expect(c.cmd).toBe("env-cmd");
    expect(c.cmdFromEnv).toBe(true);
  });

  test("cmdFromEnv true only when value came from env", () => {
    expect(resolveLlmConfig({}, { CCPLUGINIZER_LLM_CMD: "x" }).cmdFromEnv).toBe(true);
    expect(resolveLlmConfig({ llmCmd: "x" }, {}).cmdFromEnv).toBe(false);
    expect(resolveLlmConfig({}, {}).cmdFromEnv).toBe(false);
  });

  test("timeoutMs: flag seconds, then env seconds, then 120s default", () => {
    expect(resolveLlmConfig({ llmTimeout: 5 }, {}).timeoutMs).toBe(5000);
    expect(resolveLlmConfig({}, { CCPLUGINIZER_LLM_TIMEOUT: "7" }).timeoutMs).toBe(7000);
    expect(resolveLlmConfig({}, {}).timeoutMs).toBe(120000);
  });

  test("non-finite / non-positive / non-numeric timeout coerces to the 120s default", () => {
    expect(resolveLlmConfig({ llmTimeout: 0 }, {}).timeoutMs).toBe(120000);
    expect(resolveLlmConfig({ llmTimeout: -3 }, {}).timeoutMs).toBe(120000);
    expect(resolveLlmConfig({}, { CCPLUGINIZER_LLM_TIMEOUT: "abc" }).timeoutMs).toBe(120000);
  });

  test("all-empty yields no cmd and the default timeout", () => {
    const c = resolveLlmConfig({}, {});
    expect(c.cmd).toBeUndefined();
    expect(c.timeoutMs).toBe(120000);
  });
});

describe("printSplitNotice taxonomy", () => {
  test("marker -> committed-marker line, no LLM/deterministic qualifier", () => {
    const out = capture(() => { printSplitNotice(splitResult("marker"), NOT_INVOKED); });
    expect(out).toContain("via committed marker (.ccpluginizer.json)");
    expect(out).not.toMatch(/LLM backend/);
  });

  test("llm result names the backend kind", () => {
    expect(capture(() => { printSplitNotice(splitResult("llm"), { step: "won", kind: "subprocess" }); }))
      .toContain("via subprocess clustering");
    expect(capture(() => { printSplitNotice(splitResult("llm"), { step: "won", kind: "claude" }); }))
      .toContain("via claude clustering");
  });

  test("deterministic after a failed LLM step reports the exact reason", () => {
    expect(capture(() => { printSplitNotice(splitResult("name-prefix"), NO_OUTPUT); }))
      .toContain("(the LLM backend was unreachable or produced no output)");
    expect(capture(() => { printSplitNotice(splitResult("name-prefix"), GATE_REJECTED); }))
      .toContain("(the LLM grouping was rejected by the acceptance gate)");
    expect(capture(() => { printSplitNotice(splitResult("name-prefix"), NO_BACKEND); }))
      .toContain("(no LLM backend found; set --llm-cmd or install the `claude` CLI)");
  });

  test("deterministic with the LLM never invoked -> plain notice, no LLM mention", () => {
    const out = capture(() => { printSplitNotice(splitResult("metadata"), NOT_INVOKED); });
    expect(out).toContain("via metadata clustering");
    expect(out).not.toMatch(/LLM/);
    expect(out).not.toMatch(/clustering \(/); // no parenthesized fallback reason
  });
});

describe("printNoSplitNotice", () => {
  test("gate-rejected LLM grouping -> exact phrasing, names the cluster", () => {
    expect(capture(() => { printNoSplitNotice("auto-llm", GATE_REJECTED); }))
      .toBe("ccpluginizer: --cluster=auto-llm produced no split — the LLM grouping was rejected by the acceptance gate, and no clean deterministic partition; emitting a single entry.");
  });
  test("backend ran but produced nothing -> unreachable phrasing", () => {
    expect(capture(() => { printNoSplitNotice("auto-llm", NO_OUTPUT); }))
      .toBe("ccpluginizer: --cluster=auto-llm produced no split — the LLM backend was unreachable or produced no output, and no clean deterministic partition; emitting a single entry.");
  });
  test("no backend -> the actionable hint, same as the split-notice variant", () => {
    expect(capture(() => { printNoSplitNotice("llm", NO_BACKEND); }))
      .toBe("ccpluginizer: --cluster=llm produced no split — no LLM backend found; set --llm-cmd or install the `claude` CLI, and no clean deterministic partition; emitting a single entry.");
  });
});

describe("makeLazyGrouper", () => {
  test("does not resolve the backend until first invocation, then memoizes", async () => {
    let resolves = 0;
    const fn = makeLazyGrouper({ cmdFromEnv: false, timeoutMs: 1000 }, () => {
      resolves += 1;
      return SUBPROCESS;
    });
    expect(resolves).toBe(0);
    await fn([]);
    await fn([]);
    expect(resolves).toBe(1);
  });

  test("wraps backend output in the GrouperRun contract (kind + groups)", async () => {
    const backend: ResolvedGrouper = {
      fn: () => Promise.resolve([{ slug: "a", members: ["x"] }]),
      backendId: "b",
      kind: "subprocess",
    };
    const fn = makeLazyGrouper({ cmdFromEnv: false, timeoutMs: 1000 }, () => backend);
    expect(await fn([])).toEqual({ kind: "subprocess", groups: [{ slug: "a", members: ["x"] }] });
  });

  test("returns null (no backend) without crashing when nothing resolves", async () => {
    const fn = makeLazyGrouper({ cmdFromEnv: false, timeoutMs: 1000 }, () => null);
    expect(await fn([])).toBeNull();
  });
});

describe("reviewSplit (confirmFn seam)", () => {
  test("decline re-synthesizes a single entry; no partition re-attempt", async () => {
    const out = await reviewSplit(
      splitResult("name-prefix"),
      { repoPath: join(FIXTURES, "skills-only"), sourceRepo: "local/skills-only" },
      () => Promise.resolve(false),
    );
    expect(out.split).toBeNull();
    expect(out.splitAttemptedButEmpty).toBe(false);
  });

  test("accept returns the original result unchanged", async () => {
    const original = splitResult("metadata");
    const out = await reviewSplit(
      original,
      { repoPath: join(FIXTURES, "skills-only"), sourceRepo: "local/skills-only" },
      () => Promise.resolve(true),
    );
    expect(out).toBe(original);
  });
});
