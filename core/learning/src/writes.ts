/**
 * writes.ts — unattended-write safety (architecture §3.7).
 *
 * A fork running unattended may `add` memories/skills. `replace`/`remove`
 * are NEVER applied unattended — they stage into a pending store surfaced
 * for human approval. Fail-closed: if staging fails, the operation degrades
 * to plain DENIAL, not silent application. Every write carries provenance —
 * `requireProvenance` rejects unattributed writes before anything else.
 *
 * Each applied `add` is atomic: the underlying memory write runs inside
 * `Effect.uninterruptible`, so a cancel landing mid-write either sees the
 * whole write or none of it — never a torn write, never a post-cancel
 * application.
 */
import { Context, Data, Effect, Layer, Option, Ref } from "effect"
import { createHash } from "node:crypto"
import { MemoryService, type KvNamespace, type MemoryServiceShape } from "../../memory/index.js"
import type { MemoryOpError } from "../../memory/index.js"
import { requireProvenance, UnattributedWrite, type WriteProvenance } from "./provenance.js"
import type { WriteDisposition } from "./review-types.js"

/** A staged destructive proposal awaiting human approval. */
export interface PendingEntry {
  /** Content-fingerprinted id: same proposal → same id (Hermes #119668). */
  readonly pendingId: string
  readonly kind: "replace" | "remove"
  readonly namespace: KvNamespace
  readonly key: string
  /** The proposed replacement value (`replace` only). */
  readonly value?: unknown
  readonly reason: string
  readonly provenance: WriteProvenance
  readonly stagedAt: string
}

export type PendingDraft = Omit<PendingEntry, "pendingId" | "stagedAt">

/** The pending store failed (fail-closed: callers degrade to DENIAL). */
export class PendingStoreError extends Data.TaggedError("PendingStoreError")<{
  readonly operation: string
  readonly reason: string
}> {}

export interface PendingStoreService {
  readonly stage: (draft: PendingDraft) => Effect.Effect<PendingEntry, PendingStoreError>
  readonly list: () => Effect.Effect<ReadonlyArray<PendingEntry>, PendingStoreError>
  readonly get: (pendingId: string) => Effect.Effect<Option.Option<PendingEntry>, PendingStoreError>
  /** Approval/denial of a staged entry removes it (a later track records the decision). */
  readonly remove: (pendingId: string) => Effect.Effect<void, PendingStoreError>
}

export class PendingStore extends Context.Service<PendingStore, PendingStoreService>()(
  "aimy/learning/PendingStore"
) {}

/** Canonical fingerprint: kind + namespace + key + value, sha256 hex. */
export const fingerprintPending = (draft: {
  readonly kind: "replace" | "remove"
  readonly namespace: KvNamespace
  readonly key: string
  readonly value?: unknown
}): string =>
  createHash("sha256")
    .update(JSON.stringify([draft.kind, draft.namespace, draft.key, draft.value ?? null]))
    .digest("hex")

/** In-memory pending store. Production swaps this layer for the SQLite one. */
export const InMemoryPendingStore: Layer.Layer<PendingStore> = Layer.effect(
  PendingStore,
  Effect.gen(function* () {
    const entries = yield* Ref.make(new Map<string, PendingEntry>())
    const service: PendingStoreService = {
      stage: (draft) =>
        Effect.gen(function* () {
          const pendingId = fingerprintPending(draft)
          const entry: PendingEntry = { ...draft, pendingId, stagedAt: new Date().toISOString() }
          yield* Ref.update(entries, (m) => new Map(m).set(pendingId, entry))
          return entry
        }),
      list: () => Ref.get(entries).pipe(Effect.map((m) => Array.from(m.values()))),
      get: (pendingId) =>
        Ref.get(entries).pipe(Effect.map((m) => Option.fromUndefinedOr(m.get(pendingId)))),
      remove: (pendingId) =>
        Ref.update(entries, (m) => {
          const next = new Map(m)
          next.delete(pendingId)
          return next
        })
    }
    return service
  })
)

/** One unattended write proposal, as the fork runner hands it to the gate. */
export interface UnattendedWrite {
  readonly kind: "add" | "replace" | "remove"
  readonly namespace: KvNamespace
  readonly key: string
  readonly value?: unknown
  readonly reason: string
  /**
   * Validated by `requireProvenance` before anything else. `unknown` here
   * so the "write without provenance is rejected" path is typeable in tests.
   */
  readonly provenance: unknown
}

export interface UnattendedWriteGateService {
  /**
   * Dispose one unattended write:
   * - `add` → provenance-checked, applied atomically via `MemoryService`.
   * - `replace`/`remove` → staged into the pending store, never applied.
   * - staging failure → `Denied` (fail-closed), never silent application.
   * - missing/incomplete provenance → `UnattributedWrite` (typed failure).
   */
  readonly applyUnattended: (
    write: UnattendedWrite
  ) => Effect.Effect<WriteDisposition, UnattributedWrite | MemoryOpError>
}

export class UnattendedWriteGate extends Context.Service<UnattendedWriteGate, UnattendedWriteGateService>()(
  "aimy/learning/UnattendedWriteGate"
) {}

export const UnattendedWriteGateLive: Layer.Layer<UnattendedWriteGate, never, MemoryService | PendingStore> =
  Layer.effect(
    UnattendedWriteGate,
    Effect.gen(function* () {
      const memory: MemoryServiceShape = yield* MemoryService
      const pending: PendingStoreService = yield* PendingStore

      const applyUnattended: UnattendedWriteGateService["applyUnattended"] = (write) =>
        Effect.gen(function* () {
          // Provenance first: unattributed memory is a bug, rejected here.
          const provenance = yield* requireProvenance(write.provenance)

          if (write.kind === "add") {
            // Atomic: uninterruptible, so a cancel either sees the whole
            // write or none of it — never a torn or post-cancel write.
            yield* Effect.uninterruptible(memory.set(write.namespace, write.key, write.value))
            return {
              _tag: "Applied",
              namespace: write.namespace,
              key: write.key
            } as WriteDisposition
          }

          // replace/remove: stage for human approval, never apply unattended.
          // Fail-closed: a staging failure degrades to DENIAL, not to
          // silent application.
          const staged = yield* pending
            .stage({
              kind: write.kind,
              namespace: write.namespace,
              key: write.key,
              value: write.value,
              reason: write.reason,
              provenance
            })
            .pipe(Effect.option)
          if (Option.isNone(staged)) {
            return {
              _tag: "Denied",
              reason: `staging ${write.kind} of ${write.namespace}:${write.key} failed; denied fail-closed`
            } as WriteDisposition
          }
          return {
            _tag: "Staged",
            pendingId: staged.value.pendingId,
            kind: write.kind,
            namespace: write.namespace,
            key: write.key
          } as WriteDisposition
        })

      return { applyUnattended }
    })
  )
