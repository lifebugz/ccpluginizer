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

describe("synthesize: Layer 2 alone (no marker, no manifest)", () => {
  test("emits skills entry from skills-only fixture", () => {
    const entry = synthesizeEntry({
      repoRoot: join(FIXTURES, "skills-only"),
      sourceRepo: "test/skills-only",
    });
    expect(entry.name).toBe("test-skills-only");
    expect(entry.skills).toEqual(["./skills/"]);
    expect(entry.strict).toBe(false);
  });

  test("emits dotfiles-style path for .claude/ skills", () => {
    const entry = synthesizeEntry({
      repoRoot: join(FIXTURES, "dotfiles-like"),
      sourceRepo: "test/dotfiles-like",
    });
    expect(entry.skills).toEqual(["./.claude/skills/"]);
    expect(entry.agents).toEqual(["./.claude/agents/"]);
  });
});

describe("synthesize: Layer 2 + 2.5 merge", () => {
  test("uses Layer 2 paths and Layer 2.5 metadata", () => {
    const entry = synthesizeEntry({
      repoRoot: join(FIXTURES, "open-circle-like"),
      sourceRepo: "open-circle/agent-skills",
    });
    expect(entry.skills).toEqual(["./skills/valibot", "./skills/formisch"]);
    expect(entry.description).toBe("Agent Skills for Open Circle projects including Valibot and Formisch");
    expect(entry.homepage).toBe("https://opencircle.dev");
    expect(entry.repository).toBe("https://github.com/open-circle/agent-skills");
    expect(entry.author).toBe("Open Circle");
  });
});
