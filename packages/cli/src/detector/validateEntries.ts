import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as v from "valibot";
import { MarketplaceEntrySchema, type MarketplaceEntry } from "../schemas/marketplaceEntry.ts";
import { readJsonFile } from "./fsWalk.ts";

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
  /** Schema-parsed outputs of the valid items (complete only when ok). */
  readonly entries: MarketplaceEntry[];
}

/**
 * Validate a list of parsed entries against the schema and enforce cross-entry
 * name uniqueness (the schema cannot check uniqueness on its own — this mirrors
 * `claude plugin validate`'s duplicate-name guard). Pass `sources` so errors name
 * the offending file instead of a flattened index.
 */
export function validateEntries(items: readonly unknown[], sources?: readonly string[]): ValidationResult {
  const errors: string[] = [];
  const entries: MarketplaceEntry[] = [];
  const nameSource = new Map<string, string>();
  const label = (i: number): string => sources?.[i] ?? `entry[${String(i)}]`;

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
      errors.push(`${label(i)}: ${detail}`);
      return;
    }
    const name = result.output.name;
    const firstSource = nameSource.get(name);
    if (firstSource !== undefined) {
      errors.push(`duplicate entry name: ${name} (${label(i)} also declared in ${firstSource})`);
      return;
    }
    nameSource.set(name, label(i));
    entries.push(result.output);
  });

  return { ok: errors.length === 0, errors, entries };
}

export interface CollectedEntries {
  readonly items: unknown[];
  /** Provenance label per item: the file name, plus [index] for array-shaped files. */
  readonly sources: string[];
}

/** Read parsed entries from a file (object or array) or a directory of *.json files. */
export function collectEntries(path: string): CollectedEntries {
  if (!existsSync(path)) {
    throw new Error(`No such file or directory: ${path}`);
  }
  const items: unknown[] = [];
  const sources: string[] = [];
  const add = (parsed: unknown, fileLabel: string): void => {
    const list = toEntryList(parsed);
    list.forEach((item, i) => {
      items.push(item);
      sources.push(list.length > 1 ? `${fileLabel}[${String(i)}]` : fileLabel);
    });
  };
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
    for (const f of files) {
      add(readJsonFile(join(path, f)), f);
    }
  } else {
    add(readJsonFile(path), basename(path));
  }
  // A `[]` file (or a directory of them) is a truncated artifact, not a valid catalog.
  if (items.length === 0) {
    throw new Error(`No entries found in: ${path}`);
  }
  return { items, sources };
}

/** A parsed JSON file is either a single entry or an array of entries. */
function toEntryList(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [parsed];
}
