// Frontmatter file IO + classification, layered above the mechanical fsWalk
// utilities: reading/memoizing YAML frontmatter and deciding what counts as an
// agent file are detector concerns, not filesystem ones.

import { readFileSync } from "node:fs";
import * as v from "valibot";
import { AgentFrontmatterSchema, SkillFrontmatterSchema } from "../schemas/frontmatter.ts";
import { extractFrontmatter } from "./yaml.ts";

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

/** Single authority for "is this a valid SKILL.md": frontmatter parses as a skill. */
export function isSkillFile(filePath: string, readFm: FrontmatterReader = readFrontmatter): boolean {
  const fm = readFm(filePath);
  return fm !== null && v.safeParse(SkillFrontmatterSchema, fm).success;
}
