import { describe, expect, test } from "bun:test";
import type { SkillMeta } from "../src/detector/skillMeta.ts";
import {
  partitionByMetadata,
  partitionByNamePrefix,
  partitionSkills,
  type Grouping,
} from "../src/detector/partition.ts";

function mk(dir: string, product?: string, language?: string): SkillMeta {
  return {
    path: `./${dir}/`,
    dir,
    name: dir,
    description: `Skill ${dir}`,
    ...(product !== undefined ? { product } : {}),
    ...(language !== undefined ? { language } : {}),
  };
}

const LANGS = ["curl", "go", "java", "javascript", "python", "ruby"];

/** A realistic telnyx-shaped set: product families sharing leading segments, ×6 langs. */
function telnyxLike(): SkillMeta[] {
  const products = [
    "voice", "voice-media", "voice-gather", "voice-conferencing", "voice-streaming", "voice-advanced",
    "numbers", "numbers-config", "numbers-compliance", "numbers-services",
    "messaging", "messaging-hosted", "messaging-profiles",
    "porting-in", "porting-out",
    "sip", "sip-integrations",
    "webrtc", "video", "verify", "fax", "iot", "storage", "oauth",
  ];
  const skills: SkillMeta[] = [];
  for (const p of products) {
    for (const lang of LANGS) {
      skills.push(mk(`telnyx-${p}-${lang}`, p, lang));
    }
  }
  return skills;
}

/** A set no deterministic strategy can partition: one product, distinct languages only. */
function unpartitionable(): SkillMeta[] {
  return LANGS.map((l) => mk(`solo-${l}`, "solo", l));
}

function totalCovered(groups: Grouping): string[] {
  return groups.flatMap((g) => g.skills.map((s) => s.dir)).sort();
}

function assertDisjointTotalCover(groups: Grouping, all: readonly SkillMeta[]): void {
  const covered = totalCovered(groups);
  expect(covered).toEqual([...all].map((s) => s.dir).sort()); // total cover
  expect(new Set(covered).size).toBe(covered.length); // disjoint
}

describe("partitionByMetadata: collapse + coalesce-to-fit", () => {
  test("telnyx-shaped 24-product set lands within the gate (2<=K<=12)", () => {
    const skills = telnyxLike();
    const groups = partitionByMetadata(skills);
    expect(groups).not.toBeNull();
    if (groups === null) return;
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups.length).toBeLessThanOrEqual(12);
    assertDisjointTotalCover(groups, skills);
    // no group exceeds 70% of all skills
    const total = skills.length;
    expect(groups.every((g) => g.skills.length <= 0.7 * total)).toBe(true);
    // product families collapsed under a shared leading segment
    expect(groups.map((g) => g.slug)).toContain("voice");
  });

  test("an even two-product split yields K=2", () => {
    const skills = [
      ...LANGS.map((l) => mk(`m-${l}`, "messaging", l)),
      ...LANGS.map((l) => mk(`v-${l}`, "voice", l)),
    ];
    const groups = partitionByMetadata(skills);
    expect(groups?.length).toBe(2);
  });

  test("returns null when no skill carries a product", () => {
    const skills = [mk("a"), mk("b"), mk("c")];
    expect(partitionByMetadata(skills)).toBeNull();
  });

  test("returns null (K<2) when every skill is the same product", () => {
    const skills = LANGS.map((l) => mk(`a-${l}`, "alpha", l));
    expect(partitionByMetadata(skills)).toBeNull();
  });

  test("rejects a grouping where one group exceeds 70% of skills", () => {
    const skills = [
      ...Array.from({ length: 8 }, (_, i) => mk(`a${String(i)}`, "alpha")),
      mk("b0", "bravo"),
      mk("b1", "bravo"),
    ];
    // alpha = 8/10 = 80% -> gate rejects -> null
    expect(partitionByMetadata(skills)).toBeNull();
  });

  test("coalesces sub-3-skill groups into a -misc bucket", () => {
    const skills = [
      ...Array.from({ length: 5 }, (_, i) => mk(`a${String(i)}`, "alpha")),
      ...Array.from({ length: 5 }, (_, i) => mk(`b${String(i)}`, "bravo")),
      mk("c0", "charlie"),
    ];
    const groups = partitionByMetadata(skills);
    expect(groups).not.toBeNull();
    if (groups === null) return;
    expect(groups.map((g) => g.slug)).toContain("misc");
    const misc = groups.find((g) => g.slug === "misc");
    expect(misc?.skills.map((s) => s.dir)).toEqual(["c0"]);
    assertDisjointTotalCover(groups, skills);
  });
});

describe("partitionByNamePrefix: flat repos", () => {
  test("strips the global prefix and groups by product (dropping the trailing language)", () => {
    const skills = [
      mk("telnyx-messaging-python"),
      mk("telnyx-messaging-go"),
      mk("telnyx-messaging-curl"),
      mk("telnyx-voice-python"),
      mk("telnyx-voice-go"),
      mk("telnyx-voice-curl"),
    ];
    const groups = partitionByNamePrefix(skills);
    expect(groups).not.toBeNull();
    if (groups === null) return;
    const slugs = groups.map((g) => g.slug).sort();
    expect(slugs).toEqual(["messaging", "voice"]);
    assertDisjointTotalCover(groups, skills);
  });
});

describe("partitionSkills: orchestrator", () => {
  test("auto cascade falls to metadata when no marker/llm provided", async () => {
    const skills = telnyxLike();
    const result = await partitionSkills(skills, { strategy: "auto" });
    expect(result).not.toBeNull();
    expect(result?.strategy).toBe("metadata");
  });

  test("marker groups win verbatim (no gate, exact membership)", async () => {
    const skills = [
      mk("telnyx-messaging-python", "messaging"),
      mk("telnyx-voice-python", "voice"),
    ];
    const result = await partitionSkills(skills, {
      markerGroups: [
        { slug: "messaging", skills: ["./telnyx-messaging-python/"] },
        { slug: "voice", skills: ["./telnyx-voice-python/"] },
      ],
    });
    expect(result?.strategy).toBe("marker");
    expect(result?.groups.length).toBe(2);
    expect(result?.groups.find((g) => g.slug === "messaging")?.skills[0]?.dir).toBe(
      "telnyx-messaging-python",
    );
  });

  test("auto never invokes the injected grouper (deterministic-only)", async () => {
    const skills = telnyxLike();
    let called = false;
    const group = (s: readonly SkillMeta[]): Promise<{ slug: string; members: string[] }[]> => {
      called = true;
      const half = Math.ceil(s.length / 2);
      return Promise.resolve([
        { slug: "first", members: s.slice(0, half).map((x) => x.dir) },
        { slug: "second", members: s.slice(half).map((x) => x.dir) },
      ]);
    };
    const result = await partitionSkills(skills, { strategy: "auto", group });
    expect(called).toBe(false);
    expect(result?.strategy).toBe("metadata");
  });

  test("llm cascades to a deterministic strategy when the model output is gate-rejected", async () => {
    const skills = telnyxLike(); // well-named: deterministic succeeds
    const group = (s: readonly SkillMeta[]): Promise<{ slug: string; members: string[] }[]> =>
      // one group with everything -> >70% and K<2 -> gate rejects
      Promise.resolve([{ slug: "all", members: s.map((x) => x.dir) }]);
    const result = await partitionSkills(skills, { strategy: "llm", group });
    expect(result).not.toBeNull();
    expect(result?.strategy).toBe("metadata");
  });

  test("llm with no grouper falls through to the deterministic cascade", async () => {
    const skills = telnyxLike();
    const result = await partitionSkills(skills, { strategy: "llm" });
    expect(result?.strategy).toBe("metadata");
  });

  test("auto-llm: deterministic win skips the grouper entirely", async () => {
    const skills = telnyxLike();
    let called = false;
    const group = (): Promise<{ slug: string; members: string[] }[]> => {
      called = true;
      return Promise.resolve([]);
    };
    const result = await partitionSkills(skills, { strategy: "auto-llm", group });
    expect(called).toBe(false);
    expect(result?.strategy).toBe("metadata");
  });

  test("auto-llm: invokes the grouper only when deterministic finds no partition", async () => {
    const skills = unpartitionable();
    let called = false;
    const half = Math.ceil(skills.length / 2);
    const group = (s: readonly SkillMeta[]): Promise<{ slug: string; members: string[] }[]> => {
      called = true;
      return Promise.resolve([
        { slug: "first", members: s.slice(0, half).map((x) => x.dir) },
        { slug: "second", members: s.slice(half).map((x) => x.dir) },
      ]);
    };
    const result = await partitionSkills(skills, { strategy: "auto-llm", group });
    expect(called).toBe(true);
    expect(result?.strategy).toBe("llm");
    assertDisjointTotalCover(result?.groups ?? [], skills);
  });

  test("auto-llm: returns null when both deterministic and the grouper fail", async () => {
    const skills = unpartitionable();
    const group = (s: readonly SkillMeta[]): Promise<{ slug: string; members: string[] }[]> =>
      Promise.resolve([{ slug: "all", members: s.map((x) => x.dir) }]); // rejected by gate
    const result = await partitionSkills(skills, { strategy: "auto-llm", group });
    expect(result).toBeNull();
  });

  test("tolerates a malformed LLM grouper response (null/garbage elements) without crashing", async () => {
    const skills = [
      mk("d0", "a"), mk("d1", "a"), mk("d2", "a"),
      mk("d3", "b"), mk("d4", "b"), mk("d5", "b"),
    ];
    const group = (): Promise<{ slug: string; members: string[] }[]> =>
      Promise.resolve([
        null as unknown as { slug: string; members: string[] },
        { slug: "a", members: ["d0", "d1", "d2"] },
        { slug: "b", members: ["d3", "d4", "d5"] },
      ]);
    const result = await partitionSkills(skills, { strategy: "llm", group });
    expect(result?.strategy).toBe("llm");
    expect(result?.groups.length).toBe(2);
  });

  test("a forced strategy that fails the gate yields null (no split)", async () => {
    const skills = LANGS.map((l) => mk(`a-${l}`, "alpha", l)); // single product
    const result = await partitionSkills(skills, { strategy: "metadata" });
    expect(result).toBeNull();
  });

  test("auto returns null when nothing partitions cleanly", async () => {
    const skills = [mk("only-one")];
    const result = await partitionSkills(skills, { strategy: "auto" });
    expect(result).toBeNull();
  });
});
