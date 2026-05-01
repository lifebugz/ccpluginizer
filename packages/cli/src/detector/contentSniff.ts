import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import * as v from "valibot";
import { SkillFrontmatterSchema, AgentFrontmatterSchema } from "../schemas/frontmatter.ts";
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
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") {
      continue;
    }
    const fullPath = join(dir, entry);
    const s = statSync(fullPath);
    if (s.isDirectory()) {
      walk(repoRoot, fullPath, visit);
    } else if (s.isFile()) {
      visit(fullPath);
    }
  }
}

function parseFrontmatter(filePath: string): Record<string, unknown> | null {
  const content = readFileSync(filePath, "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (match === null) {
    return null;
  }
  const yamlBody = match[1];
  if (yamlBody === undefined) {
    return null;
  }
  return parseYamlBlock(yamlBody);
}

function parseYamlBlock(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    out[key] = coerceYamlValue(rawValue);
  }
  return out;
}

function coerceYamlValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}
