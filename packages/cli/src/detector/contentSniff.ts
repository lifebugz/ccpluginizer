import { dirname, relative } from "node:path";
import * as v from "valibot";
import { SkillFrontmatterSchema } from "../schemas/frontmatter.ts";
import { walkTree, type DirLister } from "./fsWalk.ts";
import { isAgentFile, readFrontmatter, type FrontmatterReader } from "./frontmatterIo.ts";
import type { Finding } from "./types.ts";

// Sniffing is the last-resort detection layer, so it looks everywhere except
// dependency/VCS internals (unlike sourceLayout, it must see tests/examples).
const SNIFF_SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface SniffCaches {
  readonly list?: DirLister;
  readonly readFrontmatter?: FrontmatterReader;
}

/** Pass the layout resolver's caches so a scan walks and parses each file once. */
export function detectContentSniff(repoRoot: string, caches: SniffCaches = {}): readonly Finding[] {
  const skillDirs = new Set<string>();
  const agentFiles = new Set<string>();
  const readFm = caches.readFrontmatter ?? readFrontmatter;

  walkTree(repoRoot, {
    skipDirs: SNIFF_SKIP_DIRS,
    ...(caches.list !== undefined ? { list: caches.list } : {}),
    onFile: (filePath) => {
      if (filePath.endsWith("SKILL.md")) {
        const fm = readFm(filePath);
        if (fm !== null && v.safeParse(SkillFrontmatterSchema, fm).success) {
          skillDirs.add(dirname(filePath));
        }
        return;
      }
      if (filePath.endsWith(".md") && isAgentFile(filePath, readFm)) {
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
