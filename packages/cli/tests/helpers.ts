// Shared test scaffolding: one SkillMeta factory and one nested-plugin builder,
// so a SkillMeta or fixture-layout change cannot silently leave a suite testing
// a stale shape.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SkillMeta } from "../src/detector/skillMeta.ts";

/** Minimal SkillMeta factory for partition/grouper tests. */
export function mk(dir: string, product?: string): SkillMeta {
  return {
    path: `./${dir}/`,
    dir,
    name: dir,
    description: `Skill ${dir}`,
    ...(product !== undefined ? { product } : {}),
  };
}

export interface PluginOpts {
  products: Record<string, number>;
  marketplace?: boolean;
  hooks?: boolean;
  commands?: boolean;
  repoLocalMcp?: boolean;
  marker?: Record<string, unknown>;
}

/** Scaffold a telnyx-shaped nested plugin in a temp dir. Caller rm -rf's the result. */
export function makeNestedPlugin(opts: PluginOpts): string {
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
