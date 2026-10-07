/**
 * timeline.test.ts — the learning timeline data model and store seam.
 *
 * Covers: content-fingerprinted ids, idempotent re-record, serializability
 * validation, queries (time range / type / subject / archived visibility),
 * archive-as-delete (never destroys), restore, edit-as-new-node, and
 * JSON-serializability of stored nodes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  InMemoryTimelineStore,
  LearningTimeline,
  LearningTimelineLive,
  nodeIdFor,
  type LearningEvent,
  type Provenance,
  type ProposedAddPayload,
} from "./timeline.js"
import { NodeAlreadyArchived, NodeNotArchived, NodeNotFound, UnserializablePayload } from "./errors.js"

const prov: Provenance = { origin: "review-fork", sessionId: "sess-1", profileId: "default" }
const userProv: Provenance = { origin: "user", sessionId: "sess-1", profileId: "default" }

const TimelineTestLayer = Layer.provide(LearningTimelineLive, InMemoryTimelineStore)

const withTimeline = <A, E>(eff: Effect.Effect<A, E, LearningTimeline>): Effect.Effect<A, E, never> =>
  Effect.provide(eff, TimelineTestLayer)

const proposedAdd = (recordedAt?: string): LearningEvent => ({
  type: "review-fork.proposed-add",
  provenance: prov,
  subject: "skill.weather",
  evidenceIds: ["claim-1"],
  ...(recordedAt !== undefined ? { recordedAt } : {}),
  payload: { store: "skills", summary: "new weather skill" },
})

describe("learning timeline", () => {
  it.effect("recordEvent fingerprints the node id over canonical content", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const at = "2026-10-07T06:00:00.000Z"
        const node = yield* timeline.recordEvent(proposedAdd(at))
        expect(node.nodeId).toBe(nodeIdFor(proposedAdd(at), at))
        expect(node.type).toBe("review-fork.proposed-add")
        expect(node.recordedAt).toBe(at)
        expect(node.subject).toBe("skill.weather")
        expect(node.evidenceIds).toEqual(["claim-1"])
        expect(node.archivedAt).toBeUndefined()
      }),
    ),
  )

  it.effect("recordEvent is idempotent for identical content and timestamp", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const at = "2026-10-07T06:00:00.000Z"
        const a = yield* timeline.recordEvent(proposedAdd(at))
        const b = yield* timeline.recordEvent(proposedAdd(at))
        expect(b.nodeId).toBe(a.nodeId)
        const nodes = yield* timeline.query({})
        expect(nodes).toHaveLength(1)
      }),
    ),
  )

  it.effect("distinct timestamps produce distinct nodes", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const a = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        const b = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:01.000Z"))
        expect(a.nodeId).not.toBe(b.nodeId)
      }),
    ),
  )

  it.effect("recordEvent fails typed on unserializable payloads", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const result = yield* Effect.flip(
          timeline.recordEvent({
            type: "review-fork.proposed-add",
            provenance: prov,
            evidenceIds: [],
            // Deliberately unserializable: cast through unknown because the
            // LearningEvent union only admits serializable payload shapes.
            // recordEvent must still reject this at runtime with UnserializablePayload.
            payload: { fn: () => 42 } as unknown as ProposedAddPayload,
          }),
        )
        expect(result).toBeInstanceOf(UnserializablePayload)
      }),
    ),
  )

  it.effect("getNode returns undefined for unknown ids", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        expect(yield* timeline.getNode("nope")).toBeUndefined()
      }),
    ),
  )

  it.effect("query filters by time range, type, and subject", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const a = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        yield* timeline.recordEvent({
          type: "verification.passed",
          provenance: { origin: "verification-arm", sessionId: "sess-1", profileId: "default" },
          subject: "skill.weather",
          evidenceIds: [],
          recordedAt: "2026-10-07T07:00:00.000Z",
          payload: { verdictIds: ["v-1"] },
        })
        yield* timeline.recordEvent({
          type: "curator.transitioned",
          provenance: { origin: "curator", sessionId: "sess-1", profileId: "default" },
          subject: "skill.old",
          evidenceIds: [],
          recordedAt: "2026-10-07T08:00:00.000Z",
          payload: { from: "stale", to: "archived", reason: "unused" },
        })

        expect((yield* timeline.query({ types: ["verification.passed"] })).map((n) => n.nodeId))
          .toHaveLength(1)
        expect((yield* timeline.query({ subject: "skill.weather" }))).toHaveLength(2)
        expect(
          (yield* timeline.query({ from: "2026-10-07T06:30:00.000Z", to: "2026-10-07T07:30:00.000Z" })),
        ).toHaveLength(1)
        // Tombstone the first node: hidden by default, visible with includeArchived.
        yield* timeline.archiveNode(a.nodeId, { reason: "user deleted", provenance: userProv })
        expect(yield* timeline.query({ subject: "skill.weather" })).toHaveLength(2) // archived + meta event
        const all = yield* timeline.query({ subject: "skill.weather", includeArchived: true })
        expect(all).toHaveLength(3)
      }),
    ),
  )

  it.effect("archiveNode tombstones but never destroys the node", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const node = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        const tombstone = yield* timeline.archiveNode(node.nodeId, {
          reason: "contested by user",
          provenance: userProv,
        })
        expect(tombstone.nodeId).toBe(node.nodeId) // identity is stable
        expect(tombstone.archivedAt).toBeDefined()
        expect(tombstone.archiveReason).toBe("contested by user")
        // The node is still retrievable and restorable — nothing was destroyed.
        const fetched = yield* timeline.getNode(node.nodeId)
        expect(fetched?.archivedAt).toBeDefined()
        const meta = yield* timeline.query({ types: ["timeline.node.archived"] })
        expect(meta).toHaveLength(1)
        expect(meta[0]?.payload).toEqual({ targetNodeId: node.nodeId, reason: "contested by user" })
      }),
    ),
  )

  it.effect("archiveNode fails on unknown ids and double archives", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const missing = yield* Effect.flip(
          timeline.archiveNode("nope", { reason: "x", provenance: userProv }),
        )
        expect(missing).toBeInstanceOf(NodeNotFound)
        const node = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        yield* timeline.archiveNode(node.nodeId, { reason: "x", provenance: userProv })
        const again = yield* Effect.flip(
          timeline.archiveNode(node.nodeId, { reason: "y", provenance: userProv }),
        )
        expect(again).toBeInstanceOf(NodeAlreadyArchived)
      }),
    ),
  )

  it.effect("restoreNode revives an archived node", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const node = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        yield* timeline.archiveNode(node.nodeId, { reason: "x", provenance: userProv })
        const restored = yield* timeline.restoreNode(node.nodeId, {
          reason: "user changed mind",
          provenance: userProv,
        })
        expect(restored.nodeId).toBe(node.nodeId)
        expect(restored.archivedAt).toBeUndefined()
        expect(restored.archiveReason).toBeUndefined()
        const meta = yield* timeline.query({ types: ["timeline.node.restored"] })
        expect(meta).toHaveLength(1)
      }),
    ),
  )

  it.effect("restoreNode fails on unknown ids and non-archived nodes", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const missing = yield* Effect.flip(
          timeline.restoreNode("nope", { reason: "x", provenance: userProv }),
        )
        expect(missing).toBeInstanceOf(NodeNotFound)
        const node = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        const notArchived = yield* Effect.flip(
          timeline.restoreNode(node.nodeId, { reason: "x", provenance: userProv }),
        )
        expect(notArchived).toBeInstanceOf(NodeNotArchived)
      }),
    ),
  )

  it.effect("editNode appends a new node and archives the old one (history never rewritten)", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const old = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        const revised = yield* timeline.editNode(
          old.nodeId,
          { store: "skills", summary: "corrected weather skill" },
          userProv,
        )
        expect(revised.nodeId).not.toBe(old.nodeId)
        expect(revised.supersedes).toBe(old.nodeId)
        expect(revised.payload).toEqual({ store: "skills", summary: "corrected weather skill" })
        const tombstone = yield* timeline.getNode(old.nodeId)
        expect(tombstone?.archivedAt).toBeDefined()
        expect(tombstone?.archiveReason).toBe("edited")
        expect(tombstone?.supersededBy).toBe(revised.nodeId)
        // Both versions are queryable; the default query hides the archived original.
        const visible = yield* timeline.query({ subject: "skill.weather" })
        expect(visible.map((n) => n.nodeId)).toContain(revised.nodeId)
        expect(visible.map((n) => n.nodeId)).not.toContain(old.nodeId)
      }),
    ),
  )

  it.effect("editNode leaves the old node untouched when the new payload is unserializable", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const old = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        const result = yield* Effect.flip(
          timeline.editNode(old.nodeId, { fn: () => 1 }, userProv),
        )
        expect(result).toBeInstanceOf(UnserializablePayload)
        const untouched = yield* timeline.getNode(old.nodeId)
        expect(untouched?.archivedAt).toBeUndefined()
      }),
    ),
  )

  it.effect("stored nodes are JSON-serializable and survive a round trip", () =>
    withTimeline(
      Effect.gen(function* () {
        const timeline = yield* LearningTimeline
        const node = yield* timeline.recordEvent(proposedAdd("2026-10-07T06:00:00.000Z"))
        yield* timeline.archiveNode(node.nodeId, { reason: "x", provenance: userProv })
        const nodes = yield* timeline.query({ includeArchived: true })
        const roundTripped = JSON.parse(JSON.stringify(nodes)) as typeof nodes
        expect(roundTripped).toEqual(nodes)
      }),
    ),
  )

  it("node ids are stable regardless of object key insertion order", () => {
    const at = "2026-10-07T06:00:00.000Z"
    const a = nodeIdFor(proposedAdd(at), at)
    const shuffled = {
      evidenceIds: ["claim-1"],
      provenance: prov,
      type: "review-fork.proposed-add",
      payload: { summary: "new weather skill", store: "skills" },
      subject: "skill.weather",
    } as LearningEvent
    expect(nodeIdFor(shuffled, at)).toBe(a)
  })
})
