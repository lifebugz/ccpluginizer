import { PathNormalizationError } from "../errors.ts";

export function normalizePath(input: string): string {
  if (input.split("/").includes("..")) {
    throw new PathNormalizationError(input, "path traversal (..) not allowed");
  }
  return input;
}
