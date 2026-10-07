/**
 * track1-writes.test.ts — unattended-write safety (architecture §3.7).
 *
 * - `add` applies unattended (provenance-checked, atomic).
 * - `replace`/`remove` NEVER apply unattended — they stage into the pending
 *   store for human approval.
 * - Fail-closed: a staging failure degrades to plain DENIAL, never silent
 *   application.
 * - Writes without complete provenance are rejected (typed).
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Option } from "effect"
import { MemoryService } from "../../memory/index.js"
import { UnattributedWrite } from "../src/provenance.js"
import {
  fingerprintPending,
  InMemoryPendingStore,
  PendingStore,
  PendingStoreError,
  UnattendedWriteGate,
  UnattendedWriteGateLive
} from "../src/writes.js"
import {
  testMemoryLayer,
  testProvenance,
  testWriteGateLayer,
  testWriteGateWithStoreLayer
} from "./track1-fixtures.js"

const runProvided = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, E>
): Promise<A> => Effect.runPromise(Effect.provide(eff, layer))

describe("UnattendedWriteGate: add applies", () => {
  it("add writes through to the memory store", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* UnattendedWriteGate
      const memory = yield* MemoryService
      const disposition = yield* gate.applyUnattended({
        kind: "add",
        namespace: "profile",
        key: "likes-tea",
        value: true,
        reason: "user said they like tea",
        provenance: testProvenance("s-1")
      })
      expect(disposition._tag).toBe("Applied")
      if (disposition._tag === "Applied") {
        expect(disposition.namespace).toBe("profile")
        expect(disposition.key).toBe("likes-tea")
      }
      expect(yield* memory.get("profile", "likes-tea")).toBe(true)
    })
    await runProvided(program, testWriteGateLayer())
  })

  it("rejects writes without complete provenance", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* UnattendedWriteGate
      const memory = yield* MemoryService
      for (const bad of [undefined, {}, { origin: "review-fork" }]) {
        const err = yield* Effect.flip(
          gate.applyUnattended({
            kind: "add",
            namespace: "profile",
            key: "k",
            value: 1,
            reason: "r",
            provenance: bad
          })
        )
        expect(err, JSON.stringify(bad)).toBeInstanceOf(UnattributedWrite)
        expect((err as UnattributedWrite)._tag).toBe("UnattributedWrite")
      }
      // Nothing was written by the rejected attempts.
      expect(yield* memory.get("profile", "k")).toBeUndefined()
    })
    await runProvided(program, testWriteGateLayer())
  })
})

describe("UnattendedWriteGate: replace/remove stage, never apply", () => {
  it("replace stages into the pending store and does not touch memory", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* UnattendedWriteGate
      const memory = yield* MemoryService
      const pending = yield* PendingStore
      const disposition = yield* gate.applyUnattended({
        kind: "replace",
        namespace: "skills",
        key: "old-skill",
        value: { steps: ["new"] },
        reason: "procedure changed",
        provenance: testProvenance("s-2")
      })
      expect(disposition._tag).toBe("Staged")
      if (disposition._tag !== "Staged") throw new Error("expected Staged")
      expect(disposition.kind).toBe("replace")
      expect(disposition.pendingId).toMatch(/^[0-9a-f]{64}$/)

      // Not applied: the memory store is untouched.
      expect(yield* memory.get("skills", "old-skill")).toBeUndefined()

      // Staged: the pending store holds it with provenance.
      const entries = yield* pending.list()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.pendingId).toBe(disposition.pendingId)
      expect(entries[0]!.provenance.sessionId).toBe("s-2")
      expect(entries[0]!.provenance.origin).toBe("review-fork")
    })
    await runProvided(program, testWriteGateWithStoreLayer())
  })

  it("remove stages as well", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* UnattendedWriteGate
      const pending = yield* PendingStore
      const disposition = yield* gate.applyUnattended({
        kind: "remove",
        namespace: "environment",
        key: "stale-fact",
        reason: "no longer true",
        provenance: testProvenance("s-3")
      })
      expect(disposition._tag).toBe("Staged")
      const entries = yield* pending.list()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.kind).toBe("remove")
    })
    await runProvided(program, testWriteGateWithStoreLayer())
  })
})

describe("UnattendedWriteGate: fail-closed staging", () => {
  // A pending store whose stage always fails (disk full, lock lost…).
  const failingStore = Layer.succeed(PendingStore, {
    stage: () => Effect.fail(new PendingStoreError({ operation: "stage", reason: "disk full" })),
    list: () => Effect.succeed([]),
    get: () => Effect.succeed(Option.none()),
    remove: () => Effect.void
  })

  it("staging failure degrades to DENIAL, never silent application", async () => {
    const memory = testMemoryLayer()
    const layer = Layer.mergeAll(
      Layer.provide(UnattendedWriteGateLive, Layer.mergeAll(memory, failingStore)),
      memory
    )
    const program = Effect.gen(function* () {
      const gate = yield* UnattendedWriteGate
      const mem = yield* MemoryService
      const disposition = yield* gate.applyUnattended({
        kind: "replace",
        namespace: "profile",
        key: "name",
        value: "Mallory",
        reason: "impersonation attempt",
        provenance: testProvenance("s-4")
      })
      expect(disposition._tag).toBe("Denied")
      if (disposition._tag === "Denied") {
        expect(disposition.reason).toContain("fail-closed")
      }
      // And the value was NOT applied despite the staging failure.
      expect(yield* mem.get("profile", "name")).toBeUndefined()
    })
    await runProvided(program, layer)
  })
})

describe("fingerprintPending", () => {
  it("is deterministic and content-addressed", () => {
    const draft = { kind: "replace" as const, namespace: "profile" as const, key: "k", value: { a: 1 } }
    expect(fingerprintPending(draft)).toBe(fingerprintPending({ ...draft }))
    expect(fingerprintPending(draft)).not.toBe(fingerprintPending({ ...draft, key: "other" }))
    expect(fingerprintPending(draft)).not.toBe(
      fingerprintPending({ kind: "remove", namespace: "profile", key: "k" })
    )
  })
})

describe("InMemoryPendingStore", () => {
  it("stage → get → remove round-trip", async () => {
    const eff = Effect.gen(function* () {
      const store = yield* PendingStore
      const entry = yield* store.stage({
        kind: "remove",
        namespace: "skills",
        key: "k",
        reason: "r",
        provenance: testProvenance("s-5")
      })
      expect(yield* store.get(entry.pendingId)).toEqual(Option.some(entry))
      yield* store.remove(entry.pendingId)
      expect(yield* store.list()).toEqual([])
    })
    await Effect.runPromise(Effect.provide(eff, InMemoryPendingStore))
  })
})
