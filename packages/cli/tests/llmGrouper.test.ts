import { describe, expect, test } from "bun:test";
import { buildClusterPrompt, parseClusterResponse, validateRawGroups } from "../src/commands/llmGrouper.ts";
import type { SkillMeta } from "../src/detector/skillMeta.ts";

describe("validateRawGroups (disk-cache shape guard)", () => {
  test("accepts a well-formed cache", () => {
    expect(validateRawGroups([{ slug: "x", members: ["a", "b"] }])).toEqual([
      { slug: "x", members: ["a", "b"] },
    ]);
  });

  test("rejects a poisoned cache (null element, non-array, wrong shape)", () => {
    expect(validateRawGroups([null, { slug: "x", members: ["a"] }])).toBeNull();
    expect(validateRawGroups("not an array")).toBeNull();
    expect(validateRawGroups([{ slug: 5, members: ["a"] }])).toBeNull();
    expect(validateRawGroups([{ slug: "x", members: "nope" }])).toBeNull();
  });
});

function mk(dir: string, product?: string): SkillMeta {
  return { path: `./${dir}/`, dir, name: dir, description: `desc of ${dir}`, ...(product !== undefined ? { product } : {}) };
}

const SKILLS = [mk("telnyx-voice-curl", "voice"), mk("telnyx-messaging-curl", "messaging")];

describe("buildClusterPrompt", () => {
  test("includes each skill dir and asks for a JSON array of groups", () => {
    const prompt = buildClusterPrompt(SKILLS);
    expect(prompt).toContain("telnyx-voice-curl");
    expect(prompt).toContain("telnyx-messaging-curl");
    expect(prompt.toLowerCase()).toContain("json");
    expect(prompt).toContain("members");
  });
});

describe("parseClusterResponse", () => {
  const validDirs = new Set(["telnyx-voice-curl", "telnyx-messaging-curl"]);

  test("extracts a JSON array embedded in prose", () => {
    const text = `Here are the groups:\n[{"slug":"voice","members":["telnyx-voice-curl"]},{"slug":"messaging","members":["telnyx-messaging-curl"]}]\nDone.`;
    const groups = parseClusterResponse(text, validDirs);
    expect(groups).not.toBeNull();
    expect(groups?.length).toBe(2);
    expect(groups?.[0]?.slug).toBe("voice");
  });

  test("drops members that are not real skill dirs", () => {
    const text = `[{"slug":"voice","members":["telnyx-voice-curl","hallucinated-skill"]}]`;
    const groups = parseClusterResponse(text, validDirs);
    expect(groups?.[0]?.members).toEqual(["telnyx-voice-curl"]);
  });

  test("returns null when there is no JSON array", () => {
    expect(parseClusterResponse("I cannot help with that.", validDirs)).toBeNull();
  });

  test("drops groups with no valid members", () => {
    const text = `[{"slug":"ghost","members":["nope"]},{"slug":"voice","members":["telnyx-voice-curl"]}]`;
    const groups = parseClusterResponse(text, validDirs);
    expect(groups?.length).toBe(1);
    expect(groups?.[0]?.slug).toBe("voice");
  });
});
