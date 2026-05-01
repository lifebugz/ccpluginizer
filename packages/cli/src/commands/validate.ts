import { Crust } from "@crustjs/core";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { MarketplaceEntrySchema } from "../schemas/marketplaceEntry.ts";

export const validateCommand = new Crust("validate")
  .meta({ description: "Validate a marketplace entry JSON file against the schema" })
  .args([{ name: "entryFile", type: "string", required: true, description: "Path to entry JSON file" }] as const)
  .run(({ args }): void => {
    const raw = readFileSync(args.entryFile, "utf8");
    const parsed: unknown = JSON.parse(raw) as unknown;
    const result = v.safeParse(MarketplaceEntrySchema, parsed);
    if (!result.success) {
      console.error("Validation failed:");
      for (const issue of result.issues) {
        console.error(JSON.stringify(issue));
      }
      process.exit(1);
    }
    console.log("OK");
  });
