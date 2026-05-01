#!/usr/bin/env bun
import { Crust } from "@crustjs/core";
import { scanCommand } from "./commands/scan.ts";
import { validateCommand } from "./commands/validate.ts";
import { submitCommand } from "./commands/submit.ts";

const app = new Crust("ccpluginizer")
  .meta({ description: "Pluginize non-plugin Claude Code repos" })
  .command(scanCommand)
  .command(validateCommand)
  .command(submitCommand);

await app.execute();
