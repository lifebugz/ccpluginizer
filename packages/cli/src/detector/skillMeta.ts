import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { SkillFrontmatterSchema } from "../schemas/frontmatter.ts";
import { extractFrontmatter } from "./yaml.ts";
import { makeDirLister, type DirLister } from "./fsWalk.ts";

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
 * to reuse its cached listings instead of re-walking the container.
 */
export function enumerateSkills(containerDir: string, list: DirLister = makeDirLister()): SkillMeta[] {
  const out: SkillMeta[] = [];
  const children = list(containerDir)
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort();
  for (const dir of children) {
    const skillPath = join(containerDir, dir);
    if (!list(skillPath).some((e) => e.isFile && e.name === "SKILL.md")) {
      continue; // no SKILL.md (or a directory named SKILL.md) — not a skill
    }
    let raw: string;
    try {
      raw = readFileSync(join(skillPath, "SKILL.md"), "utf8");
    } catch {
      continue; // vanished / EACCES between listing and read — skip rather than crash
    }
    const fm = extractFrontmatter(raw);
    if (fm === null) {
      continue;
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
