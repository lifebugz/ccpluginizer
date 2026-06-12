import { join } from "node:path";
import type * as v from "valibot";
import type { SkillFrontmatterSchema } from "../schemas/frontmatter.ts";
import { dirContainsFile, makeDirLister, type DirLister } from "./fsWalk.ts";
import { parseSkillFile, readFrontmatter, type FrontmatterReader } from "./frontmatterIo.ts";

/** One skill's clustering-relevant metadata, plus its container-relative path. */
export interface SkillMeta {
  /** Path relative to the skills container, e.g. "./telnyx-voice-python/". */
  readonly path: string;
  /** The skill directory name. */
  readonly dir: string;
  readonly name: string;
  readonly description: string;
  readonly product?: string;
}

/**
 * Enumerate every direct child directory of `containerDir` that holds a valid
 * SKILL.md, returning per-skill metadata sorted by directory name (deterministic).
 * A non-existent container yields an empty array. Pass the layout resolver's lister
 * and frontmatter reader to reuse its caches instead of re-walking the container.
 */
export function enumerateSkills(
  containerDir: string,
  list: DirLister = makeDirLister(),
  readFm: FrontmatterReader = readFrontmatter,
): SkillMeta[] {
  const out: SkillMeta[] = [];
  const children = list(containerDir)
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort();
  for (const dir of children) {
    const skillPath = join(containerDir, dir);
    if (!dirContainsFile(list, skillPath, "SKILL.md")) {
      continue; // no SKILL.md (or a directory named SKILL.md) — not a skill
    }
    const parsed = parseSkillFile(join(skillPath, "SKILL.md"), readFm);
    if (parsed === null) {
      continue; // unreadable, fence-less, or schema-invalid — skip rather than crash
    }
    out.push(toMeta(dir, parsed));
  }
  return out;
}

function toMeta(dir: string, fm: v.InferOutput<typeof SkillFrontmatterSchema>): SkillMeta {
  return {
    path: `./${dir}/`,
    dir,
    name: fm.name ?? dir,
    description: fm.description,
    ...(fm.metadata?.product !== undefined ? { product: fm.metadata.product } : {}),
  };
}

/**
 * Direct child dirs holding a SKILL.md, parse success or not. With no skip set this
 * uses the same unfiltered child set as enumerateSkills (the coverage denominator
 * for "skills the split silently dropped"); container-resolution scoring passes its
 * SKIP_DIRS to avoid probing children that can never win.
 */
export function countSkillMdDirs(
  containerDir: string,
  list: DirLister = makeDirLister(),
  skipDirs?: ReadonlySet<string>,
): number {
  return list(containerDir).filter(
    (e) =>
      e.isDirectory &&
      !(skipDirs?.has(e.name) ?? false) &&
      dirContainsFile(list, join(containerDir, e.name), "SKILL.md"),
  ).length;
}
