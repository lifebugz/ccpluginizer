---
"@ccpluginizer/ccpluginizer": minor
---

Add guarded auto-splitting to `scan`: bloated multi-domain plugins (≥25 skills with a clean partition) are now carved into a shared `<base>-core` entry (inline MCP + agents, ~0 always-on tokens) plus one install-on-demand `<base>-<domain>` skill slice per product cluster, each depending on `-core`. This restores Claude Code's per-session skill-listing budget without redistributing or modifying the source — slices are `git-subdir` entries rooted at the skills container that enumerate only their subset.

Splitting is on by default but only fires when it helps; sub-threshold and single-domain repos emit a single entry byte-identical to before. New `scan` flags: `--no-split`, `--umbrella`, `--cluster=<auto|auto-llm|llm|metadata|directory|name-prefix>`, `--llm-cmd`, `--llm-timeout`, `--out-dir`, `--write-marker`, `--interactive`, `--min-skills`. Clustering is **deterministic by default** (`metadata` `product` → directory → name-prefix); an LLM is opt-in via `--cluster=llm`/`auto-llm` with a bring-your-own subprocess command (`--llm-cmd`) or the built-in `claude` CLI, and `auto-llm` runs deterministic first with the LLM as a rescue. Every backend's output passes an acceptance gate, and stderr always states which strategy produced the split. `validate` now accepts a directory or JSON array and enforces cross-entry name uniqueness.
