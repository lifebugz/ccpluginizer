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
