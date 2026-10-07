/**
 * Re-export of the canonical `AscError` from the substrate error taxonomy.
 * The parallel-build shim was deleted at integration (2026-10-07); the
 * `ascError` convenience constructor is kept here because it is used by
 * `seams.ts` and the pipeline tests.
 *
 * Contract: `AscError { reason: string }`.
 */
export { AscError } from "../substrate/errors.js"
import { AscError } from "../substrate/errors.js"

/** Convenience constructor: `ascError("...")`. */
export const ascError = (reason: string): AscError => new AscError({ reason })
