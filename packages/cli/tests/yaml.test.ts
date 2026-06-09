import { describe, expect, test } from "bun:test";
import { parseYamlFrontmatter, extractFrontmatter } from "../src/detector/yaml.ts";

describe("extractFrontmatter: line endings", () => {
  test("parses CRLF-authored frontmatter (Windows / autocrlf)", () => {
    const fm = extractFrontmatter("---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody\r\n");
    expect(fm).not.toBeNull();
    expect(fm?.["name"]).toBe("foo");
    expect(fm?.["description"]).toBe("bar");
  });

  test("parses CRLF nested metadata without stray \\r in values", () => {
    const fm = extractFrontmatter(
      "---\r\nname: x\r\ndescription: d\r\nmetadata:\r\n  product: voice\r\n---\r\n",
    );
    const meta = fm?.["metadata"] as Record<string, unknown>;
    expect(meta["product"]).toBe("voice");
  });
});

describe("parseYamlFrontmatter: plain multi-line scalar", () => {
  test("folds an unindicated multi-line value onto one spaced string", () => {
    const body = [
      "description: A long description that wraps",
      "  onto a second line without a block indicator.",
      "name: foo",
    ].join("\n");
    const out = parseYamlFrontmatter(body);
    expect(out["description"]).toBe(
      "A long description that wraps onto a second line without a block indicator.",
    );
    expect(out["name"]).toBe("foo");
  });
});

describe("parseYamlFrontmatter: quoted flow lists", () => {
  test("does not split on a comma inside a quoted element", () => {
    expect(parseYamlFrontmatter('tags: ["foo, bar", baz]')["tags"]).toEqual(["foo, bar", "baz"]);
    expect(parseYamlFrontmatter("tags: ['x, y', z]")["tags"]).toEqual(["x, y", "z"]);
  });
});

describe("parseYamlFrontmatter: flat (back-compat)", () => {
  test("parses simple key: value pairs", () => {
    const out = parseYamlFrontmatter("name: foo\ndescription: bar\n");
    expect(out["name"]).toBe("foo");
    expect(out["description"]).toBe("bar");
  });

  test("coerces booleans and numbers, strips quotes", () => {
    const out = parseYamlFrontmatter(
      ['disable-model-invocation: true', 'count: 42', 'q: "quoted"'].join("\n"),
    );
    expect(out["disable-model-invocation"]).toBe(true);
    expect(out["count"]).toBe(42);
    expect(out["q"]).toBe("quoted");
  });

  test("keeps a zero-padded numeric scalar as a string (007 is not corrupted to 7)", () => {
    const out = parseYamlFrontmatter("product: 007\n");
    expect(out["product"]).toBe("007");
  });

  test("keeps an out-of-safe-range integer as a string (no precision loss)", () => {
    const out = parseYamlFrontmatter("id: 12345678901234567890\n");
    expect(out["id"]).toBe("12345678901234567890");
  });
});

describe("extractFrontmatter: leading BOM", () => {
  test("parses frontmatter despite a leading UTF-8 BOM (does not drop the skill)", () => {
    const fm = extractFrontmatter("\uFEFF---\nname: foo\ndescription: bar\n---\nbody\n");
    expect(fm).not.toBeNull();
    expect(fm?.["name"]).toBe("foo");
    expect(fm?.["description"]).toBe("bar");
  });

  test("ignores comments and blank lines", () => {
    const out = parseYamlFrontmatter("# a comment\n\nname: foo\n");
    expect(out["name"]).toBe("foo");
    expect(Object.keys(out)).toEqual(["name"]);
  });
});

describe("parseYamlFrontmatter: nested map (the telnyx case)", () => {
  test("reads metadata.product and metadata.language from a nested map", () => {
    const body = [
      "name: telnyx-10dlc-curl",
      "metadata:",
      "  author: telnyx",
      "  product: 10dlc",
      "  language: curl",
    ].join("\n");
    const out = parseYamlFrontmatter(body);
    expect(out["name"]).toBe("telnyx-10dlc-curl");
    const meta = out["metadata"] as Record<string, unknown>;
    expect(meta["product"]).toBe("10dlc");
    expect(meta["language"]).toBe("curl");
    expect(meta["author"]).toBe("telnyx");
  });

  test("does NOT hoist nested keys to the top level", () => {
    const body = ["metadata:", "  product: voice", "name: x"].join("\n");
    const out = parseYamlFrontmatter(body);
    expect(out["product"]).toBeUndefined();
    expect((out["metadata"] as Record<string, unknown>)["product"]).toBe("voice");
    expect(out["name"]).toBe("x");
  });

  test("preserves unknown nested keys (generated_by, profile)", () => {
    const body = [
      "metadata:",
      "  product: voice",
      "  generated_by: telnyx-ext-skills-generator",
      "  profile: northstar-v2",
    ].join("\n");
    const meta = parseYamlFrontmatter(body)["metadata"] as Record<string, unknown>;
    expect(meta["generated_by"]).toBe("telnyx-ext-skills-generator");
    expect(meta["profile"]).toBe("northstar-v2");
  });
});

describe("parseYamlFrontmatter: block scalars", () => {
  test("folds a >- block scalar into a single spaced string", () => {
    const body = [
      "description: >-",
      "  10DLC brand and campaign registration for US A2P messaging compliance. Assign",
      "  phone numbers to campaigns.",
      "metadata:",
      "  product: 10dlc",
    ].join("\n");
    const out = parseYamlFrontmatter(body);
    expect(out["description"]).toBe(
      "10DLC brand and campaign registration for US A2P messaging compliance. Assign phone numbers to campaigns.",
    );
    // The block scalar must not swallow the following top-level key.
    expect((out["metadata"] as Record<string, unknown>)["product"]).toBe("10dlc");
  });

  test("preserves newlines for a | literal block scalar", () => {
    const body = ["text: |", "  line one", "  line two"].join("\n");
    expect(parseYamlFrontmatter(body)["text"]).toBe("line one\nline two");
  });
});

describe("parseYamlFrontmatter: depth and edge cases", () => {
  test("a grandchild map is skipped, not flattened over a real sibling key", () => {
    const body = [
      "metadata:",
      "  product: voice",
      "  internal:",
      "    product: legacy",
    ].join("\n");
    const meta = parseYamlFrontmatter(body)["metadata"] as Record<string, unknown>;
    expect(meta["product"]).toBe("voice");
    expect(meta["internal"]).toBeNull();
  });

  test("a nested list item deeper than the first is skipped, not flattened", () => {
    const body = ["tags:", "  - a", "    - nested", "  - b"].join("\n");
    expect(parseYamlFrontmatter(body)["tags"]).toEqual(["a", "b"]);
  });

  test("a next-line scalar containing a URL colon folds (not misparsed as a map)", () => {
    const body = ["description:", "  See https://docs.telnyx.com for details", "name: foo"].join("\n");
    const out = parseYamlFrontmatter(body);
    expect(out["description"]).toBe("See https://docs.telnyx.com for details");
  });

  test("folds a plain scalar that starts on the following line (no indicator)", () => {
    const body = ["description:", "  Send SMS via the Telnyx API", "name: foo"].join("\n");
    const out = parseYamlFrontmatter(body);
    expect(out["description"]).toBe("Send SMS via the Telnyx API");
    expect(out["name"]).toBe("foo");
  });

  test("a bare `key:` with no content yields an empty string (matches the v0.1.1 parser)", () => {
    const out = parseYamlFrontmatter("description:\nname: foo\n");
    expect(out["description"]).toBe("");
    expect(out["name"]).toBe("foo");
  });

  test("__proto__ becomes an ordinary own key, not a prototype swap", () => {
    const body = ["__proto__:", "  description: smuggled", "name: x"].join("\n");
    const out = parseYamlFrontmatter(body);
    expect(out["name"]).toBe("x");
    expect(out["description"]).toBeUndefined();
    expect(Object.keys(out)).toContain("__proto__");
    expect((out["__proto__"] as Record<string, unknown>)["description"]).toBe("smuggled");
  });
});

describe("parseYamlFrontmatter: block lists", () => {
  test("parses a block list into an array", () => {
    const body = ["tags:", "  - messaging", "  - compliance", "category: messaging"].join("\n");
    const out = parseYamlFrontmatter(body);
    expect(out["tags"]).toEqual(["messaging", "compliance"]);
    expect(out["category"]).toBe("messaging");
  });

  test("parses an inline flow list", () => {
    const out = parseYamlFrontmatter("tags: [a, b, c]\n");
    expect(out["tags"]).toEqual(["a", "b", "c"]);
  });
});
