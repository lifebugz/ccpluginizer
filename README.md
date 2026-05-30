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

Install globally:

```bash
bun add -g @ccpluginizer/ccpluginizer
```

Then run:

```bash
ccpluginizer scan <owner/repo>          # Generate a marketplace entry (auto-splits bloated plugins)
ccpluginizer validate <entry|dir|array> # Validate entries against the schema (+ duplicate-name check)
```

To add a repo to this catalog, run `scan`, save the JSON to `entries/<name>.json`, and open a PR. See [CONTRIBUTING.md](./CONTRIBUTING.md).

One-shot, no install:

```bash
bunx @ccpluginizer/ccpluginizer scan <owner/repo>
```

### Splitting bloated plugins

Claude Code loads the name + description of **every** installed skill into a fixed per-session budget (~1% of the context window, ~100 tokens/skill). A plugin shipping hundreds of skills can overflow that budget on its own, silently degrading skill routing for *all* your plugins — and a plugin is all-or-nothing (`skillOverrides` doesn't apply to plugin skills).

So `scan` **splits by default, but only when it helps**. When a repo has many skills (≥25) *and* a clean partition exists, it emits several install-on-demand entries over the unmodified source instead of one:

- a shared **`<base>-core`** entry — the plugin's MCP server (inlined, ~0 always-on tokens) and agents;
- one **`<base>-<domain>`** slice per product cluster, each depending on `-core`, so installing a slice pulls the shared core in transitively and de-duplicates it.

Install only the domains you need; the skill-listing budget is charged only for those. Small or single-domain repos are unaffected — output is byte-identical to a single entry, and a one-line `stderr` notice reports whenever (and how) a split happened.

```bash
ccpluginizer scan team-telnyx/ai                 # auto-split (LLM clustering when `claude` is available, else deterministic)
ccpluginizer scan team-telnyx/ai --no-split      # force a single entry
ccpluginizer scan team-telnyx/ai --umbrella      # also emit the everything-in-one entry (reintroduces full cost)
ccpluginizer scan team-telnyx/ai --cluster=metadata   # force a clustering strategy: auto|llm|metadata|directory|name-prefix
ccpluginizer scan team-telnyx/ai --out-dir=entries    # write one JSON file per emitted entry
ccpluginizer scan team-telnyx/ai --write-marker       # freeze the grouping into .ccpluginizer.json (the re-scan contract)
```

The committed entries (or a `.ccpluginizer.json` marker) are the source of truth: CI validates them rather than re-clustering, so the split is deterministic at the artifact level even though a fresh LLM scan may vary.

**Limitations** (each is reported on `stderr` when it applies):

- A split's shared core carries the plugin's **MCP server (inlined) and agents**. Other non-skill artifacts (hooks, commands, output-styles, themes, monitors) are *not* carried by the slices — use `--umbrella` to keep them, or `--no-split` for a single entry.
- A **repo-local MCP** (a `command` referencing files inside the repo) inlines into core but its relative paths may not resolve from core's git-subdir root; remote (`http`/`sse`) and package-manager (`npx`/`uvx`) servers inline cleanly.
- `--write-marker` only persists for a **local path** source — a `github`/URL source is cloned to a discarded temp dir, so clone locally first.
- Scanning a **local path** emits placeholder `github.com/local/…` git URLs; set the real repository before publishing.

## Disclaimer

This is an independent, community-run catalog. We're not affiliated with Anthropic, Claude, or any of the listed source repositories. Source authors keep their own licenses and authorship. We provide metadata pointers, nothing else.

## License & Takedown

The metadata and tooling are MIT-licensed. See [LICENSE](./LICENSE).

If you author a listed source repository and want it removed, see [TAKEDOWN.md](./TAKEDOWN.md).
