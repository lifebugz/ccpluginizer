import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runScan } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("e2e: scan command", () => {
  test("scan against marker-file fixture produces expected entry", async () => {
    const { stdout, code } = await runScan([join(FIXTURES, "marker-file")]);
    expect(code).toBe(0);
    const entry: unknown = JSON.parse(stdout);
    expect((entry as { name?: unknown }).name).toBe("elysia-marker");
  }, 30_000);

  test("scan against already-marketplace fixture aborts cleanly", async () => {
    const { code } = await runScan([join(FIXTURES, "already-marketplace")]);
    expect(code).not.toBe(0);
  }, 30_000);
});

describe("smoke: real-world repos", () => {
  test("scan elysiajs/skills produces non-empty entry", async () => {
    const { stdout, code } = await runScan(["elysiajs/skills"]);
    expect(code).toBe(0);
    const entry: unknown = JSON.parse(stdout);
    expect(typeof (entry as { name?: unknown }).name).toBe("string");
    expect(Array.isArray((entry as { skills?: unknown }).skills)).toBe(true);
  }, 90_000);

  test("scan open-circle/agent-skills produces non-empty entry with author info", async () => {
    const { stdout, code } = await runScan(["open-circle/agent-skills"]);
    expect(code).toBe(0);
    const entry: unknown = JSON.parse(stdout);
    expect((entry as { author?: unknown }).author).toBeDefined();
  }, 90_000);
});
