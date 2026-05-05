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
