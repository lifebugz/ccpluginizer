import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { createLayoutResolver, resolveSourceLayout } from "../src/detector/sourceLayout.ts";
import { tempDir } from "./helpers.ts";

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

  test("finds the hooks file as a uniform artifact", () => {
    const hooks = layout.artifacts.find((a) => a.kind === "hooks");
    expect(hooks?.relPath).toBe("providers/claude/plugin/hooks/hooks.json");
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
    const tmp = tempDir("ccp-md-dir-");
    mkdirSync(join(tmp, "skills", "foo"), { recursive: true });
    writeFileSync(join(tmp, "skills", "foo", "SKILL.md"), "---\ndescription: x\n---\n");
    // a directory whose name ends in .md sitting next to real content
    mkdirSync(join(tmp, "weird.md"), { recursive: true });
    const layout = resolveSourceLayout(tmp);
    expect(layout.skillsContainer?.relPath).toBe("skills");
  });

  test("a denser tests/fixtures skills dir does not out-rank the real skills/", () => {
    const tmp = tempDir("ccp-skipdirs-");
    // Real container: 1 skill.
    mkdirSync(join(tmp, "skills", "real"), { recursive: true });
    writeFileSync(join(tmp, "skills", "real", "SKILL.md"), "---\ndescription: real\n---\n");
    // Fixture container: 3 skills — would win on count if not excluded.
    for (const n of ["a", "b", "c"]) {
      mkdirSync(join(tmp, "tests", "fixtures", n), { recursive: true });
      writeFileSync(join(tmp, "tests", "fixtures", n, "SKILL.md"), "---\ndescription: fixture\n---\n");
    }
    const layout = resolveSourceLayout(tmp);
    expect(layout.skillsContainer?.relPath).toBe("skills");
  });
});

describe("resolveSourceLayout: MCP robustness", () => {
  test("falls through a malformed higher-priority .mcp.json to a valid anchored one", () => {
    const tmp = tempDir("ccp-mcp-fallthrough-");
    // Root .mcp.json (shallowest → chosen first) is malformed; the valid one sits
    // in the other anchored location, .claude/.
    writeFileSync(join(tmp, ".mcp.json"), "{ not valid json");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", ".mcp.json"),
      JSON.stringify({ mcpServers: { telnyx: { type: "http", url: "https://x" } } }),
    );
    const layout = resolveSourceLayout(tmp);
    expect(layout.mcp?.relPath).toBe(".claude/.mcp.json");
    expect(layout.mcp?.serverType).toBe("remote");
  });

  test("a stray example .mcp.json outside anchored locations is never inlined", () => {
    const tmp = tempDir("ccp-mcp-stray-");
    mkdirSync(join(tmp, "examples", "local-server"), { recursive: true });
    writeFileSync(
      join(tmp, "examples", "local-server", ".mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: "node", args: ["./server.js"] } } }),
    );
    expect(resolveSourceLayout(tmp).mcp).toBeNull();
  });

  test("ignores a .mcp.json that is not a server map (e.g. {$schema, version})", () => {
    const tmp = tempDir("ccp-mcp-nonserver-");
    writeFileSync(join(tmp, ".mcp.json"), JSON.stringify({ $schema: "https://x", version: 1 }));
    expect(resolveSourceLayout(tmp).mcp).toBeNull();
  });

  test("ignores an array-valued mcpServers (cannot be inlined as a servers object)", () => {
    const tmp = tempDir("ccp-mcp-array-");
    writeFileSync(join(tmp, ".mcp.json"), JSON.stringify({ mcpServers: [{ command: "x" }] }));
    expect(resolveSourceLayout(tmp).mcp).toBeNull();
  });
});

describe("resolveSourceLayout: classification edges", () => {
  test("generic env interpolation (API keys) does not classify a server repo-local", () => {
    const tmp = tempDir("ccp-mcp-env-");
    writeFileSync(
      join(tmp, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          scoped: { command: "npx", args: ["-y", "@scope/mcp", "--header", "Authorization: ${API_KEY}"] },
        },
      }),
    );
    expect(resolveSourceLayout(tmp).mcp?.serverType).toBe("package");
  });

  test("CLAUDE_PLUGIN_ROOT expansion still classifies a server repo-local", () => {
    const tmp = tempDir("ccp-mcp-root-");
    writeFileSync(
      join(tmp, ".mcp.json"),
      JSON.stringify({
        mcpServers: { local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] } },
      }),
    );
    expect(resolveSourceLayout(tmp).mcp?.serverType).toBe("repo-local");
  });

  test("a src/commands code directory is not reported as a commands artifact", () => {
    const tmp = tempDir("ccp-srccmd-");
    mkdirSync(join(tmp, "src", "commands"), { recursive: true });
    writeFileSync(join(tmp, "src", "commands", "scan.ts"), "// code");
    mkdirSync(join(tmp, "skills", "a"), { recursive: true });
    writeFileSync(join(tmp, "skills", "a", "SKILL.md"), "---\ndescription: a.\n---\n");
    const layout = resolveSourceLayout(tmp);
    expect(layout.artifacts.find((a) => a.kind === "commands")).toBeUndefined();
  });

  test("a root-level commands directory IS reported as an artifact", () => {
    const tmp = tempDir("ccp-rootcmd-");
    mkdirSync(join(tmp, "commands"), { recursive: true });
    writeFileSync(join(tmp, "commands", "do.md"), "---\ndescription: Do.\n---\n");
    const layout = resolveSourceLayout(tmp);
    expect(layout.artifacts.find((a) => a.kind === "commands")?.relPath).toBe("commands");
  });
});

describe("resolveSourceLayout: symlink aliasing", () => {
  test("a symlink alias of the skills dir is neither double-counted nor chosen as root", () => {
    const tmp = tempDir("ccp-symalias-");
    for (const n of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    // "examples" sorts before "skills" — without the alias guard it would win the tie.
    symlinkSync(join(tmp, "skills"), join(tmp, "examples"));
    const resolver = createLayoutResolver(tmp);
    expect(resolver.skillsContainer?.relPath).toBe("skills"); // the real path wins
    expect(resolver.skillDirsOutsideContainer).toBe(0); // no phantom duplicate count
  });
});

describe("resolveSourceLayout: anchored configs under a plugin root", () => {
  test("a stray .mcp.json nested below the plugin root is not inlined", () => {
    const tmp = tempDir("ccp-nestedmcp-");
    const plugin = join(tmp, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x" }));
    mkdirSync(join(plugin, "examples", "demo"), { recursive: true });
    writeFileSync(
      join(plugin, "examples", "demo", ".mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: "node", args: ["./server.js"] } } }),
    );
    expect(resolveSourceLayout(tmp).mcp).toBeNull();
  });
});

describe("resolveSourceLayout: cross-parent symlink aliasing", () => {
  test("an alias in an earlier-walked parent does not steal the real container", () => {
    const tmp = tempDir("ccp-crossalias-");
    for (const n of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    // docs/ is walked before skills/ in DFS order; without global symlink deferral
    // the alias would register the inode first and win container resolution.
    mkdirSync(join(tmp, "docs"), { recursive: true });
    symlinkSync(join(tmp, "skills"), join(tmp, "docs", "skills-link"));
    const resolver = createLayoutResolver(tmp);
    expect(resolver.skillsContainer?.relPath).toBe("skills"); // the real path wins
    expect(resolver.skillDirsOutsideContainer).toBe(0);
  });
});

describe("resolveSourceLayout: anchor symmetry with the single-entry detector", () => {
  test("a repo-root .mcp.json is found even when the plugin root is nested", () => {
    const tmp = tempDir("ccp-rootmcp-");
    const plugin = join(tmp, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(tmp, ".mcp.json"), JSON.stringify({ mcpServers: { t: { type: "http", url: "https://x" } } }));
    expect(resolveSourceLayout(tmp).mcp?.relPath).toBe(".mcp.json");
  });
});
