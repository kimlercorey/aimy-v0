/**
 * Typed errors for the module-seam library.
 *
 * INTEGRATION (2026-10-07): `ModuleError`, `SandboxViolation`, and
 * `PermissionDenied` are the canonical definitions from the substrate error
 * taxonomy, re-exported here. The module-seam-local errors (HookError,
 * TurnTerminated, TrustDecisionRequired) stay defined in this file.
 *
 * NOTE: the parallel-build `PermissionDenied` shim had shape
 * `{ reason, intent? }`; the canonical contract is
 * `PermissionDenied { tool: string; tier: Tier; reason: string }`.
 * All construction sites (kernel-seam.ts, host.ts, skill-index.ts) were
 * reconciled to the canonical shape — the seam's ToolIntent already carries
 * `tool` and `tier`, so the mapping is exact, nothing invented.
 */
import { Data } from "effect"

export { ModuleError, SandboxViolation, PermissionDenied } from "../../substrate/errors.js"

/** A lifecycle hook misbehaved. Hook boundaries never throw: defects become this. */
export class HookError extends Data.TaggedError("HookError")<{
  readonly hook: string
  readonly module?: string
  readonly reason: string
}> {}

/**
 * A denied tool call terminated the turn (deny with terminate semantics).
 * Implies the call was BLOCKED (it never ran); the turn ends here.
 */
export class TurnTerminated extends Data.TaggedError("TurnTerminated")<{
  readonly reason: string
  readonly toolCallId?: string
}> {}

/** An update widened the capability manifest without a covering trust decision. */
export class TrustDecisionRequired extends Data.TaggedError("TrustDecisionRequired")<{
  readonly module: string
  readonly widened: ReadonlyArray<string>
  readonly reason: string
}> {}
