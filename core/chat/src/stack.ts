/**
 * chat/src/stack.ts — the production-shape Layer stack for the CLI.
 *
 * Same composition as m1-wiring.test.ts's buildStack, minus the test doubles:
 *   SafetyKernel.layerFromPolicy(openPolicy)
 *     -> kernel-backed PermissionGate + MemoryPathsLive (real XDG dirs)
 *     -> MemoryServiceLive
 *     -> ModuleHooks (real kernel behind the SafetyKernelSeam)
 *     -> InferencePoolLive + registered LocalHttpProvider
 *     -> HonestyServiceInMemory
 *     -> AgentLoop via layerAgentLoopWithHonesty (streaming + post-turn judges)
 *
 * Additive wiring only: no core lib's public contract is changed here.
 */
import { Effect, Layer } from "effect"
import {
  AgentLoop,
  layerAgentLoopWithHonesty,
  type AgentLoopHonestyOpts
} from "../../agent-loop/src/index.js"
import { HonestyService, HonestyServiceInMemory } from "../../honesty/index.js"
import {
  InferencePool,
  InferencePoolLive,
  LocalHttpProvider,
  type Provider
} from "../../inference-pool/index.js"
import {
  MemoryPathsLive,
  MemoryService,
  MemoryServiceLive,
  PermissionGate
} from "../../memory/index.js"
import {
  Allow,
  Ask,
  ModuleHooks,
  makeModuleHooks,
  type GateVerdict,
  type ModuleHookImpls,
  type SafetyKernelSeam
} from "../../module-seam/src/index.js"
import {
  PolicyDocument,
  SafetyKernel,
  type SafetyKernelService
} from "../../permission-kernel/index.js"
import { PermissionDenied } from "../../substrate/errors.js"
import { ToolName } from "../../substrate/types.js"

/** T0/T1 allowed (chat + memory), T2/T3 denied. Same posture as the wiring tests. */
export const openPolicy: PolicyDocument = {
  version: 1,
  rules: [
    { tool: "*", tier: "T0", decision: "allow", reason: "chat: T0 reads and tools" },
    { tool: "*", tier: "T1", decision: "allow", reason: "chat: memory writes" },
    { tool: "*", tier: "T2", decision: "deny", reason: "chat default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "chat default" }
  ]
}

/** Production-shape gate: every memory op decided by the real SafetyKernel. */
const kernelBackedGate: Layer.Layer<PermissionGate, never, SafetyKernel> = Layer.effect(
  PermissionGate,
  Effect.gen(function* () {
    const kernel = yield* SafetyKernel
    return {
      checkMemory: (op: "read" | "write", store: string) =>
        Effect.gen(function* () {
          const tier = op === "read" ? ("T0" as const) : ("T1" as const)
          const tool = ToolName(`memory:${store}:${op}`)
          const decision = yield* kernel.check({
            tool,
            tier,
            args: { op, store },
            provenance: "chat/memory-gate"
          })
          if (decision === "ask") {
            return yield* Effect.fail(
              new PermissionDenied({
                tool,
                tier,
                reason: "ask unresolved: no interactive approver in the CLI yet"
              })
            )
          }
        })
    }
  })
)

/** Adapt the REAL SafetyKernel behind the module-seam's structural seam. */
const seamFromKernel = (kernel: SafetyKernelService): SafetyKernelSeam => {
  const toKernelIntent = (intent: { tool: string; tier: "T0" | "T1" | "T2" | "T3"; module: string }) => ({
    tool: ToolName(intent.tool),
    tier: intent.tier,
    args: { module: intent.module, tool: intent.tool, tier: intent.tier },
    provenance: `chat:${intent.module}`
  })
  return {
    check: (intent) =>
      kernel.check(toKernelIntent(intent)).pipe(
        Effect.map(
          (decision): GateVerdict =>
            decision === "allow" ? Allow : Ask("ask unresolved: no interactive approver in the CLI yet")
        ),
        Effect.catch((denied: PermissionDenied) =>
          Effect.succeed<GateVerdict>({ _tag: "Deny", reason: denied.reason, terminate: false })
        )
      ),
    execute: (intent, run) => kernel.execute(toKernelIntent(intent), () => run)
  }
}

const hooksLayer = (
  impls: ReadonlyArray<ModuleHookImpls>
): Layer.Layer<ModuleHooks, never, SafetyKernel> =>
  Layer.effect(
    ModuleHooks,
    Effect.gen(function* () {
      const kernel = yield* SafetyKernel
      return makeModuleHooks({ impls, kernel: seamFromKernel(kernel) })
    })
  )

export interface ChatStack {
  /** The composed layer: build it, register the provider, chat. */
  readonly layer: Layer.Layer<AgentLoop | InferencePool | MemoryService | HonestyService>
  /** The provider to register with the pool AND hand to the loop for streaming. */
  readonly provider: LocalHttpProvider
}

/**
 * Build the chat stack. Construction opens zero sockets (the provider is
 * inert until registered and used) — the preflight check is the caller's job.
 */
export const buildChatStack = (opts: {
  readonly baseUrl: string
  readonly model: string
  readonly honestyOpts?: AgentLoopHonestyOpts | undefined
}): ChatStack => {
  const provider = new LocalHttpProvider({ name: "chat-local", baseUrl: opts.baseUrl, model: opts.model })
  const kernelLayer = SafetyKernel.layerFromPolicy(openPolicy)
  const memoryStack = Layer.provide(
    Layer.provide(MemoryServiceLive, Layer.mergeAll(kernelBackedGate, MemoryPathsLive)),
    kernelLayer
  )
  const hooksStack = Layer.provide(hooksLayer([]), kernelLayer)
  const base = Layer.mergeAll(InferencePoolLive, hooksStack, memoryStack, HonestyServiceInMemory)
  const loopOnly = Layer.provide(
    layerAgentLoopWithHonesty({ streamProviders: [provider as Provider], honesty: opts.honestyOpts }),
    base
  )
  return { layer: Layer.mergeAll(loopOnly, InferencePoolLive, memoryStack, HonestyServiceInMemory), provider }
}
