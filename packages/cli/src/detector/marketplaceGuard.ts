import { existsSync } from "node:fs";
import { join } from "node:path";
import { AlreadyMarketplaceError } from "../errors.ts";

export function checkMarketplaceGuard(repoRoot: string): void {
  const marketplaceFile = join(repoRoot, ".claude-plugin", "marketplace.json");
  if (existsSync(marketplaceFile)) {
    throw new AlreadyMarketplaceError(repoRoot);
  }
}
