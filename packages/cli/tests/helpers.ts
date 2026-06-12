// Shared test scaffolding: one SkillMeta factory, one nested-plugin builder, one
// temp-dir registry, and one CLI-spawn harness — so a fixture or harness change
// cannot silently leave a suite testing a stale shape, and tests need no
// per-test try/finally cleanup boilerplate.

import { spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SkillMeta } from "../src/detector/skillMeta.ts";

// Every builder-made dir is registered here and removed when the test process
// exits, so tests skip the try/finally rmSync scaffold entirely.
const tempPaths: string[] = [];
let cleanupHooked = false;
function track(path: string): string {
  if (!cleanupHooked) {
    cleanupHooked = true;
    process.on("exit", () => {
      for (const dir of tempPaths) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort temp cleanup
        }
      }
    });
  }
  tempPaths.push(path);
  return path;
}

/** A fresh auto-cleaned temp dir. */
export function tempDir(prefix: string): string {
  return track(mkdtempSync(join(tmpdir(), prefix)));
}

/** Minimal SkillMeta factory for partition/grouper tests. */
export function mk(dir: string, product?: string): SkillMeta {
  return {
    path: `./${dir}/`,
    dir,
    name: dir,
    description: `Skill ${dir}`,
    ...(product !== undefined ? { product } : {}),
  };
}

export interface PluginOpts {
  products: Record<string, number>;
  marketplace?: boolean;
  hooks?: boolean;
  commands?: boolean;
  repoLocalMcp?: boolean;
  marker?: Record<string, unknown>;
}

/** Scaffold a telnyx-shaped nested plugin in a temp dir. Caller rm -rf's the result. */
export function makeNestedPlugin(opts: PluginOpts): string {
  const root = tempDir("ccp-nested-");
  const plugin = join(root, "providers", "claude", "plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "telnyx" }));
  if (opts.marketplace === true) {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "telnyx", plugins: [{ name: "telnyx", source: "./providers/claude/plugin/" }] }),
    );
  }
  const mcp = opts.repoLocalMcp === true
    ? { mcpServers: { local: { command: "node", args: ["./server/index.js"] } } }
    : { mcpServers: { telnyx: { type: "http", url: "https://api.telnyx.com/v2/mcp" } } };
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify(mcp));
  mkdirSync(join(plugin, "agents"), { recursive: true });
  writeFileSync(
    join(plugin, "agents", "telnyx-developer.md"),
    "---\nname: telnyx-developer\ndescription: Telnyx dev agent.\n---\n",
  );
  if (opts.hooks === true) {
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
  }
  if (opts.commands === true) {
    mkdirSync(join(plugin, "commands"), { recursive: true });
    writeFileSync(join(plugin, "commands", "dothing.md"), "---\ndescription: Do a thing.\n---\n");
  }
  if (opts.marker !== undefined) {
    writeFileSync(join(root, ".ccpluginizer.json"), JSON.stringify(opts.marker));
  }
  for (const [product, count] of Object.entries(opts.products)) {
    for (let i = 0; i < count; i++) {
      const dir = join(plugin, "skills", `telnyx-${product}-${String(i)}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: telnyx-${product}-${String(i)}\ndescription: ${product} skill ${String(i)}.\nmetadata:\n  product: ${product}\n---\n`,
      );
    }
  }
  return root;
}

/** Scaffold a flat repo: skills/<product>-<i>/SKILL.md at the root, no plugin shell. */
export function makeFlatSkillsRepo(products: Record<string, number>): string {
  const root = tempDir("ccp-flat-");
  for (const [product, count] of Object.entries(products)) {
    for (let i = 0; i < count; i++) {
      const dir = join(root, "skills", `${product}-${String(i)}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\ndescription: ${product} ${String(i)}.\nmetadata:\n  product: ${product}\n---\n`,
      );
    }
  }
  return root;
}

/** Capture everything a call (sync or awaited) writes via console.error. */
export async function captureStderr(fn: () => unknown): Promise<string> {
  const spy = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await fn();
    return spy.mock.calls.map((c) => c.map((a) => String(a)).join(" ")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

const CLI = join(import.meta.dirname, "../src/index.ts");

/** Curated PATH so Bun.which("claude") is null inside the child (hermetic auto/llm detection). */
export function curatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dirs = ["/bin", "/usr/bin"];
  const bunDir = dirname(process.execPath);
  if (!existsSync(join(bunDir, "claude")) && !existsSync(join(bunDir, "claude.exe"))) {
    dirs.push(bunDir); // include the interpreter dir only if it does not also ship `claude`
  }
  return {
    PATH: dirs.join(":"),
    HOME: process.env["HOME"] ?? tmpdir(),
    TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
    ...extra,
  };
}

/** Spawn the CLI's scan command hermetically and collect its output. */
export async function runScan(
  scanArgs: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Launch via the absolute interpreter path; Bun resolves argv[0] against the child PATH,
  // so a bare "bun" token with a stripped PATH would throw ENOENT before the CLI runs.
  const proc = Bun.spawn([process.execPath, "run", CLI, "scan", ...scanArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: curatedEnv(opts.env),
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}
