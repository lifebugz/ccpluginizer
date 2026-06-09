import { existsSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { MarkerFileError } from "../errors.ts";
import { readJsonFile } from "./fsWalk.ts";
import type { MarkerFile } from "../schemas/markerFile.ts";
import { MarkerFileSchema } from "../schemas/markerFile.ts";

export function detectMarkerFile(repoRoot: string): MarkerFile | null {
  const markerPath = join(repoRoot, ".ccpluginizer.json");
  if (!existsSync(markerPath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = readJsonFile(markerPath);
  } catch (e) {
    throw new MarkerFileError(e instanceof Error ? e.message : String(e), []);
  }
  const result = v.safeParse(MarkerFileSchema, parsed);
  if (!result.success) {
    throw new MarkerFileError(
      `Marker file at ${markerPath} failed validation`,
      result.issues,
    );
  }
  return result.output;
}
