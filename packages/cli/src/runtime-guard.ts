// First-import runtime gate. Imported as the very first statement of index.ts so
// it evaluates before any @crustjs/* module (ESM evaluates imports depth-first in
// source order). Refuses with a clear two-path signpost; it does NOT polyfill.
//
// Defensive by design: all crust Bun.* usage is currently call-time, so there is
// no import-time invocation to catch yet — running first guards against a future
// dependency that touches Bun.* at module top level (which would otherwise run
// before a body-level check).
import { isSupportedRuntime, RUNTIME_GUARD_MESSAGE } from "./runtime-guard-check.ts";

if (!isSupportedRuntime()) {
  console.error(RUNTIME_GUARD_MESSAGE);
  process.exit(1);
}
