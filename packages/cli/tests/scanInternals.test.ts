import { describe, expect, test } from "bun:test";
import { resolveLlmConfig } from "../src/commands/scan.ts";

describe("resolveLlmConfig", () => {
  test("flag wins over env per setting", () => {
    const c = resolveLlmConfig({ llmCmd: "flag-cmd" }, { CCPLUGINIZER_LLM_CMD: "env-cmd" });
    expect(c.cmd).toBe("flag-cmd");
    expect(c.cmdFromEnv).toBe(false);
  });

  test("whitespace-only flag falls through to env", () => {
    const c = resolveLlmConfig({ llmCmd: "   " }, { CCPLUGINIZER_LLM_CMD: "env-cmd" });
    expect(c.cmd).toBe("env-cmd");
    expect(c.cmdFromEnv).toBe(true);
  });

  test("cmdFromEnv true only when value came from env", () => {
    expect(resolveLlmConfig({}, { CCPLUGINIZER_LLM_CMD: "x" }).cmdFromEnv).toBe(true);
    expect(resolveLlmConfig({ llmCmd: "x" }, {}).cmdFromEnv).toBe(false);
    expect(resolveLlmConfig({}, {}).cmdFromEnv).toBe(false);
  });

  test("timeoutMs: flag seconds, then env seconds, then 120s default", () => {
    expect(resolveLlmConfig({ llmTimeout: 5 }, {}).timeoutMs).toBe(5000);
    expect(resolveLlmConfig({}, { CCPLUGINIZER_LLM_TIMEOUT: "7" }).timeoutMs).toBe(7000);
    expect(resolveLlmConfig({}, {}).timeoutMs).toBe(120000);
  });

  test("non-finite / non-positive / non-numeric timeout coerces to the 120s default", () => {
    expect(resolveLlmConfig({ llmTimeout: 0 }, {}).timeoutMs).toBe(120000);
    expect(resolveLlmConfig({ llmTimeout: -3 }, {}).timeoutMs).toBe(120000);
    expect(resolveLlmConfig({}, { CCPLUGINIZER_LLM_TIMEOUT: "abc" }).timeoutMs).toBe(120000);
  });

  test("all-empty yields no cmd and the default timeout", () => {
    const c = resolveLlmConfig({}, {});
    expect(c.cmd).toBeUndefined();
    expect(c.timeoutMs).toBe(120000);
  });
});
