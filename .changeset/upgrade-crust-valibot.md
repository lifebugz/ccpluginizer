---
"@ccpluginizer/ccpluginizer": patch
---

Upgrade dependencies to latest: the `@crustjs/*` CLI framework stack (`core` 0.0.16→0.0.19, `plugins` 0.0.22→0.1.2, `progress` 0.0.3→0.0.4, `prompts` 0.0.13→0.1.0, `style` 0.1.0→0.2.0) and `valibot` 1.3.1→1.4.1, plus dev tooling (`@crustjs/crust`, `eslint`, `jiti`, `typescript-eslint`, `@types/bun`). No user-facing behavior change — `scan` and `validate` produce identical output; verified by typecheck, lint, build, and the full 310-test suite.
