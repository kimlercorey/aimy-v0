/**
 * Deterministic module lifecycle state machine.
 *
 * States: installed -> enabled -> running; disabled; updating (staged
 * side-by-side, explicit activation); removed.
 *
 * Update policy (self-update is safety-critical):
 * - No silent auto-update. New versions stage side-by-side; the old version
 *   is kept; activation is explicit; rollback is one click.
 * - Manifest widening requires a fresh trust decision; narrowing is free.
 * - The updater surface stays minimal and the transitions are pure so they
 *   can be property-tested.
 *
 * Removal is non-destructive to continuity: code + per-instance config are
 * deleted, but memory/skill entries the module created are ARCHIVED, never
 * silently deleted.
 *
 * Lifecycle STATE and OUTCOME records are separate types (Hermes #68499):
 * `ModuleRecord` is the current state; `LifecycleOutcome` is the append-only
 * log of what happened.
 */
import { Cause, Context, Effect, Exit, Layer, Ref } from "effect"
import { ModuleError, TrustDecisionRequired } from "./errors.js"
import type { CapabilityManifest } from "./manifest.js"

export type LifecycleState = "installed" | "enabled" | "running" | "disabled" | "updating" | "removed"

export interface TrustDecision {
  readonly decidedAt: number
  /** Widened capability descriptors this decision covers (from diffCapabilities). */
  readonly widened: ReadonlyArray<string>
  readonly approved: boolean
}

export interface StagedUpdate {
  readonly version: string
  readonly manifest: CapabilityManifest
  /** State to resume after activation (the state the module was in when staged). */
  readonly resumeState: LifecycleState
}

export interface PreviousVersion {
  readonly version: string
  readonly manifest: CapabilityManifest
}

export interface ModuleArtifacts {
  /** IDs of memory entries the module created (archived on remove, never deleted). */
  readonly memoryEntries: ReadonlyArray<string>
  /** IDs of skill entries the module created (archived on remove, never deleted). */
  readonly skillEntries: ReadonlyArray<string>
}

export interface ArchiveRecord {
  readonly moduleId: string
  readonly archivedMemoryEntries: ReadonlyArray<string>
  readonly archivedSkillEntries: ReadonlyArray<string>
  readonly at: number
}

export interface ModuleRecord {
  readonly moduleId: string
  readonly name: string
  readonly version: string
  readonly state: LifecycleState
  readonly manifest: CapabilityManifest
  readonly staged: StagedUpdate | undefined
  readonly previous: PreviousVersion | undefined
  readonly trustDecisions: ReadonlyArray<TrustDecision>
  readonly artifacts: ModuleArtifacts
}

/** Outcome log entry. Separate from state: history is never rewritten. */
export interface LifecycleOutcome {
  readonly moduleId: string
  readonly transition: string
  readonly from: LifecycleState
  readonly to: LifecycleState
  readonly at: number
  readonly result: "ok" | "failed"
  readonly detail?: string
}

export type LifecycleEvent =
  | { readonly _tag: "Enable" }
  | { readonly _tag: "Disable" }
  | { readonly _tag: "Start" }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "StageUpdate"; readonly version: string; readonly manifest: CapabilityManifest }
  | { readonly _tag: "ActivateUpdate"; readonly trust?: TrustDecision }
  | { readonly _tag: "Rollback" }

export interface CapabilityDiff {
  readonly widened: ReadonlyArray<string>
  readonly narrowed: ReadonlyArray<string>
}

const networkRank = (n: CapabilityManifest["network"]): number =>
  n === "none" ? 0 : n === "first-party" ? 1 : 2

/**
 * Diff two capability manifests. Anything the new manifest ADDS is "widened"
 * (needs a fresh trust decision); anything it drops is "narrowed" (free).
 * Descriptors are human-readable strings like "tool:+web_fetch".
 */
export const diffCapabilities = (oldM: CapabilityManifest, newM: CapabilityManifest): CapabilityDiff => {
  const widened: Array<string> = []
  const narrowed: Array<string> = []

  for (const t of newM.tools) if (!oldM.tools.includes(t)) widened.push(`tool:+${t}`)
  for (const t of oldM.tools) if (!newM.tools.includes(t)) narrowed.push(`tool:-${t}`)
  for (const h of newM.hooks) if (!oldM.hooks.includes(h)) widened.push(`hook:+${h}`)
  for (const p of newM.filesystem.read) if (!oldM.filesystem.read.includes(p)) widened.push(`fs.read:+${p}`)
  for (const p of oldM.filesystem.read) if (!newM.filesystem.read.includes(p)) narrowed.push(`fs.read:-${p}`)
  for (const p of newM.filesystem.write) if (!oldM.filesystem.write.includes(p)) widened.push(`fs.write:+${p}`)
  for (const p of oldM.filesystem.write) if (!newM.filesystem.write.includes(p)) narrowed.push(`fs.write:-${p}`)

  const or_ = networkRank(oldM.network)
  const nr = networkRank(newM.network)
  if (nr > or_) widened.push(`network:${label(oldM.network)}->${label(newM.network)}`)
  if (nr < or_) narrowed.push(`network:${label(oldM.network)}->${label(newM.network)}`)
  if (typeof oldM.network === "object" && typeof newM.network === "object") {
    for (const h of newM.network.vendorHosts) {
      if (!oldM.network.vendorHosts.includes(h)) widened.push(`network.host:+${h}`)
    }
    for (const h of oldM.network.vendorHosts) {
      if (!newM.network.vendorHosts.includes(h)) narrowed.push(`network.host:-${h}`)
    }
  }

  for (const s of newM.memory.stores) if (!oldM.memory.stores.includes(s)) widened.push(`memory.store:+${s}`)
  for (const s of oldM.memory.stores) if (!newM.memory.stores.includes(s)) narrowed.push(`memory.store:-${s}`)
  if (!oldM.memory.write && newM.memory.write) widened.push("memory.write:off->on")
  if (oldM.memory.write && !newM.memory.write) narrowed.push("memory.write:on->off")
  if (!oldM.subprocess && newM.subprocess) widened.push("subprocess:off->on")
  if (oldM.subprocess && !newM.subprocess) narrowed.push("subprocess:on->off")

  return { widened, narrowed }
}

const label = (n: CapabilityManifest["network"]): string => (typeof n === "string" ? n : "vendor-hosts")

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((x) => b.includes(x))

/**
 * Pure transition function. Returns the updated record, or a typed error.
 * `now` is injected for determinism (tests / property tests).
 */
export const transition = (
  record: ModuleRecord,
  event: LifecycleEvent,
  now: number = Date.now()
): Effect.Effect<ModuleRecord, ModuleError | TrustDecisionRequired> => {
  const bad = (reason: string) =>
    Effect.fail(new ModuleError({ module: record.moduleId, reason }))

  switch (event._tag) {
    case "Enable":
      if (record.state === "installed" || record.state === "disabled") {
        return Effect.succeed({ ...record, state: "enabled" as const })
      }
      return bad(`cannot Enable from state '${record.state}'`)

    case "Disable":
      if (record.state === "enabled" || record.state === "running") {
        return Effect.succeed({ ...record, state: "disabled" as const })
      }
      return bad(`cannot Disable from state '${record.state}'`)

    case "Start":
      if (record.state === "enabled") {
        return Effect.succeed({ ...record, state: "running" as const })
      }
      return bad(`cannot Start from state '${record.state}' (must be enabled)`)

    case "Stop":
      if (record.state === "running") {
        return Effect.succeed({ ...record, state: "enabled" as const })
      }
      return bad(`cannot Stop from state '${record.state}'`)

    case "StageUpdate": {
      if (record.state !== "enabled" && record.state !== "running") {
        return bad(`cannot stage an update from state '${record.state}'`)
      }
      if (record.staged !== undefined) {
        return bad(`an update to v${record.staged.version} is already staged; activate or roll it back first`)
      }
      const staged: StagedUpdate = { version: event.version, manifest: event.manifest, resumeState: record.state }
      return Effect.succeed({ ...record, state: "updating" as const, staged })
    }

    case "ActivateUpdate": {
      if (record.state !== "updating" || record.staged === undefined) {
        return bad("no staged update to activate")
      }
      const diff = diffCapabilities(record.manifest, record.staged.manifest)
      if (diff.widened.length > 0) {
        const trust = event.trust
        const covers =
          trust !== undefined && trust.approved && sameSet(trust.widened, diff.widened)
        if (!covers) {
          return Effect.fail(
            new TrustDecisionRequired({
              module: record.moduleId,
              widened: diff.widened,
              reason:
                `update v${record.version} -> v${record.staged.version} widens the capability manifest ` +
                `(${diff.widened.join(", ")}); a fresh trust decision covering exactly this set is required`
            })
          )
        }
      }
      const previous: PreviousVersion = { version: record.version, manifest: record.manifest }
      const trustDecisions =
        event.trust === undefined
          ? record.trustDecisions
          : [...record.trustDecisions, { ...event.trust, decidedAt: now }]
      return Effect.succeed({
        ...record,
        version: record.staged.version,
        manifest: record.staged.manifest,
        state: record.staged.resumeState,
        staged: undefined,
        previous,
        trustDecisions
      })
    }

    case "Rollback": {
      if (record.previous === undefined) {
        return bad("no previous version to roll back to")
      }
      if (record.state === "updating") {
        // Roll back a staged-but-not-activated update: discard the stage.
        return Effect.succeed({ ...record, state: record.staged?.resumeState ?? "enabled", staged: undefined })
      }
      // One-click rollback to the previous live version. Single level: the
      // rolled-from version becomes the new "previous" (roll forward again).
      const current: PreviousVersion = { version: record.version, manifest: record.manifest }
      return Effect.succeed({
        ...record,
        version: record.previous.version,
        manifest: record.previous.manifest,
        state: "enabled" as const,
        previous: current
      })
    }
  }
}

export interface InstallInput {
  readonly moduleId: string
  readonly name: string
  readonly version: string
  readonly manifest: CapabilityManifest
  readonly artifacts?: ModuleArtifacts
}

export interface ModuleLifecycleApi {
  readonly install: (input: InstallInput) => Effect.Effect<ModuleRecord, ModuleError>
  readonly get: (moduleId: string) => Effect.Effect<ModuleRecord, ModuleError>
  readonly list: () => Effect.Effect<ReadonlyArray<ModuleRecord>, never>
  /** Apply a lifecycle event. Records an outcome entry (ok or failed). */
  readonly transition: (
    moduleId: string,
    event: LifecycleEvent
  ) => Effect.Effect<ModuleRecord, ModuleError | TrustDecisionRequired>
  /**
   * Remove a module: code + config deletion is the integrator's job; this
   * archives module-created memory/skill entries (never deletes them) and
   * returns the archive record.
   */
  readonly remove: (moduleId: string) => Effect.Effect<ArchiveRecord, ModuleError>
  /** Append-only outcome log. Separate from lifecycle state. */
  readonly outcomes: () => Effect.Effect<ReadonlyArray<LifecycleOutcome>, never>
}

export class ModuleLifecycle extends Context.Service<ModuleLifecycle, ModuleLifecycleApi>()(
  "aimy/module-seam/ModuleLifecycle"
) {}

export const ModuleLifecycleLive: Layer.Layer<ModuleLifecycle> = Layer.effect(
  ModuleLifecycle,
  Effect.gen(function* () {
    const records = yield* Ref.make(new Map<string, ModuleRecord>())
    const log = yield* Ref.make<Array<LifecycleOutcome>>([])

    const recordOutcome = (entry: LifecycleOutcome) => Ref.update(log, (xs) => [...xs, entry])

    const notFound = (moduleId: string) =>
      Effect.fail(new ModuleError({ module: moduleId, reason: "module is not installed" }))

    const install = (input: InstallInput): Effect.Effect<ModuleRecord, ModuleError> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(records)
        if (existing.has(input.moduleId)) {
          return yield* Effect.fail(
            new ModuleError({ module: input.moduleId, reason: "module is already installed" })
          )
        }
        const record: ModuleRecord = {
          moduleId: input.moduleId,
          name: input.name,
          version: input.version,
          state: "installed",
          manifest: input.manifest,
          staged: undefined,
          previous: undefined,
          trustDecisions: [],
          artifacts: input.artifacts ?? { memoryEntries: [], skillEntries: [] }
        }
        yield* Ref.update(records, (m) => new Map(m).set(input.moduleId, record))
        yield* recordOutcome({
          moduleId: input.moduleId,
          transition: "Install",
          from: "installed",
          to: "installed",
          at: Date.now(),
          result: "ok"
        })
        return record
      })

    const get = (moduleId: string): Effect.Effect<ModuleRecord, ModuleError> =>
      Effect.gen(function* () {
        const record = (yield* Ref.get(records)).get(moduleId)
        return record === undefined ? yield* notFound(moduleId) : record
      })

    const list = (): Effect.Effect<ReadonlyArray<ModuleRecord>, never> =>
      Effect.map(Ref.get(records), (m) => [...m.values()])

    const transitionOp = (
      moduleId: string,
      event: LifecycleEvent
    ): Effect.Effect<ModuleRecord, ModuleError | TrustDecisionRequired> =>
      Effect.gen(function* () {
        const record = yield* get(moduleId)
        const now = Date.now()
        const result = yield* Effect.exit(transition(record, event, now))
        if (Exit.isFailure(result)) {
          yield* recordOutcome({
            moduleId,
            transition: event._tag,
            from: record.state,
            to: record.state,
            at: now,
            result: "failed",
            detail: Cause.pretty(result.cause)
          })
          return yield* Effect.failCause(result.cause)
        }
        yield* Ref.update(records, (m) => new Map(m).set(moduleId, result.value))
        yield* recordOutcome({
          moduleId,
          transition: event._tag,
          from: record.state,
          to: result.value.state,
          at: now,
          result: "ok"
        })
        return result.value
      })

    const remove = (moduleId: string): Effect.Effect<ArchiveRecord, ModuleError> =>
      Effect.gen(function* () {
        const record = yield* get(moduleId)
        const now = Date.now()
        const archive: ArchiveRecord = {
          moduleId,
          archivedMemoryEntries: record.artifacts.memoryEntries,
          archivedSkillEntries: record.artifacts.skillEntries,
          at: now
        }
        yield* Ref.update(records, (m) => new Map(m).set(moduleId, { ...record, state: "removed" as const }))
        yield* recordOutcome({
          moduleId,
          transition: "Remove",
          from: record.state,
          to: "removed",
          at: now,
          result: "ok",
          detail: `archived ${archive.archivedMemoryEntries.length} memory entries, ${archive.archivedSkillEntries.length} skill entries`
        })
        return archive
      })

    const outcomes = (): Effect.Effect<ReadonlyArray<LifecycleOutcome>, never> => Ref.get(log)

    return ModuleLifecycle.of({ install, get, list, transition: transitionOp, remove, outcomes })
  })
)
