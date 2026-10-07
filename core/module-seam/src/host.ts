/**
 * ModuleHost — the adaptive seam's composition root.
 *
 * Composes:
 * - lifecycle  (ModuleLifecycle: install/enable/update/rollback/remove)
 * - hook dispatch (ModuleHooks: the turn + tool-call lifecycle, per-module —
 *   see the DISPATCH RULE in hooks.ts; wrapped with `withActiveCheck` so a
 *   mid-run disable stops hook dispatch immediately)
 * - manifest enforcement (undeclared capability = denied, fail-closed;
 *   install is atomic: full package validation before the lifecycle record)
 * - sandbox selection (resolveBackend: unhealthy/absent backend = refuse to run)
 * - runtime registry: started modules hold an entry until stop/disable/
 *   remove tears it down (no residue); the entry will carry the OS spawn
 *   handle when real sandbox backends land.
 *
 * Enforcement points:
 * - `beforeToolCall` (SafetyKernel seam) for tool dispatch — gates sit at
 *   EXECUTION, never in the prompt (Pi #10426).
 * - `callTool` checks the module's manifest FIRST: a tool the manifest does
 *   not declare is denied without ever reaching a hook or the kernel.
 * - `start` resolves the sandbox backend for the module's tier BEFORE
 *   transitioning to running; T2+ with an unhealthy stub backend refuses to
 *   run (Hermes #61882) and the module never leaves its prior state.
 */
import { Context, Effect, Layer } from "effect"
import {
  HookError,
  ModuleError,
  PermissionDenied,
  SandboxViolation,
  TrustDecisionRequired,
  TurnTerminated
} from "./errors.js"
import {
  type ModuleHooksApi,
  ModuleHooks,
  type ToolCall,
  type TurnReport,
  type TurnSpec,
  toToolOutcome,
  withActiveCheck
} from "./hooks.js"
import { validateModulePackage } from "./packager.js"
import {
  type ArchiveRecord,
  type CapabilityDiff,
  type ModuleArtifacts,
  type ModuleLifecycleApi,
  type ModuleRecord,
  type TrustDecision,
  diffCapabilities
} from "./lifecycle.js"
import { declaresTool, parseModuleManifest } from "./manifest.js"
import {
  type BackendSet,
  type Platform,
  type SpawnHandle,
  isDirectGate,
  resolveBackend
} from "./sandbox.js"
import { type IdentitySeam, type InstanceContext, makeInstanceContext } from "./instance.js"
import {
  type SafetyKernelSeam,
  type CapabilityTier,
  toolIntent
} from "./kernel-seam.js"
import {
  type SkillIndex,
  type SkillStore,
  type SkillSummary,
  buildSkillIndex,
  makeSkillView
} from "./skill-index.js"

export interface ModulePackage {
  readonly moduleId: string
  readonly skillMd: string
  readonly tier: CapabilityTier
  readonly config?: Readonly<Record<string, unknown>>
  readonly artifacts?: ModuleArtifacts
}

export interface ModuleHostApi {
  /* lifecycle */
  readonly install: (pkg: ModulePackage) => Effect.Effect<ModuleRecord, ModuleError>
  readonly enable: (moduleId: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  /**
   * Disable stops hook dispatch immediately (even mid-turn) and tears down
   * the module's runtime state. `SandboxViolation` covers a failed teardown
   * of an out-of-process spawn handle (future OS backends).
   */
  readonly disable: (moduleId: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired | SandboxViolation>
  readonly start: (moduleId: string) => Effect.Effect<InstanceContext, ModuleError | SandboxViolation | TrustDecisionRequired>
  readonly stop: (moduleId: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired | SandboxViolation>
  readonly stageUpdate: (moduleId: string, skillMd: string, version: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  readonly activateUpdate: (
    moduleId: string,
    trust?: TrustDecision
  ) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  readonly rollback: (moduleId: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  readonly remove: (moduleId: string) => Effect.Effect<ArchiveRecord, ModuleError | SandboxViolation>
  readonly diffUpdate: (moduleId: string) => Effect.Effect<CapabilityDiff, ModuleError>
  /* execution */
  readonly runTurn: (
    spec: TurnSpec
  ) => Effect.Effect<TurnReport, HookError | PermissionDenied | TurnTerminated | SandboxViolation | ModuleError>
  readonly callTool: <A, E>(
    moduleId: string,
    call: ToolCall,
    run: Effect.Effect<A, E>
  ) => Effect.Effect<A, E | PermissionDenied | TurnTerminated | HookError | SandboxViolation | ModuleError>
  /* skills */
  readonly viewSkill: (
    moduleId: string,
    name: string
  ) => Effect.Effect<string, ModuleError | PermissionDenied | HookError | TurnTerminated | SandboxViolation>
  readonly skillIndex: () => Effect.Effect<SkillIndex, never>
  /* diagnostics */
  /** Module IDs with live runtime state (started, not yet stopped/disabled/removed). */
  readonly runtimeModules: () => Effect.Effect<ReadonlyArray<string>, never>
}

export class ModuleHost extends Context.Service<ModuleHost, ModuleHostApi>()(
  "aimy/module-seam/ModuleHost"
) {}

export interface ModuleHostDeps {
  readonly lifecycle: ModuleLifecycleApi
  readonly hooks: ModuleHooksApi
  readonly kernel: SafetyKernelSeam
  readonly identity: IdentitySeam
  readonly backends: BackendSet
  readonly platform: Platform
  readonly skills: ReadonlyArray<SkillSummary>
  readonly skillStore: SkillStore
}

const ACTIVE_STATES: ReadonlyArray<string> = ["enabled", "running"]

/**
 * Live runtime state for a started module. Today this is bookkeeping only
 * (the working execution path is the in-process DirectGate, which leaves no
 * OS-level residue); when OS sandbox backends land, the out-of-process spawn
 * handle lives here and teardown kills it.
 */
export interface ModuleRuntime {
  readonly startedAt: number
  readonly spawnHandle?: SpawnHandle
}

export const makeModuleHost = (deps: ModuleHostDeps): ModuleHostApi => {
  const configs = new Map<string, Readonly<Record<string, unknown>>>()
  const tiers = new Map<string, CapabilityTier>()
  const runtimes = new Map<string, ModuleRuntime>()

  /**
   * Disable-mid-run guard: hook dispatch consults the LIVE lifecycle state,
   * so disabling a module stops its hooks firing immediately — even inside
   * an in-flight turn. `requireActive` (below) blocks new turns/calls; this
   * wrapper stops dispatch for turns already running.
   */
  const isActive = (moduleId: string): Effect.Effect<boolean, never> =>
    Effect.orElseSucceed(
      Effect.map(deps.lifecycle.get(moduleId), (r) => ACTIVE_STATES.includes(r.state)),
      () => false
    )
  const hooks = withActiveCheck(deps.hooks, isActive)

  const skillView = makeSkillView({
    store: deps.skillStore,
    hooks,
    kernel: deps.kernel,
    manifestOf: (moduleId) => Effect.map(deps.lifecycle.get(moduleId), (r) => r.manifest)
  })

  /** Tear down a module's runtime state: kill any spawn handle, drop the entry. No residue. */
  const teardownRuntime = (moduleId: string): Effect.Effect<void, SandboxViolation> =>
    Effect.gen(function* () {
      const rt = runtimes.get(moduleId)
      if (rt?.spawnHandle !== undefined) {
        yield* rt.spawnHandle.kill()
      }
      runtimes.delete(moduleId)
    })

  const requireActive = (moduleId: string): Effect.Effect<ModuleRecord, ModuleError> =>
    Effect.flatMap(deps.lifecycle.get(moduleId), (record) =>
      ACTIVE_STATES.includes(record.state)
        ? Effect.succeed(record)
        : Effect.fail(new ModuleError({ module: moduleId, reason: `module is '${record.state}', not active` }))
    )

  /**
   * Install is atomic: the package is fully validated BEFORE the lifecycle
   * record is created, so a malformed package fails with a typed ModuleError
   * and leaves no residue (no partial install).
   */
  const install = (pkg: ModulePackage): Effect.Effect<ModuleRecord, ModuleError> =>
    Effect.gen(function* () {
      if (pkg.moduleId.trim() === "") {
        return yield* Effect.fail(new ModuleError({ module: pkg.moduleId, reason: "moduleId is empty" }))
      }
      const parsed = yield* validateModulePackage(pkg)
      const record = yield* deps.lifecycle.install({
        moduleId: pkg.moduleId,
        name: parsed.name,
        version: parsed.version,
        manifest: parsed.capability,
        artifacts: pkg.artifacts ?? { memoryEntries: [], skillEntries: [] }
      })
      configs.set(pkg.moduleId, pkg.config ?? {})
      tiers.set(pkg.moduleId, pkg.tier)
      return record
    })

  const enable = (moduleId: string) => Effect.asVoid(deps.lifecycle.transition(moduleId, { _tag: "Enable" }))

  /**
   * Disable mid-run: the lifecycle transition (enabled/running -> disabled)
   * makes `requireActive` refuse new turns/calls, the `withActiveCheck`
   * wrapper stops in-flight hook dispatch immediately, and the runtime entry
   * is torn down. No residue.
   */
  const disable = (moduleId: string) =>
    Effect.gen(function* () {
      yield* deps.lifecycle.transition(moduleId, { _tag: "Disable" })
      yield* teardownRuntime(moduleId)
    }).pipe(Effect.asVoid)

  const stop = (moduleId: string) =>
    Effect.gen(function* () {
      yield* deps.lifecycle.transition(moduleId, { _tag: "Stop" })
      yield* teardownRuntime(moduleId)
    }).pipe(Effect.asVoid)

  /**
   * Start a module: resolve the sandbox backend for its tier FIRST
   * (fail-closed: an unhealthy/absent backend refuses and the module never
   * leaves its prior state), then transition to running and hand it its
   * instance context.
   */
  const start = (
    moduleId: string
  ): Effect.Effect<InstanceContext, ModuleError | SandboxViolation | TrustDecisionRequired> =>
    Effect.gen(function* () {
      const tier = tiers.get(moduleId) ?? "T0"
      yield* resolveBackend(deps.backends, tier, deps.platform)
      yield* deps.lifecycle.transition(moduleId, { _tag: "Start" })
      runtimes.set(moduleId, { startedAt: Date.now() })
      return yield* makeInstanceContext(deps.identity, moduleId, configs.get(moduleId) ?? {})
    })

  const stageUpdate = (moduleId: string, skillMd: string, version: string) =>
    Effect.gen(function* () {
      const record = yield* deps.lifecycle.get(moduleId)
      const parsed = yield* parseModuleManifest(skillMd, moduleId)
      if (parsed.name !== record.name) {
        return yield* Effect.fail(
          new ModuleError({ module: moduleId, reason: `update renames module '${record.name}' -> '${parsed.name}'` })
        )
      }
      yield* deps.lifecycle.transition(moduleId, { _tag: "StageUpdate", version, manifest: parsed.capability })
    }).pipe(Effect.asVoid)

  const activateUpdate = (moduleId: string, trust?: TrustDecision) =>
    Effect.asVoid(
      deps.lifecycle.transition(
        moduleId,
        trust === undefined ? { _tag: "ActivateUpdate" } : { _tag: "ActivateUpdate", trust }
      )
    )

  const rollback = (moduleId: string) => Effect.asVoid(deps.lifecycle.transition(moduleId, { _tag: "Rollback" }))

  const remove = (moduleId: string) =>
    Effect.gen(function* () {
      const archive = yield* deps.lifecycle.remove(moduleId)
      yield* teardownRuntime(moduleId)
      configs.delete(moduleId)
      tiers.delete(moduleId)
      return archive
    })

  const diffUpdate = (moduleId: string): Effect.Effect<CapabilityDiff, ModuleError> =>
    Effect.gen(function* () {
      const record = yield* deps.lifecycle.get(moduleId)
      if (record.staged === undefined) {
        return yield* Effect.fail(new ModuleError({ module: moduleId, reason: "no staged update to diff" }))
      }
      return diffCapabilities(record.manifest, record.staged.manifest)
    })

  /**
   * Single tool call through the full enforcement stack:
   * 1. module must be active
   * 2. tool must be declared in the manifest (undeclared = denied, fail-closed)
   * 3. tier-appropriate sandbox backend must resolve (fail-closed)
   * 4. beforeToolCall gate (module hook + SafetyKernel seam)
   * 5. execute via the DirectGate (T0/T1); anything else fails closed —
   *    out-of-process spawn is not implemented in this phase
   * 6. I/O errors caught at the boundary; afterToolCall sees a ToolOutcome
   */
  const callTool = <A, E>(
    moduleId: string,
    call: ToolCall,
    run: Effect.Effect<A, E>
  ): Effect.Effect<A, E | PermissionDenied | TurnTerminated | HookError | SandboxViolation | ModuleError> =>
    Effect.gen(function* () {
      const record = yield* requireActive(moduleId)
      if (!declaresTool(record.manifest, call.tool)) {
        return yield* Effect.fail(
          new PermissionDenied({
            tool: call.tool,
            tier: call.tier,
            reason: `tool '${call.tool}' is not declared in module '${moduleId}' manifest (undeclared = denied)`,
          })
        )
      }
      const tier = tiers.get(moduleId) ?? call.tier
      const backend = yield* resolveBackend(deps.backends, tier, deps.platform)
      if (!isDirectGate(backend)) {
        return yield* Effect.fail(
          new SandboxViolation({
            reason: `out-of-process spawn via '${backend.name}' is not implemented in this phase; refusing to run in-process`,
            backend: backend.name
          })
        )
      }
      const intent = toolIntent(moduleId, call.tool, tier, `tool call ${call.tool}`)
      const verdict = yield* hooks.dispatchBeforeToolCall(moduleId, call)
      if (verdict._tag !== "Allow") {
        // Deny / Ask: enforce through the kernel seam. The tool never runs.
        yield* deps.kernel.execute(intent, Effect.succeed(undefined))
        return yield* Effect.fail(
          new PermissionDenied({
            tool: intent.tool,
            tier: intent.tier,
            reason: "unreachable: kernel allowed a denied tool call",
          })
        )
      }
      const outcome = yield* Effect.exit(backend.run(intent, run))
      const toolOutcome = toToolOutcome(outcome)
      yield* hooks.dispatchAfterToolCall(moduleId, call, toolOutcome)
      if (toolOutcome._tag === "IoError") {
        return yield* Effect.fail(
          new ModuleError({ module: moduleId, reason: `tool I/O error: ${toolOutcome.reason}` })
        )
      }
      return (toolOutcome as { readonly _tag: "Ok"; readonly value: unknown }).value as A
    })

  const runTurn = (
    spec: TurnSpec
  ): Effect.Effect<TurnReport, HookError | PermissionDenied | TurnTerminated | SandboxViolation | ModuleError> =>
    Effect.gen(function* () {
      yield* requireActive(spec.turn.module)
      return yield* hooks.runTurn(spec)
    })

  const viewSkill = (moduleId: string, name: string) =>
    Effect.gen(function* () {
      yield* requireActive(moduleId)
      return yield* skillView(moduleId, name)
    })

  const skillIndex = (): Effect.Effect<SkillIndex, never> => Effect.succeed(buildSkillIndex(deps.skills))

  return {
    install,
    enable,
    disable,
    start,
    stop,
    stageUpdate,
    activateUpdate,
    rollback,
    remove,
    diffUpdate,
    runTurn,
    callTool,
    viewSkill,
    skillIndex,
    runtimeModules: () => Effect.succeed([...runtimes.keys()])
  }
}

/** Build a host from plain deps (tests, CLIs). Integration composes the real layers. */
export const layerModuleHost = (deps: ModuleHostDeps): Layer.Layer<ModuleHost> =>
  Layer.succeed(ModuleHost, makeModuleHost(deps))
