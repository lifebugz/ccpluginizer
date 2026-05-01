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
