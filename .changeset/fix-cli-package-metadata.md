---
"@ccpluginizer/ccpluginizer": patch
---

Fix the CLI's published package:

- `bin/ccpluginizer` now follows symlinks correctly. Previously, when the bin was symlinked into `node_modules/.bin/`, the relative `../dist/index.js` lookup resolved to a non-existent path and `bunx`/global-install invocations failed with `Module not found`.
- Add `repository`, `homepage`, `bugs`, and `keywords` fields so the npm package page links back to GitHub.
- Add `packages/cli/README.md` (and include it in the `files` whitelist) so the npm package page renders project documentation.
- Switch publish from `bun publish` to `npm publish --provenance` so releases use npm Trusted Publishing (OIDC) and ship attestation. Eliminates the `NPM_TOKEN` repo secret requirement.
