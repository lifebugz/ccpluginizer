import { describe, expect, test, beforeAll } from "bun:test";
import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";

const FIXTURES = join(import.meta.dirname, "fixtures");

import { makeNestedPlugin, runScan, tempDir } from "./helpers.ts";

describe("scan CLI: output shapes", () => {
  let root: string;
  beforeAll(() => {
    root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
  });

  test("sub-threshold repo prints a single JSON object (byte-compatible)", async () => {
    const { stdout, code } = await runScan([join(FIXTURES, "skills-only")]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(false);
    expect((parsed as { name?: unknown }).name).toBe("local-skills-only");
  }, 30_000);

  test("split prints a JSON array of core + slices, with a stderr notice", async () => {
    const { stdout, stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2"]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    const names = (parsed as { name: string }[]).map((e) => e.name);
    expect(names.some((n) => n.endsWith("-core"))).toBe(true);
    expect(names.some((n) => n.endsWith("-messaging"))).toBe(true);
    expect(names.some((n) => n.endsWith("-voice"))).toBe(true);
    expect(stderr).toContain("split into");
    expect(stderr).toContain("metadata");
  }, 30_000);

  test("--no-split forces a single object even above threshold", async () => {
    const { stdout, code } = await runScan([root, "--no-split", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(false);
  }, 30_000);

  test("--umbrella adds the everything-entry (strict:true)", async () => {
    const { stdout } = await runScan([root, "--cluster=metadata", "--min-skills=2", "--umbrella"]);
    const entries = JSON.parse(stdout) as { name: string; strict?: boolean }[];
    const umbrella = entries.find((e) => e.strict === true);
    expect(umbrella).toBeDefined();
  }, 30_000);
});

describe("scan CLI: --out-dir and --write-marker", () => {
  let root: string;
  beforeAll(() => {
    root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
  });

  test("--out-dir writes one JSON file per entry", async () => {
    const outDir = tempDir("ccp-out-");
    const { code } = await runScan([root, "--cluster=metadata", "--min-skills=2", `--out-dir=${outDir}`]);
    expect(code).toBe(0);
    const files = readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
    expect(files.some((f) => f.endsWith("-core.json"))).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(3); // core + 2 slices
  }, 30_000);

  test("--write-marker freezes the grouping into .ccpluginizer.json", async () => {
    const { code } = await runScan([root, "--cluster=metadata", "--min-skills=2", "--write-marker"]);
    expect(code).toBe(0);
    const markerPath = join(root, ".ccpluginizer.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { groups?: unknown[] };
    expect(Array.isArray(marker.groups)).toBe(true);
    expect(marker.groups?.length).toBe(2);
  }, 30_000);
});

describe("scan CLI: warnings + message gating", () => {
  test("prints dropped-artifact warnings (hooks, commands) to stderr, not stdout", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 }, hooks: true, commands: true });
    const { stdout, stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/warning/i);
    expect(stderr).toMatch(/hooks/);
    expect(stderr).toMatch(/commands/);
    // stdout must remain pure JSON (parseable), no warning text
    expect(() => {
      JSON.parse(stdout);
    }).not.toThrow();
  }, 30_000);

  test("--no-split --cluster=llm emits no eager backend notice", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const { stderr, code } = await runScan([root, "--no-split", "--cluster=llm", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/claude/i);
    expect(stderr).not.toMatch(/no LLM backend/i); // no split happened -> no split notice
  }, 30_000);
});

describe("scan CLI: deterministic-default + decision-B hint", () => {
  test("auto with CCPLUGINIZER_LLM_CMD set emits the hint and runs no command", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const sentinel = join(tempDir("ccp-sent-"), "ran");
    const { stderr, stdout, code } = await runScan(
      [root, "--cluster=auto", "--min-skills=2"],
      { env: { CCPLUGINIZER_LLM_CMD: `touch ${sentinel}` } },
    );
    expect(code).toBe(0);
    expect(stderr).toMatch(/auto is deterministic-only/);
    expect(existsSync(sentinel)).toBe(false); // command never executed under auto
    expect(Array.isArray(JSON.parse(stdout))).toBe(true); // still a deterministic split
  }, 30_000);

  test("auto with no LLM config emits no hint", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const { stderr, code } = await runScan([root, "--cluster=auto", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/deterministic-only/);
  }, 30_000);
});

describe("scan CLI: --cluster=llm notices", () => {
  test("no backend + a deterministic split -> (no LLM backend found) notice", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const { stderr, stdout, code } = await runScan([root, "--cluster=llm", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/no LLM backend found/);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  }, 30_000);

  test("sub-threshold -> no notice at all", async () => {
    const { stderr, code } = await runScan([join(FIXTURES, "skills-only"), "--cluster=llm"]);
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/no LLM backend|produced no split/);
  }, 30_000);

  test("above threshold but no clean partition + no backend -> produced-no-split notice, single entry", async () => {
    const root = makeNestedPlugin({ products: { solo: 30 } });
    const { stderr, stdout, code } = await runScan([root, "--cluster=llm", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/--cluster=llm produced no split/);
    expect(stderr).toMatch(/no LLM backend found/);
    expect(Array.isArray(JSON.parse(stdout))).toBe(false); // single entry
  }, 30_000);
});

/** A valid 2-group cover of telnyx-solo-0..5 (each group 3 of 6 -> passes the gate). */
const SOLO6_JSON = JSON.stringify([
  { slug: "x", members: ["telnyx-solo-0", "telnyx-solo-1", "telnyx-solo-2"] },
  { slug: "y", members: ["telnyx-solo-3", "telnyx-solo-4", "telnyx-solo-5"] },
]);

describe("scan CLI: subprocess backend (--llm-cmd)", () => {
  test("a valid stub rescues a repo deterministic can't partition; notice names subprocess", async () => {
    const root = makeNestedPlugin({ products: { solo: 6 } });
    const home = tempDir("ccp-home-"); // cold cache
    const cmd = `cat >/dev/null; printf '%s' '${SOLO6_JSON}'`;
    const { stderr, stdout, code } = await runScan(
      [root, "--cluster=auto-llm", "--min-skills=2", `--llm-cmd=${cmd}`],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect(stderr).toMatch(/via subprocess clustering/);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  }, 30_000);

  test("--llm-timeout is honored: a slow stub times out and falls back to deterministic", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } }); // deterministic succeeds on fallback
    const home = tempDir("ccp-home-");
    const { stderr, stdout, code } = await runScan(
      [root, "--cluster=llm", "--min-skills=2", "--llm-timeout=1", "--llm-cmd=sleep 5"],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true); // deterministic split emitted
    expect(stderr).toMatch(/the LLM backend was unreachable or produced no usable output/);
  }, 30_000);

  test("flag overrides env for --llm-cmd", async () => {
    const root = makeNestedPlugin({ products: { solo: 6 } });
    const home = tempDir("ccp-home-");
    const envSentinel = join(tempDir("ccp-sent-"), "env-ran");
    const flagCmd = `cat >/dev/null; printf '%s' '${SOLO6_JSON}'`;
    const { stdout, code } = await runScan(
      [root, "--cluster=auto-llm", "--min-skills=2", `--llm-cmd=${flagCmd}`],
      { env: { HOME: home, CCPLUGINIZER_LLM_CMD: `touch ${envSentinel}` } },
    );
    expect(code).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
    expect(existsSync(envSentinel)).toBe(false); // env command never ran; the flag won
  }, 30_000);
});

describe("scan CLI: marker short-circuit beats a configured LLM", () => {
  test("committed marker + CCPLUGINIZER_LLM_CMD set -> marker notice only, command not run", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    // Freeze a grouping first, then re-scan with an env command that would touch a sentinel.
    await runScan([root, "--cluster=metadata", "--min-skills=2", "--write-marker"]);
    const sentinel = join(tempDir("ccp-sent-"), "ran");
    const { stderr, code } = await runScan(
      [root, "--cluster=llm", "--min-skills=2"],
      { env: { CCPLUGINIZER_LLM_CMD: `touch ${sentinel}` } },
    );
    expect(code).toBe(0);
    expect(stderr).toMatch(/via committed marker \(\.ccpluginizer\.json\)/);
    expect(stderr).not.toMatch(/no LLM backend|running LLM grouper/);
    expect(existsSync(sentinel)).toBe(false); // marker short-circuit -> grouper never invoked
  }, 30_000);
});

describe("scan CLI: auto-llm reproducibility + rescue", () => {
  test("well-named repo: deterministic wins, stub never runs, bytes identical to auto", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const sentinel = join(tempDir("ccp-sent-"), "ran");
    const auto = await runScan([root, "--cluster=auto", "--min-skills=2"]);
    const autoLlm = await runScan(
      [root, "--cluster=auto-llm", "--min-skills=2", `--llm-cmd=touch ${sentinel}; printf '%s' '${SOLO6_JSON}'`],
    );
    expect(auto.code).toBe(0);
    expect(autoLlm.code).toBe(0);
    expect(autoLlm.stdout).toBe(auto.stdout); // byte-identical entries
    expect(autoLlm.stderr).not.toMatch(/running LLM grouper|deterministic-only/); // no provenance, no hint
    expect(existsSync(sentinel)).toBe(false); // grouper never executed
  }, 30_000);

  test("unpartitionable repo + rejecting stub -> produced-no-split naming auto-llm (resolved variant)", async () => {
    const root = makeNestedPlugin({ products: { solo: 6 } });
    const home = tempDir("ccp-home-");
    const { stderr, stdout, code } = await runScan(
      [root, "--cluster=auto-llm", "--min-skills=2", "--llm-cmd=cat >/dev/null; printf 'not json'"],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect(stderr).toMatch(/--cluster=auto-llm produced no split/);
    expect(stderr).toMatch(/the LLM backend was unreachable or produced no usable output/);
    expect(Array.isArray(JSON.parse(stdout))).toBe(false); // single entry
  }, 30_000);

  test("unpartitionable repo + no backend -> produced-no-split naming auto-llm (degrade variant)", async () => {
    const root = makeNestedPlugin({ products: { solo: 6 } });
    const { stderr, code } = await runScan([root, "--cluster=auto-llm", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/--cluster=auto-llm produced no split/);
    expect(stderr).toMatch(/no LLM backend found/);
  }, 30_000);
});

describe("scan CLI: --write-marker merge + --out-dir hygiene", () => {
  test("--write-marker preserves hand-curated marker fields on refresh", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    await runScan([root, "--cluster=metadata", "--min-skills=2", "--write-marker"]);
    const markerPath = join(root, ".ccpluginizer.json");
    const before = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      markerPath,
      JSON.stringify({ ...before, description: "Curated.", license: "MIT" }, null, 2) + "\n",
    );
    const { code } = await runScan([root, "--min-skills=2", "--write-marker"]);
    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(after["description"]).toBe("Curated."); // curation survives the refresh
    expect(after["license"]).toBe("MIT");
    expect(Array.isArray(after["groups"])).toBe(true);
  }, 30_000);

  test("local-path scans never claim stale ownership (placeholder URLs collide by basename)", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const outDir = tempDir("ccp-stale-");
    await runScan([root, "--cluster=metadata", "--min-skills=2", `--out-dir=${outDir}`]);
    const coreFile = readdirSync(outDir).find((f) => f.endsWith("-core.json"));
    expect(coreFile).toBeDefined();
    const core = JSON.parse(readFileSync(join(outDir, coreFile ?? ""), "utf8")) as { source: { url: string } };
    const base = (coreFile ?? "").replace(/-core\.json$/, "");
    const staleName = `${base}-oldslice.json`;
    // Two unrelated local repos with the same directory basename share one
    // placeholder URL, so ownership is unprovable — the scan must stay quiet
    // rather than steer the user to delete a sibling repo's live entries.
    writeFileSync(
      join(outDir, staleName),
      JSON.stringify({ name: `${base}-oldslice`, source: core.source, strict: false }) + "\n",
    );
    const { stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2", `--out-dir=${outDir}`]);
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/previous scan/);
    expect(existsSync(join(outDir, staleName))).toBe(true); // never deleted either
  }, 30_000);
});

describe("scan CLI: third-wave regressions", () => {
  test("Decision-B hint stays silent on a sub-threshold repo (no split could use the LLM)", async () => {
    const { stderr, code } = await runScan(
      [join(FIXTURES, "skills-only"), "--cluster=auto"],
      { env: { CCPLUGINIZER_LLM_CMD: "echo hi" } },
    );
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/deterministic-only/);
  }, 30_000);

  test("an unknown --cluster value fails loudly instead of degrading to auto", async () => {
    const { stderr, code } = await runScan([join(FIXTURES, "skills-only"), "--cluster=auot"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown --cluster "auot"/);
  }, 30_000);

  test("--no-split --umbrella prints the ignored-flag notice", async () => {
    const { stderr, code } = await runScan([join(FIXTURES, "skills-only"), "--no-split", "--umbrella"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/--umbrella is ignored with --no-split/);
  }, 30_000);
});

describe("scan CLI: fourth-wave regressions", () => {
  test("--out-dir= (empty value) behaves like an absent flag, not mkdir('')", async () => {
    const { stdout, code } = await runScan([join(FIXTURES, "skills-only"), "--out-dir="]);
    expect(code).toBe(0);
    expect(() => {
      JSON.parse(stdout); // fell back to stdout emission
    }).not.toThrow();
  }, 30_000);

  test("a forced deterministic strategy that finds no partition explains itself", async () => {
    const root = makeNestedPlugin({ products: { solo: 30 } });
    const { stderr, stdout, code } = await runScan([root, "--cluster=metadata", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/--cluster=metadata produced no split — no clean deterministic partition/);
    expect(Array.isArray(JSON.parse(stdout))).toBe(false); // single entry
  }, 30_000);
});

describe("scan CLI: fifth-wave regressions", () => {
  test("a configured LLM is also reported as ignored under forced deterministic strategies", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const { stderr, code } = await runScan(
      [root, "--cluster=metadata", "--min-skills=2"],
      { env: { CCPLUGINIZER_LLM_CMD: "echo hi" } },
    );
    expect(code).toBe(0);
    expect(stderr).toMatch(/--cluster=metadata is deterministic-only/);
  }, 30_000);

  test("interactive mode surfaces the proposal's warnings BEFORE the review prompt, once", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 }, hooks: true });
    // Non-TTY stdin auto-accepts the confirm default; the ordering (and the absence
    // of a duplicate print on accept) is what this pins. The decline path's warning
    // carry-over is covered by the reviewSplit unit seam + the shared caches test.
    const { stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2", "--interactive"]);
    expect(code).toBe(0);
    const warnIdx = stderr.indexOf("non-skill artifacts");
    const proposalIdx = stderr.indexOf("proposed split");
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(proposalIdx).toBeGreaterThan(warnIdx); // warnings precede the prompt
    expect(stderr.indexOf("non-skill artifacts", warnIdx + 1)).toBe(-1); // and print once
  }, 30_000);
});

describe("scan CLI: sixth-wave regressions", () => {
  test("a split-suppressing marker says so when --cluster was explicitly steered", async () => {
    const root = makeNestedPlugin({
      products: { messaging: 4, voice: 4 },
      marker: { name: "curated", skills: ["./providers/claude/plugin/skills/"] },
    });
    const { stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/curates a single entry, so --cluster\/--llm-cmd were not consulted/);
  }, 30_000);

  test("a one-group marker-frozen split emits a JSON array, not a bare object", async () => {
    const root = makeNestedPlugin({
      products: { solo: 4 },
      marker: {
        name: "frozen",
        core: false,
        groups: [{ slug: "all", skills: [0, 1, 2, 3].map((i) => `./telnyx-solo-${String(i)}/`) }],
      },
    });
    const { stdout, code } = await runScan([root, "--min-skills=2"]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true); // the split contract, even at K=1
    expect((parsed as unknown[]).length).toBe(1);
  }, 30_000);
});

describe("scan CLI: --write-marker round-trip is byte-identical (regression fence)", () => {
  test("re-scanning through the frozen marker reproduces the split's stdout exactly", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });

    // 1. A clean deterministic split — the stdout the round-trip must reproduce.
    const first = await runScan([root, "--cluster=metadata", "--min-skills=2"]);
    expect(first.code).toBe(0);
    expect(Array.isArray(JSON.parse(first.stdout))).toBe(true);

    // 2. Freeze that grouping into .ccpluginizer.json via the flag under test.
    const frozen = await runScan([root, "--cluster=metadata", "--min-skills=2", "--write-marker"]);
    expect(frozen.code).toBe(0);
    expect(existsSync(join(root, ".ccpluginizer.json"))).toBe(true);

    // 3. Re-scan with NO --cluster flag: the committed marker must drive the grouping.
    const second = await runScan([root, "--min-skills=2"]);
    expect(second.code).toBe(0);

    // Entries (stdout) are byte-identical; provenance differs only on stderr.
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).toMatch(/via committed marker \(\.ccpluginizer\.json\)/);
    // A just-written marker exact-matches every skill: no staleness/fuzzy warnings.
    expect(second.stderr).not.toMatch(
      /ignoring the frozen split|match no skill directory|by directory name only|more than one group|placed in a "misc" slice/,
    );
  }, 30_000);
});
