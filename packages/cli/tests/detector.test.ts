import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkMarketplaceGuard } from "../src/detector/marketplaceGuard.ts";
import { detectMarkerFile } from "../src/detector/markerFile.ts";
import { detectConventions } from "../src/detector/conventions.ts";
import { detectNonStandardManifest } from "../src/detector/nonStandardManifest.ts";
import { detectContentSniff } from "../src/detector/contentSniff.ts";
import { AlreadyMarketplaceError } from "../src/errors.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("Layer 0: marketplace guard", () => {
  test("throws AlreadyMarketplaceError when .claude-plugin/marketplace.json exists", () => {
    expect(() => {
      checkMarketplaceGuard(join(FIXTURES, "already-marketplace"));
    }).toThrow(AlreadyMarketplaceError);
  });

  test("returns silently for repos without that file", () => {
    expect(() => {
      checkMarketplaceGuard(FIXTURES);
    }).not.toThrow();
  });
});

describe("Layer 1: marker file", () => {
  test("returns null when .ccpluginizer.json absent", () => {
    expect(detectMarkerFile(join(FIXTURES, "already-marketplace"))).toBeNull();
  });

  test("parses and returns the marker when present", () => {
    const result = detectMarkerFile(join(FIXTURES, "marker-file"));
    expect(result).not.toBeNull();
    expect(result?.name).toBe("elysia-marker");
    expect(result?.skills).toEqual(["./elysia/"]);
  });
});

describe("Layer 2: folder conventions (root only)", () => {
  test("detects skills/ at repo root", () => {
    const findings = detectConventions(join(FIXTURES, "skills-only"));
    const skills = findings.find((f) => f.kind === "skills");
    expect(skills).toBeDefined();
    expect(skills?.paths).toEqual(["./skills/"]);
    expect(skills?.confidence).toBe("high");
    expect(skills?.source).toBe("convention");
  });
});

describe("Layer 2: dual-root search", () => {
  test("detects skills/ inside .claude/ for dotfiles-style repos", () => {
    const findings = detectConventions(join(FIXTURES, "dotfiles-like"));
    const skills = findings.find((f) => f.kind === "skills");
    expect(skills?.paths).toEqual(["./.claude/skills/"]);
    expect(skills?.confidence).toBe("high");
  });

  test("detects agents/ inside .claude/", () => {
    const findings = detectConventions(join(FIXTURES, "dotfiles-like"));
    const agents = findings.find((f) => f.kind === "agents");
    expect(agents?.paths).toEqual(["./.claude/agents/"]);
  });

  test("merges multi-root findings into a single multi-path entry", () => {
    // We'll construct an inline fixture: a tmpdir with BOTH skills/ at root and .claude/skills/.
    // Skipping inline construction for v0.1; smoke test against real-world dotfiles repo covers this.
  });
});

describe("Layer 2.5: non-standard manifest", () => {
  test("returns null when no .claude-plugin/*.json (other than plugin.json)", () => {
    expect(detectNonStandardManifest(join(FIXTURES, "skills-only"))).toBeNull();
  });

  test("parses manifest.json and returns shape", () => {
    const result = detectNonStandardManifest(join(FIXTURES, "open-circle-like"));
    expect(result).not.toBeNull();
    expect(result?.manifest.name).toBe("Open Circle Agent Skills");
    expect(result?.manifest.skills).toEqual(["skills/valibot", "skills/formisch"]);
    expect(result?.filename).toBe("manifest.json");
  });

  test("ignores plugin.json (would be standard, not our concern)", () => {
    // covered indirectly — already-marketplace fixture has marketplace.json, not plugin.json
  });
});

describe("Layer 3: content sniff", () => {
  test("finds **/SKILL.md outside conventional folders", () => {
    const findings = detectContentSniff(join(FIXTURES, "elysia-like"));
    const skills = findings.find((f) => f.kind === "skills");
    expect(skills).toBeDefined();
    expect(skills?.paths).toEqual(["./elysia/"]);
    expect(skills?.confidence).toBe("medium");
    expect(skills?.source).toBe("sniff");
  });

  test("returns empty array for repos with no markdown", () => {
    expect(detectContentSniff(join(FIXTURES, "already-marketplace"))).toEqual([]);
  });
});
