/**
 * devtools/commands.ts — the PublishTimelineSnapshot command.
 *
 * Emitted only when the adversarial-review flag is on (update enforces the
 * gate before any command is built). The relay it publishes through is the
 * loopback-bound MCP relay from seam.ts.
 */
import { Effect, Schema } from "effect"
import * as Command from "foldkit/command"
import { SerializedEntry } from "foldkit/devtools-protocol"

import { Message } from "./messages.js"
import { DevtoolsRelay } from "./seam.js"

export const PublishTimelineSnapshot = Command.define("PublishTimelineSnapshot", {
  args: { entries: Schema.Array(SerializedEntry) },
  messages: [Message.SnapshotPublished, Message.SnapshotPublishDenied],
  execute: ({ entries }) =>
    Effect.match(Effect.flatMap(DevtoolsRelay, (relay) => relay.publish(entries)), {
      onFailure: (error) => Message.SnapshotPublishDenied({ reason: error.reason }),
      onSuccess: () => Message.SnapshotPublished({ entryCount: entries.length })
    })
})
