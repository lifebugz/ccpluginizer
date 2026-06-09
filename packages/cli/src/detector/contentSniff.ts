import { dirname, relative } from "node:path";
import * as v from "valibot";
import { SkillFrontmatterSchema } from "../schemas/frontmatter.ts";
import { isAgentFile, readFrontmatter, walkTree } from "./fsWalk.ts";
import type { Finding } from "./types.ts";

// Sniffing is the last-resort detection layer, so it looks everywhere except
// dependency/VCS internals (unlike sourceLayout, it must see tests/examples).
const SNIFF_SKIP_DIRS = new Set(["node_modules", ".git"]);

export function detectContentSniff(repoRoot: string): readonly Finding[] {
  const skillDirs = new Set<string>();
  const agentFiles = new Set<string>();

  walkTree(repoRoot, {
    skipDirs: SNIFF_SKIP_DIRS,
    onFile: (filePath) => {
      if (filePath.endsWith("SKILL.md")) {
        const fm = readFrontmatter(filePath);
        if (fm !== null && v.safeParse(SkillFrontmatterSchema, fm).success) {
          skillDirs.add(dirname(filePath));
        }
        return;
      }
      if (filePath.endsWith(".md") && isAgentFile(filePath)) {
        agentFiles.add(filePath);
      }
    },
  });

  const findings: Finding[] = [];
  if (skillDirs.size > 0) {
    findings.push({
      kind: "skills",
      // Sort so emitted paths are deterministic across filesystems — the Set is
      // populated in readdir (filesystem) order, which the split path never relies on.
      paths: Array.from(skillDirs)
        .map((dir) => `./${relative(repoRoot, dir)}/`)
        .sort(),
      confidence: "medium",
      source: "sniff",
    });
  }
  if (agentFiles.size > 0) {
    findings.push({
      kind: "agents",
      paths: Array.from(agentFiles)
        .map((file) => `./${relative(repoRoot, file)}`)
        .sort(),
      confidence: "medium",
      source: "sniff",
    });
  }
  return findings;
}
