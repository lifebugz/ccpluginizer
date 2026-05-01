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
