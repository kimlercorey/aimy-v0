/**
 * Typed errors for the module-seam library.
 *
 * SHIM NOTE (integration): `ModuleError`, `SandboxViolation`, and
 * `PermissionDenied` are specified to live in `../substrate/errors.ts`.
 * The substrate library has not landed yet, so they are defined HERE with
 * exactly the contracted shapes:
 *
 *   ModuleError      { module: string; reason: string }
 *   SandboxViolation { reason: string; backend?: string }
 *   PermissionDenied { reason: string; intent?: string }   (shape chosen by module-seam)
 *
 * When substrate lands, replace the three classes below with:
 *
 *   export { ModuleError, SandboxViolation, PermissionDenied } from "../substrate/errors.ts"
 *
 * and keep the module-seam-local errors (HookError, TurnTerminated,
 * TrustDecisionRequired) defined here.
 */
import { Data } from "effect"

/** A module failed in a typed, reportable way (bad manifest, bad transition, missing module, ...). */
export class ModuleError extends Data.TaggedError("ModuleError")<{
  readonly module: string
  readonly reason: string
}> {}

/** A sandbox backend refused to run something, or reported unhealthy. Fail-closed signal. */
export class SandboxViolation extends Data.TaggedError("SandboxViolation")<{
  readonly reason: string
  readonly backend?: string
}> {}

/** A capability or gate decision denied an intent. Undeclared capabilities always land here. */
export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly reason: string
  readonly intent?: string
}> {}

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
