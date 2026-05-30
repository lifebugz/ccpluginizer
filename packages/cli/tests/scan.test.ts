import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dirname, "../src/index.ts");
const FIXTURES = join(import.meta.dirname, "fixtures");

function makeNestedPlugin(products: Record<string, number>, extras?: { hooks?: boolean; commands?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "ccp-scan-"));
  const plugin = join(root, "providers", "claude", "plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "telnyx" }));
  writeFileSync(
    join(plugin, ".mcp.json"),
    JSON.stringify({ mcpServers: { telnyx: { type: "http", url: "https://api.telnyx.com/v2/mcp" } } }),
  );
  mkdirSync(join(plugin, "agents"), { recursive: true });
  writeFileSync(join(plugin, "agents", "dev.md"), "---\nname: dev\ndescription: Dev agent.\n---\n");
  if (extras?.hooks === true) {
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
  }
  if (extras?.commands === true) {
    mkdirSync(join(plugin, "commands"), { recursive: true });
    writeFileSync(join(plugin, "commands", "do.md"), "---\ndescription: Do.\n---\n");
  }
  for (const [product, count] of Object.entries(products)) {
    for (let i = 0; i < count; i++) {
      const dir = join(plugin, "skills", `telnyx-${product}-${String(i)}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: telnyx-${product}-${String(i)}\ndescription: ${product} ${String(i)}.\nmetadata:\n  product: ${product}\n---\n`,
      );
    }
  }
  return root;
}

async function runScan(scanArgs: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, "scan", ...scanArgs], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("scan CLI: output shapes", () => {
  let root: string;
  beforeAll(() => {
    root = makeNestedPlugin({ messaging: 4, voice: 4 });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("sub-threshold repo prints a single JSON object (byte-compatible)", async () => {
    const { stdout, code } = await runScan([join(FIXTURES, "skills-only")]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(false);
    expect((parsed as { name?: unknown }).name).toBe("local-skills-only");
  }, 30_000);

  test("split prints a JSON array of core + slices, with a stderr notice", async () => {
    const { stdout, stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2"]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    const names = (parsed as { name: string }[]).map((e) => e.name);
    expect(names.some((n) => n.endsWith("-core"))).toBe(true);
    expect(names.some((n) => n.endsWith("-messaging"))).toBe(true);
    expect(names.some((n) => n.endsWith("-voice"))).toBe(true);
    expect(stderr).toContain("split into");
    expect(stderr).toContain("metadata");
  }, 30_000);

  test("--no-split forces a single object even above threshold", async () => {
    const { stdout, code } = await runScan([root, "--no-split", "--min-skills=2"]);
    expect(code).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(false);
  }, 30_000);

  test("--umbrella adds the everything-entry (strict:true)", async () => {
    const { stdout } = await runScan([root, "--cluster=metadata", "--min-skills=2", "--umbrella"]);
    const entries = JSON.parse(stdout) as { name: string; strict?: boolean }[];
    const umbrella = entries.find((e) => e.strict === true);
    expect(umbrella).toBeDefined();
  }, 30_000);
});

describe("scan CLI: --out-dir and --write-marker", () => {
  let root: string;
  beforeAll(() => {
    root = makeNestedPlugin({ messaging: 4, voice: 4 });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("--out-dir writes one JSON file per entry", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ccp-out-"));
    try {
      const { code } = await runScan([root, "--cluster=metadata", "--min-skills=2", `--out-dir=${outDir}`]);
      expect(code).toBe(0);
      const files = readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
      expect(files.some((f) => f.endsWith("-core.json"))).toBe(true);
      expect(files.length).toBeGreaterThanOrEqual(3); // core + 2 slices
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("--write-marker freezes the grouping into .ccpluginizer.json", async () => {
    const { code } = await runScan([root, "--cluster=metadata", "--min-skills=2", "--write-marker"]);
    expect(code).toBe(0);
    const markerPath = join(root, ".ccpluginizer.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { groups?: unknown[] };
    expect(Array.isArray(marker.groups)).toBe(true);
    expect(marker.groups?.length).toBe(2);
  }, 30_000);
});

describe("scan CLI: warnings + message gating", () => {
  test("prints dropped-artifact warnings (hooks, commands) to stderr, not stdout", async () => {
    const root = makeNestedPlugin({ messaging: 4, voice: 4 }, { hooks: true, commands: true });
    try {
      const { stdout, stderr, code } = await runScan([root, "--cluster=metadata", "--min-skills=2"]);
      expect(code).toBe(0);
      expect(stderr).toMatch(/warning/i);
      expect(stderr).toMatch(/hooks/);
      expect(stderr).toMatch(/commands/);
      // stdout must remain pure JSON (parseable), no warning text
      expect(() => {
        JSON.parse(stdout);
      }).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("--no-split --cluster=llm does not falsely claim the claude CLI is missing", async () => {
    const root = makeNestedPlugin({ messaging: 4, voice: 4 });
    try {
      const { stderr, code } = await runScan([root, "--no-split", "--cluster=llm", "--min-skills=2"]);
      expect(code).toBe(0);
      expect(stderr).not.toMatch(/claude/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
