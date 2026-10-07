import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { AscError } from "./errors-shim.js"
import { AscSelfNarration, AscSelfNarrationLive, narrativeId } from "./asc-self-narration.js"
import { makeInMemoryMemoryReader, MemoryReader } from "./seams.js"

const narrationLayer = () =>
  Layer.provide(AscSelfNarrationLive, Layer.succeed(MemoryReader, makeInMemoryMemoryReader()))

describe("narrativeId", () => {
  it("is content-addressed and deterministic", () => {
    const a = narrativeId("2026-10-07T00:00:00Z", 3, "hello")
    const b = narrativeId("2026-10-07T00:00:00Z", 3, "hello")
    const c = narrativeId("2026-10-07T00:00:00Z", 3, "different")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^n3-[0-9a-f]{16}$/)
  })
})

describe("AscSelfNarration", () => {
  it.effect("appends entries and streams them oldest-first", () =>
    Effect.gen(function* () {
      const n = yield* AscSelfNarration
      yield* n.load
      const id1 = yield* n.append({ turn: 1, text: "First entry." })
      const id2 = yield* n.append({ turn: 2, text: "Second entry." })
      expect(id1).toMatch(/^n3-/)
      expect(id2).toMatch(/^n3-/)
      expect(id1).not.toBe(id2)
      const stream = yield* n.stream()
      expect(stream.length).toBe(2)
      expect(stream[0]!.text).toBe("First entry.")
      expect(stream[1]!.text).toBe("Second entry.")
      expect(stream[0]!.links).toEqual({})
    }).pipe(Effect.provide(narrationLayer())))

  it.effect("has no edit or delete path (append-only)", () =>
    Effect.gen(function* () {
      const n = yield* AscSelfNarration
      expect("edit" in n).toBe(false)
      expect("delete" in n).toBe(false)
      expect("update" in n).toBe(false)
      expect("remove" in n).toBe(false)
      const keys = Object.keys(n).sort()
      expect(keys).toEqual(["append", "archiveEntry", "load", "persist", "stream"].sort())
    }).pipe(Effect.provide(narrationLayer())))

  it.effect("archiveEntry appends a tombstone; the original is retained", () =>
    Effect.gen(function* () {
      const n = yield* AscSelfNarration
      yield* n.load
      const id = yield* n.append({ turn: 1, text: "Entry to archive." })
      const tombstoneId = yield* n.archiveEntry(id, "superseded by later evidence")
      const stream = yield* n.stream()
      expect(stream.length).toBe(2)
      // Original untouched.
      expect(stream[0]!.id).toBe(id)
      expect(stream[0]!.text).toBe("Entry to archive.")
      // Tombstone links back.
      expect(stream[1]!.id).toBe(tombstoneId)
      expect(stream[1]!.links.archivedEntryId).toBe(id)
      expect(stream[1]!.text).toContain("superseded by later evidence")
    }).pipe(Effect.provide(narrationLayer())))

  it.effect("entries can link DialComputation ids", () =>
    Effect.gen(function* () {
      const n = yield* AscSelfNarration
      yield* n.load
      const id = yield* n.append({
        turn: 3,
        text: "Worked through the failure.",
        links: { dialComputationId: "dc-3-123" },
      })
      const stream = yield* n.stream()
      expect(stream.length).toBe(1)
      expect(stream[0]!.id).toBe(id)
      expect(stream[0]!.links.dialComputationId).toBe("dc-3-123")
    }).pipe(Effect.provide(narrationLayer())))

  it.effect("the log only grows: appends never disturb earlier entries", () =>
    Effect.gen(function* () {
      const n = yield* AscSelfNarration
      yield* n.load
      const first = yield* n.append({ turn: 1, text: "First." })
      for (let i = 0; i < 5; i++) yield* n.append({ turn: 2, text: `Later ${i}.` })
      const stream = yield* n.stream()
      expect(stream.length).toBe(6)
      expect(stream[0]!.id).toBe(first)
      expect(stream[0]!.text).toBe("First.")
    }).pipe(Effect.provide(narrationLayer())))

  it.effect("append validates against nothing but grows the log — entry shape is stable", () =>
    Effect.gen(function* () {
      const n = yield* AscSelfNarration
      yield* n.load
      yield* n.append({ turn: 9, text: "Error acknowledged: the correction overshot, and I walked it back." })
      const stream = yield* n.stream()
      // L3 carries the system's own errors in its own words.
      expect(stream[0]!.text).toContain("the correction overshot")
      expect(stream[0]!.turn).toBe(9)
    }).pipe(Effect.provide(narrationLayer())))

  it.effect("archiveEntry fails loudly on an unknown id", () =>
    Effect.gen(function* () {
      const n = yield* AscSelfNarration
      yield* n.load
      const err = yield* Effect.flip(n.archiveEntry("n3-deadbeefdeadbeef", "nope"))
      expect(err).toBeInstanceOf(AscError)
    }).pipe(Effect.provide(narrationLayer())))

  it.effect("persists across load", () =>
    Effect.gen(function* () {
      const mem = makeInMemoryMemoryReader()
      const layer = Layer.provide(
        AscSelfNarrationLive,
        Layer.succeed(MemoryReader, mem),
      )
      const writeIt = Effect.gen(function* () {
        const n = yield* AscSelfNarration
        yield* n.load
        yield* n.append({ turn: 7, text: "Durable entry." })
        yield* n.persist
      })
      yield* writeIt.pipe(Effect.provide(layer))
      const readIt = Effect.gen(function* () {
        const n = yield* AscSelfNarration
        yield* n.load
        return yield* n.stream()
      })
      const stream = yield* readIt.pipe(Effect.provide(layer))
      expect(stream.length).toBe(1)
      expect(stream[0]!.text).toBe("Durable entry.")
    }))
})
