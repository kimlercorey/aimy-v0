/**
 * ModuleHooks — the lifecycle-hook taxonomy (Pi's vocabulary, our implementation).
 *
 * Hooks are the single place modules observe and steer the agent loop; modules
 * never reach into loop internals. This service is the host-side dispatcher:
 * each enabled module registers its `ModuleHookImpls`, and the host dispatches
 * the canonical turn sequence through them.
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
  readonly dispatchPrepareNextTurn: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly dispatchPrepareRequest: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly dispatchFinishTurn: (turn: TurnContext) => Effect.Effect<void, HookError>
  readonly dispatchTransformContext: (
    messages: ReadonlyArray<ChatMessage>
  ) => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
  readonly dispatchBeforeToolCall: (module: string, call: ToolCall) => Effect.Effect<GateVerdict, HookError>
  readonly dispatchAfterToolCall: (
    module: string,
    call: ToolCall,
    outcome: ToolOutcome
  ) => Effect.Effect<ToolOutcome, HookError>
  readonly dispatchSteeringMessages: () => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
  readonly dispatchFollowUpMessages: () => Effect.Effect<ReadonlyArray<ChatMessage>, HookError>
  /**
   * Canonical turn sequence:
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
}): ModuleHooksApi => {
  const { impls, kernel } = opts

  const forEachImpl = <A>(fn: (impl: ModuleHookImpls) => Effect.Effect<A, HookError> | undefined): Effect.Effect<Array<A>, HookError> =>
    Effect.forEach(impls, (impl) => {
      const eff = fn(impl)
      return eff === undefined ? Effect.succeed(undefined as never) : eff
    }).pipe(Effect.map((xs) => xs.filter((x) => x !== undefined) as Array<A>))

  const dispatchPrepareNextTurn = (turn: TurnContext) =>
    forEachImpl((impl) =>
      impl.prepareNextTurn === undefined ? undefined : invokeHook("prepareNextTurn", impl.module, () => impl.prepareNextTurn!(turn))
    ).pipe(Effect.asVoid)

  const dispatchPrepareRequest = (turn: TurnContext) =>
    forEachImpl((impl) =>
      impl.prepareRequest === undefined ? undefined : invokeHook("prepareRequest", impl.module, () => impl.prepareRequest!(turn))
    ).pipe(Effect.asVoid)

  const dispatchFinishTurn = (turn: TurnContext) =>
    forEachImpl((impl) =>
      impl.finishTurn === undefined ? undefined : invokeHook("finishTurn", impl.module, () => impl.finishTurn!(turn))
    ).pipe(Effect.asVoid)

  const dispatchTransformContext = (messages: ReadonlyArray<ChatMessage>) =>
    Effect.gen(function* () {
      let current = messages
      for (const impl of impls) {
        if (impl.transformContext !== undefined) {
          current = yield* invokeHook("transformContext", impl.module, () => impl.transformContext!(current))
        }
      }
      return current
    })

  const implFor = (module: string): ModuleHookImpls | undefined => impls.find((i) => i.module === module)

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

  const dispatchSteeringMessages = () =>
    forEachImpl((impl) =>
      impl.getSteeringMessages === undefined
        ? undefined
        : invokeHook("getSteeringMessages", impl.module, () => impl.getSteeringMessages!())
    ).pipe(Effect.map((lists) => lists.flat()))

  const dispatchFollowUpMessages = () =>
    forEachImpl((impl) =>
      impl.getFollowUpMessages === undefined
        ? undefined
        : invokeHook("getFollowUpMessages", impl.module, () => impl.getFollowUpMessages!())
    ).pipe(Effect.map((lists) => lists.flat()))

  type CallDisposition = "executed" | "blocked" | "terminated"

  const runOneCall = (
    turn: TurnContext,
    call: ToolCall,
    executeTool: (call: ToolCall) => Effect.Effect<unknown, unknown>
  ): Effect.Effect<CallDisposition, HookError | SandboxViolation> =>
    Effect.gen(function* () {
      const verdict = yield* dispatchBeforeToolCall(turn.module, call)
      if (verdict._tag === "Allow") {
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

      yield* dispatchPrepareNextTurn(turn)
      yield* dispatchPrepareRequest(turn)
      yield* dispatchTransformContext(spec.contextMessages)

      const dispositions: Array<CallDisposition> = []
      for (const call of spec.toolCalls) {
        if (dispositions.includes("terminated")) break
        dispositions.push(yield* runOneCall(turn, call, spec.executeTool))
      }

      const steeringMessages = yield* dispatchSteeringMessages()
      yield* dispatchFinishTurn(turn)
      const followUpMessages = yield* dispatchFollowUpMessages()

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

/** Layer from explicit deps (impls + kernel seam). The real kernel wires at integration. */
export const layerModuleHooks = (opts: {
  readonly impls: ReadonlyArray<ModuleHookImpls>
  readonly kernel: SafetyKernelSeam
}): Layer.Layer<ModuleHooks> => Layer.succeed(ModuleHooks, makeModuleHooks(opts))
