import { join } from "node:path";
import { dirContainsDir, makeDirLister, type DirLister } from "./fsWalk.ts";
import type { ScanCaches } from "./caches.ts";
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

// Listed explicitly (not derived) because this order IS the emitted entry's JSON
// key order for single-entry output — reordering would churn published bytes.
const FILE_KINDS: readonly { file: string; kind: ComponentKind }[] = [
  { file: "hooks/hooks.json", kind: "hooks" },
  { file: ".mcp.json", kind: "mcpServers" },
  { file: "monitors/monitors.json", kind: "monitors" },
];

/** How each artifact kind is emitted on a marketplace entry (field name + shape). */
export const ARTIFACT_ENTRY_EMIT: Record<
  (typeof ARTIFACT_DIR_FOLDERS)[number] | (typeof ARTIFACT_JSON_KINDS)[number],
  { readonly field: "hooks" | "commands" | "outputStyles" | "themes" | "monitors"; readonly shape: "file" | "dir" }
> = {
  hooks: { field: "hooks", shape: "file" },
  commands: { field: "commands", shape: "dir" },
  "output-styles": { field: "outputStyles", shape: "dir" },
  themes: { field: "themes", shape: "dir" },
  monitors: { field: "monitors", shape: "file" },
};

export function detectConventions(repoRoot: string, caches: ScanCaches = {}): readonly Finding[] {
  // The shared lister tolerates unreadable dirs (reporting permission skips) and
  // reuses listings the layout resolver/sniffer already paid for.
  const list = caches.list ?? makeDirLister();
  const rootFindings = scanRoot(repoRoot, "", list);
  const dotfilesFindings = scanRoot(repoRoot, ".claude", list);
  return mergeByKind([...rootFindings, ...dotfilesFindings]);
}

function scanRoot(repoRoot: string, prefix: string, list: DirLister): readonly Finding[] {
  const findings: Finding[] = [];
  const baseDir = prefix === "" ? repoRoot : join(repoRoot, prefix);
  const pathPrefix = prefix === "" ? "./" : `./${prefix}/`;

  for (const { folder, kind, emit } of FOLDER_KINDS) {
    if (!dirContainsDir(list, baseDir, folder)) {
      continue;
    }
    const folderPath = join(baseDir, folder);
    const entries = list(folderPath).map((e) => e.name);
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
    const parts = file.split("/");
    const fileName = parts[parts.length - 1] ?? file;
    const fileDir = parts.length > 1 ? join(baseDir, ...parts.slice(0, -1)) : baseDir;
    if (list(fileDir).some((e) => e.isFile && e.name === fileName)) {
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
