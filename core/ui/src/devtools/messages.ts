/**
 * devtools/messages.ts
 */
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { SerializedEntry } from "foldkit/devtools-protocol"

export const Message = defineMessageUnion({
  DevtoolsReviewChanged: { enabled: Schema.Boolean },
  TimelineAppended: { entry: SerializedEntry },
  TimelineEntrySelected: { index: Schema.Number },
  TimelineCleared: {},
  SnapshotPublishRequested: {},
  SnapshotPublished: { entryCount: Schema.Number },
  SnapshotPublishDenied: { reason: Schema.String }
})
export type Message = typeof Message.Type
