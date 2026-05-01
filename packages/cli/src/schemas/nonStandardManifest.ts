import * as v from "valibot";

export const NonStandardManifestSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  version: v.optional(v.string()),
  author: v.optional(v.union([v.string(), v.object({ name: v.string() })])),
  homepage: v.optional(v.string()),
  repository: v.optional(v.string()),
  license: v.optional(v.string()),
  skills: v.optional(v.array(v.string())),
  agents: v.optional(v.array(v.string())),
  commands: v.optional(v.array(v.string())),
  hooks: v.optional(v.string()),
  mcpServers: v.optional(v.string()),
});

export type NonStandardManifest = v.InferOutput<typeof NonStandardManifestSchema>;
