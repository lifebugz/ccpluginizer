import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { MarketplaceEntrySchema } from "../schemas/marketplaceEntry.ts";

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
}

/**
 * Validate a list of parsed entries against the schema and enforce cross-entry
 * name uniqueness (the schema cannot check uniqueness on its own — this mirrors
 * `claude plugin validate`'s duplicate-name guard).
 */
export function validateEntries(items: readonly unknown[]): ValidationResult {
  const errors: string[] = [];
  const names: string[] = [];

  items.forEach((item, i) => {
    const result = v.safeParse(MarketplaceEntrySchema, item);
    if (!result.success) {
      const detail = result.issues.map((issue) => issue.message).join("; ");
      errors.push(`entry[${String(i)}]: ${detail}`);
    } else {
      names.push(result.output.name);
    }
  });

  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const name of names) {
    if (seen.has(name) && !reported.has(name)) {
      errors.push(`duplicate entry name: ${name}`);
      reported.add(name);
    }
    seen.add(name);
  }

  return { ok: errors.length === 0, errors };
}

/** Read parsed entries from a file (object or array) or a directory of *.json files. */
export function collectEntries(path: string): unknown[] {
  if (!existsSync(path)) {
    throw new Error(`No such file or directory: ${path}`);
  }
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => parseJsonFile(join(path, f)));
  }
  const parsed = parseJsonFile(path);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
}
