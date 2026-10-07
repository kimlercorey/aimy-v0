/**
 * ASC panel update — the pure `(Message, Model) → (Model, Command[])` for the
 * `asc` slice.
 *
 * The computed-not-chosen rule, structurally: no message variant in this
 * slice can set dials except `DialComputationArchived`, which carries a
 * computation the ASC pipeline already wrote (a read-only write). The ONLY
 * effect this slice can produce is `RecordTuningChange`, which calls the
 * frozen boundary's `recordEvidence({ kind: "tuningChange", ... })` — the
 * single legitimate route into the internal tuning seam
 * (`AscSelfModel.recordTuningChange`). This panel never touches DialState,
 * the L2 pipeline, or any internal service directly.
 */
import { Cause, Effect, Schema } from "effect"
import { define as defineCommand } from "foldkit/command"
import { Update } from "foldkit"

import { ASCEngine } from "../../../asc-engine/engine.js"
import type { AscError } from "../../../asc-engine/errors-shim.js"

import {
  DIAL_HISTORY_CAP,
  ERROR_FIRING_CAP,
  GUARD_FEED_CAP,
  TUNING_LOG_CAP,
  type AscSlice,
} from "./model.js"
import { Message, type AscMessage } from "./messages.js"

// --- commands -----------------------------------------------------------------

/**
 * The ONLY write this panel can issue. Calls the frozen
 * `ASCEngine.recordEvidence` with kind `"tuningChange"`, which routes
 * internally to `AscSelfModel.recordTuningChange` (the tuning seam): the
 * change lands in L1's affect-tuning record AND the live targets —
 * auditable, versioned, never a silent overwrite.
 *
 * Foldkit commands are infallible in the error channel, so a rejected change
 * becomes `TuningChangeFailed` — a message, never a silent drop.
 */
/** Extract a human-readable reason from a tuning-change failure cause. */
const failureReason = (cause: Cause.Cause<AscError>): string => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) return reason.error.reason
  }
  return Cause.pretty(cause)
}

export const RecordTuningChange = defineCommand("RecordTuningChange", {
  args: {
    parameter: Schema.String,
    from: Schema.Number,
    to: Schema.Number,
  },
  messages: [Message.TuningChangeRecorded, Message.TuningChangeFailed],
  execute: ({ parameter, from, to }) =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      const exit = yield* Effect.exit(
        engine.recordEvidence({
          kind: "tuningChange",
          payload: { parameter, from, to },
        }),
      )
      const at = new Date().toISOString()
      if (exit._tag === "Success") {
        return Message.TuningChangeRecorded({ parameter, from, to, at })
      }
      return Message.TuningChangeFailed({
        parameter,
        reason: failureReason(exit.cause),
        at,
      })
    }),
})

// --- update -------------------------------------------------------------------

export const update = (
  model: AscSlice,
  message: AscMessage,
): Update.Return<AscSlice, AscMessage, ASCEngine> =>
  Message.match<Update.Return<AscSlice, AscMessage, ASCEngine>>(message, {
    DialComputationArchived: ({ computation }) => ({
      model: {
        ...model,
        dials: computation.finalDials,
        dialHistory: [...model.dialHistory, computation].slice(-DIAL_HISTORY_CAP),
      },
    }),

    OtherModelGuardFired: ({ classification }) => ({
      model: {
        ...model,
        guardFeed: [classification, ...model.guardFeed].slice(0, GUARD_FEED_CAP),
      },
    }),

    ErrorTermFired: ({ firing }) => {
      const existing = model.capabilityMap[firing.domain]
      return {
        model: {
          ...model,
          errorFirings: [firing, ...model.errorFirings].slice(0, ERROR_FIRING_CAP),
          capabilityMap:
            existing === undefined
              ? model.capabilityMap
              : {
                  ...model.capabilityMap,
                  [firing.domain]: { ...existing, observed: firing.observedConfidence },
                },
        },
      }
    },

    AffectTuningChanged: ({ parameter, to }) => {
      const target = model.tuning.find((t) => t.parameter === parameter)
      // Unknown parameters are never sent to the seam: the tuning record
      // only accepts the declared paper §VII.C parameters.
      if (target === undefined) return { model }
      const clamped = Math.min(target.max, Math.max(target.min, to))
      return {
        model: { ...model, tuningError: null },
        commands: [RecordTuningChange({ parameter, from: target.value, to: clamped })],
      }
    },

    DiagnosticRunCompleted: ({ at, passed, total, regressedDomains }) => ({
      model: { ...model, diagnostic: { at, passed, total, regressedDomains } },
    }),

    TuningChangeRecorded: ({ parameter, from, to, at }) => ({
      model: {
        ...model,
        tuning: model.tuning.map((t) =>
          t.parameter === parameter ? { ...t, value: to } : t,
        ),
        tuningLog: [...model.tuningLog, { at, parameter, from, to }].slice(-TUNING_LOG_CAP),
        tuningError: null,
      },
    }),

    TuningChangeFailed: ({ parameter, reason, at }) => ({
      model: { ...model, tuningError: { at, parameter, reason } },
    }),

    PreviewRendererChanged: ({ renderer }) => ({
      model: { ...model, renderer },
    }),
  })
