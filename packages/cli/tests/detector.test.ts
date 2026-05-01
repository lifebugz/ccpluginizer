import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkMarketplaceGuard } from "../src/detector/marketplaceGuard.ts";
import { detectMarkerFile } from "../src/detector/markerFile.ts";
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
