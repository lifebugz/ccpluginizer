import { describe, expect, test } from "bun:test";
import { isSupportedRuntime, RUNTIME_GUARD_MESSAGE } from "../src/runtime-guard-check.ts";

describe("isSupportedRuntime", () => {
  test("false when the Bun global is absent (Node)", () => {
    expect(isSupportedRuntime({} as typeof globalThis)).toBe(false);
  });

  test("false when Bun exists but Bun.color is missing (Bun <1.2)", () => {
    expect(isSupportedRuntime({ Bun: {} } as unknown as typeof globalThis)).toBe(false);
  });

  test("true when Bun.color is a function (Bun >=1.2)", () => {
    const fake = { Bun: { color: () => "" } } as unknown as typeof globalThis;
    expect(isSupportedRuntime(fake)).toBe(true);
  });

  test("the real Bun runtime running this test is supported", () => {
    expect(isSupportedRuntime()).toBe(true);
  });

  test("message signposts both the Bun install and the binary releases URL", () => {
    expect(RUNTIME_GUARD_MESSAGE).toContain("bun.sh/install");
    expect(RUNTIME_GUARD_MESSAGE).toContain("github.com/lifebugz/ccpluginizer/releases");
  });
});
