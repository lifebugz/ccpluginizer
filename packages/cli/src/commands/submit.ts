import { Crust } from "@crustjs/core";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSource, inferSourceRepo } from "../sources/index.ts";
import { synthesizeEntry } from "../detector/synthesize.ts";

export const submitCommand = new Crust("submit")
  .meta({ description: "Generate an entry and open a PR against ccpluginizer/marketplace" })
  .args([{ name: "repo", type: "string", required: true, description: "owner/repo to pluginize" }] as const)
  .flags({
    dryRun: { type: "boolean", short: "n", description: "Print the PR plan without opening it" },
  })
  .run(async ({ args, flags }): Promise<void> => {
    const repoPath = await resolveSource(args.repo);
    const sourceRepo = inferSourceRepo(args.repo);
    const entry = synthesizeEntry({ repoRoot: repoPath, sourceRepo });
    const tmpFile = join(mkdtempSync(join(tmpdir(), "ccp-submit-")), `${entry.name}.json`);
    writeFileSync(tmpFile, JSON.stringify(entry, null, 2) + "\n", "utf8");

    if (flags.dryRun === true) {
      console.log(`Would submit:\n  entry: ${tmpFile}\n  to:    ccpluginizer/marketplace`);
      console.log(JSON.stringify(entry, null, 2));
      return;
    }

    console.log(`Generated entry at ${tmpFile}`);
    console.log("Run with --dryRun to preview, or follow the manual PR workflow in CONTRIBUTING.md.");
  });
