import * as v from "valibot";

const PathString = v.pipe(v.string(), v.startsWith("./"));

const GroupSchema = v.strictObject({
  slug: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
  skills: v.array(PathString),
});

export const MarkerFileSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
  description: v.optional(v.string()),
  // Frozen split: when `groups` is present it authoritatively defines the slices.
  // `core` requests a shared core entry; `umbrella` also emits the everything-entry.
  groups: v.optional(v.array(GroupSchema)),
  core: v.optional(v.boolean()),
  umbrella: v.optional(v.boolean()),
  skills: v.optional(v.array(PathString)),
  agents: v.optional(v.array(PathString)),
  commands: v.optional(v.array(PathString)),
  hooks: v.optional(v.string()),
  mcpServers: v.optional(v.string()),
  outputStyles: v.optional(v.array(PathString)),
  themes: v.optional(v.array(PathString)),
  monitors: v.optional(v.string()),
  license: v.optional(v.string()),
  homepage: v.optional(v.string()),
  repository: v.optional(v.string()),
});

export type MarkerFile = v.InferOutput<typeof MarkerFileSchema>;
