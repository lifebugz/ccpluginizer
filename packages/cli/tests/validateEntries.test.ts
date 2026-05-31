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
