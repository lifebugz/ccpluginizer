import { join } from "node:path";
import * as v from "valibot";
import { SkillFrontmatterSchema } from "../schemas/frontmatter.ts";
import { dirContainsFile, makeDirLister, type DirLister } from "./fsWalk.ts";
import { readFrontmatter, type FrontmatterReader } from "./frontmatterIo.ts";

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
    const fm = readFm(join(skillPath, "SKILL.md"));
    if (fm === null) {
      continue; // unreadable or fence-less — skip rather than crash
    }
    const parsed = v.safeParse(SkillFrontmatterSchema, fm);
    if (!parsed.success) {
      continue;
    }
    out.push(toMeta(dir, parsed.output));
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
 * Direct child dirs holding a SKILL.md, parse success or not — the coverage
 * denominator for "skills the split silently dropped" accounting. Uses the same
 * unfiltered child set as enumerateSkills, so the two counts are comparable.
 */
export function countSkillMdDirs(containerDir: string, list: DirLister = makeDirLister()): number {
  return list(containerDir).filter(
    (e) => e.isDirectory && dirContainsFile(list, join(containerDir, e.name), "SKILL.md"),
  ).length;
}
