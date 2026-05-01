import * as v from "valibot";

export const MarkerFileSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
  description: v.optional(v.string()),
  skills: v.optional(v.array(v.pipe(v.string(), v.startsWith("./")))),
  agents: v.optional(v.array(v.pipe(v.string(), v.startsWith("./")))),
  commands: v.optional(v.array(v.pipe(v.string(), v.startsWith("./")))),
  hooks: v.optional(v.string()),
  mcpServers: v.optional(v.string()),
  outputStyles: v.optional(v.array(v.pipe(v.string(), v.startsWith("./")))),
  themes: v.optional(v.array(v.pipe(v.string(), v.startsWith("./")))),
  monitors: v.optional(v.string()),
  license: v.optional(v.string()),
  homepage: v.optional(v.string()),
  repository: v.optional(v.string()),
});

export type MarkerFile = v.InferOutput<typeof MarkerFileSchema>;
