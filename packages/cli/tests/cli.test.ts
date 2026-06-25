import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { runCli } from "./helpers.ts";

describe("cli: version", () => {
  test("--version prints 'ccpz v<version>' and exits 0", async () => {
    const { stdout, code } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`ccpz v${pkg.version}`);
    expect(stdout).toMatch(/^ccpz v\d+\.\d+\.\d+/);
  });

  test("-v is an alias for --version", async () => {
    const { stdout, code } = await runCli(["-v"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`ccpz v${pkg.version}`);
  });

  // R1: version middleware must short-circuit before help. If help ran first, the
  // run-less root command would trigger help and print the subcommand list instead.
  test("--version short-circuits before help (no subcommand list)", async () => {
    const { stdout } = await runCli(["--version"]);
    expect(stdout).not.toContain("validate");
  });
});

describe("cli: help", () => {
  test("--help lists both subcommands and exits 0", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("scan");
    expect(stdout).toContain("validate");
  });

  test("-h is an alias for --help", async () => {
    const { stdout, code } = await runCli(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("scan");
    expect(stdout).toContain("validate");
  });

  test("bare invocation prints help and exits 0", async () => {
    const { stdout, code } = await runCli([]);
    expect(code).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout).toContain("scan");
  });
});
