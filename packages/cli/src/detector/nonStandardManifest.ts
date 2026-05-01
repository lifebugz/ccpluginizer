import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { NonStandardManifest } from "../schemas/nonStandardManifest.ts";
import { NonStandardManifestSchema } from "../schemas/nonStandardManifest.ts";

export interface NonStandardManifestFinding {
  readonly filename: string;
  readonly manifest: NonStandardManifest;
}

export function detectNonStandardManifest(
  repoRoot: string
): NonStandardManifestFinding | null {
  const dir = join(repoRoot, ".claude-plugin");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return null;
  }
  for (const entry of readdirSync(dir)) {
    if (entry === "plugin.json" || entry === "marketplace.json") {
      continue;
    }
    if (!entry.endsWith(".json")) {
      continue;
    }
    const filePath = join(dir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    const result = v.safeParse(NonStandardManifestSchema, parsed);
    if (!result.success) {
      continue;
    }
    const m = result.output;
    const hasComponent =
      m.skills !== undefined ||
      m.agents !== undefined ||
      m.commands !== undefined ||
      m.hooks !== undefined ||
      m.mcpServers !== undefined;
    if (!hasComponent) {
      continue;
    }
    return { filename: entry, manifest: m };
  }
  return null;
}
