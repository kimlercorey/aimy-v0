/**
 * permission-kernel/kernel.test.ts
 *
 * SafetyKernel behavior: allow/ask/deny paths, intent-kill across renamed
 * tools, canonicalized fingerprints, one-shot approvals, tier-spoofing,
 * fail-closed sandbox selection, and fail-closed layer construction.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Scope } from "effect"

import { ToolName, type JsonValue } from "../substrate/types.js"
import type { ConfigError, Tier } from "../substrate/errors.js"
import {
  SafetyKernel,
  SafetyKernelConfig,
  type SafetyKernelService,
  type ToolIntent,
} from "./kernel.js"
import { defaultPolicy, type PolicyDocument, type PolicyRule } from "./policy.js"

const policy = (rules: Array<PolicyRule>): PolicyDocument => ({ version: 1, rules })

const intent = (
  tool: string,
  tier: Tier,
  args: JsonValue,
  provenance = "test",
): ToolIntent => ({ tool: ToolName(tool), tier, args, provenance })

const withKernel = <A, E>(
  policyDoc: PolicyDocument,
  use: (kernel: SafetyKernelService) => Effect.Effect<A, E, never>,
  options?: { readonly sandboxBackend?: string },
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const kernel = yield* SafetyKernel
    return yield* use(kernel)
  }).pipe(Effect.provide(SafetyKernel.layerFromPolicy(policyDoc, options)))

describe("SafetyKernel", () => {
  it.effect("allow path: check returns allow and execute runs the thunk", () =>
    withKernel(
      policy([{ tool: "read_file", tier: "T0", decision: "allow" }]),
      (kernel) =>
        Effect.gen(function* () {
          const i = intent("read_file", "T0", { path: "/tmp/a.md" })
          assert.strictEqual(yield* kernel.check(i), "allow")
          let ran = false
          const result = yield* kernel.execute(i, () =>
            Effect.sync(() => {
              ran = true
              return 42
            }),
          )
          assert.strictEqual(result, 42)
          assert.isTrue(ran)
        }),
    ),
  )

  it.effect("deny path: execute fails with typed PermissionDenied", () =>
    withKernel(
      policy([{ tool: "shell_rm", tier: "T3", decision: "deny", reason: "too dangerous" }]),
      (kernel) =>
        Effect.gen(function* () {
          const i = intent("shell_rm", "T3", { target: "/tmp/x" })
          let ran = false
          const error = yield* Effect.flip(
            kernel.execute(i, () =>
              Effect.sync(() => {
                ran = true
                return "boom"
              }),
            ),
          )
          assert.strictEqual(error._tag, "PermissionDenied")
          if (error._tag !== "PermissionDenied") assert.fail("expected PermissionDenied")
          assert.strictEqual(error.tool, "shell_rm")
          assert.strictEqual(error.tier, "T3")
          assert.strictEqual(error.reason, "too dangerous")
          assert.isFalse(ran)
        }),
    ),
  )

  it.effect("adversarial: denial kills the intent — retry via a renamed tool is denied", () =>
    withKernel(
      policy([
        { tool: "shell_rm", tier: "T3", decision: "deny" },
        // The bypass tool WOULD be allowed by policy — the kill must win.
        { tool: "exec_code", tier: "T3", decision: "allow" },
      ]),
      (kernel) =>
        Effect.gen(function* () {
          const args = { target: "/tmp/x", recursive: true }
          yield* Effect.flip(
            kernel.execute(intent("shell_rm", "T3", args), () => Effect.succeed("nope")),
          )
          // Same args, different tool name: the Hermes #65592 bypass attempt.
          const renamed = intent("exec_code", "T3", args)
          const checkError = yield* Effect.flip(kernel.check(renamed))
          assert.strictEqual(checkError._tag, "PermissionDenied")
          assert.match(checkError.reason, /kills the intent/)
          const execError = yield* Effect.flip(
            kernel.execute(renamed, () => Effect.succeed("nope")),
          )
          assert.strictEqual(execError._tag, "PermissionDenied")
        }),
      { sandboxBackend: "test-sandbox" },
    ),
  )

  it.effect("intent fingerprint is canonical: key order does not evade the kill", () =>
    withKernel(
      policy([{ tool: "db_drop", tier: "T3", decision: "deny" }]),
      (kernel) =>
        Effect.gen(function* () {
          yield* Effect.flip(
            kernel.check(intent("db_drop", "T3", { a: 1, nested: { x: 1, y: 2 } })),
          )
          const reordered = intent("db_drop_alias", "T3", {
            nested: { y: 2, x: 1 },
            a: 1,
          })
          const error = yield* Effect.flip(kernel.check(reordered))
          assert.strictEqual(error._tag, "PermissionDenied")
          assert.match(error.reason, /kills the intent/)
        }),
    ),
  )

  it.effect("ask path: check returns ask and nothing executes without approval", () =>
    withKernel(
      policy([{ tool: "write_file", tier: "T1", decision: "ask" }]),
      (kernel) =>
        Effect.gen(function* () {
          const i = intent("write_file", "T1", { path: "/tmp/a.md" })
          assert.strictEqual(yield* kernel.check(i), "ask")
          let ran = false
          const error = yield* Effect.flip(
            kernel.execute(i, () =>
              Effect.sync(() => {
                ran = true
                return "wrote"
              }),
            ),
          )
          assert.strictEqual(error._tag, "PermissionDenied")
          assert.match(error.reason, /explicit approval/)
          assert.isFalse(ran)
        }),
    ),
  )

  it.effect("approve grants a one-shot approval, consumed on use", () =>
    withKernel(
      policy([{ tool: "write_file", tier: "T1", decision: "ask" }]),
      (kernel) =>
        Effect.gen(function* () {
          const i = intent("write_file", "T1", { path: "/tmp/a.md" })
          yield* kernel.approve(i)
          let ran = false
          const result = yield* kernel.execute(i, () =>
            Effect.sync(() => {
              ran = true
              return "wrote"
            }),
          )
          assert.strictEqual(result, "wrote")
          assert.isTrue(ran)
          // One-shot: a second execute without re-approval fails.
          const error = yield* Effect.flip(
            kernel.execute(i, () => Effect.succeed("wrote")),
          )
          assert.strictEqual(error._tag, "PermissionDenied")
        }),
    ),
  )

  it.effect("approving a denied intent fails: denial is terminal", () =>
    withKernel(
      policy([{ tool: "shell_rm", tier: "T3", decision: "deny" }]),
      (kernel) =>
        Effect.gen(function* () {
          const i = intent("shell_rm", "T3", { target: "/tmp/x" })
          yield* Effect.flip(kernel.check(i)) // deny + kill
          const error = yield* Effect.flip(kernel.approve(i))
          assert.strictEqual(error._tag, "PermissionDenied")
          assert.match(error.reason, /terminal/)
        }),
    ),
  )

  it.effect("unlisted tool fails closed even at T0", () =>
    withKernel(
      policy([{ tool: "read_file", tier: "T0", decision: "allow" }]),
      (kernel) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(kernel.check(intent("mystery_tool", "T0", {})))
          assert.strictEqual(error._tag, "PermissionDenied")
          assert.match(error.reason, /default-deny/)
        }),
    ),
  )

  it.effect("tier defaults apply: T0 allow, T1/T2 ask, T3 deny", () =>
    withKernel(defaultPolicy(), (kernel) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* kernel.check(intent("anything", "T0", {})), "allow")
        assert.strictEqual(yield* kernel.check(intent("anything", "T1", {})), "ask")
        assert.strictEqual(yield* kernel.check(intent("anything", "T2", {})), "ask")
        const error = yield* Effect.flip(kernel.check(intent("anything", "T3", {})))
        assert.strictEqual(error._tag, "PermissionDenied")
      }),
    ),
  )

  it.effect("tier-spoofing fails closed: classified tier beats claimed tier", () =>
    withKernel(
      policy([
        { tool: "exec_code", tier: "T3", decision: "allow" },
        { tool: "*", tier: "T0", decision: "allow" },
      ]),
      (kernel) =>
        Effect.gen(function* () {
          // exec_code is classified T3; claiming T0 must not inherit the T0 wildcard.
          const error = yield* Effect.flip(
            kernel.check(intent("exec_code", "T0", { code: "x" })),
          )
          assert.strictEqual(error._tag, "PermissionDenied")
          assert.match(error.reason, /different tier/)
        }),
    ),
  )

  it.effect("T3 without a sandbox backend fails closed with SandboxViolation", () =>
    withKernel(
      policy([{ tool: "exec_code", tier: "T3", decision: "allow" }]),
      (kernel) =>
        Effect.gen(function* () {
          let ran = false
          const error = yield* Effect.flip(
            kernel.execute(intent("exec_code", "T3", { code: "x" }), () =>
              Effect.sync(() => {
                ran = true
                return "ran"
              }),
            ),
          )
          assert.strictEqual(error._tag, "SandboxViolation")
          assert.match(error.reason, /no sandbox backend/)
          assert.isFalse(ran)
        }),
    ),
  )

  it.effect("T3 with a sandbox backend proceeds through the gate", () =>
    withKernel(
      policy([{ tool: "exec_code", tier: "T3", decision: "allow" }]),
      (kernel) =>
        Effect.gen(function* () {
          const result = yield* kernel.execute(
            intent("exec_code", "T3", { code: "x" }),
            () => Effect.succeed("ran"),
          )
          assert.strictEqual(result, "ran")
        }),
      { sandboxBackend: "test-sandbox" },
    ),
  )

  it.effect("denied-intent registry is session-scoped: a fresh kernel forgets", () =>
    Effect.gen(function* () {
      const pol = policy([{ tool: "shell_rm", tier: "T3", decision: "deny" }])
      const i = intent("shell_rm", "T3", { target: "/tmp/x" })
      // First kernel: deny kills the intent.
      yield* Effect.flip(withKernel(pol, (kernel) => kernel.check(i)))
      // Second kernel (fresh layer): same check fails as a fresh policy deny,
      // not as an intent-kill retry — the registry did not leak across layers.
      const error = yield* Effect.flip(withKernel(pol, (kernel) => kernel.check(i)))
      assert.strictEqual(error._tag, "PermissionDenied")
      assert.notMatch(error.reason, /kills the intent/)
    }),
  )

  it.effect("missing policy file fails the layer build closed (never fail-open)", () =>
    Effect.gen(function* () {
      // Build the kernel layer directly against a nonexistent config dir:
      // the build itself must fail with ConfigError (never fail-open).
      // NOTE: SafetyKernelConfig is a Context.Reference. Effect 4's types do
      // not eliminate a Reference requirement via Context.add/Layer.succeed
      // (the provided identifier collapses to `never`), but the runtime
      // override is honored — verified: the build below fails with ConfigError.
      // The cast bridges the type-level gap only.
      const configCtx = Context.add(Context.empty(), SafetyKernelConfig, {
        configDir: "/nonexistent-aimy-policy-dir",
      })
      const build = Effect.provide(Layer.build(SafetyKernel.layer), configCtx) as Effect.Effect<
        Context.Context<SafetyKernel>,
        ConfigError,
        Scope.Scope
      >
      const error = yield* Effect.flip(build)
      assert.strictEqual(error._tag, "ConfigError")
    }),
  )
})
