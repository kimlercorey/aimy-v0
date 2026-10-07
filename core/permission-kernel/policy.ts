/**
 * permission-kernel/policy.ts
 *
 * The versioned permission-policy document: load, validate, fail closed.
 *
 * A policy document is a whitelist. Every rule names a tool, the tier the
 * tool is classified at, and the decision for that tool. Anything without a
 * matching rule — no exact tool+tier rule and no tier-wildcard rule — is
 * denied by default (fail closed). There is no fail-open path: a missing,
 * unreadable, unparsable, or schema-invalid policy file surfaces as a typed
 * `ConfigError` from substrate, and the kernel layer cannot be built without
 * a valid policy.
 *
 * Tier defaults (T0 allow / T1 ask / T2 ask / T3 deny) are expressed as
 * wildcard rules (`tool: "*"`) so that they live in the same document as the
 * overrides and can be audited, versioned, and revoked like any other rule.
 * `defaultPolicy()` builds a document containing exactly those wildcards.
 * A tool-specific rule always beats the wildcard for its tier; a claimed
 * tier that does not match the tool's classified tier is denied outright
 * (tier-spoofing fails closed).
 */
import { Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { ConfigError, type Tier } from "../substrate/errors.js"

/** Name of the policy file inside the AImy config dir. */
export const POLICY_FILE_NAME = "policy.json"

/** The policy schema version this kernel understands. */
export const SUPPORTED_POLICY_VERSION = 1 as const

/** Wildcard tool name: a rule with this tool applies to every tool at its tier. */
export const WILDCARD_TOOL = "*" as const

const TierField = Schema.Literal("T0", "T1", "T2", "T3")

/** Per-tool decision. `ask` means: do not execute until `approve()` grants a one-shot approval. */
export const DecisionSchema = Schema.Literal("allow", "ask", "deny")
export type Decision = typeof DecisionSchema.Type

export const PolicyRuleSchema = Schema.Struct({
  /** Tool name as registered, or "*" for a tier-wide default rule. */
  tool: Schema.String,
  /** The tier this tool is classified at. Must match the intent's claimed tier. */
  tier: TierField,
  decision: DecisionSchema,
  reason: Schema.optional(Schema.String),
})
export type PolicyRule = typeof PolicyRuleSchema.Type

export const PolicyDocumentSchema = Schema.Struct({
  version: Schema.Int,
  rules: Schema.Array(PolicyRuleSchema),
})
export type PolicyDocument = typeof PolicyDocumentSchema.Type

/**
 * Built-in tier defaults (Hermes #527: tiered capabilities, never binary
 * auth). Applied only via wildcard rules in a policy document — see
 * `defaultPolicy()`. T0 observes, T1/T2 ask, T3 is denied outright.
 */
export const TIER_DEFAULTS: Record<Tier, Decision> = {
  T0: "allow",
  T1: "ask",
  T2: "ask",
  T3: "deny",
}

/**
 * Build a policy document containing exactly the tier-default wildcard
 * rules. A starting point for operators; tool-specific rules are appended
 * on top and take precedence over the wildcard for their tier.
 */
export const defaultPolicy = (): PolicyDocument => ({
  version: SUPPORTED_POLICY_VERSION,
  rules: [
    {
      tool: WILDCARD_TOOL,
      tier: "T0",
      decision: "allow",
      reason: "tier default: read-only local observation is allowed",
    },
    {
      tool: WILDCARD_TOOL,
      tier: "T1",
      decision: "ask",
      reason: "tier default: bounded local writes require explicit approval",
    },
    {
      tool: WILDCARD_TOOL,
      tier: "T2",
      decision: "ask",
      reason: "tier default: network and identity-affecting actions require explicit approval",
    },
    {
      tool: WILDCARD_TOOL,
      tier: "T3",
      decision: "deny",
      reason: "tier default: destructive and privileged actions are denied",
    },
  ],
})

const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Load and validate `<configDir>/policy.json`.
 *
 * Never throws and never fails open: a missing file, invalid JSON, an
 * unsupported `version`, or any schema violation all surface as a typed
 * substrate `ConfigError`. The kernel layer depends on this effect, so no
 * `SafetyKernel` can exist without a valid policy.
 */
export const loadPolicyDocument = (
  configDir: string,
): Effect.Effect<PolicyDocument, ConfigError> =>
  Effect.gen(function* () {
    const file = path.join(configDir, POLICY_FILE_NAME)

    const text = yield* Effect.tryPromise({
      try: () => fs.readFile(file, "utf-8"),
      catch: (cause) =>
        new ConfigError({
          reason: `cannot read policy file ${file}: ${describeFailure(cause)}`,
        }),
    })

    const raw: unknown = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        new ConfigError({
          reason: `policy file ${file} is not valid JSON: ${describeFailure(cause)}`,
        }),
    })

    // Version gate with a message that names both sides; a version mismatch
    // is a typed ConfigError, never a silent fallback to old semantics.
    const rawVersion = (raw as { readonly version?: unknown } | null)?.version
    if (rawVersion !== SUPPORTED_POLICY_VERSION) {
      return yield* Effect.fail(
        new ConfigError({
          reason:
            `policy file ${file} has unsupported version ${JSON.stringify(rawVersion)}: ` +
            `this kernel supports version ${SUPPORTED_POLICY_VERSION}`,
        }),
      )
    }

    // Excess properties are rejected: a misspelled rule key must fail loudly,
    // never be silently ignored into a weaker policy.
    return yield* Schema.decodeUnknownEffect(PolicyDocumentSchema, {
      onExcessProperty: "error",
    })(raw).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            reason: `policy file ${file} failed validation: ${describeFailure(cause)}`,
          }),
      ),
    )
  })
