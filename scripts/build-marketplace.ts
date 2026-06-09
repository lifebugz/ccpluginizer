#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { MarketplaceEntrySchema } from "../packages/cli/src/schemas/marketplaceEntry.ts";

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

const entries = readdirSync(ENTRIES_DIR)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => {
    const raw = readFileSync(join(ENTRIES_DIR, f), "utf8");
    const parsed: unknown = JSON.parse(raw);
    // scan emits a JSON array when a split produces multiple entries — accept both
    // shapes per file, mirroring `ccpluginizer validate`.
    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((item, i) => {
      const result = v.safeParse(MarketplaceEntrySchema, item);
      if (!result.success) {
        console.error(`Invalid entry ${f}${items.length > 1 ? `[${String(i)}]` : ""}:`, result.issues);
        process.exit(1);
      }
      return result.output;
    });
  })
  .filter((e) => !tombstoned.has(e.name))
  // code-unit compare: localeCompare ordering varies across machines/ICU builds
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const marketplace: MarketplaceFile = {
  name: "ccp-marketplace",
  description: "Marketplace of pluginized non-plugin Claude Code repos",
  owner: { name: "ccpluginizer" },
  plugins: entries,
};

mkdirSync(join(ROOT, ".claude-plugin"), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(marketplace, null, 2) + "\n", "utf8");
console.log(`Wrote ${entries.length} entries to ${OUTPUT}`);
