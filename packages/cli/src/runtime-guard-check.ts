// Pure, side-effect-free runtime detection for this Bun-only CLI. Extracted from
// the side-effect guard (runtime-guard.ts) so all three branches — no Bun, Bun
// without Bun.color (i.e. Bun <1.2), and a satisfactory Bun — are unit-testable
// without spawning a foreign runtime. Does only `typeof` checks; it never
// *invokes* Bun.color (the `&&` short-circuits before the `.color` access when
// the Bun global is absent).

/**
 * The two-path signpost printed when the host can't run this CLI. MUST stay
 * textually identical to the no-Bun branch of `bin/ccpz`.
 */
export const RUNTIME_GUARD_MESSAGE = `ccpz runs on Bun or as a standalone binary.
  • Install Bun:    curl -fsSL https://bun.sh/install | bash   then re-run
  • Or download a native binary: https://github.com/lifebugz/ccpluginizer/releases`;

/** True only on Bun >=1.2 — feature-detected via the presence of `Bun.color`. */
export function isSupportedRuntime(globalObj: typeof globalThis = globalThis): boolean {
  const bun = (globalObj as { Bun?: { color?: unknown } }).Bun;
  return typeof bun !== "undefined" && typeof bun.color === "function";
}
