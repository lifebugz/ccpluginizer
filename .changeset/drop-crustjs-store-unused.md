---
"@ccpluginizer/ccpluginizer": patch
---

Remove the unused `@crustjs/store` dependency. It was never imported in `packages/cli/src/`, and its `peerDependencies.typescript: "^5"` (out of step with the rest of the `@crustjs/*` suite at `^6`) caused `bunx @ccpluginizer/ccpluginizer` to print a benign-but-noisy peer-dep warning. Dropping it silences the warning and slightly shrinks install size for end users.
