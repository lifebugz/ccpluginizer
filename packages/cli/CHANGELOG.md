# @ccpluginizer/ccpluginizer

## 0.8.0

### Minor Changes

- [#39](https://github.com/lifebugz/ccpluginizer/pull/39) [`e9027b1`](https://github.com/lifebugz/ccpluginizer/commit/e9027b117cb8388649a8af66a4dff91dbde8c9f9) Thanks [@lifebugz](https://github.com/lifebugz)! - Renamed: package `@ccpluginizer/ccpluginizer` → `@ccpluginizer/ccpz`, command `ccpluginizer` → `ccpz` (and `ccpluginizer:` diagnostics → `ccpz:`). Env vars (`CCPLUGINIZER_*`), the `.ccpluginizer.json` marker, and the cache dir are unchanged. The old `ccpluginizer` command no longer ships; install `@ccpluginizer/ccpz`.

## 0.7.0

### Minor Changes

- [#35](https://github.com/lifebugz/ccpluginizer/pull/35) [`eef5f0f`](https://github.com/lifebugz/ccpluginizer/commit/eef5f0f7b67c2b0c9ed5e2c32beb49f22943a0b5) Thanks [@lifebugz](https://github.com/lifebugz)! - BREAKING: Node is no longer a supported runtime. Run ccpluginizer under Bun
  (`bunx @ccpluginizer/ccpluginizer …` or `bun add -g`) or download a native
  binary from GitHub Releases. The CLI now builds with `--target bun`, requires
  `bun >=1.2.0`, and a first-import runtime guard refuses to start on Node or Bun
  <1.2 with a pointer to both supported paths.

### Patch Changes

- [#37](https://github.com/lifebugz/ccpluginizer/pull/37) [`a1b710c`](https://github.com/lifebugz/ccpluginizer/commit/a1b710c10f134d2a9464611b9c7c8bb741fca784) Thanks [@lifebugz](https://github.com/lifebugz)! - Native binaries: a `release-binaries.yml` workflow now cross-builds self-contained
  executables for macOS (arm64), Linux (x64/arm64), and Windows (x64) and uploads
  them to each GitHub Release. The package README documents the downloads and the
  unsigned-binary (Gatekeeper/SmartScreen) caveats. No change to the published JS bundle.

## 0.6.1

### Patch Changes

- [#29](https://github.com/lifebugz/ccpluginizer/pull/29) [`0f489de`](https://github.com/lifebugz/ccpluginizer/commit/0f489de6a6c9274455588fbd979faa5a6a52e1d3) Thanks [@lifebugz](https://github.com/lifebugz)! - Upgrade dependencies to latest: the `@crustjs/*` CLI framework stack (`core` 0.0.16→0.0.19, `plugins` 0.0.22→0.1.2, `progress` 0.0.3→0.0.4, `prompts` 0.0.13→0.1.0, `style` 0.1.0→0.2.0) and `valibot` 1.3.1→1.4.1, plus dev tooling (`@crustjs/crust`, `eslint`, `jiti`, `typescript-eslint`, `@types/bun`). No user-facing behavior change — `scan` and `validate` produce identical output; verified by typecheck, lint, build, and the full 310-test suite.

## 0.6.0

### Minor Changes

- [#26](https://github.com/lifebugz/ccpluginizer/pull/26) [`9fedfea`](https://github.com/lifebugz/ccpluginizer/commit/9fedfeaae0a1b655dc05fb0b7880ed85657907f1) Thanks [@lifebugz](https://github.com/lifebugz)! - Add guarded auto-splitting to `scan`: bloated multi-domain plugins (≥25 skills with a clean partition) are now carved into a shared `<base>-core` entry (inline MCP + agents, ~0 always-on tokens) plus one install-on-demand `<base>-<domain>` skill slice per product cluster, each depending on `-core`. This restores Claude Code's per-session skill-listing budget without redistributing or modifying the source — slices are `git-subdir` entries rooted at the skills container that enumerate only their subset.

  Splitting is on by default but only fires when it helps; sub-threshold and single-domain repos still emit a single entry, identical to before apart from deterministic path ordering (sniff-detected paths are now sorted) and frontmatter-detection fixes — files previous versions wrongly dropped (BOM/CRLF frontmatter, numeric name/description scalars, comma-string or flow-list agent `tools`) are now detected and may appear in regenerated entries. New `scan` flags: `--no-split`, `--umbrella`, `--cluster=<auto|auto-llm|llm|metadata|directory|name-prefix>`, `--llm-cmd`, `--llm-timeout`, `--out-dir`, `--write-marker`, `--interactive`, `--min-skills`. Clustering is **deterministic by default** (`metadata` `product` → directory → name-prefix); an LLM is opt-in via `--cluster=llm`/`auto-llm` with a bring-your-own subprocess command (`--llm-cmd`) or the built-in `claude` CLI, and `auto-llm` runs deterministic first with the LLM as a rescue. Every backend's output passes an acceptance gate, and stderr always states which strategy produced the split. `validate` now accepts a directory or JSON array, names the offending file in errors, and enforces cross-entry name uniqueness. Repos that already publish a marketplace no longer abort when the split gate fires — the split re-curates them with an explicit warning (the single-entry abort is preserved).

## 0.5.1

### Patch Changes

- [#23](https://github.com/lifebugz/ccpluginizer/pull/23) [`29e7698`](https://github.com/lifebugz/ccpluginizer/commit/29e7698b9961a7c39eff61ae8ebce864ebfd18fe) Thanks [@lifebugz](https://github.com/lifebugz)! - Verify the new GitHub App release flow end-to-end: this changeset should drive a v0.5.1 bump and the resulting "Version Packages" PR should be authored by `ccpluginizer-release-bot[bot]` with `validate` + `changeset-check` triggering on it automatically.

## 0.5.0

### Minor Changes

- [#20](https://github.com/lifebugz/ccpluginizer/pull/20) [`64a6060`](https://github.com/lifebugz/ccpluginizer/commit/64a60604a3d10832b3a920a30add51fa522c2899) Thanks [@lifebugz](https://github.com/lifebugz)! - Fix three latent issues in `scan` output that caused entries to fail Claude Code's `claude plugin validate` and prevented installs:

  - **Source field**: now emits `{ source: "url", url: "https://github.com/<owner>/<repo>.git" }` instead of `{ source: "github", repo: "<owner>/<repo>" }`. The `github` discriminator routes through a Claude Code code path with an SSH-fallback bug (anthropics/claude-code#18001) that breaks installs for users without SSH keys configured. The `url` form is the canonical shape Anthropic's own `claude-plugins-official` marketplace uses.

  - **Agents field**: now enumerates individual `.md` file paths (`./agents/foo.md`, `./agents/bar.md`, …) instead of emitting the directory path (`./agents/`). Claude Code's schema requires file paths for `agents`, not directories. Trade-off: new agent files added to a source repo are no longer auto-exposed; the entry must be re-scanned to pick them up.

  - **Author normalization**: when a source repo's manifest declares author as a string (`"author": "Some Name"`), the entry now normalizes it to the documented object form (`"author": { "name": "Some Name" }`). Claude Code's schema rejects the string form.

  Existing entries on disk that have any of the old shapes will continue to load fine — the valibot schema accepts the old forms — but they will fail `claude plugin validate` and won't install. Regenerate with `ccpluginizer scan <owner/repo> --output entries/<name>.json` to pick up the new shape.

## 0.4.0

### Minor Changes

- [#14](https://github.com/lifebugz/ccpluginizer/pull/14) [`5579700`](https://github.com/lifebugz/ccpluginizer/commit/5579700420d08eb01032a1dd55b35b9eab3e059c) Thanks [@lifebugz](https://github.com/lifebugz)! - Remove `submit` command. The CLI now focuses on generating and validating entry JSON; adding an entry to the catalog is done via a regular PR. See CONTRIBUTING.md for the workflow.

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
