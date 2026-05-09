---
"@ccpluginizer/ccpluginizer": minor
---

Run with either Bun or Node — `npx`/`npm install -g` now work alongside `bunx`/`bun add`.

- Replaced `Bun.spawn` (the only Bun-specific API in the source) with `node:child_process.spawnSync` in the GitHub clone step.
- Switched the build target from `bun` to `node` so the bundle is portable.
- The bin script now prefers `bun` at runtime when available (faster startup), falling back to `node`. Either runtime works for installation and one-shot invocation.
- Updated README with both Bun and npm/Node install paths.
