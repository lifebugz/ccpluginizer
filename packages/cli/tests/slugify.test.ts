import { describe, expect, test } from "bun:test";
import { slugify, stripCommonPrefix, uniqueSlugs } from "../src/detector/slugify.ts";

const VALID = /^[a-z0-9][a-z0-9-]*$/;

describe("slugify", () => {
  test("passes through an already-valid slug", () => {
    expect(slugify("voice-media")).toBe("voice-media");
  });

  test("lowercases and kebabs spaces / punctuation", () => {
    expect(slugify("Voice & Media")).toBe("voice-media");
    expect(slugify("a/b")).toBe("a-b");
  });

  test("trims leading/trailing hyphens and collapses runs", () => {
    expect(slugify("--foo__bar--")).toBe("foo-bar");
  });

  test("allows a leading digit (schema regex permits it)", () => {
    const s = slugify("10dlc");
    expect(s).toBe("10dlc");
    expect(VALID.test(s)).toBe(true);
  });

  test("falls back to a valid slug when input reduces to empty", () => {
    const s = slugify("!!!");
    expect(VALID.test(s)).toBe(true);
  });
});

describe("stripCommonPrefix", () => {
  test("strips a shared token prefix at the hyphen boundary", () => {
    expect(stripCommonPrefix(["telnyx-messaging", "telnyx-voice"])).toEqual(["messaging", "voice"]);
  });

  test("leaves keys untouched when there is no shared token prefix", () => {
    expect(stripCommonPrefix(["messaging", "voice", "numbers"])).toEqual([
      "messaging",
      "voice",
      "numbers",
    ]);
  });

  test("does not strip a partial (non-boundary) common substring", () => {
    // "voi" is common but not a token; must not produce ["ce","deo"]
    expect(stripCommonPrefix(["voice", "voicemail"])).toEqual(["voice", "voicemail"]);
  });

  test("refuses to strip if it would empty a key", () => {
    expect(stripCommonPrefix(["voice", "voice-media"])).toEqual(["voice", "voice-media"]);
  });

  test("returns a single key unchanged", () => {
    expect(stripCommonPrefix(["telnyx-messaging"])).toEqual(["telnyx-messaging"]);
  });
});

describe("uniqueSlugs", () => {
  test("leaves already-unique slugs alone", () => {
    expect(uniqueSlugs(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("disambiguates collisions deterministically", () => {
    const out = uniqueSlugs(["voice", "voice", "voice"]);
    expect(out).toEqual(["voice", "voice-2", "voice-3"]);
    expect(new Set(out).size).toBe(3);
  });

  test("avoids colliding a generated suffix with an existing slug", () => {
    const out = uniqueSlugs(["voice", "voice-2", "voice"]);
    expect(new Set(out).size).toBe(3);
    expect(out[0]).toBe("voice");
    expect(out[1]).toBe("voice-2");
  });
});
