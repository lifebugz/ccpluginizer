import { existsSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { MarkerFileError } from "../errors.ts";
import { readJsonFile } from "./fsWalk.ts";
import type { MarkerFile } from "../schemas/markerFile.ts";
import { MARKER_COMPONENT_FIELDS, MarkerFileSchema } from "../schemas/markerFile.ts";

/** Does the marker carry any single-entry component curation? */
export function hasComponentCuration(marker: MarkerFile): boolean {
  return MARKER_COMPONENT_FIELDS.some((key) => marker[key] !== undefined);
}

/** A marker without (non-empty) frozen groups is an explicit single-entry curation. */
export function markerSuppressesSplit(marker: MarkerFile): boolean {
  return marker.groups === undefined || marker.groups.length === 0;
}

/**
 * A freeze-only marker (a `groups` key — even hand-emptied to [] — and no component
 * fields) curates the SPLIT, not the single entry. The single-entry path must run
 * detection for it rather than emit a bare {name, source} entry that drops every skill.
 */
export function isFreezeOnlyMarker(marker: MarkerFile): boolean {
  return marker.groups !== undefined && !hasComponentCuration(marker);
}

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
