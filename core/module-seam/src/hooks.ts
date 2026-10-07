/**
 * ModuleHooks — the lifecycle-hook taxonomy (Pi's vocabulary, our implementation).
 *
 * Hooks are the single place modules observe and steer the agent loop; modules
 * never reach into loop internals. This service is the host-side dispatcher:
 * each enabled module registers its `ModuleHookImpls`, and the host dispatches
 * the canonical turn sequence through them.
 *
 * DISPATCH RULE (per-module, never broadcast): a hook fires ONLY for the
 * module whose turn or tool call it is. The host never invokes one module's
 * hooks on behalf of another module — there is no fan-out to "all modules".
 * Cross-module effects happen through the SafetyKernel seam and the shared
 * outcome log, never by calling another module's hooks. Rationale: a
 * broadcast dispatcher lets a compromised or buggy module observe or steer
 * turns that are not its own; per-module dispatch keeps each module's
 * observation surface exactly its own execution.
 *
 * Hardened invariants (from the architecture):
 * - A message truncated on `length` fails ALL its tool calls (Pi's rule,
 *   adopted verbatim): `dispatchBeforeToolCall` auto-denies truncated calls.
 * - Hook boundaries never throw: impl defects and foreign failures are
 *   converted to typed `HookError` at the boundary.
 * - Tool I/O errors are caught at the tool boundary: `runTurn`/`callTool`
 *   normalize raw failures into `ToolOutcome` before `afterToolCall` sees them.
 * - Memory operations are hook-visible like any tool call (Hermes #34352):
 *   route them through `beforeToolCall`/`afterToolCall` with kind
 *   "memory.read"/"memory.write".
 */
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { HookError, PermissionDenied, SandboxViolation, TurnTerminated } from "./errors.js"
import {
  Allow,
  type CapabilityTier,
  type GateVerdict,
  type SafetyKernelSeam,
  mergeVerdicts,
  toolIntent
} from "./kernel-seam.js"

export type HookName =
  | "prepareNextTurn"
  | "prepareRequest"
  | "finishTurn"
  | "transformContext"
  | "beforeToolCall"
  | "afterToolCall"
  | "getSteeringMessages"
  | "getFollowUpMessages"

/** All hook names, for manifest validation ("declared hooks" must be real hooks). */
export const HOOK_NAMES: ReadonlyArray<HookName> = [
  "prepareNextTurn",
  "prepareRequest",
  "finishTurn",
  "transformContext",
  "beforeToolCall",
  "afterToolCall",
  "getSteeringMessages",
  "getFollowUpMessages"
]

export interface TurnContext {
  readonly turnId: string
  readonly module: string
}

export interface ToolCall {
  readonly id: string
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  readonly tier: CapabilityTier
  /** True when the model message carrying this call was truncated on length. */
  readonly truncated: boolean
}

export interface ChatMessage {
  readonly role: string
  readonly content: string
}

/** Tool I/O outcome, normalized at the boundary. Hooks never see raw exceptions. */
export type ToolOutcome = { readonly _tag: "Ok"; readonly value: unknown } | {
  readonly _tag: "IoError"
  readonly reason: string
}

export const okOutcome = (value: unknown): ToolOutcome => ({ _tag: "Ok", value })
export const ioErrorOutcome = (reason: string): ToolOutcome => ({ _tag: "IoError", reason })

/** Normalize an Exit from raw tool execution into a boundary-safe ToolOutcome. */
export const toToolOutcome = <A, E>(exit: Exit.Exit<A, E>): ToolOutcome =>
  Exit.isSuccess(exit) ? okOutcome(exit.value) : ioErrorOutcome(Cause.pretty(exit.cause))

/**
 * What a module implements. Every hook is optional; the dispatcher skips
 * unimplemented hooks. All hooks return typed `HookError` on failure.
 */
export interface ModuleHookImpls {
  readonly module: string
  readonly prepareNextTurn?: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly prepareRequest?: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly finishTurn?: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly transformContext?: (messages: ReadonlyArray<ChatMessage>) => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
  readonly beforeToolCall?: (call: ToolCall) => Effect.Effect<GateVerdict, HookError>
  readonly afterToolCall?: (call: ToolCall, outcome: ToolOutcome) => Effect.Effect<ToolOutcome, HookError>
  readonly getSteeringMessages?: () => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
  readonly getFollowUpMessages?: () => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
}

export interface TurnSpec {
  readonly turn: TurnContext
  readonly contextMessages: ReadonlyArray<ChatMessage>
  readonly toolCalls: ReadonlyArray<ToolCall>
  /** Raw executor; the dispatcher wraps it with gate + boundary handling. */
  readonly executeTool: (call: ToolCall) => Effect.Effect<unknown, unknown>
}

export interface TurnReport {
  readonly turnId: string
  readonly executed: number
  readonly blocked: number
  readonly terminated: boolean
  readonly steeringMessages: ReadonlyArray<ChatMessage>
  readonly followUpMessages: ReadonlyArray<ChatMessage>
}

export interface ModuleHooksApi {
  /**
   * Per-module dispatchers. Each fires ONLY the named module's hooks
   * (see the DISPATCH RULE above); unimplemented hooks are skipped.
   */
  readonly dispatchPrepareNextTurn: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly dispatchPrepareRequest: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly dispatchFinishTurn: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly dispatchTransformContext: (
    module: string,
    messages: ReadonlyArray<ChatMessage>
  ) => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
  readonly dispatchBeforeToolCall: (module: string, call: ToolCall) => Effect.Effect<GateVerdict, HookError>
  readonly dispatchAfterToolCall: (
    module: string,
    call: ToolCall,
    outcome: ToolOutcome
  ) => Effect.Effect<ToolOutcome, HookError>
  readonly dispatchSteeringMessages: (module: string) => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
  readonly dispatchFollowUpMessages: (module: string) => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
  /**
   * Canonical turn sequence, all dispatched per-module to `spec.turn.module`:
   * prepareNextTurn -> prepareRequest -> transformContext ->
   * [beforeToolCall -> execute -> afterToolCall]* -> steering ->
   * finishTurn -> follow-ups.
   */
  readonly runTurn: (
    spec: TurnSpec
  ) => Effect.Effect<TurnReport, HookError | PermissionDenied | TurnTerminated | SandboxViolation>
}

export class ModuleHooks extends Context.Service<ModuleHooks, ModuleHooksApi>()(
  "aimy/module-seam/ModuleHooks"
) {}

/**
 * Hook boundaries never throw. Foreign failures and defects are converted to
 * typed HookError carrying the hook name and module. A HookError passes
 * through unchanged (no double-wrapping).
 */
const invokeHook = <A>(
  hook: HookName,
  module: string,
  run: () => Effect.Effect<A, HookError>
): Effect.Effect<A, HookError> =>
  Effect.catchDefect(
    Effect.catch(Effect.suspend(run), (e) =>
      e instanceof HookError
        ? Effect.fail(e)
        : Effect.fail(new HookError({ hook, module, reason: `hook failed: ${String(e)}` }))
    ),
    (defect) =>
      Effect.fail(
        new HookError({ hook, module, reason: `hook defect (boundary held): ${Cause.pretty(Cause.die(defect))}` })
      )
  )

export const makeModuleHooks = (opts: {
  readonly impls: ReadonlyArray<ModuleHookImpls>
  readonly kernel: SafetyKernelSeam
  /**
   * Live active check, wired by the host to the lifecycle state machine.
   * When provided, the inner turn sequence consults it before every hook
   * firing point: a disable landing mid-turn terminates the turn fail-closed
   * with a typed `HookError` instead of letting the rest of the turn's hooks
   * fire. Defaults to always-active (no behavior change for existing callers).
   */
  readonly isActive?: (module: string) => Effect.Effect<boolean, never>
}): ModuleHooksApi => {
  const { impls, kernel } = opts
  const isActiveFn = opts.isActive ?? ((_module: string) => Effect.succeed(true as const))

  /** Fail-closed mid-turn guard: inactive module => typed HookError, turn aborts. */
  const requireActiveTurn = (module: string): Effect.Effect<void, HookError> =>
    Effect.flatMap(isActiveFn(module), (active) =>
      active
        ? Effect.void
        : Effect.fail(
            new HookError({
              hook: "runTurn",
              module,
              reason: "module disabled mid-turn; turn terminated fail-closed"
            })
          )
    )

  const implFor = (module: string): ModuleHookImpls | undefined => impls.find((i) => i.module === module)

  // Per-module dispatch: each dispatcher looks up ONLY the named module's
  // impl. A module with no impl (or no such hook) is a silent no-op — the
  // dispatcher never touches another module's hooks.

  const dispatchPrepareNextTurn = (turn: TurnContext): Effect.Effect<void, HookError> => {
    const fn = implFor(turn.module)?.prepareNextTurn
    return fn === undefined
      ? Effect.void
      : Effect.asVoid(invokeHook("prepareNextTurn", turn.module, () => fn(turn)))
  }

  const dispatchPrepareRequest = (turn: TurnContext): Effect.Effect<void, HookError> => {
    const fn = implFor(turn.module)?.prepareRequest
    return fn === undefined
      ? Effect.void
      : Effect.asVoid(invokeHook("prepareRequest", turn.module, () => fn(turn)))
  }

  const dispatchFinishTurn = (turn: TurnContext): Effect.Effect<void, HookError> => {
    const fn = implFor(turn.module)?.finishTurn
    return fn === undefined
      ? Effect.void
      : Effect.asVoid(invokeHook("finishTurn", turn.module, () => fn(turn)))
  }

  const dispatchTransformContext = (
    module: string,
    messages: ReadonlyArray<ChatMessage>
  ): Effect.Effect<ReadonlyArray<ChatMessage>, HookError> => {
    const fn = implFor(module)?.transformContext
    return fn === undefined
      ? Effect.succeed(messages)
      : invokeHook("transformContext", module, () => fn(messages))
  }

  const dispatchBeforeToolCall = (module: string, call: ToolCall): Effect.Effect<GateVerdict, HookError> =>
    Effect.gen(function* () {
      // Invariant (Pi's rule, adopted verbatim): a message truncated on length
      // fails ALL its tool calls. Never execute potentially-truncated args.
      if (call.truncated) {
        return {
          _tag: "Deny",
          reason: `message truncated on length: tool call '${call.tool}' refused`,
          terminate: false
        } satisfies GateVerdict
      }
      const impl = implFor(module)
      const hookVerdict =
        impl?.beforeToolCall === undefined
          ? Allow
          : yield* invokeHook("beforeToolCall", module, () => impl.beforeToolCall!(call))
      const kernelVerdict = yield* kernel.check(toolIntent(module, call.tool, call.tier, `tool call ${call.tool}`))
      return mergeVerdicts([kernelVerdict, hookVerdict])
    })

  const dispatchAfterToolCall = (
    module: string,
    call: ToolCall,
    outcome: ToolOutcome
  ): Effect.Effect<ToolOutcome, HookError> => {
    const impl = implFor(module)
    if (impl?.afterToolCall === undefined) return Effect.succeed(outcome)
    return invokeHook("afterToolCall", module, () => impl.afterToolCall!(call, outcome))
  }

  const dispatchSteeringMessages = (module: string): Effect.Effect<ReadonlyArray<ChatMessage>, HookError> => {
    const fn = implFor(module)?.getSteeringMessages
    return fn === undefined ? Effect.succeed([]) : invokeHook("getSteeringMessages", module, () => fn())
  }

  const dispatchFollowUpMessages = (module: string): Effect.Effect<ReadonlyArray<ChatMessage>, HookError> => {
    const fn = implFor(module)?.getFollowUpMessages
    return fn === undefined ? Effect.succeed([]) : invokeHook("getFollowUpMessages", module, () => fn())
  }

  type CallDisposition = "executed" | "blocked" | "terminated"

  const runOneCall = (
    turn: TurnContext,
    call: ToolCall,
    executeTool: (call: ToolCall) => Effect.Effect<unknown, unknown>
  ): Effect.Effect<CallDisposition, HookError | SandboxViolation> =>
    Effect.gen(function* () {
      const verdict = yield* dispatchBeforeToolCall(turn.module, call)
      if (verdict._tag === "Allow") {
        // Disable may have landed after the allow verdict: re-check before
        // executing. Fail-closed: the tool never runs for an inactive module.
        yield* requireActiveTurn(turn.module)
        // Tool I/O errors are caught at the boundary, before afterToolCall.
        const exit = yield* Effect.exit(executeTool(call))
        yield* dispatchAfterToolCall(turn.module, call, toToolOutcome(exit))
        return "executed" as const
      }
      // Deny / Ask: enforce through the SafetyKernel seam. The tool never runs.
      // The seam's failure maps to a disposition; unexpected errors propagate typed.
      const intent = toolIntent(turn.module, call.tool, call.tier, `tool call ${call.tool}`)
      return yield* kernel.execute(intent, Effect.succeed("blocked" as const)).pipe(
        Effect.catchTags({
          TurnTerminated: () => Effect.succeed("terminated" as const),
          PermissionDenied: () => Effect.succeed("blocked" as const)
        })
      )
    })

  const runTurn = (spec: TurnSpec) =>
    Effect.gen(function* () {
      const { turn } = spec
      // Mid-turn disable guard: consult the live lifecycle state before every
      // hook firing point. A disable landing mid-turn aborts the turn here
      // with a typed HookError — the rest of the turn's hooks never fire.
      const check = () => requireActiveTurn(turn.module)

      yield* check()
      yield* dispatchPrepareNextTurn(turn)
      yield* check()
      yield* dispatchPrepareRequest(turn)
      yield* check()
      yield* dispatchTransformContext(turn.module, spec.contextMessages)

      const dispositions: Array<CallDisposition> = []
      for (const call of spec.toolCalls) {
        if (dispositions.includes("terminated")) break
        yield* check()
        dispositions.push(yield* runOneCall(turn, call, spec.executeTool))
      }

      yield* check()
      const steeringMessages = yield* dispatchSteeringMessages(turn.module)
      yield* check()
      yield* dispatchFinishTurn(turn)
      yield* check()
      const followUpMessages = yield* dispatchFollowUpMessages(turn.module)

      const executed = dispositions.filter((d) => d === "executed").length
      const blocked = dispositions.filter((d) => d !== "executed").length
      return {
        turnId: turn.turnId,
        executed,
        blocked,
        terminated: dispositions.includes("terminated"),
        steeringMessages,
        followUpMessages
      } satisfies TurnReport
    })

  return {
    dispatchPrepareNextTurn,
    dispatchPrepareRequest,
    dispatchFinishTurn,
    dispatchTransformContext,
    dispatchBeforeToolCall,
    dispatchAfterToolCall,
    dispatchSteeringMessages,
    dispatchFollowUpMessages,
    runTurn
  }
}

/**
 * Disable-mid-run guard: wrap a `ModuleHooksApi` with a LIVE active check
 * (the host wires this to the lifecycle state machine).
 *
 * When the module is not active (disabled mid-run, mid-turn, or never
 * enabled), its hooks stop firing IMMEDIATELY — even inside an in-flight
 * turn:
 * - void / passthrough hooks are skipped (no observation, no steering);
 * - `beforeToolCall` returns a fail-closed `Deny` (the call never runs);
 * - `afterToolCall` passes the outcome through untouched;
 * - `runTurn` fails with a typed `HookError` (the host's own `requireActive`
 *   check normally fires first with `ModuleError`; this is the inner guard).
 */
export const withActiveCheck = (
  hooks: ModuleHooksApi,
  isActive: (module: string) => Effect.Effect<boolean, never>
): ModuleHooksApi => {
  const inactiveDeny = (module: string): GateVerdict => ({
    _tag: "Deny",
    reason: `module '${module}' is not active; hook dispatch refused fail-closed`,
    terminate: false
  })
  const guard = <A, E>(
    module: string,
    whenActive: Effect.Effect<A, E>,
    whenInactive: Effect.Effect<A, E>
  ): Effect.Effect<A, E> =>
    Effect.flatMap(isActive(module), (active) => (active ? whenActive : whenInactive))

  /**
   * Backstop watcher: polls the live active state while a turn runs. If the
   * module is disabled mid-turn, this completes with a typed `HookError`,
   * winning the race in `runTurn` below and interrupting the in-flight turn
   * fail-closed. This covers inner turn sequences built without the
   * `makeModuleHooks({ isActive })` check (e.g. host-injected hooks); turns
   * built WITH it fail deterministically at the next firing point instead.
   * Same error shape either way.
   */
  const watchInactive = (module: string): Effect.Effect<never, HookError> =>
    Effect.flatMap(isActive(module), (active) =>
      active
        ? Effect.andThen(Effect.sleep("15 millis"), watchInactive(module))
        : Effect.fail(
            new HookError({
              hook: "runTurn",
              module,
              reason: "module disabled mid-turn; turn terminated fail-closed"
            })
          )
    )

  return {
    dispatchPrepareNextTurn: (turn) =>
      guard(turn.module, hooks.dispatchPrepareNextTurn(turn), Effect.void),
    dispatchPrepareRequest: (turn) =>
      guard(turn.module, hooks.dispatchPrepareRequest(turn), Effect.void),
    dispatchFinishTurn: (turn) => guard(turn.module, hooks.dispatchFinishTurn(turn), Effect.void),
    dispatchTransformContext: (module, messages) =>
      guard(module, hooks.dispatchTransformContext(module, messages), Effect.succeed(messages)),
    dispatchBeforeToolCall: (module, call) =>
      guard(module, hooks.dispatchBeforeToolCall(module, call), Effect.succeed(inactiveDeny(module))),
    dispatchAfterToolCall: (module, call, outcome) =>
      guard(
        module,
        hooks.dispatchAfterToolCall(module, call, outcome),
        Effect.succeed(outcome)
      ),
    dispatchSteeringMessages: (module) =>
      guard(module, hooks.dispatchSteeringMessages(module), Effect.succeed([])),
    dispatchFollowUpMessages: (module) =>
      guard(module, hooks.dispatchFollowUpMessages(module), Effect.succeed([])),
    runTurn: (spec) =>
      guard(
        spec.turn.module,
        // Race the inner turn against the disable-watcher: a disable landing
        // mid-turn interrupts the in-flight sequence instead of letting the
        // rest of its hooks fire. The loser is interrupted; the winner's
        // typed HookError surfaces.
        Effect.raceFirst(hooks.runTurn(spec), watchInactive(spec.turn.module)),
        Effect.fail(
          new HookError({
            hook: "runTurn",
            module: spec.turn.module,
            reason: "module is not active; turn refused"
          })
        )
      )
  }
}

/** Layer from explicit deps (impls + kernel seam). The real kernel wires at integration. */
export const layerModuleHooks = (opts: {
  readonly impls: ReadonlyArray<ModuleHookImpls>
  readonly kernel: SafetyKernelSeam
  readonly isActive?: (module: string) => Effect.Effect<boolean, never>
}): Layer.Layer<ModuleHooks> => Layer.succeed(ModuleHooks, makeModuleHooks(opts))
