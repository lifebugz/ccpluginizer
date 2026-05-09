# @ccpluginizer/ccpluginizer

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
