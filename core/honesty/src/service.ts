/**
 * honesty/service.ts — HonestyService, the verification-evidence ledger.
 *
 * Architecture §2.6 / §12 (M3): the honesty/validation layer's evidence
 * ledger, the structural counterpart to the Track 2 executable judges.
 * MUST #11 (mvp-moscow.md): verification evidence attaches to claims; a
 * claim without judge-grade evidence is an *unverified* claim, labeled as
 * such — by construction, not by prompt.
 *
 * The structural honesty guarantee: `VerificationBadge`s are pure derived
 * data. The only badge constructor in the codebase is the module-private
 * `deriveBadge` below; the public API exposes no way to mint a badge with
 * an arbitrary status. A claim with zero evidence therefore *cannot* be
 * "verified" through this API — the type simply has no path to it.
 *
 * Verdicts are outcome records (architecture §2.6, Hermes #68499): the
 * service stores them, deep-copied and frozen, and NEVER mutates them.
 * Recording an existing verdictId is a no-op success (idempotent); the
 * first write wins.
 *
 * Verdicts attach to claims through evidence: a verdict is recorded with
 * `recordVerdict`, then linked to a claim via `attachEvidence` with
 * `kind: "judge-verdict"` and `ref: <verdictId>`. The badge derivation
 * resolves those refs and forces status "failed" when any attached verdict
 * failed.
 */
import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import {
  ClaimNotFound,
  EvidenceNotFound,
  InvalidVerdict,
  VerdictNotFound,
  type HonestyError,
} from "./errors.js"
import { InMemoryLedgerStore, LedgerStore, type LedgerStoreShape } from "./store.js"
import type {
  ClaimRecord,
  ClaimWithBadge,
  EvidenceRecord,
  JudgeVerdict,
  NewClaim,
  NewEvidence,
  VerificationBadge,
  VerificationStatus,
} from "./types.js"

/** The service interface. */
export interface HonestyServiceShape {
  /** Record a claim. Idempotent: the claimId is deterministic, so re-recording returns the existing record. */
  readonly recordClaim: (claim: NewClaim) => Effect.Effect<ClaimRecord, HonestyError>
  /** Attach one evidence record to a claim. `judge-verdict` refs must name a recorded verdict. */
  readonly attachEvidence: (
    claimId: string,
    evidence: NewEvidence,
  ) => Effect.Effect<EvidenceRecord, HonestyError>
  /** Store a judge verdict (outcome record). Never mutates; re-recording a verdictId is a no-op success. */
  readonly recordVerdict: (verdict: JudgeVerdict) => Effect.Effect<void, HonestyError>
  /** Read back a stored verdict (outcome records are readable, never writable). */
  readonly getVerdict: (verdictId: string) => Effect.Effect<JudgeVerdict, HonestyError>
  /** Derive the claim's badge: failed | verified | unverified. See `deriveBadge`. */
  readonly getBadge: (claimId: string) => Effect.Effect<VerificationBadge, HonestyError>
  /** "What evidence backs claim X?" — exactly the attached set, in attach order. */
  readonly evidenceFor: (claimId: string) => Effect.Effect<ReadonlyArray<EvidenceRecord>, HonestyError>
  /** All claims for a turn, each paired with its derived badge (what the UI renders). */
  readonly claimsForTurn: (
    sessionId: string,
    turnId: string,
  ) => Effect.Effect<ReadonlyArray<ClaimWithBadge>, HonestyError>
}

export class HonestyService extends Context.Service<HonestyService, HonestyServiceShape>()(
  "aimy/honesty/HonestyService",
) {}

// ---------------------------------------------------------------------------
// Deterministic IDs — SHA-256 hex over canonical JSON. No randomness, no
// wall-clock inside ID generation; timestamps live only in `recordedAt`.
// ---------------------------------------------------------------------------

/** Canonical JSON: object keys sorted recursively, so equal values hash equal. */
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`
}

const sha256hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

/** claimId: deterministic in (sessionId, turnId, text) — re-recording is idempotent by construction. */
const claimIdFor = (claim: NewClaim): string =>
  sha256hex(canonicalize({ sessionId: claim.sessionId, turnId: claim.turnId, text: claim.text }))

/** evidenceId: deterministic in (claimId, per-claim sequence, kind, ref, summary). */
const evidenceIdFor = (
  claimId: string,
  seq: number,
  evidence: NewEvidence,
): string =>
  sha256hex(
    canonicalize({ claimId, seq, kind: evidence.kind, ref: evidence.ref, summary: evidence.summary }),
  )

// ---------------------------------------------------------------------------
// Badge derivation — the single, private badge constructor.
// ---------------------------------------------------------------------------

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * The structural honesty rule, in one place:
 *   - any attached verdict with verdict "fail"  → "failed"
 *   - otherwise, ≥1 evidence record             → "verified"
 *   - otherwise (zero evidence)                 → "unverified"
 *
 * A failed verdict dominates: even a claim with abundant other evidence is
 * "failed" once a judge says fail. A passed verdict changes nothing beyond
 * what the evidence already establishes — "verified" requires evidence.
 */
const deriveStatus = (
  evidence: ReadonlyArray<EvidenceRecord>,
  verdicts: ReadonlyArray<JudgeVerdict>,
): VerificationStatus =>
  verdicts.some((v) => v.verdict === "fail")
    ? "failed"
    : evidence.length > 0
      ? "verified"
      : "unverified"

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const HonestyServiceLive: Layer.Layer<HonestyService, never, LedgerStore> = Layer.effect(
  HonestyService,
  Effect.gen(function* () {
    const store: LedgerStoreShape = yield* LedgerStore

    const requireClaim = (claimId: string): Effect.Effect<ClaimRecord, HonestyError> =>
      Effect.gen(function* () {
        const claim = yield* store.getClaim(claimId)
        if (claim === undefined) return yield* Effect.fail(new ClaimNotFound({ claimId }))
        return claim
      })

    const resolveEvidence = (
      claim: ClaimRecord,
    ): Effect.Effect<ReadonlyArray<EvidenceRecord>, HonestyError> =>
      Effect.gen(function* () {
        const out: Array<EvidenceRecord> = []
        for (const evidenceId of claim.evidenceIds) {
          const record = yield* store.getEvidence(evidenceId)
          if (record === undefined) {
            // Cannot happen through the public API (attachEvidence always
            // writes the record before linking it), but a foreign store
            // implementation must not produce a badge over dangling refs.
            return yield* Effect.fail(new EvidenceNotFound({ evidenceId }))
          }
          out.push(record)
        }
        return out as ReadonlyArray<EvidenceRecord>
      })

    const resolveVerdicts = (
      evidence: ReadonlyArray<EvidenceRecord>,
    ): Effect.Effect<ReadonlyArray<JudgeVerdict>, HonestyError> =>
      Effect.gen(function* () {
        const out: Array<JudgeVerdict> = []
        for (const record of evidence) {
          if (record.kind !== "judge-verdict") continue
          const verdict = yield* store.getVerdict(record.ref)
          if (verdict === undefined) return yield* Effect.fail(new VerdictNotFound({ verdictId: record.ref }))
          out.push(verdict)
        }
        return out as ReadonlyArray<JudgeVerdict>
      })

    const buildBadge = (
      claim: ClaimRecord,
    ): Effect.Effect<VerificationBadge, HonestyError> =>
      Effect.gen(function* () {
        const evidence = yield* resolveEvidence(claim)
        const verdicts = yield* resolveVerdicts(evidence)
        const verdictIds = evidence
          .filter((e) => e.kind === "judge-verdict")
          .map((e) => e.ref)
        // `deriveStatus` is the ONLY badge constructor: a "verified" badge
        // for an evidence-less claim is unrepresentable through this API.
        return {
          claimId: claim.claimId,
          status: deriveStatus(evidence, verdicts),
          evidence,
          verdictIds,
        } satisfies VerificationBadge
      })

    const recordClaim: HonestyServiceShape["recordClaim"] = (claim) =>
      Effect.gen(function* () {
        const claimId = claimIdFor(claim)
        const existing = yield* store.getClaim(claimId)
        if (existing !== undefined) return existing // idempotent re-record
        const record: ClaimRecord = { ...claim, claimId, evidenceIds: [] }
        yield* store.putClaim(record)
        return record
      })

    const attachEvidence: HonestyServiceShape["attachEvidence"] = (claimId, evidence) =>
      Effect.gen(function* () {
        const claim = yield* requireClaim(claimId)
        if (evidence.kind === "judge-verdict") {
          // A verdict reference must name a verdict this ledger actually
          // holds — badges never resolve dangling refs.
          const verdict = yield* store.getVerdict(evidence.ref)
          if (verdict === undefined) {
            return yield* Effect.fail(new VerdictNotFound({ verdictId: evidence.ref }))
          }
        }
        const record: EvidenceRecord = {
          ...evidence,
          evidenceId: evidenceIdFor(claimId, claim.evidenceIds.length, evidence),
          recordedAt: new Date().toISOString(),
        }
        yield* store.putEvidence(record)
        const updated: ClaimRecord = {
          ...claim,
          evidenceIds: [...claim.evidenceIds, record.evidenceId],
        }
        yield* store.putClaim(updated)
        return record
      })

    const recordVerdict: HonestyServiceShape["recordVerdict"] = (verdict) =>
      Effect.gen(function* () {
        if (!SEMVER_RE.test(verdict.judgeVersion)) {
          return yield* Effect.fail(
            new InvalidVerdict({
              verdictId: verdict.verdictId,
              reason: `judgeVersion is not semver: ${verdict.judgeVersion}`,
            }),
          )
        }
        // The store freezes a deep copy on first write and ignores later
        // writes to the same verdictId: verdicts are never mutated.
        yield* store.putVerdict(verdict)
      })

    const getVerdict: HonestyServiceShape["getVerdict"] = (verdictId) =>
      Effect.gen(function* () {
        const verdict = yield* store.getVerdict(verdictId)
        if (verdict === undefined) return yield* Effect.fail(new VerdictNotFound({ verdictId }))
        return verdict
      })

    const getBadge: HonestyServiceShape["getBadge"] = (claimId) =>
      Effect.gen(function* () {
        const claim = yield* requireClaim(claimId)
        return yield* buildBadge(claim)
      })

    const evidenceFor: HonestyServiceShape["evidenceFor"] = (claimId) =>
      Effect.gen(function* () {
        const claim = yield* requireClaim(claimId)
        return yield* resolveEvidence(claim)
      })

    const claimsForTurn: HonestyServiceShape["claimsForTurn"] = (sessionId, turnId) =>
      Effect.gen(function* () {
        const claims = yield* store.listClaimsForTurn(sessionId, turnId)
        const out: Array<ClaimWithBadge> = []
        for (const claim of claims) {
          out.push({ claim, badge: yield* buildBadge(claim) })
        }
        return out as ReadonlyArray<ClaimWithBadge>
      })

    return HonestyService.of({
      recordClaim,
      attachEvidence,
      recordVerdict,
      getVerdict,
      evidenceFor,
      getBadge,
      claimsForTurn,
    })
  }),
)

/** Convenience: the full default stack — live service over the in-memory ledger. */
export const HonestyServiceInMemory: Layer.Layer<HonestyService> = Layer.provide(
  HonestyServiceLive,
  InMemoryLedgerStore,
)
