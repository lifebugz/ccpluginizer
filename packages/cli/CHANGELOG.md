# @ccpluginizer/ccpluginizer

## 0.3.0

### Minor Changes

- [#11](https://github.com/lifebugz/ccpluginizer/pull/11) [`05b29d8`](https://github.com/lifebugz/ccpluginizer/commit/05b29d85cce55c65eb6254ab5098bd100c65b4fc) Thanks [@lifebugz](https://github.com/lifebugz)! - Run with either Bun or Node — `npx`/`npm install -g` now work alongside `bunx`/`bun add`.

  - Replaced `Bun.spawn` (the only Bun-specific API in the source) with `node:child_process.spawnSync` in the GitHub clone step.
  - Switched the build target from `bun` to `node` so the bundle is portable.
  - The bin script now prefers `bun` at runtime when available (faster startup), falling back to `node`. Either runtime works for installation and one-shot invocation.
  - Updated README with both Bun and npm/Node install paths.

## 0.2.2

### Patch Changes

- [#9](https://github.com/lifebugz/ccpluginizer/pull/9) [`ec73132`](https://github.com/lifebugz/ccpluginizer/commit/ec73132379872ae175ba5dc01133d6f51d949c50) Thanks [@lifebugz](https://github.com/lifebugz)! - Remove the unused `@crustjs/store` dependency. It was never imported in `packages/cli/src/`, and its `peerDependencies.typescript: "^5"` (out of step with the rest of the `@crustjs/*` suite at `^6`) caused `bunx @ccpluginizer/ccpluginizer` to print a benign-but-noisy peer-dep warning. Dropping it silences the warning and slightly shrinks install size for end users.

## 0.2.1

### Patch Changes

- [#4](https://github.com/lifebugz/ccpluginizer/pull/4) [`47d247f`](https://github.com/lifebugz/ccpluginizer/commit/47d247f2eb94770194609b7dc512505ab73dda25) Thanks [@lifebugz](https://github.com/lifebugz)! - Fix the CLI's published package:

  - `bin/ccpluginizer` now follows symlinks correctly. Previously, when the bin was symlinked into `node_modules/.bin/`, the relative `../dist/index.js` lookup resolved to a non-existent path and `bunx`/global-install invocations failed with `Module not found`.
  - Add `repository`, `homepage`, `bugs`, and `keywords` fields so the npm package page links back to GitHub.
  - Add `packages/cli/README.md` (and include it in the `files` whitelist) so the npm package page renders project documentation.
  - Switch publish from `bun publish` to `npm publish --provenance` so releases use npm Trusted Publishing (OIDC) and ship attestation. Eliminates the `NPM_TOKEN` repo secret requirement.

- [#5](https://github.com/lifebugz/ccpluginizer/pull/5) [`efc75b4`](https://github.com/lifebugz/ccpluginizer/commit/efc75b4944338837c6e4c4c8a06a336b842f9081) Thanks [@lifebugz](https://github.com/lifebugz)! - Use `bunx npm@latest publish` instead of upgrading the system npm. The previous workflow ran `npm install -g npm@latest` to get the npm 11.5.1+ required for OIDC trusted publishing, but that triggered a known npm self-upgrade race condition (`Cannot find module 'promise-retry'`) that failed CI. `bunx npm@latest` fetches a fresh npm CLI on demand without modifying the runner's global Node install.

## 0.2.0

### Minor Changes

- [#1](https://github.com/lifebugz/ccpluginizer/pull/1) [`17feef8`](https://github.com/lifebugz/ccpluginizer/commit/17feef87abc8e1d2679543a6a9762451f590bb2b) Thanks [@lifebugz](https://github.com/lifebugz)! - Adopt Changesets release flow.
