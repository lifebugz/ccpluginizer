import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { runCli, tempDir } from "./helpers.ts";

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
  // version wins: stdout is exactly the version banner, exit 0, help suppressed.
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
    // Build with the SAME flags as the production build script (package.json "build":
    // --target bun --format esm) so this exercises the exact codegen path that ships.
    const buildResult = await Bun.build({
      entrypoints: [join(import.meta.dirname, "../src/index.ts")],
      target: "bun",
      format: "esm",
      outdir: dir,
    });
    expect(buildResult.success).toBe(true);

    // Derive the emitted entry path from the build result instead of hardcoding a
    // filename: this survives a future bun renaming the entry output.
    const entry = buildResult.outputs.find((o) => o.kind === "entry-point");
    if (entry === undefined) throw new Error("build emitted no entry-point output");
    const builtBundle = entry.path;
    expect(existsSync(builtBundle)).toBe(true);

    // Structural regression guard for the bundle-leak bug (named vs default JSON import):
    // bun ALWAYS inlines JSON imports as object literals, so the real risk is WHICH fields
    // get inlined. A default `import pkg` would inline the whole package.json (scripts +
    // devDependencies); the named `import { version }` must inline only the version string.
    const bundleText = await Bun.file(builtBundle).text();
    expect(bundleText).toContain(pkg.version); // version IS inlined
    expect(bundleText).not.toContain("devDependencies"); // whole package.json must not leak
    expect(bundleText).not.toContain("package_default"); // no default-namespace JSON object
    expect(bundleText).not.toContain("scripts"); // package.json "scripts" must not leak
    expect(bundleText).not.toContain("prepublishOnly"); // a scripts key must not leak
    expect(bundleText).not.toContain("typescript-eslint"); // a devDependency value must not leak

    // Behavioral half: run the BUILT artifact through the shared runCli harness
    // (target override = the freshly built bundle, cwd = its temp dir) and confirm it
    // executes and prints the version. Reusing runCli keeps the hermetic env + dual-pipe
    // drain in one place instead of re-implementing the spawn here.
    const { stdout, stderr, code } = await runCli(["--version"], { target: builtBundle, cwd: dir });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`ccpz v${pkg.version}`);
  }, 15_000); // build adds ~1-2s; 15s timeout is generous
});
