import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { synthesizeEntry } from "../src/detector/synthesize.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("synthesize: Layer 1 marker file wins", () => {
  test("uses marker file authoritatively, ignores other layers", () => {
    const entry = synthesizeEntry({
      repoRoot: join(FIXTURES, "marker-file"),
      sourceRepo: "test/marker-file",
    });
    expect(entry.name).toBe("elysia-marker");
    expect(entry.skills).toEqual(["./elysia/"]);
    expect(entry.strict).toBe(false);
    expect(entry.source).toEqual({ source: "github", repo: "test/marker-file" });
  });
});
