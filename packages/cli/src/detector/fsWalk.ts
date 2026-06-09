// Shared filesystem traversal: one error-tolerant, symlink-following, memoized
// lister feeds every detector (sourceLayout, contentSniff, skillMeta), so a scan
// pays one readdir per directory instead of three and never re-stats a child.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { AgentFrontmatterSchema } from "../schemas/frontmatter.ts";
import { extractFrontmatter } from "./yaml.ts";

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

export type DirLister = (dir: string) => readonly DirEntry[];

/**
 * Memoized directory lister. Unreadable/vanished dirs yield [] (EACCES or a race
 * must skip a directory, not abort the scan); symlinked entries are stat-followed
 * so a symlinked skills dir still counts as a directory.
 */
export function makeDirLister(): DirLister {
  const cache = new Map<string, readonly DirEntry[]>();
  return (dir: string): readonly DirEntry[] => {
    const hit = cache.get(dir);
    if (hit !== undefined) {
      return hit;
    }
    let out: DirEntry[] = [];
    try {
      out = readdirSync(dir, { withFileTypes: true }).map((d) => {
        if (d.isSymbolicLink()) {
          try {
            const s = statSync(join(dir, d.name));
            return { name: d.name, isDirectory: s.isDirectory(), isFile: s.isFile() };
          } catch {
            return { name: d.name, isDirectory: false, isFile: false }; // broken symlink
          }
        }
        return { name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() };
      });
    } catch {
      // unreadable dir (EACCES) or vanished mid-walk
    }
    cache.set(dir, out);
    return out;
  };
}

export interface WalkOptions {
  readonly skipDirs: ReadonlySet<string>;
  readonly list?: DirLister;
  readonly onDir?: (dir: string) => void;
  readonly onFile?: (file: string) => void;
}

/** Depth-first walk from root (root itself visits onDir), skipping skipDirs by name. */
export function walkTree(root: string, options: WalkOptions): void {
  const list = options.list ?? makeDirLister();
  const visit = (dir: string): void => {
    options.onDir?.(dir);
    for (const entry of list(dir)) {
      if (options.skipDirs.has(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        visit(full);
      } else if (entry.isFile) {
        options.onFile?.(full);
      }
    }
  };
  visit(root);
}

/** Read + JSON.parse with a uniform "Invalid JSON in <file>" failure message. */
export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
}

/** Read a file and extract its YAML frontmatter; null when unreadable or fence-less. */
export function readFrontmatter(filePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null; // vanished / EACCES between listing and read — skip, don't abort the scan
  }
  return extractFrontmatter(raw);
}

/** Single authority for "is this .md an agent file": frontmatter parses as agent. */
export function isAgentFile(filePath: string): boolean {
  const fm = readFrontmatter(filePath);
  return fm !== null && v.safeParse(AgentFrontmatterSchema, fm).success;
}
