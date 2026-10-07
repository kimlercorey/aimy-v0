/**
 * @aimy/learning — M6 learning loop library.
 *
 * Track 2 (verification arm + quarantine → evidence gate → trusted + curator):
 * - `quarantine.ts`: structural holding state for new/modified skills —
 *   T0-observed sandboxed runs only, never live, never auto-invoked.
 * - `arm.ts`: the independent verification arm — generated tests, evals,
 *   second-model critic, all executable through the honesty judges
 *   framework. Mints `VerifiedReport` (brand) only on passing reports with
 *   executable evidence per mechanism.
 * - `gate.ts`: the evidence gate — quarantined → trusted ONLY on a
 *   `VerifiedReport`. Prompt-only promotion is a type error.
 * - `curator.ts`: deterministic lifecycle (active → stale → archived, never
 *   delete; pinned/cron-referenced bypass) + LLM-proposes/evidence-disposes
 *   consolidation requiring verified absorption.
 *
 * Track 3 (timeline + fossilization guard):
 * - `timeline.ts`: every learning event is a node (content-fingerprinted id,
 *   provenance, evidence links); append-only; delete archives, never destroys.
 *   The `LearningEvent` union is the wire contract Track 2's pipeline emits.
 * - `fossilization.ts`: transient failures must never become permanent
 *   avoidance (Hermes #6051). Avoidances are time-bounded, versioned, carry
 *   their failure context, and are re-tested against current environment
 *   state on expiry or on demand.
 *
 * Track 1 (background-review forks + unattended-write safety):
 * - `snapshot.ts`: immutable conversation snapshots + compact digests.
 * - `provenance.ts`: write provenance; unattributed writes are rejected.
 * - `prompts.ts`: the review prompt (our own words, from the failure
 *   taxonomy) + the JSON-lines proposal parser.
 * - `review-types.ts`: shared Track 1 types (proposals, dispositions,
 *   fork outcomes, cancel acks, config).
 * - `writes.ts`: `UnattendedWriteGate` (add-only unattended; replace/remove
 *   stage for approval, fail-closed) + the `PendingStore`.
 * - `forks.ts`: `ReviewForks` — supervised review fibers, dispatch
 *   whitelist toolset, aux-model routing, bounded-cancel handshake.
 * - `scheduling.ts`: `ReviewScheduler` — idle-gated queue (settle window,
 *   max age, one slot per session, newest-snapshot-wins); explicit
 *   refinement never defers. `IdleSignal` is injectable.
 */
export * from "./errors.js"
export * from "./timeline.js"
export * from "./fossilization.js"
export * from "./types.js"
export * from "./quarantine.js"
export * from "./arm.js"
export * from "./gate.js"
export * from "./curator.js"
export * from "./provenance.js"
export * from "./snapshot.js"
export * from "./prompts.js"
export * from "./review-types.js"
export * from "./writes.js"
export * from "./forks.js"
export * from "./scheduling.js"
