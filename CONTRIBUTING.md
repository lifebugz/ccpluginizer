# Contributing

Thank you for considering an addition to ccpluginizer's catalog.

## Submit an entry

```bash
# After installing globally (bun add -g @ccpluginizer/cli):
ccpluginizer scan <owner/repo>
# Or one-shot without installing:
bunx --package=@ccpluginizer/cli ccpluginizer scan <owner/repo>
# Review the output, save to entries/<name>.json
bun scripts/build-marketplace.ts  # Verify it merges cleanly
```

Then open a PR adding `entries/<name>.json`. The validation CI will run automatically.

## Quality bar (v0.1)

- The source repo must be public.
- It must contain at least one valid component (skill, agent, command, hook, MCP server).
- Detection must produce all paths at `high` confidence (or `medium` if Layer 3 is the only finding).
- The entry's `license` field must reflect the source repo's license; if unknown, we will request clarification.
- We default the entry's `name` to `<owner>-<repo>` (kebab-cased) to avoid impersonation. Authors who want a different name should commit a `.ccpluginizer.json` marker file to their source repo.

## Marker file (optional)

If you author a source repo and want a clean, authoritative entry, commit `.ccpluginizer.json` to the repo root. See the [design spec](./docs/superpowers/specs/2026-04-30-ccpluginizer-design.md) for the schema.

## Adding a changeset

Every PR requires a changeset. After making your changes:

```bash
bunx changeset
```

For PRs that don't change the CLI (entry submissions, docs, CI tweaks):

```bash
bunx changeset --empty
```

Commit the generated `.changeset/*.md` file with your PR.

### Bump types (pre-1.0)

Changesets prompts you to pick `patch` / `minor` / `major`, but pre-1.0 semver flips the conventional meaning. Use this decision tree:

| Your change | Pre-1.0 (now) | Post-1.0 |
|---|---|---|
| Bug fix, no behavior change | `patch` | `patch` |
| New feature, backward-compatible | `minor` | `minor` |
| Breaking CLI flag change, removed command, etc. | `minor` | `major` |

Examples:
- "Add `--json` flag to `scan`" → `minor`
- "Fix crash when entry path doesn't exist" → `patch`
- "Rename `submit` command to `publish`" → `minor` (would be `major` after 1.0)

When in doubt, pick `minor` — pre-1.0, every release is implicitly "may break things."

## Releasing (maintainers only)

Releases are automated. Do not run `bun publish` manually.

1. Wait for the "Version Packages" PR to be opened by the bot after changesets accumulate on `main`.
2. Review the bumped versions and `CHANGELOG.md` entries.
3. Merge the PR. The release workflow publishes to npm, pushes git tags, AND creates a GitHub Release for each tagged version (release notes auto-populated from `CHANGELOG.md`).

### Pre-flight (before first release)

The `NPM_TOKEN` secret must exist in repo secrets before merging the scaffolding PR that adds Changesets. Generate an npm Automation token (granular access scoped to `@ccpluginizer/cli` or the entire `@ccpluginizer` scope) and add it at Settings → Secrets and variables → Actions.

### Yanking a release

`npm unpublish @ccpluginizer/cli@<version>` within 72 hours of publish. After 72h, contact npm support.

### Adding a workspace dependency between packages

If you add an internal `workspace:*` dependency between packages (e.g., a future `@ccpluginizer/utils` consumed by `@ccpluginizer/cli`), re-verify with `bun pm pack` that the published tarball still has concrete version specifiers (no `workspace:*` strings survive). `bun publish` strips workspace protocols at pack time, but it's worth confirming for any new dependency shape.
