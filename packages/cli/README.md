# @ccpluginizer/ccpz

> CLI for pluginizing non-plugin Claude Code repos.

Generate and validate [ccpluginizer marketplace](https://github.com/lifebugz/ccpluginizer) entries from any GitHub repo with Claude Code-compatible content (skills, agents, commands, hooks, MCP servers).

## Install

ccpluginizer is **Bun-first**. Two co-equal ways to run it — pick whichever fits.

### Bun (light)

```bash
bun add -g @ccpluginizer/ccpz
# or one-shot, no install:
bunx @ccpluginizer/ccpz scan <owner/repo>
```

Don't have Bun? `curl -fsSL https://bun.sh/install | bash`.

### Native binary (self-contained)

Download the binary for your platform from
[GitHub Releases](https://github.com/lifebugz/ccpluginizer/releases) — no runtime
required (the Bun runtime is embedded; ~60 MB):

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | `ccpz-darwin-arm64` |
| Linux x64 | `ccpz-linux-x64` |
| Linux arm64 | `ccpz-linux-arm64` |
| Windows x64 | `ccpz-windows-x64.exe` |

```bash
# macOS / Linux — mark executable, then run:
chmod +x ccpz-<os>-<arch>
# macOS only: clear the Gatekeeper quarantine flag first (see the macOS note below)
./ccpz-<os>-<arch> scan <owner/repo>

# Windows (PowerShell or cmd) — run the .exe directly:
.\ccpz-windows-x64.exe scan <owner/repo>
```

> **macOS:** the binaries are unsigned, so Gatekeeper quarantines them. Clear it
> before running: `xattr -c ./ccpz-darwin-arm64`.
> **Windows:** the unsigned `.exe` triggers SmartScreen — choose *More info →
> Run anyway*.

> **Windows:** ccpluginizer's `bin/ccpz` launcher is a POSIX shell script
> that doesn't run natively on Windows, so prefer this native binary over the Bun path.

> **Node is not supported.** The CLI uses Bun-native APIs; running it under
> `npm`/`npx` (Node) refuses to start with a pointer to the two paths above.

## Usage

```bash
ccpz scan <owner/repo>     # Generate a marketplace entry
ccpz validate <entry.json> # Validate an entry against the schema
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
