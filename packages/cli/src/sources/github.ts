import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceCloneError } from "../errors.ts";

export async function resolveGithub(repo: string): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), `ccp-${repo.replace("/", "-")}-`));
  const url = `https://github.com/${repo}.git`;
  const proc = Bun.spawn(["git", "clone", "--depth=1", url, dest], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new SourceCloneError(repo, stderr);
  }
  return dest;
}
