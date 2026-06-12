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

export function isPermissionError(err: unknown): boolean {
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
  // Alias/cycle guard. The lister follows symlinks, so a link to an ancestor (or an
  // alias of another dir anywhere in the tree) would be re-traversed and double-
  // counted. Real directories are walked FIRST — globally, not just per parent — and
  // symlinked directories are deferred to a queue drained afterwards, so the real
  // path always registers an inode before any alias can claim it. Identity stats are
  // paid lazily: a symlink-free repo never stats at all.
  const realDirs: string[] = [];
  const pendingSymlinks: string[] = [];
  let seen: Set<string> | null = null;
  const idOf = (dir: string): string | null => {
    try {
      const st = statSync(dir);
      return `${String(st.dev)}:${String(st.ino)}`;
    } catch {
      return null; // vanished / unreadable — caller skips
    }
  };
  const walkInto = (dir: string): void => {
    options.onDir?.(dir);
    const entries = list(dir).filter((e) => !options.skipDirs.has(e.name));
    for (const entry of entries) {
      if (entry.isFile) {
        options.onFile?.(join(dir, entry.name));
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory && !entry.isSymlink) {
        const full = join(dir, entry.name);
        realDirs.push(full);
        if (seen !== null) {
          const id = idOf(full);
          if (id === null || seen.has(id)) {
            continue;
          }
          seen.add(id);
        }
        walkInto(full);
      } else if (entry.isDirectory && entry.isSymlink) {
        pendingSymlinks.push(join(dir, entry.name));
      }
    }
  };
  realDirs.push(root);
  walkInto(root);
  while (pendingSymlinks.length > 0) {
    // First symlinked dir encountered: register every real dir's identity now.
    seen ??= new Set(realDirs.map(idOf).filter((id): id is string => id !== null));
    const dir = pendingSymlinks.shift();
    if (dir === undefined) {
      break;
    }
    const id = idOf(dir);
    if (id === null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    walkInto(dir);
  }
}

/**
 * Read + JSON.parse with uniform failure messages. Read failures and parse failures
 * are reported distinctly — an EACCES must not masquerade as "Invalid JSON".
 */
export function readJsonFile(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
}
