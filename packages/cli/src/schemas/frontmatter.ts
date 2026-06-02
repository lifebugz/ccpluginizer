import * as v from "valibot";

// Lenient string: a bare-numeric or boolean YAML scalar (e.g. a product slug like
// `2024`) is coerced to its string form rather than rejected, so the skill is not
// silently dropped during detection.
const Stringy = v.pipe(v.union([v.string(), v.number(), v.boolean()]), v.transform(String));

const isScalar = (val: unknown): val is string | number | boolean =>
  typeof val === "string" || typeof val === "number" || typeof val === "boolean";

// Advisory scalar (product/language/.../category): these are clustering *hints*, not
// skill-identity. A present-but-unusable shape (null, a map, a list — e.g. the
// zero-dep YAML parser yields `product: null` for a deeply-nested value) must be
// ignored, NOT cause the whole skill to be dropped. Anything non-scalar → undefined.
const AdvisoryString = v.pipe(
  v.unknown(),
  v.transform((val) => (isScalar(val) ? String(val) : undefined)),
);

// Advisory string list (tags): accept a YAML block/flow list OR a single bare scalar
// (`tags: voice`), drop non-scalar items, and treat any other shape (e.g. a map) as
// absent — so a malformed `tags` never drops the skill (mirrors AdvisoryString).
const AdvisoryStringList = v.pipe(
  v.unknown(),
  v.transform((val) => {
    if (Array.isArray(val)) {
      const items = val.filter(isScalar).map(String);
      return items.length > 0 ? items : undefined;
    }
    return isScalar(val) ? [String(val)] : undefined;
  }),
);

// Advisory nested metadata: a non-object value (scalar/array/null) collapses to an
// empty map so the skill survives; declared keys are surfaced leniently and unknown
// keys (generated_by, profile, ...) are ignored rather than rejected.
const AdvisoryMetadata = v.pipe(
  v.unknown(),
  v.transform((val) =>
    val !== null && typeof val === "object" && !Array.isArray(val)
      ? (val as Record<string, unknown>)
      : {},
  ),
  v.object({
    product: v.optional(AdvisoryString),
    language: v.optional(AdvisoryString),
    author: v.optional(AdvisoryString),
    category: v.optional(AdvisoryString),
  }),
);

export const SkillFrontmatterSchema = v.object({
  name: v.optional(Stringy),
  description: Stringy,
  "disable-model-invocation": v.optional(v.boolean()),
  metadata: v.optional(AdvisoryMetadata),
  tags: v.optional(AdvisoryStringList),
  category: v.optional(AdvisoryString),
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
