import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join, dirname } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dirname, "../src/index.ts");
const FIXTURES = join(import.meta.dirname, "fixtures");

import { makeNestedPlugin } from "./helpers.ts";

/** Curated PATH so Bun.which("claude") is null inside the child (hermetic auto/llm detection). */
function curatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dirs = ["/bin", "/usr/bin"];
  const bunDir = dirname(process.execPath);
  if (!existsSync(join(bunDir, "claude")) && !existsSync(join(bunDir, "claude.exe"))) {
    dirs.push(bunDir); // include the interpreter dir only if it does not also ship `claude`
  }
  return {
    PATH: dirs.join(":"),
    HOME: process.env["HOME"] ?? tmpdir(),
    TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
    ...extra,
  };
}

async function runScan(
  scanArgs: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Launch via the absolute interpreter path; Bun resolves argv[0] against the child PATH,
  // so a bare "bun" token with a stripped PATH would throw ENOENT before the CLI runs.
  const proc = Bun.spawn([process.execPath, "run", CLI, "scan", ...scanArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: curatedEnv(opts.env),
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("scan CLI: output shapes", () => {
  let root: string;
  beforeAll(() => {
    root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
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
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("--out-dir writes one JSON file per entry", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ccp-out-"));
    try {
      const { code } = await runScan([root, "--cluster=metadata", "--min-skills=2", `--out-dir=${outDir}`]);
      expect(code).toBe(0);
      const files = readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
      expect(files.some((f) => f.endsWith("-core.json"))).toBe(true);
      expect(files.length).toBeGreaterThanOrEqual(3); // core + 2 slices
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
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
    try {
      const { stdout, stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2"]);
      expect(code).toBe(0);
      expect(stderr).toMatch(/warning/i);
      expect(stderr).toMatch(/hooks/);
      expect(stderr).toMatch(/commands/);
      // stdout must remain pure JSON (parseable), no warning text
      expect(() => {
        JSON.parse(stdout);
      }).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("--no-split --cluster=llm emits no eager backend notice", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    try {
      const { stderr, code } = await runScan([root, "--no-split", "--cluster=llm", "--min-skills=2"]);
      expect(code).toBe(0);
      expect(stderr).not.toMatch(/claude/i);
      expect(stderr).not.toMatch(/no LLM backend/i); // no split happened -> no split notice
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("scan CLI: deterministic-default + decision-B hint", () => {
  test("auto with CCPLUGINIZER_LLM_CMD set emits the hint and runs no command", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const sentinel = join(mkdtempSync(join(tmpdir(), "ccp-sent-")), "ran");
    try {
      const { stderr, stdout, code } = await runScan(
        [root, "--cluster=auto", "--min-skills=2"],
        { env: { CCPLUGINIZER_LLM_CMD: `touch ${sentinel}` } },
      );
      expect(code).toBe(0);
      expect(stderr).toMatch(/auto is deterministic-only/);
      expect(existsSync(sentinel)).toBe(false); // command never executed under auto
      expect(Array.isArray(JSON.parse(stdout))).toBe(true); // still a deterministic split
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(sentinel), { recursive: true, force: true });
    }
  }, 30_000);

  test("auto with no LLM config emits no hint", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    try {
      const { stderr, code } = await runScan([root, "--cluster=auto", "--min-skills=2"]);
      expect(code).toBe(0);
      expect(stderr).not.toMatch(/deterministic-only/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("scan CLI: --cluster=llm notices", () => {
  test("no backend + a deterministic split -> (no LLM backend found) notice", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    try {
      const { stderr, stdout, code } = await runScan([root, "--cluster=llm", "--min-skills=2"]);
      expect(code).toBe(0);
      expect(stderr).toMatch(/no LLM backend found/);
      expect(Array.isArray(JSON.parse(stdout))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("sub-threshold -> no notice at all", async () => {
    const { stderr, code } = await runScan([join(FIXTURES, "skills-only"), "--cluster=llm"]);
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/no LLM backend|produced no split/);
  }, 30_000);

  test("above threshold but no clean partition + no backend -> produced-no-split notice, single entry", async () => {
    const root = makeNestedPlugin({ products: { solo: 30 } });
    try {
      const { stderr, stdout, code } = await runScan([root, "--cluster=llm", "--min-skills=2"]);
      expect(code).toBe(0);
      expect(stderr).toMatch(/--cluster=llm produced no split/);
      expect(stderr).toMatch(/no LLM backend found/);
      expect(Array.isArray(JSON.parse(stdout))).toBe(false); // single entry
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    const home = mkdtempSync(join(tmpdir(), "ccp-home-")); // cold cache
    try {
      const cmd = `cat >/dev/null; printf '%s' '${SOLO6_JSON}'`;
      const { stderr, stdout, code } = await runScan(
        [root, "--cluster=auto-llm", "--min-skills=2", `--llm-cmd=${cmd}`],
        { env: { HOME: home } },
      );
      expect(code).toBe(0);
      expect(stderr).toMatch(/via subprocess clustering/);
      expect(Array.isArray(JSON.parse(stdout))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("--llm-timeout is honored: a slow stub times out and falls back to deterministic", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } }); // deterministic succeeds on fallback
    const home = mkdtempSync(join(tmpdir(), "ccp-home-"));
    try {
      const { stderr, stdout, code } = await runScan(
        [root, "--cluster=llm", "--min-skills=2", "--llm-timeout=1", "--llm-cmd=sleep 5"],
        { env: { HOME: home } },
      );
      expect(code).toBe(0);
      expect(Array.isArray(JSON.parse(stdout))).toBe(true); // deterministic split emitted
      expect(stderr).toMatch(/the LLM backend was unreachable or produced no output/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("flag overrides env for --llm-cmd", async () => {
    const root = makeNestedPlugin({ products: { solo: 6 } });
    const home = mkdtempSync(join(tmpdir(), "ccp-home-"));
    const envSentinel = join(mkdtempSync(join(tmpdir(), "ccp-sent-")), "env-ran");
    try {
      const flagCmd = `cat >/dev/null; printf '%s' '${SOLO6_JSON}'`;
      const { stdout, code } = await runScan(
        [root, "--cluster=auto-llm", "--min-skills=2", `--llm-cmd=${flagCmd}`],
        { env: { HOME: home, CCPLUGINIZER_LLM_CMD: `touch ${envSentinel}` } },
      );
      expect(code).toBe(0);
      expect(Array.isArray(JSON.parse(stdout))).toBe(true);
      expect(existsSync(envSentinel)).toBe(false); // env command never ran; the flag won
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(dirname(envSentinel), { recursive: true, force: true });
    }
  }, 30_000);
});

describe("scan CLI: marker short-circuit beats a configured LLM", () => {
  test("committed marker + CCPLUGINIZER_LLM_CMD set -> marker notice only, command not run", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    // Freeze a grouping first, then re-scan with an env command that would touch a sentinel.
    await runScan([root, "--cluster=metadata", "--min-skills=2", "--write-marker"]);
    const sentinel = join(mkdtempSync(join(tmpdir(), "ccp-sent-")), "ran");
    try {
      const { stderr, code } = await runScan(
        [root, "--cluster=llm", "--min-skills=2"],
        { env: { CCPLUGINIZER_LLM_CMD: `touch ${sentinel}` } },
      );
      expect(code).toBe(0);
      expect(stderr).toMatch(/via committed marker \(\.ccpluginizer\.json\)/);
      expect(stderr).not.toMatch(/no LLM backend|running LLM grouper/);
      expect(existsSync(sentinel)).toBe(false); // marker short-circuit -> grouper never invoked
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(sentinel), { recursive: true, force: true });
    }
  }, 30_000);
});

describe("scan CLI: auto-llm reproducibility + rescue", () => {
  test("well-named repo: deterministic wins, stub never runs, bytes identical to auto", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const sentinel = join(mkdtempSync(join(tmpdir(), "ccp-sent-")), "ran");
    try {
      const auto = await runScan([root, "--cluster=auto", "--min-skills=2"]);
      const autoLlm = await runScan(
        [root, "--cluster=auto-llm", "--min-skills=2", `--llm-cmd=touch ${sentinel}; printf '%s' '${SOLO6_JSON}'`],
      );
      expect(auto.code).toBe(0);
      expect(autoLlm.code).toBe(0);
      expect(autoLlm.stdout).toBe(auto.stdout); // byte-identical entries
      expect(autoLlm.stderr).not.toMatch(/running LLM grouper|deterministic-only/); // no provenance, no hint
      expect(existsSync(sentinel)).toBe(false); // grouper never executed
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(sentinel), { recursive: true, force: true });
    }
  }, 30_000);

  test("unpartitionable repo + rejecting stub -> produced-no-split naming auto-llm (resolved variant)", async () => {
    const root = makeNestedPlugin({ products: { solo: 6 } });
    const home = mkdtempSync(join(tmpdir(), "ccp-home-"));
    try {
      const { stderr, stdout, code } = await runScan(
        [root, "--cluster=auto-llm", "--min-skills=2", "--llm-cmd=cat >/dev/null; printf 'not json'"],
        { env: { HOME: home } },
      );
      expect(code).toBe(0);
      expect(stderr).toMatch(/--cluster=auto-llm produced no split/);
      expect(stderr).toMatch(/the LLM backend was unreachable or produced no output/);
      expect(Array.isArray(JSON.parse(stdout))).toBe(false); // single entry
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("unpartitionable repo + no backend -> produced-no-split naming auto-llm (degrade variant)", async () => {
    const root = makeNestedPlugin({ products: { solo: 6 } });
    try {
      const { stderr, code } = await runScan([root, "--cluster=auto-llm", "--min-skills=2"]);
      expect(code).toBe(0);
      expect(stderr).toMatch(/--cluster=auto-llm produced no split/);
      expect(stderr).toMatch(/no LLM backend found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("scan CLI: --write-marker merge + --out-dir hygiene", () => {
  test("--write-marker preserves hand-curated marker fields on refresh", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    try {
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("--out-dir warns about (but never deletes) stale entries from a previous grouping", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const outDir = mkdtempSync(join(tmpdir(), "ccp-stale-"));
    try {
      await runScan([root, "--cluster=metadata", "--min-skills=2", `--out-dir=${outDir}`]);
      const coreFile = readdirSync(outDir).find((f) => f.endsWith("-core.json"));
      expect(coreFile).toBeDefined();
      const core = JSON.parse(readFileSync(join(outDir, coreFile ?? ""), "utf8")) as { source: { url: string } };
      const base = (coreFile ?? "").replace(/-core\.json$/, "");
      const staleName = `${base}-oldslice.json`;
      // Stale detection requires provable ownership: the file must reference this
      // repo's source URL, or it could be a sibling repo's live entry.
      writeFileSync(
        join(outDir, staleName),
        JSON.stringify({ name: `${base}-oldslice`, source: core.source, strict: false }) + "\n",
      );
      const { stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2", `--out-dir=${outDir}`]);
      expect(code).toBe(0);
      expect(stderr).toMatch(/previous scan/);
      expect(stderr).toContain(staleName);
      expect(existsSync(join(outDir, staleName))).toBe(true); // warn-only, never delete
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
