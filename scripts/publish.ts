#!/usr/bin/env bun
/**
 * Idempotently publish public workspace packages to npm.
 *
 * The `release` workflow runs this (via `ci:publish`) on every push to `main`
 * that carries no changesets — changesets/action's "attempting to publish any
 * unpublished packages" path. A bare `npm publish` there 403s on any version
 * already on npm, turning every CI/chore commit into a red release run. So we
 * skip packages whose exact `name@version` is already published and only
 * publish the ones that aren't.
 *
 * Why not `changeset publish` (which is idempotent for free)? It shells out to
 * the runner's system npm, which is too old for npm OIDC trusted publishing +
 * provenance. The current pipeline relies on `bunx npm@latest publish` to get a
 * new-enough npm, so we keep that and add the skip-guard ourselves.
 *
 * `changeset tag` still runs at the end: its `New tag: <pkg>@<version>` stdout
 * is what changesets/action parses to create GitHub Releases.
 *
 * `--dry-run` prints the publish/skip decision without mutating anything.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const PACKAGES_DIR = "packages";

function isAlreadyPublished(name: string, version: string): boolean {
  const { status, stdout } = spawnSync(
    "bunx",
    ["npm@latest", "view", `${name}@${version}`, "version"],
    { encoding: "utf8" },
  );
  // status 0 + matching version => that exact version is on the registry.
  // Anything else (E404, network error) => treat as "not published" and let the
  // publish attempt be the source of truth.
  return status === 0 && stdout.trim() === version;
}

let publishedCount = 0;
for (const entry of readdirSync(PACKAGES_DIR)) {
  const pkgJsonPath = join(PACKAGES_DIR, entry, "package.json");
  if (!existsSync(pkgJsonPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const spec = `${pkg.name}@${pkg.version}`;

  if (pkg.private) {
    console.log(`skip ${spec} (private)`);
    continue;
  }
  if (isAlreadyPublished(pkg.name, pkg.version)) {
    console.log(`skip ${spec} (already on npm)`);
    continue;
  }

  console.log(`publish ${spec}${DRY_RUN ? " (dry-run)" : ""}`);
  if (DRY_RUN) continue;

  const res = spawnSync("bunx", ["npm@latest", "publish"], {
    cwd: join(PACKAGES_DIR, entry),
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error(`publish failed for ${spec}`);
    process.exit(res.status ?? 1);
  }
  publishedCount++;
}

console.log(`published ${publishedCount} package(s)`);

if (!DRY_RUN) {
  // Creates git tags for current versions (skips tags that already exist); its
  // "New tag: ..." output drives changesets/action's GitHub Release creation.
  const tag = spawnSync("bunx", ["changeset", "tag"], { stdio: "inherit" });
  if (tag.status !== 0) process.exit(tag.status ?? 1);
}
