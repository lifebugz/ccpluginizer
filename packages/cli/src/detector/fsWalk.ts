// Shared filesystem traversal: one error-tolerant, symlink-following, memoized
// lister feeds every detector (sourceLayout, contentSniff, skillMeta), so a scan
// pays one readdir per directory and parses each frontmatter file at most once.

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

/** Does `dir`'s cached listing contain a regular file named `name`? */
export function dirContainsFile(list: DirLister, dir: string, name: string): boolean {
  return list(dir).some((e) => e.isFile && e.name === name);
}

/** Does `dir`'s cached listing contain a directory named `name`? */
export function dirContainsDir(list: DirLister, dir: string, name: string): boolean {
  return list(dir).some((e) => e.isDirectory && e.name === name);
}

/** Final path segment, ignoring "."/empty segments and a trailing slash. */
export function lastPathSegment(p: string): string {
  const parts = p.split("/").filter((seg) => seg !== "" && seg !== ".");
  return parts[parts.length - 1] ?? p;
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
  // Cycle guard: the lister follows symlinks, so a link to an ancestor would
  // otherwise re-traverse the tree until the kernel's resolution limit. Track
  // visited directories by dev:ino identity, not by (alias-prone) path.
  const seen = new Set<string>();
  const visit = (dir: string): void => {
    let id: string;
    try {
      const st = statSync(dir);
      id = `${String(st.dev)}:${String(st.ino)}`;
    } catch {
      return; // vanished / unreadable — skip
    }
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
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

export type FrontmatterReader = (file: string) => Record<string, unknown> | null;

/** Memoizing frontmatter reader, so layout resolution and sniffing parse each file once. */
export function makeFrontmatterReader(): FrontmatterReader {
  const cache = new Map<string, Record<string, unknown> | null>();
  return (file: string): Record<string, unknown> | null => {
    if (cache.has(file)) {
      return cache.get(file) ?? null;
    }
    const fm = readFrontmatter(file);
    cache.set(file, fm);
    return fm;
  };
}

/** Single authority for "is this .md an agent file": frontmatter parses as agent. */
export function isAgentFile(filePath: string, readFm: FrontmatterReader = readFrontmatter): boolean {
  const fm = readFm(filePath);
  return fm !== null && v.safeParse(AgentFrontmatterSchema, fm).success;
}
