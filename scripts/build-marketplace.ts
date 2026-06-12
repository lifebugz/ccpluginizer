#!/usr/bin/env bun
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { collectEntries, validateEntries } from "../packages/cli/src/detector/validateEntries.ts";
import { byCodeUnit } from "../packages/cli/src/detector/slugify.ts";

const ROOT = join(import.meta.dirname, "..");
const ENTRIES_DIR = join(ROOT, "entries");
const TOMBSTONES_DIR = join(ROOT, "tombstones");
const OUTPUT = join(ROOT, ".claude-plugin", "marketplace.json");

interface MarketplaceFile {
  name: string;
  description: string;
  owner: { name: string };
  plugins: unknown[];
}

const tombstoned = new Set(
  readdirSync(TOMBSTONES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", "")),
);

// Same loader + validator as `ccpluginizer validate`: flattens array-shaped entry
// files (a split scan emits several entries per file), enforces cross-entry name
// uniqueness, and names the offending file in every error. An entries/ dir with no
// files (e.g. the last entry just moved to tombstones/) builds an empty catalog.
const { items, sources } = collectEntries(ENTRIES_DIR, { allowEmptyDir: true });
const check = validateEntries(items, sources);
if (!check.ok) {
  console.error("Invalid entries:");
  for (const error of check.errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

const entries = check.entries
  .filter((e) => !tombstoned.has(e.name))
  .sort((a, b) => byCodeUnit(a.name, b.name));

const marketplace: MarketplaceFile = {
  name: "ccp-marketplace",
  description: "Marketplace of pluginized non-plugin Claude Code repos",
  owner: { name: "ccpluginizer" },
  plugins: entries,
};

mkdirSync(join(ROOT, ".claude-plugin"), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(marketplace, null, 2) + "\n", "utf8");
console.log(`Wrote ${entries.length} entries to ${OUTPUT}`);
