import { dirname, relative } from "node:path";
import { walkTree } from "./fsWalk.ts";
import { isAgentFile, isSkillFile, readFrontmatter, type FrontmatterReader } from "./frontmatterIo.ts";
import type { ScanCaches } from "./caches.ts";
import type { Finding } from "./types.ts";

// Sniffing is the last-resort detection layer, so it looks everywhere except
// dependency/VCS internals (unlike sourceLayout, it must see tests/examples).
const SNIFF_SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Pass the scan's caches so a scan walks and parses each file once. */
export function detectContentSniff(repoRoot: string, caches: ScanCaches = {}): readonly Finding[] {
  const skillDirs = new Set<string>();
  const agentFiles = new Set<string>();
  const readFm: FrontmatterReader = caches.readFrontmatter ?? readFrontmatter;

  walkTree(repoRoot, {
    skipDirs: SNIFF_SKIP_DIRS,
    ...(caches.list !== undefined ? { list: caches.list } : {}),
    onFile: (filePath) => {
      if (filePath.endsWith("SKILL.md")) {
        if (isSkillFile(filePath, readFm)) {
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
