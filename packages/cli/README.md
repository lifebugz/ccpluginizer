# @ccpluginizer/ccpluginizer

> CLI for pluginizing non-plugin Claude Code repos.

Generate and validate [ccpluginizer marketplace](https://github.com/lifebugz/ccpluginizer) entries from any GitHub repo with Claude Code-compatible content (skills, agents, commands, hooks, MCP servers).

## Install

Works with either runtime. Pick whichever you have.

With Bun:

```bash
bun add -g @ccpluginizer/ccpluginizer
# or one-shot:
bunx @ccpluginizer/ccpluginizer scan <owner/repo>
```

With npm or Node:

```bash
npm install -g @ccpluginizer/ccpluginizer
# or one-shot:
npx @ccpluginizer/ccpluginizer scan <owner/repo>
```

At runtime the CLI prefers Bun when it's around (it starts faster), and falls back to Node otherwise. You don't need to configure anything.

## Usage

```bash
ccpluginizer scan <owner/repo>     # Generate a marketplace entry
ccpluginizer validate <entry.json> # Validate an entry against the schema
```

To add a repo to the catalog, run `scan`, commit the JSON to `entries/<name>.json` in the catalog repo, and open a PR. See the catalog's [CONTRIBUTING.md](https://github.com/lifebugz/ccpluginizer/blob/main/CONTRIBUTING.md).

`<owner/repo>` accepts either GitHub shorthand (`elysiajs/skills`) or a full URL (`https://github.com/elysiajs/skills`).

## How it works

ccpluginizer detects skills, agents, commands, hooks, and MCP servers in the source repo, then synthesizes a marketplace entry that uses Claude Code's `strict: false` mode to point at the source. The catalog never holds a copy of the source itself.

Detection runs in three passes. The first looks at convention paths like `.claude/skills/`, `.claude/agents/`, and `.claude/commands/`. The second reads `.claude-plugin/manifest.json` or a `.ccpluginizer.json` marker file if the repo has one. The third is a heuristic fallback for repos that follow neither convention. It scans for `SKILL.md` files with YAML frontmatter, `commands/*.md`, and similar patterns.

## Repository

Source, issues, and contribution guide: https://github.com/lifebugz/ccpluginizer

## License

MIT
