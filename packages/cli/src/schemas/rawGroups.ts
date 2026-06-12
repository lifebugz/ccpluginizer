import * as v from "valibot";

// The single shape authority for {slug, members} buckets crossing an untrusted
// boundary: LLM backend stdout, the on-disk response cache, and the injected
// GroupSkillsFn seam all validate against this one schema (lenient per-item at
// stdout/injection, whole-array for the cache we wrote ourselves).
export const RawGroupSchema = v.object({
  slug: v.string(),
  members: v.array(v.string()),
});

export const RawGroupsSchema = v.array(RawGroupSchema);

export type RawGroup = v.InferOutput<typeof RawGroupSchema>;
