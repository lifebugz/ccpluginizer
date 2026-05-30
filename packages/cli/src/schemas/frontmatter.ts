import * as v from "valibot";

// Lenient string: a bare-numeric or boolean YAML scalar (e.g. a product slug like
// `2024`) is coerced to its string form rather than rejected, so the skill is not
// silently dropped during detection.
const Stringy = v.pipe(v.union([v.string(), v.number(), v.boolean()]), v.transform(String));

export const SkillFrontmatterSchema = v.object({
  name: v.optional(Stringy),
  description: Stringy,
  "disable-model-invocation": v.optional(v.boolean()),
  // Lenient nested metadata: declared keys (product/language/...) are surfaced,
  // unknown keys (generated_by, profile, ...) are ignored rather than rejected.
  metadata: v.optional(
    v.object({
      product: v.optional(Stringy),
      language: v.optional(Stringy),
      author: v.optional(Stringy),
      category: v.optional(Stringy),
    }),
  ),
  tags: v.optional(v.array(Stringy)),
  category: v.optional(Stringy),
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
