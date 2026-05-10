---
"@ccpluginizer/ccpluginizer": minor
---

Fix three latent issues in `scan` output that caused entries to fail Claude Code's `claude plugin validate` and prevented installs:

- **Source field**: now emits `{ source: "url", url: "https://github.com/<owner>/<repo>.git" }` instead of `{ source: "github", repo: "<owner>/<repo>" }`. The `github` discriminator routes through a Claude Code code path with an SSH-fallback bug (anthropics/claude-code#18001) that breaks installs for users without SSH keys configured. The `url` form is the canonical shape Anthropic's own `claude-plugins-official` marketplace uses.

- **Agents field**: now enumerates individual `.md` file paths (`./agents/foo.md`, `./agents/bar.md`, …) instead of emitting the directory path (`./agents/`). Claude Code's schema requires file paths for `agents`, not directories. Trade-off: new agent files added to a source repo are no longer auto-exposed; the entry must be re-scanned to pick them up.

- **Author normalization**: when a source repo's manifest declares author as a string (`"author": "Some Name"`), the entry now normalizes it to the documented object form (`"author": { "name": "Some Name" }`). Claude Code's schema rejects the string form.

Existing entries on disk that have any of the old shapes will continue to load fine — the valibot schema accepts the old forms — but they will fail `claude plugin validate` and won't install. Regenerate with `ccpluginizer scan <owner/repo> --output entries/<name>.json` to pick up the new shape.
