/**
 * honesty/types.ts — the M3 shared type contracts.
 *
 * These shapes are a cross-track contract (Track 1 ledger, Track 2
 * executable judges, Track 3 loop wiring). Field names, tags, and literals
 * are fixed: do not rename them. Track 2 produces `JudgeVerdict`; this
 * library stores it but never mutates it (architecture §2.6 — verdicts are
 * outcome records, separate from the task lifecycle).
 *
 * M3 scope note: claims are explicit records created by the loop from tool
 * outcomes / task results — NOT parsed from prose. Prose claim-extraction is
 * a future extension (see README "Future seams").
 */

/**
 * A claim the agent made that can carry evidence. M3 scope: claims are
 * explicit records created by the loop from tool outcomes / task results —
 * NOT parsed from prose (prose claim-extraction is a future extension).
 */
export interface ClaimRecord {
  readonly claimId: string
  readonly sessionId: string
  readonly turnId: string
  readonly text: string
  readonly kind: "task-result" | "factual" | "tool-outcome"
  readonly evidenceIds: ReadonlyArray<string>
}

export interface EvidenceRecord {
  readonly evidenceId: string
  readonly kind: "tool-output" | "judge-verdict" | "source" | "state-diff"
  readonly ref: string // pointer: tool call id, verdict id, URI, or diff hash
  readonly summary: string // human-readable one-liner
  readonly recordedAt: string // ISO timestamp
}

/** Structural honesty: a claim with zero evidence is unverified by construction, not by prompt. */
export type VerificationStatus = "verified" | "unverified" | "failed"

export interface VerificationBadge {
  readonly claimId: string
  readonly status: VerificationStatus
  readonly evidence: ReadonlyArray<EvidenceRecord>
  readonly verdictIds: ReadonlyArray<string>
}

export interface JudgeVerdict {
  readonly verdictId: string
  readonly judgeId: string
  readonly judgeVersion: string // semver, pinned per task
  readonly taskId: string
  readonly verdict: "pass" | "fail"
  readonly reasons: ReadonlyArray<string>
  readonly evidenceIds: ReadonlyArray<string>
  readonly ranAt: string // ISO timestamp
}

/** Input shape for `recordClaim`: the service generates `claimId` deterministically. */
export type NewClaim = Omit<ClaimRecord, "claimId" | "evidenceIds">

/** Input shape for `attachEvidence`: the service generates `evidenceId` and `recordedAt`. */
export type NewEvidence = Omit<EvidenceRecord, "evidenceId" | "recordedAt">

/** A claim paired with its derived badge — what `claimsForTurn` returns and what the UI renders. */
export interface ClaimWithBadge {
  readonly claim: ClaimRecord
  readonly badge: VerificationBadge
}
