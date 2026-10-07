import { Data } from "effect"

/**
 * SHIM — identical stand-in for the canonical `AscError` defined in
 * `../substrate/errors.ts` (`AscError { reason: string }`).
 *
 * The substrate coordinator owns the canonical definition, which does not
 * exist yet (substrate/ is empty as of 2026-10-07). Until it lands:
 *  - this file carries the identical shape so asc-engine compiles and runs,
 *  - every import is local to `./errors-shim.js`,
 *  - at integration, delete this file and repoint imports to
 *    `../substrate/errors.js` — no behavioral change is expected because the
 *    shape is identical by construction.
 */
export class AscError extends Data.TaggedError("AscError")<{
  readonly reason: string
}> {}

/** Convenience constructor: `ascError("...")`. */
export const ascError = (reason: string): AscError => new AscError({ reason })
