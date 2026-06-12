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

describe("resolveSourceLayout: skill-internal directories never win container resolution", () => {
  // Finding A: a skill that bundles its OWN agents/ subdir must not have that subdir
  // chosen as the agents container (it is content of the skill, and rooting the core
  // git-subdir there would ship the wrong subtree).
  test("a skill's own agents/ subdir does not win the agents container", () => {
    const tmp = tempDir("ccp-skill-agents-");
    // The real, top-level agents container — only 1 agent file.
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "real.md"), "---\nname: real\ndescription: Real top-level agent.\n---\n");
    // A skill bundling its own agents/ subdir with MORE agent files: it would out-count
    // the real container and win if skill-internal dirs were not excluded.
    mkdirSync(join(tmp, "skills", "foo", "agents"), { recursive: true });
    writeFileSync(join(tmp, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: Foo skill.\n---\n");
    for (const n of ["a", "b", "c"]) {
      writeFileSync(
        join(tmp, "skills", "foo", "agents", `${n}.md`),
        `---\nname: ${n}\ndescription: Bundled agent ${n}.\n---\n`,
      );
    }
    const layout = resolveSourceLayout(tmp);
    expect(layout.agentsContainer?.relPath).toBe("agents");
  });
});

describe("resolveSourceLayout: a root-level SKILL.md does not bury the skills container", () => {
  // Finding B: an incidental SKILL.md at the repo ROOT must not make the root's
  // direct children "inside a skill"; a real skills/ container directly under root
  // must still resolve (otherwise the split silently never fires).
  test("skills container resolves even when the repo root is itself a skill", () => {
    const tmp = tempDir("ccp-root-skill-");
    writeFileSync(join(tmp, "SKILL.md"), "---\nname: root\ndescription: The repo root is itself a skill.\n---\n");
    for (const n of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    const layout = resolveSourceLayout(tmp);
    expect(layout.skillsContainer?.relPath).toBe("skills");
  });

  test("the root-skill's own nested template dir is still excluded from the count", () => {
    const tmp = tempDir("ccp-root-skill-tpl-");
    writeFileSync(join(tmp, "SKILL.md"), "---\nname: root\ndescription: Root skill with a template.\n---\n");
    // skills/ is the real container (2 skills); a template dir nested INSIDE a skill
    // (skills/alpha/examples/inner) ships its own SKILL.md and must not be counted as
    // an uncovered skill outside the container.
    for (const n of ["alpha", "beta"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    mkdirSync(join(tmp, "skills", "alpha", "examples", "inner"), { recursive: true });
    writeFileSync(join(tmp, "skills", "alpha", "examples", "inner", "SKILL.md"), "---\ndescription: example.\n---\n");
    const resolver = createLayoutResolver(tmp);
    expect(resolver.skillsContainer?.relPath).toBe("skills");
    expect(resolver.skillDirsOutsideContainer).toBe(0);
  });

  test("a single-skill repo (root SKILL.md, no skills/ container) does not mis-fire a split", () => {
    // The root skill's OWN template/example dir (examples/inner/SKILL.md) is skill
    // content, not a skills container — there must be no container and no split.
    const tmp = tempDir("ccp-single-skill-");
    writeFileSync(join(tmp, "SKILL.md"), "---\nname: root\ndescription: The whole repo is one skill.\n---\n");
    mkdirSync(join(tmp, "examples", "inner"), { recursive: true });
    writeFileSync(join(tmp, "examples", "inner", "SKILL.md"), "---\ndescription: bundled example.\n---\n");
    expect(resolveSourceLayout(tmp).skillsContainer).toBeNull();
  });

  test("a skill that bundles direct-child sub-skills does not steal the container", () => {
    const tmp = tempDir("ccp-bundled-subskills-");
    writeFileSync(join(tmp, "SKILL.md"), "---\nname: root\ndescription: Root skill.\n---\n");
    for (const n of ["alpha", "beta"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    // skills/alpha is itself a skill that bundles 5 sub-skills as DIRECT children — it
    // would out-count the real skills/ container (2) if a skill could be a container.
    for (const s of ["s1", "s2", "s3", "s4", "s5"]) {
      mkdirSync(join(tmp, "skills", "alpha", s), { recursive: true });
      writeFileSync(join(tmp, "skills", "alpha", s, "SKILL.md"), `---\ndescription: ${s}.\n---\n`);
    }
    const resolver = createLayoutResolver(tmp);
    expect(resolver.skillsContainer?.relPath).toBe("skills");
    expect(resolver.skillDirsOutsideContainer).toBe(0);
  });

  test("a skills/ folder bundled inside a bare skill is that skill's content, not a container", () => {
    // foo/ is a bare skill (SKILL.md, no plugin.json) that ships example sub-skills under
    // its own skills/ subdir — the superpowers `writing-skills` pattern. Those examples
    // are foo's content and must NOT win the container; the real container is the repo
    // root (which holds the single real skill foo), never foo/skills.
    const tmp = tempDir("ccp-bare-skill-skills-");
    const foo = join(tmp, "foo");
    mkdirSync(foo, { recursive: true });
    writeFileSync(join(foo, "SKILL.md"), "---\nname: foo\ndescription: A bare skill bundling examples.\n---\n");
    for (const n of ["alpha", "beta"]) {
      mkdirSync(join(foo, "skills", n), { recursive: true });
      writeFileSync(join(foo, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    const resolver = createLayoutResolver(tmp);
    expect(resolver.skillsContainer?.relPath).toBe("."); // root holds the one real skill (foo)
    expect(resolver.skillDirsOutsideContainer).toBe(0); // the bundled examples are not uncovered skills
  });

  test("a meta-skill that bundles example skills under its own skills/ does not steal the real container", () => {
    // The superpowers/writing-skills pattern, with a competing real container: the
    // bundled examples (more numerous than the real skills) must NOT win, and must not
    // be counted as uncovered.
    const tmp = tempDir("ccp-meta-skill-");
    for (const n of ["one", "two"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    const meta = join(tmp, "skills", "writing-skills");
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, "SKILL.md"), "---\nname: writing-skills\ndescription: A meta-skill.\n---\n");
    for (const e of ["e1", "e2", "e3", "e4", "e5"]) {
      mkdirSync(join(meta, "examples", "skills", e), { recursive: true });
      writeFileSync(join(meta, "examples", "skills", e, "SKILL.md"), `---\ndescription: ${e}.\n---\n`);
    }
    const resolver = createLayoutResolver(tmp);
    expect(resolver.skillsContainer?.relPath).toBe("skills");
    expect(resolver.skillDirsOutsideContainer).toBe(0);
  });

  test("a skills/ container with its own overview SKILL.md still resolves (not collapsed to root)", () => {
    // A `skills/` folder documented with an index/overview SKILL.md alongside its skill
    // children is still a container, not a leaf skill — it must not be dropped.
    const tmp = tempDir("ccp-skills-overview-");
    mkdirSync(join(tmp, "skills"), { recursive: true });
    writeFileSync(join(tmp, "skills", "SKILL.md"), "---\nname: pack\ndescription: Overview of the pack.\n---\n");
    for (const n of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    expect(resolveSourceLayout(tmp).skillsContainer?.relPath).toBe("skills");
  });

  test("a repoRoot with a trailing slash does not crash and still resolves the container", () => {
    const tmp = tempDir("ccp-trailing-slash-");
    writeFileSync(join(tmp, "SKILL.md"), "---\nname: root\ndescription: Root skill.\n---\n");
    for (const n of ["alpha", "beta"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    expect(resolveSourceLayout(`${tmp}/`).skillsContainer?.relPath).toBe("skills");
  });
});

describe("resolveSourceLayout: plugin roots are structural, never skill-internal", () => {
  // A plugin root may also ship a SKILL.md (a single-skill plugin), and a plugin root
  // may be nested under a wrapper/meta skill. In both cases its components (agents,
  // mcp, artifacts) and the plugin root itself must still resolve.
  test("a plugin root that also ships a SKILL.md keeps its agents, mcp, and plugin root", () => {
    const tmp = tempDir("ccp-plugin-is-skill-");
    const plugin = join(tmp, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: plugin\ndescription: Plugin that is also a skill.\n---\n");
    writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { t: { type: "http", url: "https://x" } } }));
    mkdirSync(join(plugin, "agents"), { recursive: true });
    writeFileSync(join(plugin, "agents", "dev.md"), "---\nname: dev\ndescription: Dev agent.\n---\n");
    for (const n of ["alpha", "beta"]) {
      mkdirSync(join(plugin, "skills", n), { recursive: true });
      writeFileSync(join(plugin, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    const layout = resolveSourceLayout(tmp);
    expect(layout.pluginRoot?.relPath).toBe("plugin");
    expect(layout.agentsContainer?.relPath).toBe("plugin/agents");
    expect(layout.mcp?.relPath).toBe("plugin/.mcp.json");
    expect(layout.skillsContainer?.relPath).toBe("plugin/skills");
  });

  test("a plugin root nested under a non-root wrapper SKILL.md still resolves its plugin root + mcp", () => {
    // The wrapper SKILL.md sits on a NON-root ancestor (integrations/). The plugin root,
    // mcp, and artifacts resolve via the unfiltered scan (they self-anchor and are never
    // dropped wholesale). The plugin's skills/agents, however, are treated as the wrapper
    // skill's content — the same rule that keeps a tutorial skill's bundled SAMPLE plugin
    // from stealing the container.
    const tmp = tempDir("ccp-wrapper-skill-");
    const wrapper = join(tmp, "integrations");
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(join(wrapper, "SKILL.md"), "---\nname: wrapper\ndescription: Meta wrapper skill.\n---\n");
    const acme = join(wrapper, "acme");
    mkdirSync(join(acme, ".claude-plugin"), { recursive: true });
    writeFileSync(join(acme, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme" }));
    writeFileSync(join(acme, ".mcp.json"), JSON.stringify({ mcpServers: { t: { type: "http", url: "https://x" } } }));
    const layout = resolveSourceLayout(tmp);
    expect(layout.pluginRoot?.relPath).toBe("integrations/acme");
    expect(layout.mcp?.relPath).toBe("integrations/acme/.mcp.json");
  });

  test("a sample plugin bundled inside a tutorial skill does not steal the skills container", () => {
    // The superpowers `writing-skills` pattern: a tutorial skill ships a COMPLETE sample
    // plugin (its own .claude-plugin/plugin.json) whose demo skills outnumber the real
    // ones. Walking the skill-content chain THROUGH the nested plugin root keeps the real
    // top-level skills/ as the container and leaves the demo skills out of the count.
    const tmp = tempDir("ccp-sample-plugin-");
    for (const n of ["voice", "sms"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    const tut = join(tmp, "skills", "writing-skills");
    mkdirSync(tut, { recursive: true });
    writeFileSync(join(tut, "SKILL.md"), "---\nname: writing-skills\ndescription: Tutorial.\n---\n");
    const sample = join(tut, "sample-plugin");
    mkdirSync(join(sample, ".claude-plugin"), { recursive: true });
    writeFileSync(join(sample, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sample" }));
    for (const d of ["greet", "echo", "ping", "pong"]) {
      mkdirSync(join(sample, "skills", d), { recursive: true });
      writeFileSync(join(sample, "skills", d, "SKILL.md"), `---\ndescription: ${d}.\n---\n`);
    }
    const resolver = createLayoutResolver(tmp);
    expect(resolver.skillsContainer?.relPath).toBe("skills");
    expect(resolver.skillDirsOutsideContainer).toBe(0);
  });
});

describe("resolveSourceLayout: the repo root's own conventional containers survive its SKILL.md", () => {
  test("a top-level agents/ resolves even when the repo root is itself a skill", () => {
    const tmp = tempDir("ccp-root-skill-agents-");
    writeFileSync(join(tmp, "SKILL.md"), "---\nname: root\ndescription: The root is itself a skill.\n---\n");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    for (const a of ["dev1", "dev2"]) {
      writeFileSync(join(tmp, "agents", `${a}.md`), `---\nname: ${a}\ndescription: Agent ${a}.\n---\n`);
    }
    for (const n of ["alpha", "beta"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    const layout = resolveSourceLayout(tmp);
    expect(layout.agentsContainer?.relPath).toBe("agents");
    expect(layout.agentsContainer?.files).toEqual(["dev1.md", "dev2.md"]);
    expect(layout.skillsContainer?.relPath).toBe("skills");
  });
});

describe("resolveSourceLayout: a relative repoRoot is canonicalized", () => {
  // `ccpluginizer scan ./myrepo` hands createLayoutResolver a "./"-prefixed path verbatim;
  // it must be resolved to absolute so the inside-skill parent walk terminates (otherwise
  // a relative root recurses toward the filesystem root and overflows the stack).
  test("a relative './<name>' repoRoot resolves the container without crashing", () => {
    const tmp = tempDir("ccp-relroot-");
    for (const n of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(tmp, "skills", n), { recursive: true });
      writeFileSync(join(tmp, "skills", n, "SKILL.md"), `---\ndescription: ${n}.\n---\n`);
    }
    const original = process.cwd();
    try {
      process.chdir(tmp);
      expect(resolveSourceLayout("./").skillsContainer?.relPath).toBe("skills");
    } finally {
      process.chdir(original);
    }
  });
});
