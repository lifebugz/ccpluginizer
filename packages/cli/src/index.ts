#!/usr/bin/env bun
import "./runtime-guard.ts";
import { Crust } from "@crustjs/core";
import { scanCommand } from "./commands/scan.ts";
import { validateCommand } from "./commands/validate.ts";

const app = new Crust("ccpz")
  .meta({ description: "Pluginize non-plugin Claude Code repos" })
  .command(scanCommand)
  .command(validateCommand);

await app.execute();
