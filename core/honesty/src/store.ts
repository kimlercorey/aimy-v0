/**
 * honesty/store.ts — the `LedgerStore` storage seam and its in-memory default.
 *
 * The store interface is Effect-based so a future durable backend (SQLite
 * under MemoryService, file-per-session JSONL, …) can implement it without
 * changing the service. Records are plain JSON-serializable data — no class
 * instances, no Dates, no Maps — so the in-memory state can be snapshotted
 * to disk verbatim when the durable store lands (see README "Future seams").
 *
 * Concurrency: the in-memory implementation performs all mutations inside
 * `Effect.sync`, so each operation is atomic with respect to the Effect
 * runtime's cooperative scheduling. A durable implementation must provide
 * the same per-operation atomicity.
 */
import { Context, Effect, Layer } from "effect"
import type { ClaimRecord, EvidenceRecord, JudgeVerdict } from "./types.js"
import type { HonestyError } from "./errors.js"

/**
 * The storage seam. Implementations own their state; the service owns the
 * derivation logic. Stores must treat records as opaque values — they never
 * interpret badges, verdicts, or evidence kinds.
 */
export interface LedgerStoreShape {
  readonly getClaim: (claimId: string) => Effect.Effect<ClaimRecord | undefined, HonestyError>
  readonly putClaim: (claim: ClaimRecord) => Effect.Effect<void, HonestyError>
  /** All claims recorded for one turn, in insertion order. */
  readonly listClaimsForTurn: (
    sessionId: string,
    turnId: string,
  ) => Effect.Effect<ReadonlyArray<ClaimRecord>, HonestyError>
  readonly getEvidence: (evidenceId: string) => Effect.Effect<EvidenceRecord | undefined, HonestyError>
  readonly putEvidence: (evidence: EvidenceRecord) => Effect.Effect<void, HonestyError>
  readonly getVerdict: (verdictId: string) => Effect.Effect<JudgeVerdict | undefined, HonestyError>
  readonly putVerdict: (verdict: JudgeVerdict) => Effect.Effect<void, HonestyError>
}

export class LedgerStore extends Context.Service<LedgerStore, LedgerStoreShape>()(
  "aimy/honesty/LedgerStore",
) {}

/** Deep-copy + freeze: the store never aliases caller-owned objects. */
const freezeCopy = <T>(value: T): T => Object.freeze(structuredClone(value)) as T

interface InMemoryState {
  readonly claims: Map<string, ClaimRecord>
  readonly evidence: Map<string, EvidenceRecord>
  readonly verdicts: Map<string, JudgeVerdict>
}

const freshState = (): InMemoryState => ({
  claims: new Map(),
  evidence: new Map(),
  verdicts: new Map(),
})

/**
 * Default store: process-local memory. Each layer build gets its own
 * isolated state — tests that build the layer twice never share records.
 */
export const InMemoryLedgerStore: Layer.Layer<LedgerStore> = Layer.sync(LedgerStore, () => {
  const state = freshState()

  const store: LedgerStoreShape = {
    getClaim: (claimId) => Effect.sync(() => state.claims.get(claimId)),
    putClaim: (claim) =>
      Effect.sync(() => {
        state.claims.set(claim.claimId, freezeCopy(claim))
      }),
    listClaimsForTurn: (sessionId, turnId) =>
      Effect.sync(() => {
        const out: Array<ClaimRecord> = []
        for (const claim of state.claims.values()) {
          if (claim.sessionId === sessionId && claim.turnId === turnId) out.push(claim)
        }
        return out as ReadonlyArray<ClaimRecord>
      }),
    getEvidence: (evidenceId) => Effect.sync(() => state.evidence.get(evidenceId)),
    putEvidence: (evidence) =>
      Effect.sync(() => {
        // Evidence records are immutable; the evidenceId is content-derived,
        // so a second put of the same id is necessarily the same record.
        if (!state.evidence.has(evidence.evidenceId)) {
          state.evidence.set(evidence.evidenceId, freezeCopy(evidence))
        }
      }),
    getVerdict: (verdictId) => Effect.sync(() => state.verdicts.get(verdictId)),
    putVerdict: (verdict) =>
      Effect.sync(() => {
        // First write wins: verdicts are outcome records and are NEVER
        // mutated. Re-recording an existing verdictId is a no-op (idempotent).
        if (!state.verdicts.has(verdict.verdictId)) {
          state.verdicts.set(verdict.verdictId, freezeCopy(verdict))
        }
      }),
  }
  return store
})
