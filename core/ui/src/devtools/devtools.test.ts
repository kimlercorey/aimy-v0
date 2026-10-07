/**
 * devtools/devtools.test.ts — the adversarial-review gate and the timeline.
 */
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import type { SerializedEntry } from "foldkit/devtools-protocol"

import { PublishTimelineSnapshot } from "./commands.js"
import { Message } from "./messages.js"
import { initialModel, MCP_BIND_HOST } from "./model.js"
import { DevtoolsRelay, DevtoolsRelayUnwired } from "./seam.js"
import { update } from "./update.js"

const makeEntry = (index: number, tag: string): SerializedEntry => ({
  index,
  tag,
  message: { _tag: tag },
  commands: [],
  mountStarts: [],
  mountEnds: [],
  timestamp: 1728288000000 + index * 1000,
  isModelChanged: true,
  changedPaths: ["sovereignty.telemetry"],
  affectedPaths: ["sovereignty"],
  submodelPath: [],
  maybeLeafTag: Option.none()
})

const enabled = () => update(initialModel(), Message.DevtoolsReviewChanged({ enabled: true })).model

describe("the adversarial-review gate", () => {
  it("defaults OFF", () => {
    expect(initialModel().adversarialReviewEnabled).toBe(false)
  })

  it("when off, timeline messages are rejected — the surface does not exist", () => {
    const model = initialModel()
    const appended = update(model, Message.TimelineAppended({ entry: makeEntry(0, "Foo") }))
    expect(appended.model.entries).toEqual([])
    expect(appended.commands).toBeUndefined()

    const selected = update(model, Message.TimelineEntrySelected({ index: 0 }))
    expect(selected.model).toBe(model)

    const cleared = update(model, Message.TimelineCleared())
    expect(cleared.model).toBe(model)

    const published = update(model, Message.SnapshotPublishRequested())
    expect(published.model).toBe(model)
    expect(published.commands).toBeUndefined()
  })

  it("enabling the gate opens the surface; disabling wipes it", () => {
    const on = enabled()
    expect(on.adversarialReviewEnabled).toBe(true)
    const withEntry = update(on, Message.TimelineAppended({ entry: makeEntry(0, "Foo") })).model
    expect(withEntry.entries).toHaveLength(1)
    const off = update(withEntry, Message.DevtoolsReviewChanged({ enabled: false })).model
    expect(off.adversarialReviewEnabled).toBe(false)
    expect(off.entries).toEqual([])
  })
})

describe("the message timeline", () => {
  it("appends, selects, and clears entries", () => {
    let model = enabled()
    model = update(model, Message.TimelineAppended({ entry: makeEntry(0, "ToggleFlipStamped") })).model
    model = update(model, Message.TimelineAppended({ entry: makeEntry(1, "EgressDenied") })).model
    expect(model.entries.map((e) => e.tag)).toEqual(["ToggleFlipStamped", "EgressDenied"])
    model = update(model, Message.TimelineEntrySelected({ index: 1 })).model
    expect(model.selectedIndex).toBe(1)
    model = update(model, Message.TimelineCleared()).model
    expect(model.entries).toEqual([])
    expect(model.selectedIndex).toBeUndefined()
  })

  it("publishing a snapshot emits the command only when the gate is on", () => {
    const model = update(enabled(), Message.TimelineAppended({ entry: makeEntry(0, "Foo") })).model
    const result = update(model, Message.SnapshotPublishRequested())
    expect(result.commands).toHaveLength(1)
    expect(result.commands?.[0]?.name).toBe("PublishTimelineSnapshot")
  })
})

describe("loopback-only MCP exposure", () => {
  it("binds to 127.0.0.1 — never 0.0.0.0", () => {
    expect(MCP_BIND_HOST).toBe("127.0.0.1")
  })

  it("the unwired relay fails closed", async () => {
    const msg = await Effect.runPromise(
      Effect.provide(
        PublishTimelineSnapshot({ entries: [makeEntry(0, "Foo")] }).effect,
        Layer.succeed(DevtoolsRelay, DevtoolsRelayUnwired)
      )
    )
    expect(msg._tag).toBe("SnapshotPublishDenied")
    if (msg._tag === "SnapshotPublishDenied") {
      expect(msg.reason).toBe("devtools:relay-not-bound")
    }
  })

  it("a bound relay publishes the snapshot", async () => {
    let published = 0
    const msg = await Effect.runPromise(
      Effect.provide(
        PublishTimelineSnapshot({ entries: [makeEntry(0, "Foo"), makeEntry(1, "Bar")] }).effect,
        Layer.succeed(DevtoolsRelay, {
          bindHost: MCP_BIND_HOST,
          publish: (entries) => Effect.sync(() => { published = entries.length })
        })
      )
    )
    expect(published).toBe(2)
    expect(msg._tag).toBe("SnapshotPublished")
    if (msg._tag === "SnapshotPublished") {
      expect(msg.entryCount).toBe(2)
    }
  })
})
