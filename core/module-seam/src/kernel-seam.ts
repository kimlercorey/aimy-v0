/**
 * Structural seam for the real SafetyKernel.
 *
 * The permission-kernel library owns the real SafetyKernel; module-seam must
 * not depend on it (parallel build, and the seam keeps the dependency
 * direction one-way). The real kernel wires in at integration by implementing
 * this structural interface and providing `SafetyKernelSeamTag`.
 *
 * Gate semantics (Pi #10426, Hermes #65592):
 * - Gates are enforced at EXECUTION, never in the prompt.
 * - A deny always BLOCKS the call (it never runs). Deny with
 *   `terminate: true` additionally TERMINATES the turn.
 * - After a deny, the intent is dead: retrying via a different tool path
 *   must go through `check` again, where the kernel tracks denied intents.
 */
import { Context, Effect } from "effect"
import { HookError, PermissionDenied, SandboxViolation, TurnTerminated } from "./errors.js"

/** Least-privilege capability tiers (Hermes #527). DirectGate serves T0/T1 only. */
export type CapabilityTier = "T0" | "T1" | "T2" | "T3"

/** What a module (or the loop) wants to do, in kernel-checkable form. */
export interface ToolIntent {
  readonly kind: string // "tool.call" | "skill.view" | "memory.read" | ...
  readonly module: string
  readonly tool: string
  readonly tier: CapabilityTier
  readonly summary: string
}

/**
 * Gate verdict. Deny carries block + terminate semantics: the call is always
 * blocked, and `terminate: true` ends the turn as well.
 */
export type GateVerdict =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Ask"; readonly reason: string }
  | { readonly _tag: "Deny"; readonly reason: string; readonly terminate: boolean }

export const Allow: GateVerdict = { _tag: "Allow" }
export const Ask = (reason: string): GateVerdict => ({ _tag: "Ask", reason })
export const Deny = (reason: string, terminate = false): GateVerdict => ({
  _tag: "Deny",
  reason,
  terminate
})

/** Deny wins, then Ask, then Allow. Fail-closed merge for multiple verdict sources. */
export const mergeVerdicts = (verdicts: ReadonlyArray<GateVerdict>): GateVerdict => {
  let ask: GateVerdict | undefined
  for (const v of verdicts) {
    if (v._tag === "Deny") return v
    if (v._tag === "Ask" && ask === undefined) ask = v
  }
  return ask ?? Allow
}

export interface SafetyKernelSeam {
  /** Check an intent. Does not execute anything. */
  readonly check: (intent: ToolIntent) => Effect.Effect<GateVerdict, HookError>
  /**
   * Enforce the verdict and run `run` only on Allow.
   * - Allow: runs the effect.
   * - Ask: fails PermissionDenied (unresolved ask blocks; this layer is headless).
   * - Deny: fails PermissionDenied, or TurnTerminated when terminate is set.
   * The effect NEVER runs on non-Allow.
   */
  readonly execute: <A, E>(
    intent: ToolIntent,
    run: Effect.Effect<A, E>
  ) => Effect.Effect<A, E | PermissionDenied | TurnTerminated | HookError | SandboxViolation>
}

export class SafetyKernelSeamTag extends Context.Service<SafetyKernelSeamTag, SafetyKernelSeam>()(
  "aimy/module-seam/SafetyKernelSeam"
) {}

/** Build a ToolIntent for an ordinary tool call. */
export const toolIntent = (module: string, tool: string, tier: CapabilityTier, summary: string): ToolIntent => ({
  kind: "tool.call",
  module,
  tool,
  tier,
  summary
})

/**
 * Test / structural stub. `decide` fixes the verdict per intent.
 * `execute` enforces it exactly like the real kernel must: non-Allow never runs.
 */
export const makeStubSafetyKernel = (decide: (intent: ToolIntent) => GateVerdict): SafetyKernelSeam => ({
  check: (intent) => Effect.succeed(decide(intent)),
  execute: (intent, run) => {
    const verdict = decide(intent)
    switch (verdict._tag) {
      case "Allow":
        return run
      case "Ask":
        return Effect.fail(
          new PermissionDenied({
            tool: intent.tool,
            tier: intent.tier,
            reason: `ask unresolved, call blocked: ${verdict.reason}`,
          })
        )
      case "Deny":
        return verdict.terminate
          ? Effect.fail(new TurnTerminated({ reason: verdict.reason, toolCallId: intent.tool }))
          : Effect.fail(
              new PermissionDenied({ tool: intent.tool, tier: intent.tier, reason: verdict.reason })
            )
    }
  }
})

/** Stub kernel that allows everything (happy-path tests). */
export const allowAllKernel: SafetyKernelSeam = makeStubSafetyKernel(() => Allow)

/** Stub kernel that denies everything (fail-closed tests). */
export const makeDenyAllKernel = (terminate = false, reason = "denied by test kernel"): SafetyKernelSeam =>
  makeStubSafetyKernel(() => Deny(reason, terminate))
