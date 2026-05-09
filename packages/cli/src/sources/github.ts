import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceCloneError } from "../errors.ts";

export function resolveGithub(repo: string): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), `ccp-${repo.replace("/", "-")}-`));
  const url = `https://github.com/${repo}.git`;
  const result = spawnSync("git", ["clone", "--depth=1", url, dest], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new SourceCloneError(repo, result.stderr);
  }
  return Promise.resolve(dest);
}
