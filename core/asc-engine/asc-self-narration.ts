import { createHash } from "node:crypto"

import { Context, Effect, Layer, Option, Ref } from "effect"

import { AscError } from "./errors-shim.js"
import { L3_STORAGE_KEY, MemoryReader } from "./seams.js"

// ---------------------------------------------------------------------------
// AscSelfNarration — L3 append-only narrative log (paper §III.C).
//
// The persistent story: what the system attempted, where it was wrong, what
// it corrected, what it still doesn't know. Written in PLAIN LANGUAGE, not
// framework vocabulary (the T1 rule applies to L3 too — the narrative is
// meaning, not a dashboard).
//
//   - Entries are content-addressed (sha256 of at|turn|text, 16 hex chars).
//   - Archive-on-delete, never hard-delete: `archiveEntry` appends a
//     tombstone entry linked to the original; the original stays.
//   - There is NO edit path and NO delete path on this service. The log only
//     grows. The frozen ASCEngine boundary exposes the stream read-only.
// ---------------------------------------------------------------------------

export interface NarrativeLinks {
  readonly dialComputationId?: string
  readonly archivedEntryId?: string
}

export interface NarrativeEntry {
  readonly id: string
  readonly turn: number
  readonly at: string
  /** Plain language, including the system's own errors. */
  readonly text: string
  readonly links: NarrativeLinks
}

export interface AppendNarrativeInput {
  readonly turn: number
  readonly text: string
  readonly links?: NarrativeLinks
}

/** Content-addressed id: `n3-` + first 16 hex chars of sha256(at|turn|text). */
export const narrativeId = (at: string, turn: number, text: string): string => {
  const digest = createHash("sha256").update(`${at}|${turn}|${text}`, "utf8").digest("hex")
  return `n3-${digest.slice(0, 16)}`
}

const nowIso = (): string => new Date().toISOString()

/** Storage cap: the log is append-only but bounded; oldest entries roll off. */
export const NARRATIVE_CAP = 500

export interface AscSelfNarrationShape {
  /** Load from MemoryReader; start empty when absent. */
  readonly load: Effect.Effect<void, AscError>
  /** Persist current log. */
  readonly persist: Effect.Effect<void, AscError>
  /** Append one entry. Returns the content-addressed id. */
  readonly append: (input: AppendNarrativeInput) => Effect.Effect<string, AscError>
  /** Read-only chronological stream (oldest first). */
  readonly stream: (limit?: number) => Effect.Effect<ReadonlyArray<NarrativeEntry>, AscError>
  /**
   * Archive-on-delete: appends a tombstone entry linked to the original.
   * The original entry is NEVER removed or mutated.
   */
  readonly archiveEntry: (id: string, reason: string) => Effect.Effect<string, AscError>
}

export class AscSelfNarration extends Context.Service<AscSelfNarration, AscSelfNarrationShape>()(
  "aimy/AscSelfNarration",
) {}

export const makeAscSelfNarration = Effect.gen(function* () {
  const memory = yield* MemoryReader
  const logRef = yield* Ref.make<ReadonlyArray<NarrativeEntry>>([])

  const load = Effect.gen(function* () {
    const raw = yield* memory.read(L3_STORAGE_KEY)
    if (Option.isNone(raw)) {
      yield* Ref.set(logRef, [])
      return
    }
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(raw.value) as unknown,
      catch: (cause) =>
        new AscError({ reason: `L3 narrative log failed to parse: ${String(cause)}` }),
    })
    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(
        new AscError({ reason: "L3 narrative log is not an array" }),
      )
    }
    yield* Ref.set(logRef, parsed as ReadonlyArray<NarrativeEntry>)
  })

  const persist = Effect.gen(function* () {
    const log = yield* Ref.get(logRef)
    yield* memory.write(L3_STORAGE_KEY, JSON.stringify(log))
  })

  const pushEntry = (entry: NarrativeEntry) =>
    Ref.update(logRef, (log) => [...log, entry].slice(-NARRATIVE_CAP))

  return AscSelfNarration.of({
    load,
    persist,
    append: (input) =>
      Effect.gen(function* () {
        const at = nowIso()
        const entry: NarrativeEntry = {
          id: narrativeId(at, input.turn, input.text),
          turn: input.turn,
          at,
          text: input.text,
          links: input.links ?? {},
        }
        yield* pushEntry(entry)
        return entry.id
      }),
    stream: (limit = 100) =>
      Effect.map(Ref.get(logRef), (log) => log.slice(-Math.max(1, limit))),
    archiveEntry: (id, reason) =>
      Effect.gen(function* () {
        const log = yield* Ref.get(logRef)
        const original = log.find((e) => e.id === id)
        if (!original) {
          return yield* Effect.fail(new AscError({ reason: `narrative entry not found: ${id}` }))
        }
        const at = nowIso()
        const text =
          `Archived entry ${id} (turn ${original.turn}): ${reason}. ` +
          `The original entry is retained below for the record.`
        const tombstone: NarrativeEntry = {
          id: narrativeId(at, original.turn, text),
          turn: original.turn,
          at,
          text,
          links: { archivedEntryId: id },
        }
        yield* pushEntry(tombstone)
        return tombstone.id
      }),
  })
})

/** Requires MemoryReader in the environment (integration seam). */
export const AscSelfNarrationLive: Layer.Layer<AscSelfNarration, AscError, MemoryReader> =
  Layer.effect(AscSelfNarration, makeAscSelfNarration)
