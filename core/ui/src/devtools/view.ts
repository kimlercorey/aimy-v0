/**
 * devtools/view.ts — the message-timeline view.
 *
 * When the adversarial-review flag is off, the surface does not exist: the
 * view renders an empty node and update rejects every message. When on, the
 * timeline shows each message's tag, timestamp, and the model paths it
 * changed — the inspect/history half of §3.9.
 */
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SerializedEntry } from "foldkit/devtools-protocol"

import { Message } from "./messages.js"
import { MCP_BIND_HOST, type Model } from "./model.js"

type H = HtmlBuilder<Message>

const entryRow = (h: H, entry: SerializedEntry, selected: boolean): Html =>
  h.li([h.Class(selected ? "tl-entry selected" : "tl-entry")], [
    h.button(
      [h.OnClick(Message.TimelineEntrySelected({ index: entry.index }))],
      [`#${entry.index} ${entry.tag}`]
    ),
    h.span(
      [h.Class("tl-meta")],
      [
        new Date(entry.timestamp).toISOString(),
        ...(entry.isModelChanged ? [" — model changed"] : [" — no model change"])
      ]
    )
  ])

const entryDetail = (h: H, entry: SerializedEntry): Html =>
  h.section([h.Class("tl-detail")], [
    h.h3([], [`#${entry.index} — ${entry.tag}`]),
    h.p([], [`At: ${new Date(entry.timestamp).toISOString()}`]),
    h.p([], [`Changed paths: ${entry.changedPaths.join(", ") || "(none)"}`]),
    h.p([], [`Affected paths: ${entry.affectedPaths.join(", ") || "(none)"}`]),
    h.p([], [`Commands emitted: ${entry.commands.map((c) => c.name).join(", ") || "(none)"}`])
  ])

export const view = (model: Model, h: H): Html => {
  if (!model.adversarialReviewEnabled) {
    return h.div([], [])
  }
  const selected =
    model.selectedIndex === undefined
      ? undefined
      : model.entries.find((e) => e.index === model.selectedIndex)
  return h.main([h.Class("devtools")], [
    h.header([], [
      h.h2([], ["DevTools — message timeline"]),
      h.p([h.Class("lede")], [
        `MCP exposure binds to ${MCP_BIND_HOST} only. Messages in order, the model diff each produced, the commands each emitted.`
      ])
    ]),
    h.div([h.Class("row")], [
      h.button([h.OnClick(Message.SnapshotPublishRequested())], ["Publish snapshot"]),
      h.button([h.OnClick(Message.TimelineCleared())], ["Clear"]),
      h.button(
        [h.OnClick(Message.DevtoolsReviewChanged({ enabled: false }))],
        ["Disable DevTools"]
      )
    ]),
    ...(model.entries.length === 0
      ? [h.p([h.Class("empty-note")], ["No messages yet."])]
      : [
          h.ul(
            [],
            model.entries.map((entry) =>
              entryRow(h, entry, entry.index === model.selectedIndex)
            )
          )
        ]),
    ...(selected !== undefined ? [entryDetail(h, selected)] : [])
  ])
}
