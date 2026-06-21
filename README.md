# ccpluginizer

> Pluginize non-plugin Claude Code resources.

ccpluginizer makes any GitHub repo with Claude Code-compatible content (skills, agents, commands, hooks, MCP servers) installable as a Claude Code plugin. The source repo doesn't get modified, and no source code lives in our catalog.

## Install

```bash
claude plugin marketplace add lifebugz/ccpluginizer
claude plugin install <plugin-name>@ccp-marketplace
```

## Browse

The catalog lives in [`entries/`](./entries), one JSON file per pluginized repo.

## How it works

Every entry in `marketplace.json` uses Claude Code's `strict: false` mode. The entry points at a source repo and lists which paths inside it are skills, agents, and so on. When you install, Claude Code clones the source directly into your plugin cache. The catalog itself never holds the code.

Auto-update happens for free. Entries omit `version` fields, so Claude Code falls back to git commit-SHA versioning. Every push to a source repo's default branch is a new plugin version on its own.

## CLI

ccpluginizer is **Bun-first**, with two co-equal install paths:

```bash
# Bun (light):
bun add -g @ccpluginizer/ccpz            # global
bunx @ccpluginizer/ccpz scan <owner/repo> # one-shot, no install

# Native binary (self-contained, no runtime needed):
# download ccpluginizer-<os>-<arch> from https://github.com/lifebugz/ccpluginizer/releases
# (unsigned: macOS `xattr -c ./ccpluginizer-<os>-<arch>`, Windows SmartScreen "Run anyway")
```

**Windows** users should use the `windows-x64` native binary (ccpluginizer's
`bin/ccpluginizer` launcher is a POSIX shell script that doesn't run natively on
Windows). **Node is not supported** — the CLI uses Bun-native APIs.

Then run:

```bash
ccpz scan <owner/repo>          # Generate a marketplace entry (auto-splits bloated plugins)
ccpz validate <entry|dir|array> # Validate entries against the schema (+ duplicate-name check)
```

To add a repo to this catalog, run `scan --out-dir entries` (one JSON file per emitted entry; a single un-split scan can also be saved as `entries/<name>.json`) and open a PR. See [CONTRIBUTING.md](./CONTRIBUTING.md).

### Splitting bloated plugins

Claude Code loads the name + description of **every** installed skill into a fixed per-session budget (~1% of the context window, ~100 tokens/skill). A plugin shipping hundreds of skills can overflow that budget on its own, silently degrading skill routing for *all* your plugins — and a plugin is all-or-nothing (`skillOverrides` doesn't apply to plugin skills).

So `scan` **splits by default, but only when it helps**. When a repo has many skills (≥25) *and* a clean partition exists, it emits several install-on-demand entries over the unmodified source instead of one:

- a shared **`<base>-core`** entry — the plugin's MCP server (inlined, ~0 always-on tokens) and agents;
- one **`<base>-<domain>`** slice per product cluster, each depending on `-core`, so installing a slice pulls the shared core in transitively and de-duplicates it.

Install only the domains you need; the skill-listing budget is charged only for those. Small or single-domain repos are unaffected — output stays a single entry, identical to before apart from deterministic path ordering (sniff-detected paths are now emitted sorted) and stricter-parser fixes (skills/agents with BOM/CRLF or numeric frontmatter that older versions wrongly dropped are now detected), and a one-line `stderr` notice reports whenever (and how) a split happened.

```bash
ccpz scan team-telnyx/ai                 # auto-split (deterministic, offline — no LLM)
ccpz scan team-telnyx/ai --no-split      # force a single entry
ccpz scan team-telnyx/ai --umbrella      # also emit the everything-in-one entry (reintroduces full cost)
ccpz scan team-telnyx/ai --cluster=auto-llm --llm-cmd "ollama run llama3"   # deterministic first, LLM only if no clean partition
ccpz scan team-telnyx/ai --cluster=llm   --llm-cmd "llm -m gpt-4o-mini"     # LLM-first (deterministic fallback)
ccpz scan team-telnyx/ai --out-dir=entries    # write one JSON file per emitted entry
ccpz scan team-telnyx/ai --cluster=auto-llm --write-marker   # freeze the emitted grouping into .ccpluginizer.json
```

**Clustering strategies.** `--cluster` selects how skills are grouped:

- `auto` (default) — deterministic only (`metadata` → `directory` → `name-prefix`). No subprocess, no network; identical output for every user, even with an LLM configured. This is the reproducible path and needs no LLM.
- `auto-llm` (**recommended when you have an LLM**) — deterministic first; the LLM is invoked *only* for repos the heuristics can't partition cleanly. Well-named repos stay byte-reproducible (the LLM is never touched); the messy minority gets rescued. Freeze the rescue with `--cluster=auto-llm --write-marker` + commit to make the whole repo reproducible thereafter.
- `llm` — LLM-first: prefer the model's grouping, fall back to deterministic if it produces nothing acceptable.
- `metadata` / `directory` / `name-prefix` — force one deterministic strategy.

**Bring your own LLM.** `--cluster=llm`/`auto-llm` resolve a backend by precedence: an explicit subprocess command (`--llm-cmd`, or the `CCPLUGINIZER_LLM_CMD` env var) → the `claude` CLI if on PATH → none. A subprocess backend reads the clustering prompt on **stdin** and writes a JSON array `[{"slug","members":[...]}]` to **stdout**, so any tool fits: `--llm-cmd "ollama run llama3"`, `--llm-cmd "llm -m gpt-4o-mini"`, `--llm-cmd "claude -p"`, `--llm-cmd "./my-grouper.sh"`, or an OpenAI-compatible one-liner `--llm-cmd 'curl -s https://api.openai.com/v1/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY" -d @- | jq ...'`. Tune the per-call ceiling with `--llm-timeout <seconds>` or the `CCPLUGINIZER_LLM_TIMEOUT` env var (flag wins; default 120). Whatever a backend returns passes the same acceptance gate as everything else, so a weak or garbled model can never emit a broken split — it is rejected and the tool falls back. A native HTTP (`--llm-url`) backend is **deferred** to a later minor (see the design spec's Non-goals).

**Reproducibility for LLM users:** `--write-marker` + commit. It freezes whatever was *emitted* — a deterministic win (including `auto-llm`'s), the accepted LLM grouping, or the deterministic fallback when the model's output was rejected — into `.ccpluginizer.json`. A committed marker grouping always wins verbatim, so every later scan (LLM-less collaborators and CI included) reproduces that exact split.

**Security boundary.** Under `--cluster=llm`/`auto-llm`, `--llm-cmd`/`CCPLUGINIZER_LLM_CMD` is **shell-executed** — do not auto-load it from untrusted repos (`direnv`/`.envrc`). A secret **inlined** into the command is echoed verbatim to stderr (and CI logs) by the provenance notice, so pass keys via an env var the child expands (`$OPENAI_API_KEY`), never as a literal. The skills prompt (dir names + truncated descriptions) **leaves the machine** to whatever the command contacts.

**Limitations** (each is reported on `stderr` when it applies):

- A split's shared core carries the plugin's **MCP server (inlined) and agents**. Other non-skill artifacts (hooks, commands, output-styles, themes, monitors) are *not* carried by the slices — use `--umbrella` to keep them, or `--no-split` for a single entry.
- A **repo-local MCP** (a `command` referencing files inside the repo) inlines into core but its relative paths may not resolve from core's git-subdir root; remote (`http`/`sse`) and package-manager (`npx`/`uvx`) servers inline cleanly.
- `--write-marker` only persists for a **local path** source — a `github`/URL source is cloned to a discarded temp dir, so clone locally first.
- Scanning a **local path** emits placeholder `github.com/local/…` git URLs; set the real repository before publishing.
- A repo that **already publishes a marketplace** (`.claude-plugin/marketplace.json`) still aborts on the single-entry path, but a firing split now *re-curates* it (with a warning) instead of aborting — install via `/plugin marketplace add` if you just want the existing catalog.

## Disclaimer

This is an independent, community-run catalog. We're not affiliated with Anthropic, Claude, or any of the listed source repositories. Source authors keep their own licenses and authorship. We provide metadata pointers, nothing else.

## License & Takedown

The metadata and tooling are MIT-licensed. See [LICENSE](./LICENSE).

If you author a listed source repository and want it removed, see [TAKEDOWN.md](./TAKEDOWN.md).
