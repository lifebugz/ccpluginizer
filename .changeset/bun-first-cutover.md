---
"@ccpluginizer/ccpluginizer": minor
---

BREAKING: Node is no longer a supported runtime. Run ccpluginizer under Bun
(`bunx @ccpluginizer/ccpluginizer …` or `bun add -g`) or download a native
binary from GitHub Releases. The CLI now builds with `--target bun`, requires
`bun >=1.2.0`, and a first-import runtime guard refuses to start on Node or Bun
<1.2 with a pointer to both supported paths.
