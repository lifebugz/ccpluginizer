## Summary

<!-- 1-2 sentences on what this PR does and why. -->

## Type

- [ ] New catalog entry (`entries/<name>.json`)
- [ ] CLI change (`packages/cli/`)
- [ ] Docs, CI, or repo config

## Checklist

- [ ] Added a changeset (`bunx changeset` for CLI changes; `bunx changeset --empty` for entries, docs, or CI tweaks)
- [ ] For new entries: ran `bun scripts/build-marketplace.ts` and the catalog still builds cleanly
- [ ] For CLI changes: `bun --filter='@ccpluginizer/*' test` passes locally
