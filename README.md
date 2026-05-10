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
ccpluginizer scan <owner/repo>     # Generate a marketplace entry
ccpluginizer validate <entry.json> # Validate an entry against the schema
```

To add a repo to this catalog, run `scan`, save the JSON to `entries/<name>.json`, and open a PR. See [CONTRIBUTING.md](./CONTRIBUTING.md).

One-shot, no install:

```bash
bunx @ccpluginizer/ccpluginizer scan <owner/repo>
```

## Disclaimer

This is an independent, community-run catalog. We're not affiliated with Anthropic, Claude, or any of the listed source repositories. Source authors keep their own licenses and authorship. We provide metadata pointers, nothing else.

## License & Takedown

The metadata and tooling are MIT-licensed. See [LICENSE](./LICENSE).

If you author a listed source repository and want it removed, see [TAKEDOWN.md](./TAKEDOWN.md).
