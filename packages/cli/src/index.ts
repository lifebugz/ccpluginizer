#!/usr/bin/env bun
import "./runtime-guard.ts";
import { Crust } from "@crustjs/core";
import { helpPlugin, versionPlugin } from "@crustjs/plugins";
// Named import (not `import pkg`) so bun's bundler inlines ONLY the version
// string; a default import inlines the whole package.json (scripts +
// devDependencies) into the shipped dist bundle. Still build-time-sourced — never hardcoded.
import { version } from "../package.json";
import { scanCommand } from "./commands/scan.ts";
import { validateCommand } from "./commands/validate.ts";

const app = new Crust("ccpz")
  .meta({ description: "Pluginize non-plugin Claude Code repos" })
  // Registration order is precedence order: the first matching plugin short-circuits.
  // versionPlugin must precede helpPlugin so `--version --help` resolves to version, not help.
  .use(versionPlugin(version))
  .use(helpPlugin())
  .command(scanCommand)
  .command(validateCommand);

await app.execute();
