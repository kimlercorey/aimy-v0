/**
 * Re-export of the canonical `InferenceError` from the substrate error
 * taxonomy. The parallel-build shim was deleted at integration (2026-10-07);
 * all importers of this path now resolve to the real contract:
 * `InferenceError { provider: string; reason: string }`.
 */
export { InferenceError } from "../substrate/errors.js"
