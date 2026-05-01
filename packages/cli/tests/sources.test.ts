import { describe, expect, test } from "bun:test";
import { parseSourceInput } from "../src/sources/index.ts";
import { resolveGithub } from "../src/sources/github.ts";
import { existsSync } from "node:fs";

describe("parseSourceInput", () => {
  test("parses owner/repo shorthand", () => {
    const r = parseSourceInput("elysiajs/skills");
    expect(r.kind).toBe("github");
    if (r.kind === "github") {
      expect(r.repo).toBe("elysiajs/skills");
    }
  });

  test("parses https github URL", () => {
    const r = parseSourceInput("https://github.com/elysiajs/skills");
    expect(r.kind).toBe("github");
    if (r.kind === "github") {
      expect(r.repo).toBe("elysiajs/skills");
    }
  });

  test("parses ssh github URL", () => {
    const r = parseSourceInput("git@github.com:elysiajs/skills.git");
    expect(r.kind).toBe("github");
    if (r.kind === "github") {
      expect(r.repo).toBe("elysiajs/skills");
    }
  });

  test("parses local path (absolute)", () => {
    const r = parseSourceInput("/tmp/some-repo");
    expect(r.kind).toBe("local");
    if (r.kind === "local") {
      expect(r.path).toBe("/tmp/some-repo");
    }
  });

  test("parses local path (relative)", () => {
    const r = parseSourceInput("./tests/fixtures/elysia-like");
    expect(r.kind).toBe("local");
  });
});

describe("resolveGithub", () => {
  test(
    "clones a public repo into a tmpdir and returns the path",
    async () => {
      // Use a tiny known-good public repo for this test
      const path = await resolveGithub("elysiajs/skills");
      expect(existsSync(path)).toBe(true);
    },
    60_000,
  );
});

describe("resolveSource", () => {
  test("returns local path unchanged for local input", async () => {
    const { resolveSource } = await import("../src/sources/index.ts");
    const path = await resolveSource("./tests/fixtures/elysia-like");
    expect(path).toBe("./tests/fixtures/elysia-like");
  });
});
