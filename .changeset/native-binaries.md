---
"@ccpluginizer/ccpluginizer": patch
---

Native binaries: a `release-binaries.yml` workflow now cross-builds self-contained
executables for macOS (arm64), Linux (x64/arm64), and Windows (x64) and uploads
them to each GitHub Release. The package README documents the downloads and the
unsigned-binary (Gatekeeper/SmartScreen) caveats. No change to the published JS bundle.
