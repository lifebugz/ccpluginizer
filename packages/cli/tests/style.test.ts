import { describe, expect, test } from "bun:test";
import { createStyle, fgCode, bgCode } from "@crustjs/style";

// A truecolor foreground SGR `\x1b[38;2;r;g;b…` is produced by Bun.color; matching
// the 24-bit `38;2;` introducer — not just any `\x1b[` — proves the truecolor path
// executed and would catch a silent downgrade to 16/256-color.
// eslint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI escapes
const TRUECOLOR_FG = /\x1b\[38;2;/;

describe("styled output exercises the Bun.color path under Bun", () => {
  const style = createStyle({ mode: "always" });

  test("forced mode resolves to a color-capable depth", () => {
    expect(style.colorDepth).toBe("truecolor");
  });

  test("hex foreground emits truecolor ANSI and preserves the text", () => {
    const out = style.fg("ccpluginizer", "#ff8800");
    expect(out).toContain("ccpluginizer");
    expect(out).toMatch(TRUECOLOR_FG);
  });

  test("rgb foreground emits truecolor ANSI", () => {
    expect(style.fg("hi", [0, 128, 255])).toMatch(TRUECOLOR_FG);
  });

  test("fgCode resolves a hex color through Bun.color to a truecolor pair", () => {
    expect(fgCode("#00ff00").open).toContain("[38;2;");
  });

  test("bgCode resolves a hex color through Bun.color to a truecolor pair", () => {
    expect(bgCode("#0000ff").open).toContain("[48;2;");
  });
});
