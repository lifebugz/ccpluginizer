import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { runCli, curatedEnv, tempDir } from "./helpers.ts";

describe("cli: version", () => {
  test("--version prints 'ccpz v<version>' and exits 0", async (): Promise<void> => {
    const { stdout, stderr, code } = await runCli(["--version"]);
    expect(code).toBe(0);
    // Exact equality pins the full string, so a separate prefix regex would add
    // no coverage (and would falsely assume a 3-segment shape pkg.version need not have).
    expect(stdout.trim()).toBe(`ccpz v${pkg.version}`);
    // item 5: stderr must be empty on happy path
    expect(stderr).toBe("");
  });

  test("-v is an alias for --version", async (): Promise<void> => {
    const { stdout, stderr, code } = await runCli(["-v"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`ccpz v${pkg.version}`);
    // happy path: alias must be as clean as the long form (no stderr noise)
    expect(stderr).toBe("");
  });

  // R1: version middleware must short-circuit before help. If help ran first, the
  // run-less root command would trigger help and print the subcommand list instead.
  test("--version short-circuits before help (no subcommand list)", async (): Promise<void> => {
    const { stdout } = await runCli(["--version"]);
    // "help suppressed" is proven by stdout being EXACTLY the one-line version
    // banner: if help had run it would have appended the COMMANDS/scan/validate
    // block. A single trimmed line equal to the banner rules that out directly,
    // which a `not.toContain("validate")` proxy does not.
    expect(stdout.trim()).toBe(`ccpz v${pkg.version}`);
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("cli: help", () => {
  test("--help lists both subcommands and exits 0", async (): Promise<void> => {
    const { stdout, stderr, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("scan");
    expect(stdout).toContain("validate");
    // item 5: stderr must be empty on happy path
    expect(stderr).toBe("");
  });

  test("-h is an alias for --help", async (): Promise<void> => {
    const { stdout, stderr, code } = await runCli(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("scan");
    expect(stdout).toContain("validate");
    // happy path: alias must be as clean as the long form (no stderr noise)
    expect(stderr).toBe("");
  });

  test("bare invocation prints help and exits 0", async (): Promise<void> => {
    const { stdout, code } = await runCli([]);
    expect(code).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout).toContain("scan");
  });

  // item 2: per-command help — scan-specific tokens discovered empirically
  test("scan --help shows scan-specific options and exits 0", async (): Promise<void> => {
    const { stdout, code } = await runCli(["scan", "--help"]);
    expect(code).toBe(0);
    // scan has -o / --output and --outDir flags not present in root help
    expect(stdout).toContain("--output");
    expect(stdout).toContain("--outDir");
  });

  // item 2: per-command help — validate-specific tokens discovered empirically
  test("validate --help shows validate-specific usage and exits 0", async (): Promise<void> => {
    const { stdout, code } = await runCli(["validate", "--help"]);
    expect(code).toBe(0);
    // validate has the <entryFile> positional arg not present in root or scan help
    expect(stdout).toContain("<entryFile>");
  });
});

describe("cli: error paths", () => {
  // item 3: unknown-command path — behavior discovered empirically:
  // exit 1, stderr = 'Error: Unknown command "badcmd".', stdout empty
  test("unknown command exits 1 and writes error to stderr", async (): Promise<void> => {
    const { stdout, stderr, code } = await runCli(["badcmd"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('Unknown command "badcmd"');
  });
});

describe("cli: flag precedence", () => {
  // item 4: combined --version --help — version short-circuits first (R1 load order)
  // Discovered empirically: stdout = "ccpz v0.8.0", exit 0 (version wins, help suppressed)
  test("--version --help: version wins (R1 versionPlugin precedes helpPlugin)", async (): Promise<void> => {
    const { stdout, code } = await runCli(["--version", "--help"]);
    // version short-circuits; help output is suppressed
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`ccpz v${pkg.version}`);
    expect(stdout).not.toContain("COMMANDS:");
  });
});

describe("cli: build-artifact version inlining", () => {
  // item 1 [Important]: proves the version is INLINED into the built bundle at build time,
  // not just resolved at runtime from the TS source. All other tests spawn src/index.ts
  // where `import pkg from "../package.json"` resolves at runtime. This test exercises the
  // actual codegen path that ships to npm / Homebrew / binary users.
  test("built bundle emits correct version (build-time inlining)", async (): Promise<void> => {
    // tempDir() auto-registers cleanup on process exit — no try/finally rmSync needed.
    const dir = tempDir("ccpz-build-test-");
    // Build the CLI to a temp dir (no --compile needed; bun's bundler inlines JSON imports)
    const buildResult = await Bun.build({
      entrypoints: [join(import.meta.dirname, "../src/index.ts")],
      target: "bun",
      outdir: dir,
    });
    expect(buildResult.success).toBe(true);

    const builtBundle = join(dir, "index.js");
    // Guard the output-naming assumption: if a future bun renames the entry output,
    // fail here with a clear message instead of an opaque "bun run <missing file>".
    expect(existsSync(builtBundle)).toBe(true);

    // Spawn the BUILT artifact with the same hermetic env the harness uses.
    // Drain BOTH pipes (matching runCli) so a chatty/failing artifact can neither
    // deadlock on a full stderr buffer nor swallow its own error diagnostics.
    const proc = Bun.spawn([process.execPath, "run", builtBundle, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: curatedEnv(),
      cwd: dir,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`ccpz v${pkg.version}`);
  }, 15_000); // build adds ~1-2s; 15s timeout is generous
});
