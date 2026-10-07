/**
 * permission-kernel/policy.test.ts
 *
 * Policy document load/validate: valid loads, every invalid shape fails
 * closed with a typed ConfigError, version mismatches are typed errors.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  POLICY_FILE_NAME,
  SUPPORTED_POLICY_VERSION,
  TIER_DEFAULTS,
  WILDCARD_TOOL,
  defaultPolicy,
  loadPolicyDocument,
} from "./policy.js"

const writePolicy = (dir: string, body: string) =>
  fs.writeFile(path.join(dir, POLICY_FILE_NAME), body, "utf-8")

const freshDir = () => fs.mkdtemp(path.join(os.tmpdir(), "aimy-policy-test-"))

describe("policy document", () => {
  it.effect("loads a valid policy file", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => freshDir())
      yield* Effect.promise(() =>
        writePolicy(
          dir,
          JSON.stringify({
            version: 1,
            rules: [{ tool: "read_file", tier: "T0", decision: "allow" }],
          }),
        ),
      )
      const doc = yield* loadPolicyDocument(dir)
      assert.strictEqual(doc.version, 1)
      assert.strictEqual(doc.rules.length, 1)
      assert.strictEqual(doc.rules[0]?.tool, "read_file")
      assert.strictEqual(doc.rules[0]?.decision, "allow")
    }),
  )

  it.effect("missing policy file fails closed with ConfigError (never fail-open)", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => freshDir())
      const error = yield* Effect.flip(loadPolicyDocument(dir))
      assert.strictEqual(error._tag, "ConfigError")
      assert.match(error.reason, /cannot read policy file/)
    }),
  )

  it.effect("invalid JSON fails closed with ConfigError", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => freshDir())
      yield* Effect.promise(() => writePolicy(dir, "{ not json"))
      const error = yield* Effect.flip(loadPolicyDocument(dir))
      assert.strictEqual(error._tag, "ConfigError")
      assert.match(error.reason, /not valid JSON/)
    }),
  )

  it.effect("schema violation fails closed with ConfigError", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => freshDir())
      yield* Effect.promise(() =>
        writePolicy(
          dir,
          JSON.stringify({
            version: 1,
            rules: [{ tool: "read_file", tier: "T9", decision: "allow" }],
          }),
        ),
      )
      const error = yield* Effect.flip(loadPolicyDocument(dir))
      assert.strictEqual(error._tag, "ConfigError")
      assert.match(error.reason, /failed validation/)
    }),
  )

  it.effect("excess properties are rejected, not silently ignored", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => freshDir())
      yield* Effect.promise(() =>
        writePolicy(
          dir,
          JSON.stringify({
            version: 1,
            rules: [
              { tool: "read_file", tier: "T0", decision: "allow", decison: "deny" },
            ],
          }),
        ),
      )
      const error = yield* Effect.flip(loadPolicyDocument(dir))
      assert.strictEqual(error._tag, "ConfigError")
    }),
  )

  it.effect("policy version mismatch is a typed ConfigError", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => freshDir())
      yield* Effect.promise(() =>
        writePolicy(
          dir,
          JSON.stringify({ version: SUPPORTED_POLICY_VERSION + 1, rules: [] }),
        ),
      )
      const error = yield* Effect.flip(loadPolicyDocument(dir))
      assert.strictEqual(error._tag, "ConfigError")
      assert.match(error.reason, /unsupported version/)
      assert.match(error.reason, new RegExp(String(SUPPORTED_POLICY_VERSION)))
    }),
  )

  it("defaultPolicy carries exactly the tier-default wildcard rules", () => {
    const policy = defaultPolicy()
    assert.strictEqual(policy.version, SUPPORTED_POLICY_VERSION)
    assert.strictEqual(policy.rules.length, 4)
    for (const tier of ["T0", "T1", "T2", "T3"] as const) {
      const rule = policy.rules.find(
        (r) => r.tool === WILDCARD_TOOL && r.tier === tier,
      )
      assert.isDefined(rule)
      assert.strictEqual(rule?.decision, TIER_DEFAULTS[tier])
    }
    // T0 allow, T1 ask, T2 ask, T3 deny — the locked tier defaults.
    assert.deepStrictEqual(TIER_DEFAULTS, {
      T0: "allow",
      T1: "ask",
      T2: "ask",
      T3: "deny",
    })
  })
})
