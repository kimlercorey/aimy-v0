/**
 * devtools/update.ts — pure update with the adversarial-review gate.
 *
 * When the flag is off, every message except the flag flip itself is
 * rejected: the model is returned unchanged, no commands, no view surface.
 * Not hidden — nonexistent.
 */
import type { Return as UpdateReturn } from "foldkit/update"

import { PublishTimelineSnapshot } from "./commands.js"
import { DevtoolsRelay } from "./seam.js"
import { Message } from "./messages.js"
import { type Model } from "./model.js"

type Return = UpdateReturn<Model, Message, DevtoolsRelay>

export const update = (model: Model, message: Message): Return => {
  if (!model.adversarialReviewEnabled && message._tag !== "DevtoolsReviewChanged") {
    return { model }
  }
  return Message.match<Return>(message, {
    DevtoolsReviewChanged: ({ enabled }) => ({
      model: {
        ...model,
        adversarialReviewEnabled: enabled,
        // Disabling the gate wipes the surface: nothing retained while off.
        entries: enabled ? model.entries : [],
        selectedIndex: undefined
      }
    }),
    TimelineAppended: ({ entry }) => ({
      model: { ...model, entries: [...model.entries, entry] }
    }),
    TimelineEntrySelected: ({ index }) => ({
      model: { ...model, selectedIndex: index }
    }),
    TimelineCleared: () => ({
      model: { ...model, entries: [], selectedIndex: undefined }
    }),
    SnapshotPublishRequested: () => ({
      model,
      commands: [PublishTimelineSnapshot({ entries: model.entries })]
    }),
    SnapshotPublished: () => ({ model }),
    SnapshotPublishDenied: () => ({ model })
  })
}
