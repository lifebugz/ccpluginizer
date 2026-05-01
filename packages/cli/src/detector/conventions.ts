import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ComponentKind, Finding } from "./types.ts";

const FOLDER_KINDS: readonly { folder: string; kind: ComponentKind }[] = [
  { folder: "skills", kind: "skills" },
  { folder: "agents", kind: "agents" },
  { folder: "commands", kind: "commands" },
  { folder: "output-styles", kind: "outputStyles" },
  { folder: "themes", kind: "themes" },
];

const FILE_KINDS: readonly { file: string; kind: ComponentKind }[] = [
  { file: "hooks/hooks.json", kind: "hooks" },
  { file: ".mcp.json", kind: "mcpServers" },
  { file: "monitors/monitors.json", kind: "monitors" },
];

export function detectConventions(repoRoot: string): readonly Finding[] {
  const rootFindings = scanRoot(repoRoot, "");
  const dotfilesFindings = scanRoot(repoRoot, ".claude");
  return mergeByKind([...rootFindings, ...dotfilesFindings]);
}

function scanRoot(repoRoot: string, prefix: string): readonly Finding[] {
  const findings: Finding[] = [];
  const baseDir = prefix === "" ? repoRoot : join(repoRoot, prefix);
  const pathPrefix = prefix === "" ? "./" : `./${prefix}/`;

  for (const { folder, kind } of FOLDER_KINDS) {
    const folderPath = join(baseDir, folder);
    if (existsSync(folderPath) && statSync(folderPath).isDirectory()) {
      const hasContents = readdirSync(folderPath).length > 0;
      findings.push({
        kind,
        paths: [`${pathPrefix}${folder}/`],
        confidence: hasContents ? "high" : "medium",
        source: "convention",
      });
    }
  }

  for (const { file, kind } of FILE_KINDS) {
    if (existsSync(join(baseDir, file))) {
      findings.push({
        kind,
        paths: [`${pathPrefix}${file}`],
        confidence: "high",
        source: "convention",
      });
    }
  }

  return findings;
}

function mergeByKind(findings: readonly Finding[]): readonly Finding[] {
  const byKind = new Map<ComponentKind, Finding>();
  for (const finding of findings) {
    const existing = byKind.get(finding.kind);
    if (existing === undefined) {
      byKind.set(finding.kind, finding);
    } else {
      const mergedPaths = [...new Set([...existing.paths, ...finding.paths])];
      const mergedConfidence: Finding["confidence"] =
        existing.confidence === "high" || finding.confidence === "high"
          ? "high"
          : existing.confidence === "medium" || finding.confidence === "medium"
            ? "medium"
            : "low";
      byKind.set(finding.kind, {
        kind: finding.kind,
        paths: mergedPaths,
        confidence: mergedConfidence,
        source: existing.source,
      });
    }
  }
  return Array.from(byKind.values());
}
