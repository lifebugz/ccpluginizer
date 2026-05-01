# ccpluginizer

> Pluginize non-plugin Claude Code resources.

ccpluginizer makes any non-plugin GitHub repo containing Claude Code-compatible content (skills, agents, commands, hooks, MCP servers) installable as a Claude Code plugin — without modifying the source repo and without redistributing source code.

## Install

```bash
claude /plugin marketplace add ccpluginizer/marketplace
claude /plugin install <plugin-name>@ccpluginizer
```

## Browse

See [`entries/`](./entries) for the full catalog.

## How it works

Every entry in our `marketplace.json` uses Claude Code's `strict: false` mode to point at a source repo and declare which paths within it are skills, agents, etc. Claude Code clones the source directly into your plugin cache at install time. We never copy or redistribute source code.

Auto-update is native: every commit to a source repo's default branch becomes a new plugin version automatically (we omit explicit `version` fields, so Claude Code falls through to git commit-SHA versioning).

## CLI

```bash
bunx ccpluginizer scan <owner/repo>     # Generate a marketplace entry
bunx ccpluginizer submit <owner/repo>   # Open a PR to add the repo to this catalog
bunx ccpluginizer validate <entry.json> # Validate an entry against the schema
```

## Disclaimer

This is an independent, community-run catalog. ccpluginizer is **not affiliated with Anthropic, Claude, or any of the source repositories listed**. Source repositories retain their own licenses and authorship; ccpluginizer provides only metadata pointers.

## License & Takedown

ccpluginizer's metadata and tooling are MIT-licensed. See [LICENSE](./LICENSE).

If you are an author of a listed source repository and want it removed, see [TAKEDOWN.md](./TAKEDOWN.md).
