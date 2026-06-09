import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { synthesizeEntry, synthesizeEntries } from "../src/detector/synthesize.ts";
import { makeFlatSkillsRepo, makeNestedPlugin } from "./helpers.ts";
import type { MarketplaceEntry } from "../src/schemas/marketplaceEntry.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");


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
    const res = await synthesizeEntries({
      repoRoot: root,
      sourceRepo: "test/telnyx",
      split: false,
      minSkillsToSplit: 2,
    });
    expect(res.split).toBeNull();
    expect(res.entries.length).toBe(1);
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
  });
});

describe("synthesizeEntries: re-curation vs abort", () => {
  test("re-curates an already-marketplace repo when the split gate fires", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 }, marketplace: true });
    const res = await synthesizeEntries({
      repoRoot: root,
      sourceRepo: "test/telnyx",
      strategy: "metadata",
      minSkillsToSplit: 2,
    });
    expect(res.split).not.toBeNull();
    expect(res.entries.length).toBeGreaterThan(1);
    // Re-curation is deliberate but never silent.
    expect(res.warnings.some((w) => w.includes("already publishes a marketplace"))).toBe(true);
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
    const res = await synthesizeEntries({
      repoRoot: root,
      sourceRepo: "test/telnyx",
      strategy: "metadata",
      minSkillsToSplit: 2,
    });
    expect(res.split).toBeNull();
    expect(res.entries.length).toBe(1);
    expect(res.entries[0]?.name).toBe("my-curated-plugin");
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
    const res = await synthesizeEntries({
      repoRoot: root,
      sourceRepo: "test/telnyx",
      umbrella: false,
      minSkillsToSplit: 2,
    });
    expect(res.split).not.toBeNull();
    const umbrella = res.entries.find((e) => e.strict === true);
    expect(umbrella?.name).toBe("telnyx");
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
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "local/whatever", minSkillsToSplit: 2 });
    expect(res.entries.every((e) => e.name.startsWith("telnyx"))).toBe(true);
    expect(res.entries.some((e) => e.name === "telnyx-voice")).toBe(true);
  });
});

describe("synthesizeEntries: warnings", () => {
  test("warns when a repo-local MCP is inlined into core", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 }, repoLocalMcp: true });
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
    expect(res.warnings.some((w) => /repo-local|MCP/i.test(w))).toBe(true);
  });

  test("warns that hooks and commands are not carried into the split", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 }, hooks: true, commands: true });
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
    const joined = res.warnings.join(" ");
    expect(joined).toMatch(/hooks/);
    expect(joined).toMatch(/commands/);
  });

  test("warns that a local source yields placeholder git URLs", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "local/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
    expect(res.warnings.some((w) => /local|placeholder/i.test(w))).toBe(true);
  });

  test("no spurious warnings for a clean remote-MCP split", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
    expect(res.warnings).toEqual([]);
  });
});

describe("synthesizeEntries: splitAttemptedButEmpty flag", () => {
  test("true when above threshold but no clean partition exists", async () => {
    const root = makeNestedPlugin({ products: { solo: 6 } }); // one product -> no partition
    const res = await synthesizeEntries({
      repoRoot: root,
      sourceRepo: "test/solo",
      strategy: "metadata",
      minSkillsToSplit: 2,
    });
    expect(res.split).toBeNull();
    expect(res.splitAttemptedButEmpty).toBe(true);
  });

  test("false on a successful split", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const res = await synthesizeEntries({
      repoRoot: root,
      sourceRepo: "test/telnyx",
      strategy: "metadata",
      minSkillsToSplit: 2,
    });
    expect(res.split).not.toBeNull();
    expect(res.splitAttemptedButEmpty).toBe(false);
  });

  test("false when sub-threshold (partitionSkills never called)", async () => {
    const res = await synthesizeEntries({
      repoRoot: join(FIXTURES, "skills-only"),
      sourceRepo: "test/skills-only",
    });
    expect(res.split).toBeNull();
    expect(res.splitAttemptedButEmpty).toBe(false);
  });
});

describe("synthesizeEntries: regression fixes", () => {
  test("plugin-less umbrella is strict:false and carries components explicitly", async () => {
    const root = makeFlatSkillsRepo({ alpha: 4, beta: 4 });
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/flat", umbrella: true, strategy: "metadata", minSkillsToSplit: 2 });
    const umbrella = res.entries.find((e) => e.name === "test-flat");
    expect(umbrella).toBeDefined();
    expect(umbrella?.strict).toBe(false); // strict needs plugin.json at the source root
    // A bare git-subdir at "." would rely on root auto-discovery; components are explicit.
    expect(umbrella?.skills).toContain("./skills/alpha-0/");
    expect(umbrella?.skills?.length).toBe(8);
  });

  test("--no-split with a freeze-only marker still detects skills (no bare entry)", async () => {
    const root = makeNestedPlugin({
      products: { messaging: 4, voice: 4 },
      marker: {
        name: "telnyx",
        core: true,
        groups: [
          { slug: "messaging", skills: [0, 1, 2, 3].map((i) => `./telnyx-messaging-${String(i)}/`) },
          { slug: "voice", skills: [0, 1, 2, 3].map((i) => `./telnyx-voice-${String(i)}/`) },
        ],
      },
    });
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", split: false });
    expect(res.entries.length).toBe(1);
    const entry = res.entries[0];
    expect(entry?.name).toBe("telnyx");
    expect(Array.isArray(entry?.skills)).toBe(true); // detection ran; skills were not dropped
    expect((entry?.skills ?? []).length).toBeGreaterThan(0);
  });

  test("core is never rooted at a container that would auto-load skills/", async () => {
    const root = makeFlatSkillsRepo({ alpha: 4, beta: 4 });
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { x: { type: "http", url: "https://x" } } }));
    writeFileSync(join(root, "dev.md"), "---\nname: dev\ndescription: Dev agent.\n---\n");
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/rooty", strategy: "metadata", minSkillsToSplit: 2 });
    const core = res.entries.find((e) => e.name.endsWith("-core"));
    expect(core).toBeDefined();
    expect(core?.agents).toBeUndefined(); // agents dropped rather than auto-loading every skill
    expect((core?.source as { path?: string }).path).toBe("skills");
    expect(res.warnings.some((w) => w.includes("auto-load"))).toBe(true);
  });

  test("an agents dir with its own (non-chosen) skills/ child is also refused as core root", async () => {
    const root = makeFlatSkillsRepo({ alpha: 4, beta: 4 });
    mkdirSync(join(root, "agents", "skills", "stray"), { recursive: true });
    writeFileSync(join(root, "agents", "dev.md"), "---\nname: dev\ndescription: Dev agent.\n---\n");
    writeFileSync(join(root, "agents", "skills", "stray", "SKILL.md"), "---\ndescription: stray.\n---\n");
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/agentskills", strategy: "metadata", minSkillsToSplit: 2 });
    const core = res.entries.find((e) => e.name.endsWith("-core"));
    // No MCP and the agents root is unsafe -> no core at all, with the auto-load warning.
    expect(core).toBeUndefined();
    expect(res.warnings.some((w) => w.includes("auto-load"))).toBe(true);
  });

  test("a marker with groups: [] takes the freeze-only path (skills are not dropped)", async () => {
    const root = makeNestedPlugin({
      products: { messaging: 4, voice: 4 },
      marker: { name: "curated", groups: [] },
    });
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx" });
    expect(res.entries.length).toBe(1);
    expect(res.entries[0]?.name).toBe("curated");
    expect((res.entries[0]?.skills ?? []).length).toBeGreaterThan(0); // detection ran
  });

  test("warns when skills exist outside the chosen container", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const stray = join(root, "extra", "stray-skill");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "SKILL.md"), "---\ndescription: stray.\n---\n");
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
    expect(res.warnings.some((w) => w.includes("outside"))).toBe(true);
  });
});

describe("synthesizeEntries: third-wave regressions", () => {
  test("a fully-stale marker does not bypass the min-skills threshold", async () => {
    const root = makeNestedPlugin({
      products: { messaging: 4, voice: 4 },
      marker: { name: "old", groups: [{ slug: "gone", skills: ["./vanished-skill/"] }] },
    });
    // 8 skills < default 25: with the marker voided, the threshold must hold.
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx" });
    expect(res.split).toBeNull();
    expect(res.warnings.some((w) => w.includes("ignoring the frozen split"))).toBe(true);
  });

  test("warns when SKILL.md dirs inside the container fail frontmatter parsing", async () => {
    const root = makeNestedPlugin({ products: { messaging: 4, voice: 4 } });
    const broken = join(root, "providers", "claude", "plugin", "skills", "broken-skill");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "SKILL.md"), "no frontmatter fence at all\n");
    const res = await synthesizeEntries({ repoRoot: root, sourceRepo: "test/telnyx", strategy: "metadata", minSkillsToSplit: 2 });
    expect(res.split).not.toBeNull();
    expect(res.warnings.some((w) => w.includes("invalid SKILL.md frontmatter"))).toBe(true);
  });
});
