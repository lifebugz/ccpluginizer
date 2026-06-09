import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { MarketplaceEntrySchema } from "../schemas/marketplaceEntry.ts";
import { readJsonFile } from "./fsWalk.ts";

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
      // Prefix each message with its dot path — "skills.0: Invalid type" identifies
      // the failing field, where the bare message alone would not.
      const detail = result.issues
        .map((issue) => {
          const path = v.getDotPath(issue);
          return path === null ? issue.message : `${path}: ${issue.message}`;
        })
        .join("; ");
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
    const files = readdirSync(path)
      .filter((f) => f.endsWith(".json"))
      .sort();
    // A directory with no entry files is almost always a wrong-path mistake;
    // returning [] would make `validate <dir>` falsely report "OK (0 entries)".
    if (files.length === 0) {
      throw new Error(`No entry JSON files (*.json) found in directory: ${path}`);
    }
    // Flatten array-shaped files the same way the single-file branch does, so a
    // multi-entry array dropped into the directory validates entry-by-entry rather
    // than being mis-parsed as one (non-conforming) array element.
    return files.flatMap((f) => toEntryList(readJsonFile(join(path, f))));
  }
  return toEntryList(readJsonFile(path));
}

/** A parsed JSON file is either a single entry or an array of entries. */
function toEntryList(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [parsed];
}
