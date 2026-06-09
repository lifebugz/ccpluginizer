#!/usr/bin/env bun
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { MarketplaceEntrySchema } from "../packages/cli/src/schemas/marketplaceEntry.ts";
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
// files (a split scan emits several entries per file) and enforces cross-entry
// name uniqueness across the whole catalog.
const items = collectEntries(ENTRIES_DIR);
const check = validateEntries(items);
if (!check.ok) {
  console.error("Invalid entries:");
  for (const error of check.errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

const entries = items
  .map((item) => v.parse(MarketplaceEntrySchema, item))
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
