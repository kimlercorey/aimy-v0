/**
 * @aimy/honesty — the M3 Track 1 honesty layer: the HonestyService evidence
 * ledger plus verification badges.
 *
 * `HonestyService.recordClaim` records what the agent claimed;
 * `attachEvidence` / `recordVerdict` attach the backing; `getBadge`
 * derives the claim's `VerificationBadge` — "failed" if any attached judge
 * verdict failed, "verified" if ≥1 evidence and no failures, "unverified"
 * otherwise. Badges are pure derived data; the Foldkit UI renders them in M8.
 */
export * from "./types.js"
export * from "./errors.js"
export * from "./store.js"
export * from "./service.js"
