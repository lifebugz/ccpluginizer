import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import * as v from "valibot";
import { SkillFrontmatterSchema, AgentFrontmatterSchema } from "../schemas/frontmatter.ts";
import { extractFrontmatter } from "./yaml.ts";
import type { Finding } from "./types.ts";

export function detectContentSniff(repoRoot: string): readonly Finding[] {
  const skillDirs = new Set<string>();
  const agentFiles = new Set<string>();

  walk(repoRoot, repoRoot, (filePath) => {
    if (filePath.endsWith("SKILL.md")) {
      const fm = parseFrontmatter(filePath);
      if (fm !== null && v.safeParse(SkillFrontmatterSchema, fm).success) {
        const dir = dirname(filePath);
        skillDirs.add(dir);
      }
      return;
    }
    if (filePath.endsWith(".md")) {
      const fm = parseFrontmatter(filePath);
      if (fm !== null && v.safeParse(AgentFrontmatterSchema, fm).success) {
        agentFiles.add(filePath);
      }
    }
  });

  const findings: Finding[] = [];
  if (skillDirs.size > 0) {
    findings.push({
      kind: "skills",
      paths: Array.from(skillDirs).map((dir) => `./${relative(repoRoot, dir)}/`),
      confidence: "medium",
      source: "sniff",
    });
  }
  if (agentFiles.size > 0) {
    findings.push({
      kind: "agents",
      paths: Array.from(agentFiles).map((file) => `./${relative(repoRoot, file)}`),
      confidence: "medium",
      source: "sniff",
    });
  }
  return findings;
}

function walk(repoRoot: string, dir: string, visit: (filePath: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable dir (EACCES) or vanished mid-walk — skip rather than abort the scan
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") {
      continue;
    }
    const fullPath = join(dir, entry);
    let s;
    try {
      s = statSync(fullPath);
    } catch {
      continue; // broken symlink / race between readdir and stat — skip this entry
    }
    if (s.isDirectory()) {
      walk(repoRoot, fullPath, visit);
    } else if (s.isFile()) {
      visit(fullPath);
    }
  }
}

function parseFrontmatter(filePath: string): Record<string, unknown> | null {
  return extractFrontmatter(readFileSync(filePath, "utf8"));
}
