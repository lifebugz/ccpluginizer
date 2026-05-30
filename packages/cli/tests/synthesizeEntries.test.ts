import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { synthesizeEntry, synthesizeEntries } from "../src/detector/synthesize.ts";
import type { MarketplaceEntry } from "../src/schemas/marketplaceEntry.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

interface PluginOpts {
  products: Record<string, number>;
  marketplace?: boolean;
  hooks?: boolean;
  commands?: boolean;
  repoLocalMcp?: boolean;
  marker?: Record<string, unknown>;
}

/** Scaffold a telnyx-shaped nested plugin in a temp dir. */
function makeNestedPlugin(opts: PluginOpts): string {
  const root = mkdtempSync(join(tmpdir(), "ccp-nested-"));
  const plugin = join(root, "providers", "claude", "plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "telnyx" }));
  if (opts.marketplace === true) {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "telnyx", plugins: [{ name: "telnyx", source: "./providers/claude/plugin/" }] }),
    );
  }
  const mcp = opts.repoLocalMcp === true
    ? { mcpServers: { local: { command: "node", args: ["./server/index.js"] } } }
    : { mcpServers: { telnyx: { type: "http", url: "https://api.telnyx.com/v2/mcp" } } };
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify(mcp));
  mkdirSync(join(plugin, "agents"), { recursive: true });
  writeFileSync(
    join(plugin, "agents", "telnyx-developer.md"),
    "---\nname: telnyx-developer\ndescription: Telnyx dev agent.\n---\n",
  );
  if (opts.hooks === true) {
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
  }
  if (opts.commands === true) {
    mkdirSync(join(plugin, "commands"), { recursive: true });
    writeFileSync(join(plugin, "commands", "dothing.md"), "---\ndescription: Do a thing.\n---\n");
  }
  if (opts.marker !== undefined) {
    writeFileSync(join(root, ".ccpluginizer.json"), JSON.stringify(opts.marker));
  }
  for (const [product, count] of Object.entries(opts.products)) {
    for (let i = 0; i < count; i++) {
      const dir = join(plugin, "skills", `telnyx-${product}-${String(i)}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: telnyx-${product}-${String(i)}\ndescription: ${product} skill ${String(i)}.\nmetadata:\n  product: ${product}\n---\n`,
      );
    }
  }
  return root;
}

describe("synthesizeEntries: back-compat (no split)", () => {
  test("sub-threshold repo returns a single entry identical to synthesizeEntry", async () => {
    const repoRoot = join(FIXTURES, "skills-only");
    const single = synthesizeEntry({ repoRoot, sourceRepo: "test/skills-only" });
    const res = await synthesizeEntries({ repoRoot, sourceRepo: "test/skills-only" });
    expect(res.split).toBeNull();
    expect(res.entries.length).toBe(1);
    expect(res.entries[0]).toEqual(single);
  });

  test("--no-split forces a single entry even on a splittable repo", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    try {
      const res = await synthesizeEntries({
        repoRoot: root,
        sourceRepo: "test/telnyx",
        split: false,
        minSkillsToSplit: 2,
      });
      expect(res.split).toBeNull();
      expect(res.entries.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("synthesizeEntries: guarded split", () => {
  let root: string;
  let entries: MarketplaceEntry[];
  let coreName: string;

  beforeAll(async () => {
    root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const res = await synthesizeEntries({
      repoRoot: root,
      sourceRepo: "test/telnyx",
      strategy: "metadata",
      minSkillsToSplit: 2,
    });
    entries = res.entries;
    coreName = "test-telnyx-core";
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("emits a core entry plus one slice per product group", () => {
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("test-telnyx-core");
    expect(names).toContain("test-telnyx-messaging");
    expect(names).toContain("test-telnyx-voice");
  });

  test("every emitted name is schema-valid and unique", () => {
    const names = entries.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => /^[a-z0-9][a-z0-9-]*$/.test(n))).toBe(true);
  });

  test("core inlines mcpServers and enumerates agents, with zero skills", () => {
    const core = entries.find((e) => e.name === coreName);
    expect(core?.skills).toBeUndefined();
    expect(core?.mcpServers).toEqual({ telnyx: { type: "http", url: "https://api.telnyx.com/v2/mcp" } });
    expect(core?.agents).toEqual(["./telnyx-developer.md"]);
    expect(core?.source).toEqual({
      source: "git-subdir",
      url: "https://github.com/test/telnyx.git",
      path: "providers/claude/plugin/agents",
    });
  });

  test("each slice is a git-subdir at the skills container with enumerated skills + a core dependency", () => {
    const slice = entries.find((e) => e.name === "test-telnyx-voice");
    expect(slice?.source).toEqual({
      source: "git-subdir",
      url: "https://github.com/test/telnyx.git",
      path: "providers/claude/plugin/skills",
    });
    expect(slice?.dependencies).toEqual([coreName]);
    expect(slice?.skills?.length).toBe(4);
    expect(slice?.skills?.every((p) => p.startsWith("./telnyx-voice-"))).toBe(true);
  });

  test("every skill is covered exactly once across all slices (disjoint + total)", () => {
    const slices = entries.filter((e) => e.name !== coreName && e.skills !== undefined);
    const allSkills = slices.flatMap((e) => e.skills ?? []);
    expect(new Set(allSkills).size).toBe(allSkills.length);
    expect(allSkills.length).toBe(8);
  });

  test("reports the split strategy and group count", async () => {
    const res = await synthesizeEntries({
      repoRoot: root,
      sourceRepo: "test/telnyx",
      strategy: "metadata",
      minSkillsToSplit: 2,
    });
    expect(res.split?.strategy).toBe("metadata");
    expect(res.split?.groupCount).toBe(2);
  });
});

describe("synthesizeEntries: umbrella opt-in", () => {
  test("emits an umbrella entry (git-subdir at plugin root, strict:true) only when requested", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    try {
      const res = await synthesizeEntries({
        repoRoot: root,
        sourceRepo: "test/telnyx",
        strategy: "metadata",
        minSkillsToSplit: 2,
        umbrella: true,
      });
      const umbrella = res.entries.find((e) => e.name === "test-telnyx");
      expect(umbrella?.strict).toBe(true);
      expect(umbrella?.source).toEqual({
        source: "git-subdir",
        url: "https://github.com/test/telnyx.git",
        path: "providers/claude/plugin",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("synthesizeEntries: re-curation vs abort", () => {
  test("re-curates an already-marketplace repo when the split gate fires", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 }, marketplace: true });
    try {
      const res = await synthesizeEntries({
        repoRoot: root,
        sourceRepo: "test/telnyx",
        strategy: "metadata",
        minSkillsToSplit: 2,
      });
      expect(res.split).not.toBeNull();
      expect(res.entries.length).toBeGreaterThan(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves the abort for an already-marketplace repo that does not split", async () => {
    let threw = false;
    try {
      await synthesizeEntries({ repoRoot: join(FIXTURES, "already-marketplace"), sourceRepo: "test/am" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("synthesizeEntries: marker authority", () => {
  test("a committed marker WITHOUT groups suppresses the auto-split (honors curation)", async () => {
    const root = makeNestedPlugin({
      products: { messaging: 4, voice: 4 },
      marker: { name: "my-curated-plugin", skills: ["./providers/claude/plugin/skills/"] },
    });
    try {
      const res = await synthesizeEntries({
        repoRoot: root,
        sourceRepo: "test/telnyx",
        strategy: "metadata",
        minSkillsToSplit: 2,
      });
      expect(res.split).toBeNull();
      expect(res.entries.length).toBe(1);
      expect(res.entries[0]?.name).toBe("my-curated-plugin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marker.umbrella:true is honored even when the umbrella flag is at its default (false)", async () => {
    const skills = (p: string): string[] =>
      [0, 1, 2, 3].map((i) => `./telnyx-${p}-${String(i)}/`);
    const root = makeNestedPlugin({
      products: { messaging: 4, voice: 4 },
      marker: {
        name: "telnyx",
        umbrella: true,
        groups: [
          { slug: "messaging", skills: skills("messaging") },
          { slug: "voice", skills: skills("voice") },
        ],
      },
    });
    try {
      const res = await synthesizeEntries({
        repoRoot: root,
        sourceRepo: "test/telnyx",
        umbrella: false,
        minSkillsToSplit: 2,
      });
      expect(res.split).not.toBeNull();
      const umbrella = res.entries.find((e) => e.strict === true);
      expect(umbrella?.name).toBe("telnyx");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marker.name is used as the base for split entry names", async () => {
    const skills = (p: string): string[] =>
      [0, 1, 2, 3].map((i) => `./telnyx-${p}-${String(i)}/`);
    const root = makeNestedPlugin({
      products: { messaging: 4, voice: 4 },
      marker: {
        name: "telnyx",
        groups: [
          { slug: "messaging", skills: skills("messaging") },
          { slug: "voice", skills: skills("voice") },
        ],
      },
    });
    try {
      const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "local/whatever", minSkillsToSplit: 2 });
      expect(res.entries.every((e) => e.name.startsWith("telnyx"))).toBe(true);
      expect(res.entries.some((e) => e.name === "telnyx-voice")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("synthesizeEntries: warnings", () => {
  test("warns when a repo-local MCP is inlined into core", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 }, repoLocalMcp: true });
    try {
      const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
      expect(res.warnings.some((w) => /repo-local|MCP/i.test(w))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns that hooks and commands are not carried into the split", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 }, hooks: true, commands: true });
    try {
      const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
      const joined = res.warnings.join(" ");
      expect(joined).toMatch(/hooks/);
      expect(joined).toMatch(/commands/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns that a local source yields placeholder git URLs", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    try {
      const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "local/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
      expect(res.warnings.some((w) => /local|placeholder/i.test(w))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no spurious warnings for a clean remote-MCP split", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    try {
      const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
      expect(res.warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
