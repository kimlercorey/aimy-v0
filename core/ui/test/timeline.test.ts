/**
 * ui/test/timeline.test.ts — M8 acceptance: the timeline slice against the
 * LIVE `LearningTimeline` service (in-memory store).
 *
 * Each test mounts the slice's pure update, runs its real Commands against
 * the real service (the layer is provided ONCE around the whole test body,
 * so seeding, commands, and assertions share one in-memory store), then
 * renders the pure view and asserts displayed values === service state.
 */
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { inertHtml, type HtmlBuilder } from "foldkit/html"

import { LearningTimeline } from "../../learning/src/timeline.js"
import type { LearningEvent, LearningNode } from "../../learning/src/timeline.js"
import {
  initialModel,
  Message,
  shortNodeId,
  update,
  view,
} from "../src/timeline/index.js"
import type { Model, TimelineMessage } from "../src/timeline/index.js"
import { normalized, textOf } from "../src/shared/text.js"
import { drain, timelineLayers } from "./helpers.js"

const h = inertHtml as unknown as HtmlBuilder<TimelineMessage>

const PROV = { origin: "user" as const, sessionId: "test-session", profileId: "test-profile" }

/** Records the seed events through the REAL service. Layer provided by the caller. */
const seedEvents: Effect.Effect<ReadonlyArray<LearningNode>, unknown, any> =
  Effect.gen(function* () {
    const timeline = yield* LearningTimeline
    const events: ReadonlyArray<LearningEvent> = [
      {
        type: "review-fork.proposed-add",
        provenance: PROV,
        subject: "memory:theme",
        evidenceIds: [],
        recordedAt: "2026-10-07T10:00:00.000Z",
        payload: { store: "profile", summary: "user prefers dark themes" },
      },
      {
        type: "verification.started",
        provenance: PROV,
        subject: "skill:notes",
        evidenceIds: [],
        recordedAt: "2026-10-07T10:01:00.000Z",
        payload: { judgeIds: ["judge-1"] },
      },
      {
        type: "skill.trusted",
        provenance: { ...PROV, origin: "verification-arm" as const },
        subject: "skill:notes",
        evidenceIds: ["claim-1"],
        recordedAt: "2026-10-07T10:02:00.000Z",
        payload: { judgeVersions: ["judge-1@v3"] },
      },
      {
        type: "curator.transitioned",
        provenance: { ...PROV, origin: "curator" as const },
        subject: "skill:old-notes",
        evidenceIds: [],
        recordedAt: "2026-10-07T10:03:00.000Z",
        payload: { from: "active", to: "stale", reason: "superseded by skill:notes" },
      },
    ]
    const nodes = []
    for (const e of events) nodes.push(yield* timeline.recordEvent(e))
    return nodes as ReadonlyArray<LearningNode>
  })

const renderText = (model: Model): string => normalized(textOf(view(model, h)))

/** Refresh the slice from the live service. Layer provided by the caller. */
const refresh = (model: Model): Effect.Effect<Model, unknown, any> =>
  drain(update, model, Message.TimelineRefreshRequested()) as Effect.Effect<Model, unknown, any>

describe("timeline slice + live LearningTimeline", () => {
  it.effect("refresh renders the nodes recorded through the real service", () =>
    Effect.gen(function* () {
      const seeded = yield* seedEvents
      const model = yield* refresh(initialModel)

      // Displayed values === service state.
      expect(model.nodes).toHaveLength(seeded.length)
      expect(model.nodes.map((n) => n.nodeId).sort()).toEqual(
        seeded.map((n) => n.nodeId).sort(),
      )

      const text = renderText(model)
      expect(text).toContain("memory entry learned")
      expect(text).toContain("skill verified ✓")
      expect(text).toContain("curator transition")
      expect(text).toContain("memory:theme")
      for (const n of seeded) expect(text).toContain(shortNodeId(n.nodeId))
      // The skill:notes subject shows the unverified → verified transition.
      expect(text).toContain("verified")
      expect(model.status).toBe("ready")
    }).pipe(Effect.provide(timelineLayers())),
  )

  it.effect("archive/restore round-trips through the real service; nothing is destroyed", () =>
    Effect.gen(function* () {
      const seeded = yield* seedEvents
      const target = seeded[0] as LearningNode
      let model = yield* refresh(initialModel)

      model = (yield* drain(
        update,
        model,
        Message.TimelineNodeArchiveRequested({ nodeId: target.nodeId, reason: "test cleanup" }),
      )) as Model
      const archived = model.nodes.find((n) => n.nodeId === target.nodeId)
      expect(archived?.archivedAt).toBeDefined()
      expect(archived?.archiveReason).toBe("test cleanup")

      // The service still holds the node — archive never destroys.
      const timeline = yield* LearningTimeline
      const stillThere = yield* timeline.getNode(target.nodeId)
      expect(stillThere?.archivedAt).toBeDefined()

      // Hidden by default, visible dimmed with showArchived.
      expect(renderText(model)).not.toContain("memory:theme")
      model = update(model, Message.TimelineShowArchivedToggled()).model as Model
      const withArchived = renderText(model)
      expect(withArchived).toContain("memory:theme")
      expect(withArchived).toContain("archived")

      // Restore lifts the tombstone.
      model = (yield* drain(
        update,
        model,
        Message.TimelineNodeRestoreRequested({ nodeId: target.nodeId }),
      )) as Model
      expect(model.nodes.find((n) => n.nodeId === target.nodeId)?.archivedAt).toBeUndefined()
      expect(renderText(model)).toContain("memory:theme")
    }).pipe(Effect.provide(timelineLayers())),
  )

  it.effect("filters narrow the rendered list", () =>
    Effect.gen(function* () {
      yield* seedEvents
      let model = yield* refresh(initialModel)

      model = update(
        model,
        Message.TimelineNodeTypeFilterChanged({ nodeType: "curator.transitioned" }),
      ).model as Model
      const text = renderText(model)
      // The node list is filtered (the filter dropdown itself always lists
      // every type, so assert on subjects, not labels).
      expect(text).toContain("skill:old-notes")
      expect(text).not.toContain("memory:theme")
      expect(text).not.toContain("skill:notes")

      model = update(model, Message.TimelineNodeTypeFilterChanged({ nodeType: "" })).model as Model
      model = update(
        model,
        Message.TimelineSessionFilterChanged({ sessionId: "no-such-session" }),
      ).model as Model
      expect(renderText(model)).not.toContain("skill:old-notes")
    }).pipe(Effect.provide(timelineLayers())),
  )

  it.effect("budget header shows entries used / budget per store", () =>
    Effect.gen(function* () {
      yield* seedEvents
      const model = yield* refresh(initialModel)

      const text = renderText(model)
      expect(text).toContain("learning budget")
      expect(text).toContain("profile")
      // 1 profile-store entry used of the 500 budget.
      expect(text).toContain("1 / 500")
      // The pipeline events (verification/curator) count under "pipeline".
      expect(model.entriesUsed["pipeline"]).toBe(3)
    }).pipe(Effect.provide(timelineLayers())),
  )

  it.effect("expanding a node shows its full provenance", () =>
    Effect.gen(function* () {
      const seeded = yield* seedEvents
      const target = seeded[2] as LearningNode
      let model = yield* refresh(initialModel)

      // Collapsed: full node id and evidence not shown.
      expect(renderText(model)).not.toContain(target.nodeId)
      model = update(model, Message.TimelineNodeExpanded({ nodeId: target.nodeId })).model as Model
      const text = renderText(model)
      expect(text).toContain(target.nodeId)
      expect(text).toContain("verification-arm")
      expect(text).toContain("claim-1")
      expect(text).toContain("judge-1@v3")
    }).pipe(Effect.provide(timelineLayers())),
  )
})
