import { Crust } from "@crustjs/core";
import { writeFileSync } from "node:fs";
import { resolveSource, inferSourceRepo } from "../sources/index.ts";
import { synthesizeEntry } from "../detector/synthesize.ts";

export const scanCommand = new Crust("scan")
  .meta({ description: "Scan a non-plugin repo and emit a marketplace entry" })
  .args([{ name: "repo", type: "string", required: true, description: "owner/repo, URL, or local path" }] as const)
  .flags({
    output: { type: "string", short: "o", description: "Write entry JSON to file" },
  })
  .run(async ({ args, flags }): Promise<void> => {
    const repoPath = await resolveSource(args.repo);
    const sourceRepo = inferSourceRepo(args.repo);
    const entry = synthesizeEntry({ repoRoot: repoPath, sourceRepo });
    const json = JSON.stringify(entry, null, 2);
    if (flags.output !== undefined) {
      writeFileSync(flags.output, json + "\n", "utf8");
    } else {
      console.log(json);
    }
  });
