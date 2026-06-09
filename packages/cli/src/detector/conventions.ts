import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ComponentKind, Finding } from "./types.ts";

type FolderEmit = "directory" | { readonly enumerateFiles: string };

// The single source of the non-skill artifact conventions, shared with
// sourceLayout's split-time artifact resolver.
export const ARTIFACT_DIR_FOLDERS = ["commands", "output-styles", "themes"] as const;
export const ARTIFACT_JSON_KINDS = ["hooks", "monitors"] as const;

const ARTIFACT_FOLDER_KIND: Record<(typeof ARTIFACT_DIR_FOLDERS)[number], ComponentKind> = {
  commands: "commands",
  "output-styles": "outputStyles",
  themes: "themes",
};

const FOLDER_KINDS: readonly { folder: string; kind: ComponentKind; emit: FolderEmit }[] = [
  { folder: "skills", kind: "skills", emit: "directory" },
  { folder: "agents", kind: "agents", emit: { enumerateFiles: ".md" } },
  ...ARTIFACT_DIR_FOLDERS.map((folder) => ({ folder, kind: ARTIFACT_FOLDER_KIND[folder], emit: "directory" as const })),
];

const FILE_KINDS: readonly { file: string; kind: ComponentKind }[] = [
  ...ARTIFACT_JSON_KINDS.map((kind) => ({ file: `${kind}/${kind}.json`, kind })),
  { file: ".mcp.json", kind: "mcpServers" },
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

  for (const { folder, kind, emit } of FOLDER_KINDS) {
    const folderPath = join(baseDir, folder);
    if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
      continue;
    }
    const entries = readdirSync(folderPath);
    if (emit === "directory") {
      findings.push({
        kind,
        paths: [`${pathPrefix}${folder}/`],
        confidence: entries.length > 0 ? "high" : "medium",
        source: "convention",
      });
    } else {
      const files = entries.filter((e) => e.endsWith(emit.enumerateFiles));
      if (files.length > 0) {
        findings.push({
          kind,
          paths: files.map((f) => `${pathPrefix}${folder}/${f}`),
          confidence: "high",
          source: "convention",
        });
      }
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
