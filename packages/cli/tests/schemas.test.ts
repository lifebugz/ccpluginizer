import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { MarkerFileSchema } from "../src/schemas/markerFile.ts";

describe("MarkerFileSchema", () => {
  test("accepts a minimal valid marker", () => {
    const result = v.safeParse(MarkerFileSchema, { name: "elysia" });
    expect(result.success).toBe(true);
  });

  test("accepts a fully populated marker", () => {
    const result = v.safeParse(MarkerFileSchema, {
      name: "elysia",
      description: "Skills for Elysia",
      skills: ["./elysia/"],
      agents: ["./agents/"],
      commands: ["./commands/"],
      license: "MIT",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown keys (typo guard)", () => {
    const result = v.safeParse(MarkerFileSchema, {
      name: "elysia",
      skils: ["./elysia/"], // typo
    });
    expect(result.success).toBe(false);
  });

  test("rejects names with uppercase letters", () => {
    const result = v.safeParse(MarkerFileSchema, { name: "ElySia" });
    expect(result.success).toBe(false);
  });

  test("rejects skills paths without ./ prefix", () => {
    const result = v.safeParse(MarkerFileSchema, {
      name: "elysia",
      skills: ["elysia/"],
    });
    expect(result.success).toBe(false);
  });
});

import { NonStandardManifestSchema } from "../src/schemas/nonStandardManifest.ts";
import { SkillFrontmatterSchema, AgentFrontmatterSchema } from "../src/schemas/frontmatter.ts";

describe("NonStandardManifestSchema", () => {
  test("accepts the open-circle/agent-skills shape", () => {
    const result = v.safeParse(NonStandardManifestSchema, {
      name: "Open Circle Agent Skills",
      description: "Agent Skills for Open Circle projects including Valibot and Formisch",
      version: "1.0.0",
      author: "Open Circle",
      homepage: "https://opencircle.dev",
      repository: "https://github.com/open-circle/agent-skills",
      skills: ["skills/valibot", "skills/formisch"],
    });
    expect(result.success).toBe(true);
  });

  test("accepts paths WITHOUT ./ prefix (lenient — normalizer fixes later)", () => {
    const result = v.safeParse(NonStandardManifestSchema, {
      name: "test",
      skills: ["skills/foo"],
    });
    expect(result.success).toBe(true);
  });

  test("accepts unknown keys (foreign convention — not strict)", () => {
    const result = v.safeParse(NonStandardManifestSchema, {
      name: "test",
      unknownField: 42,
    });
    expect(result.success).toBe(true);
  });

  test("accepts author as string OR object", () => {
    const r1 = v.safeParse(NonStandardManifestSchema, { author: "Alice" });
    const r2 = v.safeParse(NonStandardManifestSchema, { author: { name: "Alice" } });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});

describe("SkillFrontmatterSchema", () => {
  test("accepts SKILL.md frontmatter with description", () => {
    const result = v.safeParse(SkillFrontmatterSchema, {
      description: "Adds a /quality-review skill for quick code reviews",
    });
    expect(result.success).toBe(true);
  });

  test("accepts SKILL.md frontmatter with optional name and disable-model-invocation", () => {
    const result = v.safeParse(SkillFrontmatterSchema, {
      name: "quality-review",
      description: "Reviews code",
      "disable-model-invocation": true,
    });
    expect(result.success).toBe(true);
  });

  test("rejects frontmatter without description (it's the marker for skill-shape)", () => {
    const result = v.safeParse(SkillFrontmatterSchema, { name: "foo" });
    expect(result.success).toBe(false);
  });
});

describe("AgentFrontmatterSchema", () => {
  test("accepts agent frontmatter with name and description", () => {
    const result = v.safeParse(AgentFrontmatterSchema, {
      name: "code-reviewer",
      description: "Reviews code thoroughly",
    });
    expect(result.success).toBe(true);
  });

  test("rejects agent frontmatter missing name", () => {
    const result = v.safeParse(AgentFrontmatterSchema, {
      description: "Reviews code",
    });
    expect(result.success).toBe(false);
  });
});
