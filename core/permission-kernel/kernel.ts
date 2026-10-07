/**
 * permission-kernel/kernel.ts
 *
 * The SafetyKernel: AImy's fail-closed permission system (architecture §1.1
 * item 7, Part 02 §2). One Effect `Context.Tag` service, built as a `Layer`.
 *
 * Hard rules, from the pitfalls checklist:
 * - Gates live at EXECUTION, never in the prompt (Pi #10426). `execute()`
 *   is the one code-execution entry point; the gate is consulted inside it,
 *   at the moment of execution. Hiding a tool from the model is UX, not
 *   enforcement.
 * - Denial kills the INTENT, not the tool call (Hermes #65592). A denied
 *   intent is recorded under a tool-agnostic fingerprint of its canonicalized
 *   args; retrying the same args via a different tool or path is denied.
 *   Denied intents are terminal for the session and cannot be approved.
 * - Sandbox selection fails closed (Hermes #61882). T3 (code execution,
 *   destructive) requires a configured sandbox backend; without one,
 *   `execute()` fails with `SandboxViolation` instead of running on the host.
 * - Tiered capabilities, never binary auth (Hermes #527). Per-tool
 *   allow/ask/deny across T0-T3; TS types are documentation, the registry
 *   and the execution gate are the boundary (Pi #9824).
 * - Nothing here touches the network. The only filesystem access in this
 *   library is the policy-file read in `policy.ts`.
 */
import { Context, Effect, Layer } from "effect"

import { resolvePaths } from "../substrate/config.js"
import {
  ConfigError,
  PermissionDenied,
  SandboxViolation,
  type Tier,
} from "../substrate/errors.js"
import type { JsonValue, ToolName } from "../substrate/types.js"
import {
  WILDCARD_TOOL,
  loadPolicyDocument,
  type Decision,
  type PolicyDocument,
} from "./policy.js"

/**
 * A single tool-call intent presented to the gate. The `tier` is the
 * caller's claim; the policy document is the authority — a claimed tier that
 * does not match the tool's classified tier is denied (tier-spoofing fails
 * closed).
 */
export interface ToolIntent {
  readonly tool: ToolName
  readonly tier: Tier
  readonly args: JsonValue
  /** Who/why this intent exists, e.g. "agent-loop:turn-42" or "module:web-retrieval". */
  readonly provenance: string
}

/** Kernel configuration, provided as a `Context.Reference` with sane defaults. */
export interface SafetyKernelConfig {
  /** Directory containing `policy.json`. Defaults to the AImy XDG config home. */
  readonly configDir: string
  /**
   * Name of the sandbox backend available to this kernel (e.g. "seatbelt",
   * "namespaces", "wasm"). `undefined` means no backend is available: T3
   * code execution then fails closed with `SandboxViolation` rather than
   * running on the host (Hermes #61882).
   */
  readonly sandboxBackend?: string
}

export const SafetyKernelConfig = Context.Reference<SafetyKernelConfig>(
  "aimy/permission-kernel/SafetyKernelConfig",
  { defaultValue: () => ({ configDir: resolvePaths().config }) },
)

export interface SafetyKernelService {
  /**
   * Decide an intent without executing anything. Succeeds with "allow" or
   * "ask"; a "deny" decision fails with a typed `PermissionDenied` (and
   * kills the intent — see below).
   */
  readonly check: (intent: ToolIntent) => Effect.Effect<Decision, PermissionDenied>
  /**
   * The ONE code-execution entry point. The gate is enforced here, at
   * execution time (Pi #10426). "allow" runs; "ask" runs only with a live
   * one-shot approval from `approve()` (consumed on use); anything else
   * fails typed. T3 additionally requires a sandbox backend.
   */
  readonly execute: <A, E>(
    intent: ToolIntent,
    run: () => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | PermissionDenied | SandboxViolation>
  /**
   * Grant a one-shot approval for an "ask" intent, consumed by the next
   * `execute()` of the exact same intent. Approving an "allow" intent is a
   * no-op. Approving a denied (or unlisted) intent fails: denial is terminal
   * and approval can never override a deny.
   */
  readonly approve: (intent: ToolIntent) => Effect.Effect<void, PermissionDenied>
}

export class SafetyKernel extends Context.Service<SafetyKernel, SafetyKernelService>()(
  "aimy/permission-kernel/SafetyKernel",
) {
  /**
   * Live layer: loads the policy from `<configDir>/policy.json` and builds
   * the session-scoped kernel. Fails with `ConfigError` when the policy is
   * missing or invalid — the kernel cannot exist without a valid policy,
   * so there is no fail-open path.
   */
  static readonly layer: Layer.Layer<SafetyKernel, ConfigError, SafetyKernelConfig> =
    Layer.effect(
      SafetyKernel,
      Effect.gen(function* () {
        const config = yield* SafetyKernelConfig
        const policy = yield* loadPolicyDocument(config.configDir)
        return SafetyKernel.of(buildKernel(policy, config.sandboxBackend))
      }),
    )

  /**
   * Test/dev layer: build a kernel from an in-memory policy document.
   * The denied-intent registry and approval set are fresh per layer build
   * (session-scoped, in-memory).
   */
  static readonly layerFromPolicy = (
    policy: PolicyDocument,
    options?: { readonly sandboxBackend?: string },
  ): Layer.Layer<SafetyKernel> =>
    Layer.succeed(
      SafetyKernel,
      SafetyKernel.of(buildKernel(policy, options?.sandboxBackend)),
    )
}

/** Canonicalize args into a stable string: object keys sorted recursively. */
const canonicalize = (value: JsonValue): string => {
  if (value === null) return "null"
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value)
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(",")}]`
      }
      const record = value as Record<string, JsonValue>
      const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key] as JsonValue)}`)
      return `{${entries.join(",")}}`
    }
  }
}

/**
 * Tool-agnostic identity of an intent (Hermes #65592). Two calls with the
 * same canonicalized args are the same intent even under different tool
 * names — this is what makes "denial kills the intent" hold across a
 * rename-the-tool bypass attempt.
 */
const intentFingerprint = (intent: ToolIntent): string => canonicalize(intent.args)

/** Exact identity for one-shot approvals: tool + provenance + canonical args. */
const approvalFingerprint = (intent: ToolIntent): string =>
  `${intent.tool}\u0000${intent.provenance}\u0000${canonicalize(intent.args)}`

/**
 * Pure policy lookup. Precedence: exact tool+tier rule, then tier-wildcard
 * rule, then deny. A tool classified in the policy at any tier but claimed
 * at a different tier is denied — the policy classifies tools, the caller
 * does not get to re-tier them.
 */
const decide = (policy: PolicyDocument, intent: ToolIntent): Decision => {
  const toolRules = policy.rules.filter((rule) => rule.tool === intent.tool)
  const exact = toolRules.find((rule) => rule.tier === intent.tier)
  if (exact !== undefined) return exact.decision
  // Classified at another tier: claimed tier is spoofed or stale — deny.
  if (toolRules.length > 0) return "deny"
  const wildcard = policy.rules.find(
    (rule) => rule.tool === WILDCARD_TOOL && rule.tier === intent.tier,
  )
  // Unlisted tool, no tier default: default-deny (fail closed).
  return wildcard?.decision ?? "deny"
}

/**
 * Human-readable reason for a deny. Mirrors `decide()`'s precedence exactly:
 * exact rule, then classified-at-another-tier, then tier wildcard, then
 * default-deny — so the message always names the rule that actually denied.
 */
const denialReason = (policy: PolicyDocument, intent: ToolIntent): string => {
  const toolRules = policy.rules.filter((rule) => rule.tool === intent.tool)
  const exact = toolRules.find((rule) => rule.tier === intent.tier)
  if (exact !== undefined) {
    return exact.reason ?? `denied by policy rule for tool "${exact.tool}" at tier ${intent.tier}`
  }
  if (toolRules.length > 0) {
    return (
      `tool "${intent.tool}" is classified at a different tier; ` +
      `claimed tier ${intent.tier} does not match — denied (fail closed)`
    )
  }
  const wildcard = policy.rules.find(
    (rule) => rule.tool === WILDCARD_TOOL && rule.tier === intent.tier,
  )
  if (wildcard?.reason !== undefined) return wildcard.reason
  if (wildcard !== undefined) {
    return `denied by policy rule for tool "${wildcard.tool}" at tier ${intent.tier}`
  }
  return `no policy rule for tool "${intent.tool}" at tier ${intent.tier} — default-deny (fail closed)`
}

interface KernelState {
  /** Fingerprints of killed intents (tool-agnostic). Session-scoped. */
  readonly deniedIntents: Set<string>
  /** One-shot approvals, consumed by the next matching execute(). */
  readonly approvals: Set<string>
}

const buildKernel = (
  policy: PolicyDocument,
  sandboxBackend: string | undefined,
): SafetyKernelService => {
  const state: KernelState = { deniedIntents: new Set(), approvals: new Set() }

  const isKilled = (intent: ToolIntent): boolean =>
    state.deniedIntents.has(intentFingerprint(intent))

  const killedError = (intent: ToolIntent): PermissionDenied =>
    new PermissionDenied({
      tool: intent.tool,
      tier: intent.tier,
      reason:
        "intent was denied earlier in this session; denial kills the intent — " +
        "retrying the same action via a different tool or path is not permitted",
    })

  const check = (intent: ToolIntent): Effect.Effect<Decision, PermissionDenied> =>
    Effect.gen(function* () {
      if (isKilled(intent)) {
        return yield* Effect.fail(killedError(intent))
      }
      const decision = decide(policy, intent)
      if (decision === "deny") {
        // Denial kills the intent: record it BEFORE failing so every later
        // retry — same tool or renamed — hits the registry above.
        state.deniedIntents.add(intentFingerprint(intent))
        return yield* Effect.fail(
          new PermissionDenied({
            tool: intent.tool,
            tier: intent.tier,
            reason: denialReason(policy, intent),
          }),
        )
      }
      return decision
    })

  const approve = (intent: ToolIntent): Effect.Effect<void, PermissionDenied> =>
    Effect.gen(function* () {
      if (isKilled(intent)) {
        return yield* Effect.fail(
          new PermissionDenied({
            tool: intent.tool,
            tier: intent.tier,
            reason: "denied intents are terminal for this session and cannot be approved",
          }),
        )
      }
      const decision = decide(policy, intent)
      if (decision === "deny") {
        return yield* Effect.fail(
          new PermissionDenied({
            tool: intent.tool,
            tier: intent.tier,
            reason: `policy denies this intent (${denialReason(policy, intent)}); approval cannot override a deny`,
          }),
        )
      }
      if (decision === "ask") {
        state.approvals.add(approvalFingerprint(intent))
      }
      // "allow" needs no approval: approving it is a no-op success.
    })

  const execute = <A, E>(
    intent: ToolIntent,
    run: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | PermissionDenied | SandboxViolation> =>
    Effect.gen(function* () {
      // The gate is consulted HERE, at execution (Pi #10426) — never cached
      // from an earlier check, never decided in the prompt.
      const decision = yield* check(intent)
      if (decision === "ask") {
        const key = approvalFingerprint(intent)
        if (!state.approvals.has(key)) {
          return yield* Effect.fail(
            new PermissionDenied({
              tool: intent.tool,
              tier: intent.tier,
              reason:
                `intent requires explicit approval (ask); grant it with approve() first — ` +
                `approvals are one-shot and consumed on use`,
            }),
          )
        }
        state.approvals.delete(key)
      }
      // Sandbox selection fails closed (Hermes #61882): T3 without a
      // configured backend never runs on the host.
      if (intent.tier === "T3" && sandboxBackend === undefined) {
        return yield* Effect.fail(
          new SandboxViolation({
            reason:
              `refusing T3 code execution for tool "${intent.tool}" with no sandbox ` +
              `backend configured — will not run on the host (fail closed)`,
          }),
        )
      }
      return yield* run()
    })

  return { check, execute, approve }
}
