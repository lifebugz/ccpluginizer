import { describe, expect, test } from "bun:test";
import { parseSourceInput } from "../src/sources/index.ts";

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
