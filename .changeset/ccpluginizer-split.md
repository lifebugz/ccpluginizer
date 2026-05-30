---
"@ccpluginizer/ccpluginizer": minor
---

Add guarded auto-splitting to `scan`: bloated multi-domain plugins (≥25 skills with a clean partition) are now carved into a shared `<base>-core` entry (inline MCP + agents, ~0 always-on tokens) plus one install-on-demand `<base>-<domain>` skill slice per product cluster, each depending on `-core`. This restores Claude Code's per-session skill-listing budget without redistributing or modifying the source — slices are `git-subdir` entries rooted at the skills container that enumerate only their subset.

Splitting is on by default but only fires when it helps; sub-threshold and single-domain repos emit a single entry byte-identical to before. New `scan` flags: `--no-split`, `--umbrella`, `--cluster=<auto|llm|metadata|directory|name-prefix>`, `--out-dir`, `--write-marker`, `--interactive`, `--min-skills`. Clustering defaults to LLM/semantic (via the `claude` CLI) and falls back to deterministic strategies (metadata `product`, directory, name-prefix) with a stderr notice. `validate` now accepts a directory or JSON array and enforces cross-entry name uniqueness.
