/**
 * sovereignty/update.ts — pure update for the sovereignty toggles panel.
 *
 * Toggle flips land in the Model and in the opt-in ledger (what / when /
 * stated data flow). A flip to off additionally emits the interrupt command
 * for that class's in-flight egress — fail-closed. Offline mode flips the
 * master switch and interrupts every vendor-network class; first-party LAN
 * toggles are untouched.
 */
import type { Return as UpdateReturn } from "foldkit/update"

import { interruptEgressFor, StampTime } from "./commands.js"
import { inventoryRowFor, VENDOR_NETWORK_CLASSES, type Model, type OptInEntry } from "./model.js"
import { Message } from "./messages.js"

type Return = UpdateReturn<Model, Message>

const classKeyOf = (classId: string, targetId: string | undefined): string =>
  targetId === undefined ? classId : `${classId}:${targetId}`

const labelFor = (model: Model, classId: string, targetId: string | undefined): string => {
  const row = inventoryRowFor(classId)
  const base = row?.label ?? classId
  if (targetId === undefined) return base
  const target =
    model.cloudEndpoints.find((e) => e.id === targetId)?.label ??
    model.webResearch.find((m) => m.moduleId === targetId)?.moduleLabel ??
    model.pairSyncScopes.find((p) => p.pairId === targetId)?.pairLabel ??
    targetId
  return `${base} — ${target}`
}

const flipToggle = (
  model: Model,
  classId: string,
  targetId: string | undefined,
  enabled: boolean
): Model => {
  switch (classId) {
    case "localInference":
      return { ...model, localInference: enabled }
    case "updateChecks":
      return { ...model, updateChecks: enabled }
    case "trustedBroadcast":
      return { ...model, trustedBroadcast: enabled }
    case "telemetry":
      return { ...model, telemetry: enabled }
    case "lanDiscovery":
      return { ...model, lanDiscoverability: enabled }
    case "cloudEndpoint":
      return {
        ...model,
        cloudEndpoints: model.cloudEndpoints.map((e) =>
          e.id === targetId ? { ...e, enabled } : e
        )
      }
    case "webResearch":
      return {
        ...model,
        webResearch: model.webResearch.map((m) =>
          m.moduleId === targetId ? { ...m, enabled } : m
        )
      }
    case "pairSync":
      return {
        ...model,
        pairSyncScopes: model.pairSyncScopes.map((p) =>
          p.pairId === targetId ? { ...p, enabled } : p
        )
      }
    default:
      return model
  }
}

/** Record the flip in the opt-in ledger: grant appends, revoke closes the open entry. */
const recordLedger = (
  model: Model,
  classId: string,
  targetId: string | undefined,
  enabled: boolean,
  at: string
): Model => {
  const key = classKeyOf(classId, targetId)
  if (enabled) {
    const entry: OptInEntry = {
      id: `optin-${model.ledgerSeq + 1}`,
      classId: key,
      label: labelFor(model, classId, targetId),
      statedDataFlow: inventoryRowFor(classId)?.statedDataFlow ?? "",
      grantedAt: at
    }
    return {
      ...model,
      optInLedger: [...model.optInLedger, entry],
      ledgerSeq: model.ledgerSeq + 1
    }
  }
  let openIndex = -1
  for (let i = model.optInLedger.length - 1; i >= 0; i--) {
    const e = model.optInLedger[i]
    if (e !== undefined && e.classId === key && e.revokedAt === undefined) {
      openIndex = i
      break
    }
  }
  if (openIndex < 0) return model
  return {
    ...model,
    optInLedger: model.optInLedger.map((e, i) =>
      i === openIndex ? { ...e, revokedAt: at } : e
    )
  }
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ToggleFlipRequested: ({ classId, targetId, enabled }) => ({
      model,
      commands: [StampTime({ purpose: "toggle", classId, targetId, enabled })]
    }),
    ToggleFlipStamped: ({ classId, targetId, enabled, at }) => {
      const next = recordLedger(flipToggle(model, classId, targetId, enabled), classId, targetId, enabled, at)
      // Fail-closed: a toggle flipped off mid-flight cancels the in-flight egress.
      return enabled ? { model: next } : { model: next, commands: [interruptEgressFor(classId)] }
    },
    OfflineModeRequested: ({ enabled }) => ({
      model,
      commands: [StampTime({ purpose: "offline", enabled })]
    }),
    OfflineModeStamped: ({ enabled }) => {
      const next = { ...model, offlineMode: enabled }
      if (!enabled) return { model: next }
      // One gesture denies all vendor-network classes; LAN keeps its own toggles.
      return {
        model: next,
        commands: VENDOR_NETWORK_CLASSES.map((classId) => interruptEgressFor(classId))
      }
    },
    OptInGranted: ({ classId, label, statedDataFlow, at }) => ({
      model: {
        ...model,
        optInLedger: [
          ...model.optInLedger,
          { id: `optin-${model.ledgerSeq + 1}`, classId, label, statedDataFlow, grantedAt: at }
        ],
        ledgerSeq: model.ledgerSeq + 1
      }
    }),
    OptInRevoked: ({ entryId, at }) => ({
      model: {
        ...model,
        optInLedger: model.optInLedger.map((e) =>
          e.id === entryId && e.revokedAt === undefined ? { ...e, revokedAt: at } : e
        )
      }
    }),
    EgressInterruptCompleted: ({ classId, outcome }) => {
      if (outcome !== "Interrupted") return { model }
      return {
        model: {
          ...model,
          inflightCancelled: model.inflightCancelled.includes(classId)
            ? model.inflightCancelled
            : [...model.inflightCancelled, classId]
        }
      }
    },
    EgressAllowed: () => ({ model }),
    EgressDenied: () => ({ model })
  })
