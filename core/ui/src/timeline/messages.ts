/**
 * ui/src/timeline/messages.ts — the timeline slice's Message vocabulary.
 *
 * Follows architecture §3.2 (Memory/learning): `MemoryEntryLearned`,
 * `MemoryEntryArchived`, `SkillCreated`, `SkillVerified`, `NarrativeAppended`,
 * `CompactionEventRecorded` arrive through the service-fed refresh; the
 * archive/restore controls are local intent Messages that produce Commands.
 */
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

import { TimelineNodeSchema } from "./model.js"

export const Message = defineMessageUnion({
  /** Initial load / explicit refresh: read the store, replace the snapshot. */
  TimelineRefreshRequested: {},
  /** The refresh Command's success result: the store's current nodes. */
  TimelineRefreshed: {
    nodes: Schema.Array(TimelineNodeSchema),
  },
  /** The refresh Command's failure result. */
  TimelineRefreshFailed: {
    reason: Schema.String,
  },
  TimelineNodeTypeFilterChanged: { nodeType: Schema.String },
  TimelineSessionFilterChanged: { sessionId: Schema.String },
  TimelineFromDateFilterChanged: { fromDate: Schema.String },
  TimelineToDateFilterChanged: { toDate: Schema.String },
  TimelineShowArchivedToggled: {},
  TimelineNodeExpanded: { nodeId: Schema.String },
  TimelineNodeCollapsed: { nodeId: Schema.String },
  /**
   * Archive-on-delete (Hermes curator pattern): the node is tombstoned in
   * the service, never destroyed. `reason` is user-supplied.
   */
  TimelineNodeArchiveRequested: {
    nodeId: Schema.String,
    reason: Schema.String,
  },
  /** The archive Command's success result: the tombstoned node. */
  TimelineNodeArchived: {
    node: TimelineNodeSchema,
  },
  /** Restore an archived node: the tombstone is lifted. */
  TimelineNodeRestoreRequested: {
    nodeId: Schema.String,
  },
  /** The restore Command's success result: the restored node. */
  TimelineNodeRestored: {
    node: TimelineNodeSchema,
  },
  /** Any archive/restore Command failure. */
  TimelineOperationFailed: {
    nodeId: Schema.String,
    action: Schema.String,
    reason: Schema.String,
  },
})
export type Message = typeof Message.Type
