// Shared filesystem traversal: one error-tolerant, symlink-following, memoized
// lister feeds every detector, so a scan pays one readdir per directory. This is
// the purely mechanical layer — frontmatter/domain classification lives in
// frontmatterIo.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  /** True when the entry is a symlink (its kind above is the stat-followed target's). */
  readonly isSymlink: boolean;
}

export type DirLister = (dir: string) => readonly DirEntry[];

/** Invoked when a path is skipped because it could not be read (not for ENOENT races). */
export type SkipReporter = (path: string, err: unknown) => void;

function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Memoized directory lister. Unreadable/vanished dirs yield [] (EACCES or a race
 * must skip a directory, not abort the scan) — permission failures are reported to
 * `onSkip` so the caller can warn that detection was incomplete. Symlinked entries
 * are stat-followed so a symlinked skills dir still counts as a directory.
 */
export function makeDirLister(onSkip?: SkipReporter): DirLister {
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
            return { name: d.name, isDirectory: s.isDirectory(), isFile: s.isFile(), isSymlink: true };
          } catch {
            return { name: d.name, isDirectory: false, isFile: false, isSymlink: true }; // broken symlink
          }
        }
        return { name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile(), isSymlink: false };
      });
    } catch (err) {
      // unreadable dir (EACCES) or vanished mid-walk; only the former is worth a warning
      if (isPermissionError(err)) {
        onSkip?.(dir, err);
      }
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
  // otherwise re-traverse the tree until the kernel's resolution limit. A cycle can
  // only enter via a symlink, so only symlinked directories pay the identity stat.
  const seen = new Set<string>();
  const visit = (dir: string, viaSymlink: boolean): void => {
    if (viaSymlink) {
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
    }
    options.onDir?.(dir);
    for (const entry of list(dir)) {
      if (options.skipDirs.has(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        visit(full, viaSymlink || entry.isSymlink);
      } else if (entry.isFile) {
        options.onFile?.(full);
      }
    }
  };
  visit(root, false);
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
