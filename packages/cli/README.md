# @ccpluginizer/ccpluginizer

> CLI for pluginizing non-plugin Claude Code repos.

Generate, validate, and submit [ccpluginizer marketplace](https://github.com/lifebugz/ccpluginizer) entries from any GitHub repo containing Claude Code-compatible content (skills, agents, commands, hooks, MCP servers).

## Install

Works with either runtime — pick whichever you have.

**With Bun:**

```bash
bun add -g @ccpluginizer/ccpluginizer
# or one-shot:
bunx @ccpluginizer/ccpluginizer scan <owner/repo>
```

**With npm / Node:**

```bash
npm install -g @ccpluginizer/ccpluginizer
# or one-shot:
npx @ccpluginizer/ccpluginizer scan <owner/repo>
```

The CLI prefers Bun at runtime if available (faster startup) and falls back to Node otherwise. Either works; no configuration needed.

## Usage

```bash
ccpluginizer scan <owner/repo>     # Generate a marketplace entry
ccpluginizer submit <owner/repo>   # Open a PR to add the repo to the catalog
ccpluginizer validate <entry.json> # Validate an entry against the schema
```

`<owner/repo>` accepts either GitHub shorthand (`elysiajs/skills`) or a full URL (`https://github.com/elysiajs/skills`).

## How it works

ccpluginizer detects skills, agents, commands, hooks, and MCP servers in the source repo, then synthesizes a marketplace entry that uses Claude Code's `strict: false` mode to point at the source. Source code is never copied or redistributed.

Three detection layers:

1. **Convention paths** — `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, etc.
2. **Manifest metadata** — `.claude-plugin/manifest.json` or `.ccpluginizer.json` marker file.
3. **Heuristic fallback** — looks for `SKILL.md` files with YAML frontmatter, `commands/*.md`, etc.

## Repository

Source, issues, and contribution guide: https://github.com/lifebugz/ccpluginizer

## License

MIT
