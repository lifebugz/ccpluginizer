import { Crust } from "@crustjs/core";
import { collectEntries, validateEntries } from "../detector/validateEntries.ts";

export const validateCommand = new Crust("validate")
  .meta({ description: "Validate marketplace entries against the schema (file, JSON array, or directory)" })
  .args([
    { name: "entryFile", type: "string", required: true, description: "Path to an entry JSON file, a JSON array, or a directory of entries" },
  ] as const)
  .run(({ args }): void => {
    const items = collectEntries(args.entryFile);
    const result = validateEntries(items);
    if (!result.ok) {
      console.error("Validation failed:");
      for (const error of result.errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }
    console.log(`OK (${String(items.length)} ${items.length === 1 ? "entry" : "entries"})`);
  });
