/**
 * ModuleHost — the adaptive seam's composition root.
 *
 * Composes:
 * - lifecycle  (ModuleLifecycle: install/enable/update/rollback/remove)
 * - hook dispatch (ModuleHooks: the turn + tool-call lifecycle)
 * - manifest enforcement (undeclared capability = denied, fail-closed)
 * - sandbox selection (resolveBackend: unhealthy/absent backend = refuse to run)
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
  toToolOutcome
} from "./hooks.js"
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
  readonly disable: (moduleId: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  readonly start: (moduleId: string) => Effect.Effect<InstanceContext, ModuleError | SandboxViolation | TrustDecisionRequired>
  readonly stop: (moduleId: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  readonly stageUpdate: (moduleId: string, skillMd: string, version: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  readonly activateUpdate: (
    moduleId: string,
    trust?: TrustDecision
  ) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  readonly rollback: (moduleId: string) => Effect.Effect<void, ModuleError | TrustDecisionRequired>
  readonly remove: (moduleId: string) => Effect.Effect<ArchiveRecord, ModuleError>
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

export const makeModuleHost = (deps: ModuleHostDeps): ModuleHostApi => {
  const configs = new Map<string, Readonly<Record<string, unknown>>>()
  const tiers = new Map<string, CapabilityTier>()
  const skillView = makeSkillView({
    store: deps.skillStore,
    hooks: deps.hooks,
    kernel: deps.kernel,
    manifestOf: (moduleId) => Effect.map(deps.lifecycle.get(moduleId), (r) => r.manifest)
  })

  const requireActive = (moduleId: string): Effect.Effect<ModuleRecord, ModuleError> =>
    Effect.flatMap(deps.lifecycle.get(moduleId), (record) =>
      ACTIVE_STATES.includes(record.state)
        ? Effect.succeed(record)
        : Effect.fail(new ModuleError({ module: moduleId, reason: `module is '${record.state}', not active` }))
    )

  const install = (pkg: ModulePackage): Effect.Effect<ModuleRecord, ModuleError> =>
    Effect.gen(function* () {
      if (pkg.moduleId.trim() === "") {
        return yield* Effect.fail(new ModuleError({ module: pkg.moduleId, reason: "moduleId is empty" }))
      }
      const parsed = yield* parseModuleManifest(pkg.skillMd, pkg.moduleId)
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

  const disable = (moduleId: string) => Effect.asVoid(deps.lifecycle.transition(moduleId, { _tag: "Disable" }))

  const stop = (moduleId: string) => Effect.asVoid(deps.lifecycle.transition(moduleId, { _tag: "Stop" }))

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
      const verdict = yield* deps.hooks.dispatchBeforeToolCall(moduleId, call)
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
      yield* deps.hooks.dispatchAfterToolCall(moduleId, call, toolOutcome)
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
      return yield* deps.hooks.runTurn(spec)
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
    skillIndex
  }
}

/** Build a host from plain deps (tests, CLIs). Integration composes the real layers. */
export const layerModuleHost = (deps: ModuleHostDeps): Layer.Layer<ModuleHost> =>
  Layer.succeed(ModuleHost, makeModuleHost(deps))
