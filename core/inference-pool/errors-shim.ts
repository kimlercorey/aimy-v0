/**
 * errors-shim.ts — TEMPORARY SHIM (parallel build).
 *
 * The substrate library (`../substrate/errors.ts`) has not landed yet, so this
 * file provides the shared `InferenceError` contract locally. Name and fields
 * are IDENTICAL to the contract so the swap is mechanical:
 *
 *   contract: `InferenceError { provider: string; reason: string }`
 *
 * When `../substrate/errors.ts` exists, delete this file and change the
 * imports in `provider.ts`, `pool.ts`, and `local-stub.ts` to:
 *
 *   import { InferenceError } from "../substrate/errors.js"
 *
 * Nothing else in this package may change.
 */
import { Data } from "effect"

export class InferenceError extends Data.TaggedError("InferenceError")<{
  readonly provider: string
  readonly reason: string
}> {}
