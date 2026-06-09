import { existsSync } from "node:fs";
import { join } from "node:path";
import { AlreadyMarketplaceError } from "../errors.ts";

/** Does the repo already publish a marketplace catalog? */
export function isAlreadyMarketplace(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".claude-plugin", "marketplace.json"));
}

export function checkMarketplaceGuard(repoRoot: string): void {
  if (isAlreadyMarketplace(repoRoot)) {
    throw new AlreadyMarketplaceError(repoRoot);
  }
}
