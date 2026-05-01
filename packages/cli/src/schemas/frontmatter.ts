import * as v from "valibot";

export const SkillFrontmatterSchema = v.object({
  name: v.optional(v.string()),
  description: v.string(),
  "disable-model-invocation": v.optional(v.boolean()),
});

export type SkillFrontmatter = v.InferOutput<typeof SkillFrontmatterSchema>;

export const AgentFrontmatterSchema = v.object({
  name: v.string(),
  description: v.string(),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  maxTurns: v.optional(v.number()),
  tools: v.optional(v.array(v.string())),
  disallowedTools: v.optional(v.union([v.string(), v.array(v.string())])),
});

export type AgentFrontmatter = v.InferOutput<typeof AgentFrontmatterSchema>;
