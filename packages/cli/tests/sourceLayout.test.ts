import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveSourceLayout } from "../src/detector/sourceLayout.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("resolveSourceLayout: nested telnyx-shaped plugin", () => {
  const layout = resolveSourceLayout(join(FIXTURES, "nested-plugin"));

  test("finds the skills container by structure (deep path, no ./)", () => {
    expect(layout.skillsContainer?.relPath).toBe("providers/claude/plugin/skills");
  });

  test("finds the plugin root (dir holding .claude-plugin/plugin.json)", () => {
    expect(layout.pluginRoot?.relPath).toBe("providers/claude/plugin");
  });

  test("finds the agents container and enumerates agent files", () => {
    expect(layout.agentsContainer?.relPath).toBe("providers/claude/plugin/agents");
    expect(layout.agentsContainer?.files).toEqual([
      "telnyx-developer.md",
      "webrtc-phone-developer.md",
    ]);
  });

  test("inlines the MCP servers object and classifies http as remote", () => {
    expect(layout.mcp?.serverType).toBe("remote");
    expect(layout.mcp?.servers).toEqual({ telnyx: { type: "http", url: "https://api.telnyx.com/v2/mcp" } });
  });

  test("finds the hooks file", () => {
    expect(layout.hooks?.relPath).toBe("providers/claude/plugin/hooks/hooks.json");
  });
});

describe("resolveSourceLayout: flat repo (skills at root, no plugin shell)", () => {
  const layout = resolveSourceLayout(join(FIXTURES, "telnyx-like"));

  test("skills container is the root skills/ dir", () => {
    expect(layout.skillsContainer?.relPath).toBe("skills");
  });

  test("no plugin root, no mcp, no agents when absent", () => {
    expect(layout.pluginRoot).toBeNull();
    expect(layout.mcp).toBeNull();
    expect(layout.agentsContainer).toBeNull();
  });
});

describe("resolveSourceLayout: repo-local MCP is flagged", () => {
  test("classifies a command referencing repo files as repo-local", () => {
    const layout = resolveSourceLayout(join(FIXTURES, "repo-local-mcp"));
    expect(layout.mcp?.serverType).toBe("repo-local");
  });
});

describe("resolveSourceLayout: filesystem robustness", () => {
  test("does not crash when a *.md entry is itself a directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccp-md-dir-"));
    try {
      mkdirSync(join(tmp, "skills", "foo"), { recursive: true });
      writeFileSync(join(tmp, "skills", "foo", "SKILL.md"), "---\ndescription: x\n---\n");
      // a directory whose name ends in .md sitting next to real content
      mkdirSync(join(tmp, "weird.md"), { recursive: true });
      const layout = resolveSourceLayout(tmp);
      expect(layout.skillsContainer?.relPath).toBe("skills");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
