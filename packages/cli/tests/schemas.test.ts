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

  test("accepts a frozen split: groups + core + umbrella", () => {
    const result = v.safeParse(MarkerFileSchema, {
      name: "team-telnyx-ai",
      core: true,
      umbrella: false,
      groups: [
        { slug: "messaging", skills: ["./telnyx-messaging-python/", "./telnyx-messaging-go/"] },
        { slug: "voice", skills: ["./telnyx-voice-python/"] },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.groups?.length).toBe(2);
      expect(result.output.groups?.[0]?.slug).toBe("messaging");
    }
  });

  test("rejects group skills paths without ./ prefix", () => {
    const result = v.safeParse(MarkerFileSchema, {
      name: "x",
      groups: [{ slug: "messaging", skills: ["telnyx-messaging-python/"] }],
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

  test("accepts nested metadata (product, language) plus tags and category", () => {
    const result = v.safeParse(SkillFrontmatterSchema, {
      name: "telnyx-10dlc-curl",
      description: "10DLC brand and campaign registration",
      metadata: { author: "telnyx", product: "10dlc", language: "curl" },
      tags: ["messaging", "compliance"],
      category: "messaging",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.metadata?.product).toBe("10dlc");
      expect(result.output.metadata?.language).toBe("curl");
    }
  });

  test("coerces a numeric metadata.product / description to string (lenient, no skill drop)", () => {
    const result = v.safeParse(SkillFrontmatterSchema, {
      description: 2024,
      metadata: { product: 10, language: 3 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.description).toBe("2024");
      expect(result.output.metadata?.product).toBe("10");
      expect(result.output.metadata?.language).toBe("3");
    }
  });

  test("ignores unknown metadata keys (generated_by, profile) without failing", () => {
    const result = v.safeParse(SkillFrontmatterSchema, {
      description: "x",
      metadata: { product: "voice", generated_by: "telnyx-ext-skills-generator", profile: "northstar-v2" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.metadata?.product).toBe("voice");
    }
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

import { MarketplaceEntrySchema } from "../src/schemas/marketplaceEntry.ts";

describe("MarketplaceEntrySchema", () => {
  test("accepts a complete strict-false entry", () => {
    const result = v.safeParse(MarketplaceEntrySchema, {
      name: "elysia",
      source: { source: "github", repo: "elysiajs/skills" },
      strict: false,
      skills: ["./elysia/"],
      license: "MIT",
      description: "Skills for Elysia",
      homepage: "https://github.com/elysiajs/skills",
    });
    expect(result.success).toBe(true);
  });

  test("rejects entries missing name", () => {
    const result = v.safeParse(MarketplaceEntrySchema, {
      source: { source: "github", repo: "x/y" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects entries with relative path missing ./ prefix", () => {
    const result = v.safeParse(MarketplaceEntrySchema, {
      name: "elysia",
      source: { source: "github", repo: "elysiajs/skills" },
      skills: ["elysia/"],
    });
    expect(result.success).toBe(false);
  });

  test("accepts git-subdir source", () => {
    const result = v.safeParse(MarketplaceEntrySchema, {
      name: "x",
      source: {
        source: "git-subdir",
        url: "https://github.com/owner/monorepo.git",
        path: "tools/myplugin",
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts bare-string dependencies (the proven slice→core wiring)", () => {
    const result = v.safeParse(MarketplaceEntrySchema, {
      name: "team-telnyx-ai-messaging",
      source: { source: "git-subdir", url: "https://github.com/team-telnyx/ai.git", path: "providers/claude/plugin/skills" },
      skills: ["./telnyx-messaging-python/"],
      dependencies: ["team-telnyx-ai-core"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.dependencies).toEqual(["team-telnyx-ai-core"]);
    }
  });

  test("accepts object-form dependencies with optional version", () => {
    const result = v.safeParse(MarketplaceEntrySchema, {
      name: "x",
      source: { source: "github", repo: "a/b" },
      dependencies: [{ name: "core" }, { name: "other", version: "^1.0.0" }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts inline mcpServers object for a zero-skill core entry", () => {
    const result = v.safeParse(MarketplaceEntrySchema, {
      name: "team-telnyx-ai-core",
      source: { source: "git-subdir", url: "https://github.com/team-telnyx/ai.git", path: "providers/claude/plugin/agents" },
      mcpServers: { telnyx: { command: "npx", args: ["-y", "@telnyx/mcp"] } },
    });
    expect(result.success).toBe(true);
  });
});
