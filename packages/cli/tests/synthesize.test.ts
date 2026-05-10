import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    expect(entry.source).toEqual({ source: "url", url: "https://github.com/test/marker-file.git" });
  });

  test("emits all 8 component kinds when marker file declares them", () => {
    const entry = synthesizeEntry({
      repoRoot: join(FIXTURES, "marker-file-full"),
      sourceRepo: "test/marker-full",
    });
    expect(entry.name).toBe("marker-full");
    expect(entry.skills).toEqual(["./skills/"]);
    expect(entry.agents).toEqual(["./agents/"]);
    expect(entry.commands).toEqual(["./commands/"]);
    expect(entry.hooks).toBe("./hooks/hooks.json");
    expect(entry.mcpServers).toBe("./.mcp.json");
    expect(entry.outputStyles).toEqual(["./styles/"]);
    expect(entry.themes).toEqual(["./themes/"]);
    expect(entry.monitors).toBe("./monitors.json");
    expect(entry.license).toBe("MIT");
    expect(entry.homepage).toBe("https://example.com");
    expect(entry.repository).toBe("https://github.com/test/marker-full");
  });

  test("drops marker paths that don't exist on disk", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccp-marker-missing-"));
    try {
      mkdirSync(join(tmp, "elysia"), { recursive: true });
      writeFileSync(join(tmp, "elysia/SKILL.md"), "---\ndescription: x\n---\n");
      writeFileSync(
        join(tmp, ".ccpluginizer.json"),
        JSON.stringify({
          name: "missing-path-test",
          skills: ["./elysia/", "./does-not-exist/"],
        }),
      );

      const entry = synthesizeEntry({ repoRoot: tmp, sourceRepo: "test/missing" });
      expect(entry.skills).toEqual(["./elysia/"]); // missing dropped
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
    expect(entry.agents).toEqual(["./.claude/agents/reviewer.md"]);
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
    expect(entry.author).toEqual({ name: "Open Circle" });
  });
});

describe("synthesize: Layer 3 fallback", () => {
  test("emits skills entry from elysia-like (no manifest, no convention folder)", () => {
    const entry = synthesizeEntry({
      repoRoot: join(FIXTURES, "elysia-like"),
      sourceRepo: "elysiajs/skills",
    });
    expect(entry.skills).toEqual(["./elysia/"]);
  });
});
