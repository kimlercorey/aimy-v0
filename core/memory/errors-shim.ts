/**
 * errors-shim.ts — INTEGRATION SHIM
 *
 * The parallel substrate build owns `../substrate/errors.ts`, which does not
 * exist yet. Every shared contract error is defined here with IDENTICAL
 * names/fields so the memory library compiles and tests standalone.
 *
 * INTEGRATION STEP (when ../substrate/errors.ts lands):
 *   1. Delete the two classes below (MemoryStoreError, PermissionDenied).
 *   2. Replace this module's exports with:
 *        export { MemoryStoreError, PermissionDenied } from "../substrate/errors.js"
 *      (or point every consumer at the substrate file directly).
 *   3. Re-run `npx vitest run` from ~/workspace/aimy/core.
 *
 * Fields were copied verbatim from the shared contract:
 *   MemoryStoreError { store: string; reason: string }
 *   PermissionDenied (op + store; reason is an optional diagnostic)
 */
import { Data } from "effect"

/** Raised by MemoryService for any store-level failure. Shared contract. */
export class MemoryStoreError extends Data.TaggedError("MemoryStoreError")<{
  readonly store: string
  readonly reason: string
}> {}

/** Raised by the PermissionGate when an operation is not allowed. Shared contract. */
export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly op: "read" | "write"
  readonly store: string
  readonly reason?: string
}> {}
