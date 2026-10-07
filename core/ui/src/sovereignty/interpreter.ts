/**
 * sovereignty/interpreter.ts — the egress boundary enforcement logic.
 *
 * §3.6: "Enforcement is at the `NetworkEgress` command boundary — the
 * interpreter checks the toggle before the packet exists." The foldkit runtime
 * runs the command's Effect; the Effect calls `interpretEgress` with a toggle
 * snapshot taken from the Model at dispatch time. The snapshot travels in the
 * command args (update is pure — args are data, so the boundary decision is
 * fully deterministic and testable here).
 *
 * Fail-closed throughout: unknown classes, unknown endpoints/modules/pairs,
 * and anything not explicitly opted in is denied with a typed reason.
 */
import { Effect } from "effect"

import { isVendorNetworkClass } from "./model.js"
import type { Model } from "./model.js"

/** Toggle state as seen by the boundary, frozen at dispatch time. */
export interface ToggleSnapshot {
  readonly offlineMode: boolean
  readonly localInference: boolean
  readonly cloudEndpoints: ReadonlyArray<{ readonly id: string; readonly enabled: boolean }>
  readonly webResearch: ReadonlyArray<{ readonly moduleId: string; readonly enabled: boolean }>
  readonly updateChecks: boolean
  readonly trustedBroadcast: boolean
  readonly telemetry: boolean
  readonly lanDiscoverability: boolean
  readonly pairSyncScopes: ReadonlyArray<{ readonly pairId: string; readonly enabled: boolean }>
}

export interface EgressAttempt {
  readonly classId: string
  /** Endpoint id / module id / pair id for per-item classes; undefined for flat toggles. */
  readonly targetId: string | undefined
  readonly host: string
}

export type EgressDecision =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Denied"; readonly reason: string }

const denied = (reason: string): EgressDecision => ({ _tag: "Denied", reason })

/** Freeze the Model's toggles into the snapshot the boundary enforces. */
export const snapshotOf = (model: Model): ToggleSnapshot => ({
  offlineMode: model.offlineMode,
  localInference: model.localInference,
  cloudEndpoints: model.cloudEndpoints.map((e) => ({ id: e.id, enabled: e.enabled })),
  webResearch: model.webResearch.map((m) => ({ moduleId: m.moduleId, enabled: m.enabled })),
  updateChecks: model.updateChecks,
  trustedBroadcast: model.trustedBroadcast,
  telemetry: model.telemetry,
  lanDiscoverability: model.lanDiscoverability,
  pairSyncScopes: model.pairSyncScopes.map((p) => ({ pairId: p.pairId, enabled: p.enabled }))
})

/**
 * The boundary check. Offline mode denies every vendor-network class in one
 * gesture; first-party LAN keeps its own toggles. A toggle flipped off
 * mid-flight cancels in-flight egress via the command's interrupt key
 * (see commands.ts) — this function is the per-attempt half of fail-closed.
 */
export const interpretEgress = (
  snapshot: ToggleSnapshot,
  attempt: EgressAttempt
): Effect.Effect<EgressDecision, never> =>
  Effect.suspend(() => {
    if (snapshot.offlineMode && isVendorNetworkClass(attempt.classId)) {
      return Effect.succeed(
        denied(`offline mode: ${attempt.classId} denied — all vendor-network classes are off`)
      )
    }
    switch (attempt.classId) {
      case "localInference":
        return Effect.succeed(
          snapshot.localInference ? { _tag: "Allowed" } : denied("local inference toggle is off")
        )
      case "cloudEndpoint": {
        const endpoint = snapshot.cloudEndpoints.find((e) => e.id === attempt.targetId)
        if (endpoint === undefined) {
          return Effect.succeed(denied(`unknown cloud endpoint '${attempt.targetId ?? "(none)"}' — fail-closed`))
        }
        return Effect.succeed(
          endpoint.enabled ? { _tag: "Allowed" } : denied(`cloud endpoint '${endpoint.id}' is not opted in`)
        )
      }
      case "webResearch": {
        const mod = snapshot.webResearch.find((m) => m.moduleId === attempt.targetId)
        if (mod === undefined) {
          return Effect.succeed(denied(`unknown web-research module '${attempt.targetId ?? "(none)"}' — fail-closed`))
        }
        return Effect.succeed(
          mod.enabled ? { _tag: "Allowed" } : denied(`web-research module '${mod.moduleId}' is not opted in`)
        )
      }
      case "updateChecks":
        return Effect.succeed(
          snapshot.updateChecks ? { _tag: "Allowed" } : denied("update checks are off")
        )
      case "trustedBroadcast":
        return Effect.succeed(
          snapshot.trustedBroadcast ? { _tag: "Allowed" } : denied("trusted broadcast subscription is off")
        )
      case "telemetry":
        return Effect.succeed(snapshot.telemetry ? { _tag: "Allowed" } : denied("telemetry is off"))
      case "lanDiscovery":
        return Effect.succeed(
          snapshot.lanDiscoverability ? { _tag: "Allowed" } : denied("LAN discoverability is off")
        )
      case "pairSync": {
        const pair = snapshot.pairSyncScopes.find((p) => p.pairId === attempt.targetId)
        if (pair === undefined) {
          return Effect.succeed(denied(`unknown pair '${attempt.targetId ?? "(none)"}' — fail-closed`))
        }
        return Effect.succeed(
          pair.enabled ? { _tag: "Allowed" } : denied(`sync scope for pair '${pair.pairId}' is off`)
        )
      }
      default:
        return Effect.succeed(denied(`unknown network intent class '${attempt.classId}' — fail-closed`))
    }
  })
