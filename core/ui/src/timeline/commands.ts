/**
 * ui/src/timeline/commands.ts — foldkit Commands for the timeline slice.
 *
 * Commands are data describing effects; the Effect runtime interprets them at
 * the shell boundary with the live services provided (`TimelineStore`,
 * `LearningTimeline`). Every execute path catches its errors and returns a
 * failure Message — Commands never fail silently, and never throw into update.
 */
import { Effect, Schema } from "effect"
import { define as defineCommand } from "foldkit/command"

import { LearningTimeline } from "../../../learning/src/timeline.js"
import { Message } from "./messages.js"
import { TimelineNodeSchema } from "./model.js"

const decodeNodes = Schema.decodeUnknownEffect(Schema.Array(TimelineNodeSchema))
const decodeNode = Schema.decodeUnknownEffect(TimelineNodeSchema)

const ARCHIVE_PROVENANCE = {
  origin: "user" as const,
  sessionId: "ui",
  profileId: "ui",
}

/**
 * Read the timeline's nodes through the service boundary (never the store
 * directly — the store is the service's private dependency).
 */
export const RefreshTimeline = defineCommand("timeline/refresh", {
  messages: [Message.TimelineRefreshed, Message.TimelineRefreshFailed],
  execute: Effect.gen(function* () {
    const timeline = yield* LearningTimeline
    const nodes = yield* timeline.query({})
    const sorted = [...nodes].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
    return Message.TimelineRefreshed({ nodes: yield* decodeNodes(sorted) })
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Message.TimelineRefreshFailed({ reason: String(cause) }),
      ),
    ),
  ),
})

/** Archive-on-delete: tombstone the node via the real service. */
export const ArchiveTimelineNode = defineCommand("timeline/archive-node", {
  args: { nodeId: Schema.String, reason: Schema.String },
  messages: [Message.TimelineNodeArchived, Message.TimelineOperationFailed],
  execute: ({ nodeId, reason }) =>
    Effect.gen(function* () {
      const timeline = yield* LearningTimeline
      const node = yield* timeline.archiveNode(nodeId, {
        reason,
        provenance: ARCHIVE_PROVENANCE,
      })
      return Message.TimelineNodeArchived({ node: yield* decodeNode(node) })
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          Message.TimelineOperationFailed({
            nodeId,
            action: "archive",
            reason: String(cause),
          }),
        ),
      ),
    ),
})

/** Restore an archived node: lift the tombstone via the real service. */
export const RestoreTimelineNode = defineCommand("timeline/restore-node", {
  args: { nodeId: Schema.String },
  messages: [Message.TimelineNodeRestored, Message.TimelineOperationFailed],
  execute: ({ nodeId }) =>
    Effect.gen(function* () {
      const timeline = yield* LearningTimeline
      const node = yield* timeline.restoreNode(nodeId, {
        reason: "restored from timeline view",
        provenance: ARCHIVE_PROVENANCE,
      })
      return Message.TimelineNodeRestored({ node: yield* decodeNode(node) })
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          Message.TimelineOperationFailed({
            nodeId,
            action: "restore",
            reason: String(cause),
          }),
        ),
      ),
    ),
})
