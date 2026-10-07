/**
 * comms/capability.ts — the TrustedBroadcastCapability seam (M7, Track 3).
 *
 * Ground truth: mvp-moscow.md "trusted broadcast" Should item — the banner
 * channel must support a `source` field distinguishing system/job/scheduler
 * origins from a future trusted-broadcast origin, WITH DIFFERENT AUDIT
 * REQUIREMENTS. The broadcast transport is later work (architecture §12
 * post-MVP #5); this module is the CHANNEL-side seam it will reuse.
 *
 * The security property is STRUCTURAL, not documentary:
 *
 * - `TrustedBroadcastCapability` is a class with a PRIVATE constructor and a
 *   private brand field (nominal typing: no plain object is assignable).
 * - This module exports the class (so it is nameable as a TYPE) but NO
 *   constructor, factory, or minting function. There is no code path in the
 *   local system that can produce an instance — the type has exactly one
 *   inhabitant source, and it does not exist yet.
 * - `publish()` (service.ts) requires `instanceof TrustedBroadcastCapability`
 *   for `source: "trusted-broadcast"`. Missing capability →
 *   `TrustedBroadcastCapabilityMissing`; a fabricated value →
 *   `TrustedBroadcastCapabilityInvalid`.
 *
 * The future vendor-network module (opt-in, off by default — architecture
 * §1.3) will hold the minting site: it receives the capability from the
 * user's explicit opt-in trust decision, and ONLY that module will gain a
 * construction path (an explicit, auditable change to this file). The local
 * system — JobRunner, scheduler, ASC diagnostics, modules — cannot forge it.
 *
 * Defense in depth: a runtime `instanceof` check backs the compile-time
 * type. Structural typing alone would let a cast object slip through; the
 * `instanceof` check fails it with a typed error instead of a silent accept.
 */

/**
 * The capability authorizing a `trusted-broadcast` banner publish.
 *
 * NOT CONSTRUCTIBLE outside this module: private constructor, no factory
 * exported. Name it only as a type (`TrustedBroadcastCapability`); the only
 * runtime value that satisfies `isTrustedBroadcastCapability` today is one
 * produced by the future vendor-network minting site (not yet written).
 */
export class TrustedBroadcastCapability {
  /** Nominal brand: private fields make the class unassignable from plain objects. */
  private readonly brand: "trusted-broadcast-capability" = "trusted-broadcast-capability"
  private constructor() {
    // Intentionally empty. The future opt-in vendor-network module gains the
    // sole minting site via an explicit, auditable change here.
  }
}

/**
 * Runtime check: is this value a genuine capability instance?
 * Backs the compile-time type so forged objects fail closed at runtime too.
 */
export const isTrustedBroadcastCapability = (value: unknown): value is TrustedBroadcastCapability =>
  value instanceof TrustedBroadcastCapability
