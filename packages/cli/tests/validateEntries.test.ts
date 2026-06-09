import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateEntries, collectEntries } from "../src/detector/validateEntries.ts";

describe("collectEntries: friendly errors", () => {
  test("throws a clear message for a missing path (not raw ENOENT)", () => {
    expect(() => collectEntries(join(tmpdir(), "ccp-definitely-missing-xyz.json"))).toThrow(
      /No such file or directory/i,
    );
  });

  test("throws a clear message for malformed JSON (not a raw parse stack)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccp-badjson-"));
    try {
      const file = join(tmp, "bad.json");
      writeFileSync(file, "{ not valid json");
      expect(() => collectEntries(file)).toThrow(/Invalid JSON/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("throws for a directory with no entry JSON files (no silent empty pass)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccp-emptydir-"));
    try {
      writeFileSync(join(tmp, "README.md"), "not an entry");
      expect(() => collectEntries(tmp)).toThrow(/No entry JSON files/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("flattens an array-shaped JSON file inside a directory (entry-by-entry, like the single-file path)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccp-arrdir-"));
    try {
      const entries = [
        { name: "a", source: { source: "github", repo: "x/y" } },
        { name: "b", source: { source: "github", repo: "x/y" } },
      ];
      writeFileSync(join(tmp, "entries.json"), JSON.stringify(entries));
      const { items, sources } = collectEntries(tmp);
      expect(items).toHaveLength(2);
      expect(sources).toEqual(["entries.json[0]", "entries.json[1]"]);
      // The validator must see two real entries, not one (non-conforming) array element.
      expect(validateEntries(items, sources).ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

const valid = (name: string): unknown => ({
  name,
  source: { source: "github", repo: "a/b" },
  skills: ["./x/"],
});

describe("validateEntries", () => {
  test("accepts a set of unique, schema-valid entries", () => {
    const r = validateEntries([valid("a"), valid("b"), valid("c")]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("flags a schema-invalid entry with its index", () => {
    const r = validateEntries([valid("a"), { name: "B!", source: { source: "github", repo: "a/b" } }]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("[1]"))).toBe(true);
  });

  test("flags a duplicate entry name across entries (mirrors claude plugin validate)", () => {
    const r = validateEntries([valid("dup"), valid("dup")]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("duplicate") && e.includes("dup"))).toBe(true);
  });

  test("accepts a single entry", () => {
    expect(validateEntries([valid("solo")]).ok).toBe(true);
  });

  test("validates slice + core entries with dependencies", () => {
    const core = { name: "x-core", source: { source: "git-subdir", url: "u", path: "p" }, mcpServers: { s: {} } };
    const slice = {
      name: "x-voice",
      source: { source: "git-subdir", url: "u", path: "p" },
      skills: ["./v/"],
      dependencies: ["x-core"],
    };
    expect(validateEntries([core, slice]).ok).toBe(true);
  });
});

describe("collectEntries: empty artifacts are rejected", () => {
  test("a file containing [] fails instead of passing as OK (0 entries)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccp-empty-"));
    try {
      const file = join(tmp, "empty.json");
      writeFileSync(file, "[]\n");
      expect(() => collectEntries(file)).toThrow(/No entries found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("validateEntries: error provenance", () => {
  test("a broken entry in a directory is attributed to its file, not a flat index", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccp-attrib-"));
    try {
      writeFileSync(join(tmp, "good.json"), JSON.stringify({ name: "good", source: { source: "github", repo: "a/b" } }));
      writeFileSync(join(tmp, "broken.json"), JSON.stringify({ name: "BAD NAME", source: { source: "github", repo: "a/b" } }));
      const { items, sources } = collectEntries(tmp);
      const r = validateEntries(items, sources);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("broken.json"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
