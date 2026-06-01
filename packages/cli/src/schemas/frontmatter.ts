import * as v from "valibot";

// Lenient string: a bare-numeric or boolean YAML scalar (e.g. a product slug like
// `2024`) is coerced to its string form rather than rejected, so the skill is not
// silently dropped during detection.
const Stringy = v.pipe(v.union([v.string(), v.number(), v.boolean()]), v.transform(String));

// Lenient string list: accept a YAML block/flow list OR a single bare scalar
// (`tags: voice`) and normalize to an array, so a non-list value never drops the
// whole skill during detection (mirrors the Stringy leniency for scalars).
const StringyList = v.pipe(
  v.union([v.array(Stringy), Stringy]),
  v.transform((value) => (Array.isArray(value) ? value : [value])),
);

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
  tags: v.optional(StringyList),
  category: v.optional(Stringy),
});

export type SkillFrontmatter = v.InferOutput<typeof SkillFrontmatterSchema>;

export const AgentFrontmatterSchema = v.object({
  // Match SkillFrontmatterSchema's leniency: a numeric/boolean name or description
  // (e.g. `description: 2024`) is coerced to its string form so the agent is not
  // silently dropped during detection while the equivalent skill would pass.
  name: Stringy,
  description: Stringy,
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  maxTurns: v.optional(v.number()),
  // Claude Code's documented agent format is a comma-separated string
  // (`tools: Read, Grep, Bash`), not only a YAML list — accept either, so a real
  // agent with a string `tools` value is not rejected and dropped from the core entry.
  tools: v.optional(v.union([v.string(), v.array(v.string())])),
  disallowedTools: v.optional(v.union([v.string(), v.array(v.string())])),
});

export type AgentFrontmatter = v.InferOutput<typeof AgentFrontmatterSchema>;
