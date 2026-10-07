/**
 * substrate/errors.ts
 *
 * The shared typed-error taxonomy for Project AImy.
 *
 * Contract: every error is an Effect `Data.TaggedError` and is NEVER thrown
 * across library boundaries (architecture §1.4 — Pi's "must never throw"
 * rule adopted as a general contract). Error names and fields are a
 * cross-library contract: do not rename them.
 */
import { Data } from "effect"

/** Permission tiers for the SafetyKernel's per-tool allow/ask/deny gates (never binary auth). */
export type Tier = "T0" | "T1" | "T2" | "T3"

/** A tool call was refused by the permission gate. Denial kills the intent, not the call. */
export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly tool: string
  readonly tier: Tier
  readonly reason: string
}> {}

/** A sandbox backend or membrane refused an action (fail-closed). */
export class SandboxViolation extends Data.TaggedError("SandboxViolation")<{
  readonly reason: string
  readonly backend?: string
}> {}

/** A memory store operation failed (session tree, profile, skill, graph, ...). */
export class MemoryStoreError extends Data.TaggedError("MemoryStoreError")<{
  readonly store: string
  readonly reason: string
}> {}

/** An inference provider/endpoint operation failed. */
export class InferenceError extends Data.TaggedError("InferenceError")<{
  readonly provider: string
  readonly reason: string
}> {}

/** A one-click export step failed. Secrets are never part of export payloads. */
export class ExportError extends Data.TaggedError("ExportError")<{
  readonly reason: string
}> {}

/** Config resolution or validation failed. */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string
}> {}

/** Install identity / keying operation failed. */
export class IdentityError extends Data.TaggedError("IdentityError")<{
  readonly reason: string
}> {}

/** A module lifecycle operation failed (install/enable/update/remove/hook dispatch). */
export class ModuleError extends Data.TaggedError("ModuleError")<{
  readonly module: string
  readonly reason: string
}> {}

/** An ASC engine operation failed (dial computation, guard, audit, ...). */
export class AscError extends Data.TaggedError("AscError")<{
  readonly reason: string
}> {}

/** The union of every typed error in the system. Catch sites should handle this. */
export type AimyError =
  | PermissionDenied
  | SandboxViolation
  | MemoryStoreError
  | InferenceError
  | ExportError
  | ConfigError
  | IdentityError
  | ModuleError
  | AscError
