// Frontmatter file IO + classification, layered above the mechanical fsWalk
// utilities: reading/memoizing YAML frontmatter and deciding what counts as an
// agent file are detector concerns, not filesystem ones.

import { readFileSync } from "node:fs";
import * as v from "valibot";
import { AgentFrontmatterSchema, SkillFrontmatterSchema, type SkillFrontmatter } from "../schemas/frontmatter.ts";
import { extractFrontmatter } from "./yaml.ts";
import { isPermissionError, type SkipReporter } from "./fsWalk.ts";

/**
 * Read a file and extract its YAML frontmatter; null when unreadable or fence-less.
 * Permission failures report to `onSkip` so detection is never silently incomplete.
 */
export function readFrontmatter(filePath: string, onSkip?: SkipReporter): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (isPermissionError(err)) {
      onSkip?.(filePath, err);
    }
    return null; // vanished mid-walk or unreadable — skip, don't abort the scan
  }
  return extractFrontmatter(raw);
}

export type FrontmatterReader = (file: string) => Record<string, unknown> | null;

/** Memoizing frontmatter reader, so layout resolution and sniffing parse each file once. */
export function makeFrontmatterReader(onSkip?: SkipReporter): FrontmatterReader {
  const cache = new Map<string, Record<string, unknown> | null>();
  return (file: string): Record<string, unknown> | null => {
    if (cache.has(file)) {
      return cache.get(file) ?? null;
    }
    const fm = readFrontmatter(file, onSkip);
    cache.set(file, fm);
    return fm;
  };
}

/** Single authority for "is this .md an agent file": frontmatter parses as agent. */
export function isAgentFile(filePath: string, readFm: FrontmatterReader = readFrontmatter): boolean {
  const fm = readFm(filePath);
  return fm !== null && v.safeParse(AgentFrontmatterSchema, fm).success;
}

/** Single authority for SKILL.md validity: the parsed frontmatter, or null. */
export function parseSkillFile(filePath: string, readFm: FrontmatterReader = readFrontmatter): SkillFrontmatter | null {
  const fm = readFm(filePath);
  if (fm === null) {
    return null;
  }
  const parsed = v.safeParse(SkillFrontmatterSchema, fm);
  return parsed.success ? parsed.output : null;
}

/** Boolean form of parseSkillFile, for the sniffer. */
export function isSkillFile(filePath: string, readFm: FrontmatterReader = readFrontmatter): boolean {
  return parseSkillFile(filePath, readFm) !== null;
}
