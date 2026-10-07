/**
 * learning/test/track1-fixtures.ts — shared fixtures for Track 1 tests
 * (review forks + unattended-write safety).
 *
 * - `testProvenance`: a complete, valid provenance value.
 * - `testMemoryLayer`: real `MemoryServiceLive` over a tmp dir with
 *   `AllowAllGate` (the gate is consulted; these tests allow everything).
 * - `testWriteGateLayer`: `UnattendedWriteGateLive` + `InMemoryPendingStore`.
 * - `testForksLayer`: `layerReviewForks` with an injected worker and the
 *   real inference pool (no providers registered — custom workers never
 *   touch it).
 * - `testSnapshot`: a small frozen conversation snapshot.
 */
import { afterEach, } from "vitest"
import { Deferred, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { InferencePoolLive } from "../../inference-pool/index.js"
import {
  AllowAllGate,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
  resolveMemoryDirs
} from "../../memory/index.js"
import { layerReviewForks, ReviewForks, ReviewWorkerError, type ReviewWorker, type WorkerResult } from "../src/forks.js"
import type { WriteProvenance } from "../src/provenance.js"
import { deepFreeze, type ConversationSnapshot } from "../src/snapshot.js"
import type { RawProposal, WriteDisposition } from "../src/review-types.js"
import { InMemoryPendingStore, PendingStore, UnattendedWriteGate, UnattendedWriteGateLive } from "../src/writes.js"

const tmpRoots: Array<string> = []

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

export const testProvenance = (sessionId = "s-test"): WriteProvenance => ({
  origin: "review-fork",
  executionContext: "unattended",
  sessionId,
  profileId: "profile-test"
})

export const testMemoryLayer = (): Layer.Layer<MemoryService> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-learning-t1-"))
  tmpRoots.push(dir)
  const base = resolveMemoryDirs()
  const paths = Layer.succeed(MemoryPaths, {
    ...base,
    sessionsDir: path.join(dir, "sessions"),
    storesDir: path.join(dir, "stores")
  })
  return Layer.provide(MemoryServiceLive, Layer.mergeAll(AllowAllGate, paths))
}

export const testWriteGateLayer = (): Layer.Layer<UnattendedWriteGate | MemoryService> => {
  const memory = testMemoryLayer()
  const gate = Layer.provide(UnattendedWriteGateLive, Layer.mergeAll(memory, InMemoryPendingStore))
  return Layer.mergeAll(gate, memory)
}

export const testForksLayer = (
  worker: ReviewWorker,
  opts?: { readonly ackDeadlineMs?: number }
): Layer.Layer<ReviewForks | MemoryService> => {
  const memory = testMemoryLayer()
  const gate = Layer.provide(UnattendedWriteGateLive, Layer.mergeAll(memory, InMemoryPendingStore))
  const forks = Layer.provide(
    layerReviewForks({ worker, ackDeadlineMs: opts?.ackDeadlineMs }),
    Layer.mergeAll(gate, InferencePoolLive, memory)
  )
  return Layer.mergeAll(forks, memory)
}

/** Exposes the PendingStore alongside the gate for assertions. */
export const testWriteGateWithStoreLayer = (): Layer.Layer<UnattendedWriteGate | PendingStore | MemoryService> => {
  const memory = testMemoryLayer()
  const store = InMemoryPendingStore
  const gate = Layer.provide(UnattendedWriteGateLive, Layer.mergeAll(memory, store))
  return Layer.mergeAll(gate, store, memory)
}

export const testSnapshot = (sessionId = "s-test"): ConversationSnapshot =>
  deepFreeze({
    sessionId,
    capturedAt: "2026-10-07T06:30:00.000Z",
    turns: [
      { role: "user", text: "do you remember that I like tea?", toolCalls: [] },
      { role: "assistant", text: "Noted — you like tea.", toolCalls: [] }
    ]
  })

/** Worker that proposes nothing and records the toolset it was given. */
export const makeWhitelistProbeWorker = (seen: { toolset?: object }): ReviewWorker =>
  (_snapshot, toolset) => {
    seen.toolset = toolset
    return Effect.succeed<WorkerResult>({ proposals: [], dispositions: [] })
  }

/** Worker that proposes the given raw proposals through the toolset. */
export const makeProposingWorker = (
  raws: ReadonlyArray<RawProposal>,
  spawned?: Array<string>
): ReviewWorker =>
  (snapshot, toolset) =>
    Effect.gen(function* () {
      if (spawned !== undefined) spawned.push(snapshot.sessionId)
      const dispositions: Array<WriteDisposition> = []
      for (const raw of raws) {
        dispositions.push(
          yield* toolset.proposeWrite(raw).pipe(
            Effect.catch((e) =>
              Effect.fail(new ReviewWorkerError({ reason: `fixture proposeWrite failed: ${e._tag}` }))
            )
          )
        )
      }
      return { proposals: [...raws], dispositions }
    })

/** Worker that blocks on a latch, then proposes (used for cancel tests). */
export const makeBlockingWorker = (
  latch: Deferred.Deferred<void>,
  raws: ReadonlyArray<RawProposal>
): ReviewWorker =>
  (_snapshot, toolset) =>
    Deferred.await(latch).pipe(
      Effect.andThen(() =>
        Effect.gen(function* () {
          const dispositions: Array<WriteDisposition> = []
          for (const raw of raws) {
            dispositions.push(
              yield* toolset.proposeWrite(raw).pipe(
                Effect.catch((e) =>
                  Effect.fail(new ReviewWorkerError({ reason: `fixture proposeWrite failed: ${e._tag}` }))
                )
              )
            )
          }
          return { proposals: [...raws], dispositions }
        })
      )
    )
