import * as v from "valibot";

const PathString = v.pipe(v.string(), v.startsWith("./"));

const GithubSourceSchema = v.strictObject({
  source: v.literal("github"),
  repo: v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/)),
  ref: v.optional(v.string()),
  sha: v.optional(v.string()),
});

const UrlSourceSchema = v.strictObject({
  source: v.literal("url"),
  url: v.string(),
  ref: v.optional(v.string()),
  sha: v.optional(v.string()),
});

const GitSubdirSourceSchema = v.strictObject({
  source: v.literal("git-subdir"),
  url: v.string(),
  path: v.string(),
  ref: v.optional(v.string()),
  sha: v.optional(v.string()),
});

export const SourceSchema = v.union([GithubSourceSchema, UrlSourceSchema, GitSubdirSourceSchema]);

export const MarketplaceEntrySchema = v.object({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
  source: SourceSchema,
  strict: v.optional(v.boolean()),
  description: v.optional(v.string()),
  version: v.optional(v.string()),
  author: v.optional(v.union([v.string(), v.object({ name: v.string() })])),
  homepage: v.optional(v.string()),
  repository: v.optional(v.string()),
  license: v.optional(v.string()),
  keywords: v.optional(v.array(v.string())),
  skills: v.optional(v.array(PathString)),
  agents: v.optional(v.array(PathString)),
  commands: v.optional(v.array(PathString)),
  hooks: v.optional(v.union([PathString, v.record(v.string(), v.unknown())])),
  mcpServers: v.optional(v.union([PathString, v.record(v.string(), v.unknown())])),
  outputStyles: v.optional(v.array(PathString)),
  themes: v.optional(v.array(PathString)),
  monitors: v.optional(PathString),
});

export type MarketplaceEntry = v.InferOutput<typeof MarketplaceEntrySchema>;
export type Source = v.InferOutput<typeof SourceSchema>;
