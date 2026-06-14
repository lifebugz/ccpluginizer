---
---

CI-only change: bump `actions/create-github-app-token` to v3 (Node 24 runtime) in the release workflow. No package release is warranted, so this changeset is intentionally empty.

It also serves as a guard: with an empty changeset present, the post-merge `release` run takes the "all changesets are empty; not creating PR" branch instead of "no changesets found → attempting to publish". The latter would invoke `ci:publish`, whose raw `npm publish` is not idempotent and would 403 trying to republish the already-published version.
