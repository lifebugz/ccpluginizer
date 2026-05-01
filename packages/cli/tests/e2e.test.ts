import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "../src/index.ts");
const FIXTURES = join(import.meta.dirname, "fixtures");

describe("e2e: scan command", () => {
  test("scan against marker-file fixture produces expected entry", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "scan", join(FIXTURES, "marker-file")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const entry: unknown = JSON.parse(out);
    expect((entry as { name?: unknown }).name).toBe("elysia-marker");
  }, 30_000);

  test("scan against already-marketplace fixture aborts cleanly", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "scan", join(FIXTURES, "already-marketplace")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  }, 30_000);
});

describe("smoke: real-world repos", () => {
  test("scan elysiajs/skills produces non-empty entry", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "scan", "elysiajs/skills"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const entry: unknown = JSON.parse(out);
    expect(typeof (entry as { name?: unknown }).name).toBe("string");
    expect(Array.isArray((entry as { skills?: unknown }).skills)).toBe(true);
  }, 90_000);

  test("scan open-circle/agent-skills produces non-empty entry with author info", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "scan", "open-circle/agent-skills"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const entry: unknown = JSON.parse(out);
    expect((entry as { author?: unknown }).author).toBeDefined();
  }, 90_000);
});
