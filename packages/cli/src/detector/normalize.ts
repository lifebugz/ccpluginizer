import { PathNormalizationError } from "../errors.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function normalizePath(input: string): string {
  if (input.split("/").includes("..")) {
    throw new PathNormalizationError(input, "path traversal (..) not allowed");
  }
  if (input.startsWith("/") || input.startsWith("~")) {
    throw new PathNormalizationError(input, "absolute paths not allowed");
  }
  if (/^[A-Za-z]:[/\\]/.test(input)) {
    throw new PathNormalizationError(input, "windows-style absolute paths not allowed");
  }
  if (input.startsWith("./")) {
    return input;
  }
  return `./${input}`;
}

export interface NormalizedPaths {
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
}

export function normalizePathsAgainstRepo(
  repoRoot: string,
  paths: readonly string[],
): NormalizedPaths {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of paths) {
    const normalized = normalizePath(raw);
    const fullPath = join(repoRoot, normalized);
    if (existsSync(fullPath)) {
      kept.push(normalized);
    } else {
      dropped.push(normalized);
    }
  }
  return { kept, dropped };
}
