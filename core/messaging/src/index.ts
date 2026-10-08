/**
 * @aimy/messaging — the messaging gateway core (spec: planning/messaging-gateway-spec.md).
 *
 * Phase 1: channel seam, pairing registry (single-chat policy), forwarding
 * prefs. No platform code here — channels (telegram, …) implement `Channel`
 * and never decide trust; the gateway core does.
 *
 * Seams:
 * - Channel (types.ts) — telegram first; more channels without touching this file.
 * - PairingRegistry (pairing.ts) — file-backed (0600); codes memory-only (fail-closed on restart).
 */
export * from "./errors.js"
export * from "./types.js"
export * from "./pairing.js"
export * from "./dispatch.js"
export * from "./forward.js"
export * from "./ratelimit.js"
