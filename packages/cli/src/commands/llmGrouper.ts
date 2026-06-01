import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroupSkillsFn } from "../detector/partition.ts";
import type { SkillMeta } from "../detector/skillMeta.ts";

export interface RawGroup {
  readonly slug: string;
  readonly members: string[];
}

// Cap the `claude -p` clustering call so a hung/stalled/auth-prompting CLI cannot
// block the scan forever; on timeout spawnSync returns a non-zero status and we
// fall back to deterministic clustering.
const CLUSTER_TIMEOUT_MS = 120_000;

/** Build a one-shot clustering prompt for the `claude -p` CLI. */
export function buildClusterPrompt(skills: readonly SkillMeta[]): string {
  const lines = skills.map((s) => {
    const product = s.product !== undefined ? ` [product=${s.product}]` : "";
    const desc = s.description.slice(0, 140);
    return `- ${s.dir}${product}: ${desc}`;
  });
  return [
    "You are grouping Claude Code skills into a small number of coherent product domains.",
    "",
    "Rules:",
    "- Produce between 2 and 12 groups.",
    "- Every skill must appear in exactly one group (disjoint, total cover).",
    "- No group may contain more than ~70% of all skills.",
    "- Group by product/domain meaning, not by programming language.",
    '- Each group needs a short kebab-case "slug" (e.g. "messaging", "voice").',
    "",
    "Skills:",
    ...lines,
    "",
    'Respond with ONLY a JSON array, no prose: [{"slug":"...","members":["<skill-dir>",...]}, ...]',
  ].join("\n");
}

/** Parse the model's response into validated groups, dropping hallucinated members. */
export function parseClusterResponse(
  text: string,
  validDirs: ReadonlySet<string>,
): RawGroup[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const groups: RawGroup[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const slug = obj["slug"];
    const members = obj["members"];
    if (typeof slug !== "string" || !Array.isArray(members)) {
      continue;
    }
    const valid = members.filter((m): m is string => typeof m === "string" && validDirs.has(m));
    if (valid.length > 0) {
      groups.push({ slug, members: valid });
    }
  }
  return groups.length > 0 ? groups : null;
}

/** Validate a value (e.g. a disk-cache file) as a RawGroup[], rejecting wrong shapes. */
export function validateRawGroups(parsed: unknown): RawGroup[] | null {
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: RawGroup[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") {
      return null;
    }
    const obj = item as Record<string, unknown>;
    const slug = obj["slug"];
    const members = obj["members"];
    if (typeof slug !== "string" || !Array.isArray(members)) {
      return null;
    }
    out.push({ slug, members: members.filter((m): m is string => typeof m === "string") });
  }
  return out;
}

/**
 * Return an injectable LLM grouper backed by the `claude` CLI, or null when the
 * CLI is unavailable (so callers fall back to deterministic clustering).
 * Results are cached on disk keyed by a content hash of the skill set.
 */
export function makeClaudeGrouper(): GroupSkillsFn | null {
  const claude = which("claude");
  if (claude === null) {
    return null;
  }
  return (skills: readonly SkillMeta[]): Promise<RawGroup[]> => {
    const validDirs = new Set(skills.map((s) => s.dir));
    const cacheKey = hashSkills(skills);
    const cached = readCache(cacheKey);
    if (cached !== null) {
      return Promise.resolve(cached);
    }
    const result = spawnSync(claude, ["-p", buildClusterPrompt(skills)], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: CLUSTER_TIMEOUT_MS,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      return Promise.resolve([]);
    }
    const groups = parseClusterResponse(result.stdout, validDirs) ?? [];
    // Only cache a non-empty grouping: an empty `[]` (a failed/garbled response)
    // would be read back as a valid cache hit and permanently bypass the LLM.
    if (groups.length > 0) {
      writeCache(cacheKey, groups);
    }
    return Promise.resolve(groups);
  };
}

function which(cmd: string): string | null {
  if (typeof Bun !== "undefined") {
    return Bun.which(cmd);
  }
  // `which` does not exist on Windows; use `where` there. `where` can print
  // several matches (one per line) — take the first.
  const finder = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(finder, [cmd], { encoding: "utf8" });
  const out = typeof r.stdout === "string" ? (r.stdout.split("\n")[0] ?? "").trim() : "";
  return r.status === 0 && out !== "" ? out : null;
}

function hashSkills(skills: readonly SkillMeta[]): string {
  const material = [...skills]
    .map((s) => `${s.dir}\x00${s.product ?? ""}\x00${s.description}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function cacheDir(): string {
  return join(tmpdir(), "ccpluginizer-cache");
}

function readCache(key: string): RawGroup[] | null {
  const file = join(cacheDir(), `${key}.json`);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return validateRawGroups(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeCache(key: string, groups: RawGroup[]): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), `${key}.json`), JSON.stringify(groups), "utf8");
  } catch {
    // best-effort cache; ignore write failures
  }
}
