/**
 * sovereignty/commands.ts — foldkit Commands for the sovereignty slice.
 *
 * - `NetworkEgress`: the boundary. Interruptible, keyed by intent class, so a
 *   toggle flipped off mid-flight cancels the in-flight egress (fail-closed):
 *   update answers the flip with `NetworkEgress.Interrupt({ classId }, …)`,
 *   and the runtime stops every holder of that key — their result messages
 *   are guaranteed never to dispatch.
 * - `StampTime`: reads the clock for the opt-in ledger (the view is pure and
 *   cannot stamp time; update stays pure by delegating to this command).
 */
import { Clock, Effect, Schema } from "effect"
import * as Command from "foldkit/command"

import { interpretEgress, type ToggleSnapshot } from "./interpreter.js"
import { Message } from "./messages.js"

export const ToggleSnapshotSchema: Schema.Schema<ToggleSnapshot> = Schema.Struct({
  offlineMode: Schema.Boolean,
  localInference: Schema.Boolean,
  cloudEndpoints: Schema.Array(
    Schema.Struct({ id: Schema.String, enabled: Schema.Boolean })
  ),
  webRetrieval: Schema.Array(
    Schema.Struct({ moduleId: Schema.String, enabled: Schema.Boolean })
  ),
  updateChecks: Schema.Boolean,
  trustedBroadcast: Schema.Boolean,
  telemetry: Schema.Boolean,
  lanDiscoverability: Schema.Boolean,
  pairSyncScopes: Schema.Array(
    Schema.Struct({ pairId: Schema.String, enabled: Schema.Boolean })
  )
})

export const NetworkEgress = Command.define("NetworkEgress", {
  args: {
    classId: Schema.String,
    targetId: Schema.optional(Schema.String),
    host: Schema.String,
    snapshot: ToggleSnapshotSchema
  },
  messages: [Message.EgressAllowed, Message.EgressDenied],
  interrupt: {
    keyFields: ["classId"],
    toKey: ({ classId }: { readonly classId: string }) => `egress:${classId}`
  },
  execute: ({ classId, targetId, host, snapshot }) =>
    interpretEgress(snapshot, { classId, targetId, host }).pipe(
      Effect.map((decision) =>
        decision._tag === "Allowed"
          ? Message.EgressAllowed({ classId, host })
          : Message.EgressDenied({ classId, host, reason: decision.reason })
      )
    )
})

/** Build the fail-closed interrupt for a class whose toggle just flipped off. */
export const interruptEgressFor = (classId: string) =>
  NetworkEgress.Interrupt({ classId }, (outcome) =>
    Message.EgressInterruptCompleted({ classId, outcome: outcome._tag })
  )

export const StampTime = Command.define("StampTime", {
  args: {
    purpose: Schema.Literals(["toggle", "offline"]),
    classId: Schema.optional(Schema.String),
    targetId: Schema.optional(Schema.String),
    enabled: Schema.Boolean
  },
  messages: [Message.ToggleFlipStamped, Message.OfflineModeStamped],
  execute: ({ purpose, classId, targetId, enabled }) =>
    Effect.map(Clock.currentTimeMillis, (ms) => {
      const at = new Date(ms).toISOString()
      return purpose === "offline"
        ? Message.OfflineModeStamped({ enabled, at })
        : Message.ToggleFlipStamped({ classId: classId ?? "unknown", targetId, enabled, at })
    })
})
