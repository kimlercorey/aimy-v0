/**
 * agent-loop/test/fixtures.ts — shared stack builders for agent-loop tests.
 *
 * Moved verbatim out of loop.test.ts so the M3 honesty wiring tests
 * (honesty/test/wiring.test.ts) and the honesty demo (honesty/demo.ts) can
 * drive the REAL loop stack: the REAL SafetyKernel behind ModuleHooks'
 * SafetyKernelSeam and behind MemoryService's PermissionGate. No fake gates
 * anywhere in this file.
 *
 * Not a test file itself (no *.test.ts suffix): vitest does not pick it up,
 * and importing it from another test module does not re-register tests.
 */
import { Effect, Layer, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  InferencePool,
  InferencePoolLive,
  StubProvider,
  type Provider
} from "../../inference-pool/index.js"
import {
  MemoryDirs,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
  PermissionGate
} from "../../memory/index.js"
import {
  Allow,
  Ask,
  Deny,
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
import {
  AgentLoop,
  layerAgentLoop,
  layerAgentLoopWithHonesty,
  type AgentLoopHonestyOpts,
  type ChatChunk,
  type TurnReport
} from "../src/index.js"
import { HonestyService, HonestyServiceInMemory } from "../../honesty/src/index.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "aimy-loop-test-"))

const pathsLayer = (dir: string): Layer.Layer<MemoryPaths> =>
  Layer.succeed(MemoryPaths, {
    sessionsDir: path.join(dir, "sessions"),
    storesDir: path.join(dir, "stores")
  } satisfies MemoryDirs)

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
            // Distinguishing args: the kernel fingerprints intents by args,
            // so distinct operations must not share one fingerprint.
            args: { op, store },
            provenance: "agent-loop-test/memory-gate"
          })
          if (decision === "ask") {
            return yield* Effect.fail(
              new PermissionDenied({
                tool,
                tier,
                reason: "ask unresolved: no interactive approver in headless tests"
              })
            )
          }
        })
    }
  })
)

/**
 * Adapt the REAL SafetyKernel behind the module-seam's structural
 * `SafetyKernelSeam`. Deny becomes a `Deny` verdict (no terminate — the real
 * kernel has no terminate semantics); ask fails closed headless.
 */
const seamFromKernel = (kernel: SafetyKernelService): SafetyKernelSeam => {
  const toKernelIntent = (intent: { tool: string; tier: "T0" | "T1" | "T2" | "T3"; module: string }) => ({
    tool: ToolName(intent.tool),
    tier: intent.tier,
    // The seam carries no args, so the kernel's arg-fingerprint cannot see
    // them. Synthesize the intent identity from what the seam does carry —
    // denial then kills exactly this (module, tool, tier) intent. Limitation:
    // the kernel's rename-the-tool bypass protection is degraded at this
    // seam, because two tools with identical synthesized args share a
    // fingerprint only when they also share the tool name.
    args: { module: intent.module, tool: intent.tool, tier: intent.tier },
    provenance: `agent-loop:${intent.module}`
  })
  return {
    check: (intent) =>
      kernel.check(toKernelIntent(intent)).pipe(
        Effect.map(
          (decision): GateVerdict =>
            decision === "allow"
              ? Allow
              : Ask("ask unresolved: no interactive approver in headless tests")
        ),
        Effect.catch((denied: PermissionDenied) =>
          Effect.succeed<GateVerdict>(Deny(denied.reason, false))
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

export const openPolicy: PolicyDocument = {
  version: 1,
  rules: [
    { tool: "*", tier: "T0", decision: "allow", reason: "test: T0 reads and tools" },
    { tool: "*", tier: "T1", decision: "allow", reason: "test: memory writes" },
    { tool: "*", tier: "T2", decision: "deny", reason: "test default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "test default" }
  ]
}

export const denySessionInfoPolicy: PolicyDocument = {
  version: 1,
  rules: [
    { tool: "session.info", tier: "T0", decision: "deny", reason: "test: session.info denied" },
    { tool: "*", tier: "T0", decision: "allow", reason: "test: other T0 tools" },
    { tool: "*", tier: "T1", decision: "allow", reason: "test: memory writes" },
    { tool: "*", tier: "T2", decision: "deny", reason: "test default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "test default" }
  ]
}

export interface StackOpts {
  readonly policy?: PolicyDocument
  readonly impls?: ReadonlyArray<ModuleHookImpls>
  readonly streamProviders?: ReadonlyArray<Provider>
  /**
   * M3 honesty wiring (Track 3): forwarded to `layerAgentLoop`. The pipeline
   * additionally requires `HonestyService` in the composed layer — merge
   * `HonestyServiceInMemory` (or another `HonestyService` layer) with the
   * stack returned here.
   */
  readonly honesty?: AgentLoopHonestyOpts
}

export const buildStack = (
  dir: string,
  opts: StackOpts = {}
): Layer.Layer<AgentLoop | InferencePool | MemoryService | HonestyService> => {
  const kernelLayer = SafetyKernel.layerFromPolicy(opts.policy ?? openPolicy)
  const memoryStack = Layer.provide(
    Layer.provide(MemoryServiceLive, Layer.mergeAll(kernelBackedGate, pathsLayer(dir))),
    kernelLayer
  )
  const hooksStack = Layer.provide(hooksLayer(opts.impls ?? []), kernelLayer)
  const base = Layer.mergeAll(InferencePoolLive, hooksStack, memoryStack)
  // M3 honesty (Track 3): when `opts.honesty` is set, the loop is built with
  // `HonestyService` as a declared requirement, so the post-turn pipeline is
  // guaranteed to run. (Ambient pickup via `Effect.serviceOption` inside
  // `layerAgentLoop` cannot see a sibling `Layer.mergeAll` branch at build
  // time, hence the explicit requirement.)
  const loopOnly =
    opts.honesty === undefined
      ? Layer.provide(layerAgentLoop({ streamProviders: opts.streamProviders ?? [] }), base)
      : Layer.provide(
          layerAgentLoopWithHonesty({
            streamProviders: opts.streamProviders ?? [],
            honesty: opts.honesty
          }),
          Layer.mergeAll(base, HonestyServiceInMemory)
        )
  // Test programs register the stub through the pool and assert on memory
  // directly, so both stay visible alongside the loop (same layer instances:
  // one build, memoized by identity). HonestyService is always exposed so
  // honesty tests can read the same ledger the loop's pipeline wrote to
  // (shared by layer identity — a single instance per build); the loop only
  // consumes it when honesty opts are set.
  return Layer.mergeAll(loopOnly, InferencePoolLive, memoryStack, HonestyServiceInMemory)
}

/** Register the stub, run one chat, collect every chunk. */
export const collectChat = (
  stack: Layer.Layer<AgentLoop | InferencePool | MemoryService>,
  stub: StubProvider,
  sessionId: string,
  input: string
): Promise<Array<ChatChunk>> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(stub)
        const loop = yield* AgentLoop
        return [...(yield* Stream.runCollect(loop.chat(sessionId, input)))]
      }),
      stack
    )
  )

export const doneReport = (chunks: ReadonlyArray<ChatChunk>): TurnReport => {
  const last = chunks[chunks.length - 1]
  if (last === undefined || last._tag !== "Done") throw new Error("expected final Done chunk")
  return last.report
}

export const tokenDeltas = (chunks: ReadonlyArray<ChatChunk>): Array<string> =>
  chunks.filter((c) => c._tag === "Token").map((c) => (c as { delta: string }).delta)

export const toolBlock = (tool: string, args: unknown = {}): string =>
  "```aimy-tool\n" + JSON.stringify({ tool, args }) + "\n```"
