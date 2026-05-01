import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath, normalizePathsAgainstRepo } from "../src/detector/normalize.ts";
import { PathNormalizationError } from "../src/errors.ts";

describe("normalizePath: traversal rejection", () => {
  test("rejects paths containing ..", () => {
    expect(() => normalizePath("../foo")).toThrow(PathNormalizationError);
  });

  test("rejects paths with .. in middle", () => {
    expect(() => normalizePath("./foo/../bar")).toThrow(PathNormalizationError);
  });
});

describe("normalizePath: absolute path rejection", () => {
  test("rejects unix absolute paths", () => {
    expect(() => normalizePath("/foo/bar")).toThrow(PathNormalizationError);
  });

  test("rejects home-relative paths", () => {
    expect(() => normalizePath("~/foo")).toThrow(PathNormalizationError);
  });

  test("rejects windows-style absolute paths", () => {
    expect(() => normalizePath("C:\\foo")).toThrow(PathNormalizationError);
    expect(() => normalizePath("C:/foo")).toThrow(PathNormalizationError);
  });
});

describe("normalizePath: ./ prefix", () => {
  test("preserves paths already starting with ./", () => {
    expect(normalizePath("./skills/")).toBe("./skills/");
  });

  test("prepends ./ to bare relative paths", () => {
    expect(normalizePath("skills/")).toBe("./skills/");
    expect(normalizePath("skills/valibot")).toBe("./skills/valibot");
  });

  test("prepends ./ to dotfiles paths", () => {
    expect(normalizePath(".claude/skills/")).toBe("./.claude/skills/");
  });
});

describe("normalizePathsAgainstRepo: existence verification", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ccp-norm-"));
  mkdirSync(join(tmp, "skills/valibot"), { recursive: true });
  writeFileSync(join(tmp, "skills/valibot/SKILL.md"), "---\ndescription: x\n---\n");

  test("keeps existing paths and drops missing ones", () => {
    const { kept, dropped } = normalizePathsAgainstRepo(tmp, ["./skills/valibot", "./skills/missing"]);
    expect(kept).toEqual(["./skills/valibot"]);
    expect(dropped).toEqual(["./skills/missing"]);
  });

  test("normalizes bare paths AND verifies them", () => {
    const { kept } = normalizePathsAgainstRepo(tmp, ["skills/valibot"]);
    expect(kept).toEqual(["./skills/valibot"]);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
});
