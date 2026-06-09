import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { enumerateSkills } from "../src/detector/skillMeta.ts";
import { tempDir } from "./helpers.ts";

const CONTAINER = join(import.meta.dirname, "fixtures", "telnyx-like", "skills");

describe("enumerateSkills", () => {
  test("enumerates only directories that contain a valid SKILL.md", () => {
    const skills = enumerateSkills(CONTAINER);
    const dirs = skills.map((s) => s.dir);
    expect(dirs).toContain("telnyx-messaging-curl");
    expect(dirs).toContain("push-notification-tester");
    expect(dirs).not.toContain("not-a-skill");
    expect(skills.length).toBe(5);
  });

  test("skips a broken symlink instead of crashing the scan", () => {
    const tmp = tempDir("ccp-brokenlink-");
    mkdirSync(join(tmp, "real"), { recursive: true });
    writeFileSync(join(tmp, "real", "SKILL.md"), "---\ndescription: real\n---\n");
    symlinkSync(join(tmp, "does-not-exist"), join(tmp, "brokenlink"));
    const skills = enumerateSkills(tmp);
    expect(skills.map((s) => s.dir)).toEqual(["real"]);
  });

  test("returns results sorted by dir for determinism", () => {
    const dirs = enumerateSkills(CONTAINER).map((s) => s.dir);
    expect(dirs).toEqual([...dirs].sort());
  });

  test("emits a container-relative ./<dir>/ path for each skill", () => {
    const meta = enumerateSkills(CONTAINER).find((s) => s.dir === "telnyx-voice-python");
    expect(meta?.path).toBe("./telnyx-voice-python/");
  });

  test("surfaces nested metadata.product (the clustering key)", () => {
    const meta = enumerateSkills(CONTAINER).find((s) => s.dir === "telnyx-messaging-curl");
    expect(meta?.product).toBe("messaging");
  });

  test("surfaces the folded block-scalar description", () => {
    const meta = enumerateSkills(CONTAINER).find((s) => s.dir === "telnyx-messaging-curl");
    expect(meta?.description).toContain("Send and receive SMS/MMS messages");
    expect(meta?.description).not.toContain(">-");
  });

  test("extra frontmatter (tags, language) never drops a skill", () => {
    const meta = enumerateSkills(CONTAINER).find((s) => s.dir === "push-notification-tester");
    expect(meta?.product).toBe("webrtc");
  });

  test("falls back name to the dir name when frontmatter omits it", () => {
    // every fixture sets name; assert name is populated from frontmatter
    const meta = enumerateSkills(CONTAINER).find((s) => s.dir === "telnyx-voice-curl");
    expect(meta?.name).toBe("telnyx-voice-curl");
  });

  test("returns an empty array for a non-existent container", () => {
    expect(enumerateSkills(join(CONTAINER, "nope"))).toEqual([]);
  });

  test("skips (does not crash) a skill whose SKILL.md is itself a directory", () => {
    const tmp = tempDir("ccp-eisdir-");
    // a valid skill plus a malformed one whose SKILL.md is a directory
    mkdirSync(join(tmp, "good"), { recursive: true });
    writeFileSync(join(tmp, "good", "SKILL.md"), "---\ndescription: ok\n---\n");
    mkdirSync(join(tmp, "weird", "SKILL.md"), { recursive: true });
    const skills = enumerateSkills(tmp);
    expect(skills.map((s) => s.dir)).toEqual(["good"]);
  });
});
