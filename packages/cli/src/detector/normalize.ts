import { PathNormalizationError } from "../errors.ts";

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
