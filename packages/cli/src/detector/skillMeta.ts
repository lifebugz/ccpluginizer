import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { SkillFrontmatterSchema } from "../schemas/frontmatter.ts";
import { extractFrontmatter } from "./yaml.ts";

/** One skill's clustering-relevant metadata, plus its container-relative path. */
export interface SkillMeta {
  /** Path relative to the skills container, e.g. "./telnyx-voice-python/". */
  readonly path: string;
  /** The skill directory name. */
  readonly dir: string;
  readonly name: string;
  readonly description: string;
  readonly product?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly category?: string;
}

/**
 * Enumerate every direct child directory of `containerDir` that holds a valid
 * SKILL.md, returning per-skill metadata sorted by directory name (deterministic).
 * A non-existent container yields an empty array.
 */
export function enumerateSkills(containerDir: string): SkillMeta[] {
  if (!existsSync(containerDir) || !statSync(containerDir).isDirectory()) {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const dir of readdirSync(containerDir).sort()) {
    const skillPath = join(containerDir, dir);
    try {
      if (!statSync(skillPath).isDirectory()) {
        continue; // not a directory — skip
      }
    } catch {
      continue; // broken symlink / vanished between readdir and stat — skip, don't crash
    }
    const skillMd = join(skillPath, "SKILL.md");
    let raw: string;
    try {
      if (!statSync(skillMd).isFile()) {
        continue; // a directory named SKILL.md, etc. — not a skill
      }
      raw = readFileSync(skillMd, "utf8");
    } catch {
      continue; // missing / EISDIR / EACCES — skip rather than crash
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
  const category = fm.category ?? fm.metadata?.category;
  return {
    path: `./${dir}/`,
    dir,
    name: fm.name ?? dir,
    description: fm.description,
    ...(fm.metadata?.product !== undefined ? { product: fm.metadata.product } : {}),
    ...(fm.metadata?.language !== undefined ? { language: fm.metadata.language } : {}),
    ...(fm.tags !== undefined ? { tags: fm.tags } : {}),
    ...(category !== undefined ? { category } : {}),
  };
}
