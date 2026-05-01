import { describe, expect, test } from "bun:test";
import { normalizePath } from "../src/detector/normalize.ts";
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
