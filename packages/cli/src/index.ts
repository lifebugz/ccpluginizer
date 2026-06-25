#!/usr/bin/env bun
import "./runtime-guard.ts";
import { Crust } from "@crustjs/core";
import { helpPlugin, versionPlugin } from "@crustjs/plugins";
import pkg from "../package.json";
import { scanCommand } from "./commands/scan.ts";
import { validateCommand } from "./commands/validate.ts";

const app = new Crust("ccpz")
  .meta({ description: "Pluginize non-plugin Claude Code repos" })
  .use(versionPlugin(pkg.version)) // MUST precede helpPlugin — see plan Global Constraints (R1)
  .use(helpPlugin())
  .command(scanCommand)
  .command(validateCommand);

await app.execute();
