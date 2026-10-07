/**
 * Determinism, registry pinning, typed errors, freezing, and malformed inputs.
 */
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  defineJudge,
  JudgeInputInvalid,
  JudgeNotFound,
  JudgeRegistry,
  JudgeThrew,
  JudgeVerdictInvalid,
  referenceJudges,
  runJudge,
  runJudgeDefinition,
  type JudgeDefinition,
  type JudgeInput,
} from "../src/index.js"
import { verdictIdFor } from "../src/canonical.js"

const NOW = "2026-10-07T11:40:00.000Z"

/** Effect 4.x has no Either-returning combinator: capture failures without throwing. */
const capture = async <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<{ readonly _tag: "Right"; readonly right: A } | { readonly _tag: "Left"; readonly left: E }> => {
  try {
    return { _tag: "Right", right: await Effect.runPromise(effect) }
  } catch (error) {
    return { _tag: "Left", left: error as E }
  }
}

const goodInput = (): JudgeInput => ({
  taskId: "task-1",
  claim: "I called clock.now and got the time successfully.",
  finalState: { time: "2026-10-07T11:30:00Z" },
  sideEffects: [
    {
      toolCallId: "c1",
      tool: "clock.now",
      args: {},
      outcome: "ok",
      resultSummary: "2026-10-07T11:30:00Z",
    },
  ],
  dialogue: [{ role: "assistant", text: "I called clock.now and got the time successfully." }],
})

describe("determinism", () => {
  it("same input twice → deep-equal verdicts and identical verdictIds", async () => {
    const registry = referenceJudges()
    const first = await Effect.runPromise(
      runJudge(registry, "tool-success-matches-side-effects", "1.0.0", goodInput(), { now: NOW }),
    )
    const second = await Effect.runPromise(
      runJudge(registry, "tool-success-matches-side-effects", "1.0.0", goodInput(), {
        now: "2026-10-07T12:00:00.000Z",
      }),
    )
    expect(second.verdictId).toBe(first.verdictId)
    expect(second.judgeId).toBe(first.judgeId)
    expect(second.judgeVersion).toBe("1.0.0")
    // byte-identical except ranAt
    expect({ ...second, ranAt: NOW }).toEqual({ ...first, ranAt: NOW })
    expect(second.ranAt).not.toBe(first.ranAt)
  })

  it("verdictId is a stable hash of (judgeId, version, canonical inputs)", async () => {
    const input = goodInput()
    const expected = verdictIdFor("tool-success-matches-side-effects", "1.0.0", input)
    const verdict = await Effect.runPromise(
      runJudge(referenceJudges(), "tool-success-matches-side-effects", undefined, input, { now: NOW }),
    )
    expect(verdict.verdictId).toBe(expected)
    // key order must not matter
    const reordered = { ...input, finalState: { time: "2026-10-07T11:30:00Z", extra: 1 } }
    const v2 = await Effect.runPromise(
      runJudge(referenceJudges(), "tool-success-matches-side-effects", undefined, reordered, { now: NOW }),
    )
    expect(v2.verdictId).not.toBe(expected) // different inputs → different id
  })
})

describe("version pinning", () => {
  const v1: JudgeDefinition = defineJudge({
    id: "x",
    version: "1.0.0",
    description: "v1 always passes",
    check: () => ({ verdict: "pass", reasons: ["v1"], evidenceIds: [] }),
  })
  const v2: JudgeDefinition = defineJudge({
    id: "x",
    version: "2.0.0",
    description: "v2 always fails",
    check: () => ({ verdict: "fail", reasons: ["v2"], evidenceIds: [] }),
  })
  const registry = JudgeRegistry.from([v1, v2])

  it('resolve("x", "1.0.0") pins 1.0.0 while 2.0.0 coexists', async () => {
    const def = await Effect.runPromise(registry.resolve("x", "1.0.0"))
    expect(def.version).toBe("1.0.0")
    const verdict = await Effect.runPromise(runJudge(registry, "x", "1.0.0", goodInput(), { now: NOW }))
    expect(verdict.judgeVersion).toBe("1.0.0")
    expect(verdict.verdict).toBe("pass")
  })

  it('resolve("x", "^1.0.0") pins the highest 1.x, resolve("x") pins latest', async () => {
    const caret = await Effect.runPromise(registry.resolve("x", "^1.0.0"))
    expect(caret.version).toBe("1.0.0")
    const latest = await Effect.runPromise(registry.resolve("x"))
    expect(latest.version).toBe("2.0.0")
    const v2verdict = await Effect.runPromise(runJudge(registry, "x", "2.0.0", goodInput(), { now: NOW }))
    expect(v2verdict.judgeVersion).toBe("2.0.0")
    expect(v2verdict.verdict).toBe("fail")
  })

  it("unknown id → typed JudgeNotFound", async () => {
    const result = await capture(registry.resolve("nope"))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(JudgeNotFound)
      expect(result.left._tag).toBe("JudgeNotFound")
      expect(result.left.judgeId).toBe("nope")
    }
  })

  it("known id, unsatisfiable version → typed JudgeNotFound", async () => {
    const result = await capture(registry.resolve("x", "3.0.0"))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(JudgeNotFound)
      expect(result.left.requestedVersion).toBe("3.0.0")
    }
  })

  it("runJudge on unknown id surfaces JudgeNotFound, never throws", async () => {
    const result = await capture(runJudge(registry, "nope", undefined, goodInput()))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(JudgeNotFound)
  })
})

describe("input freezing", () => {
  it("a deliberately mutating judge cannot alter the input; it receives a frozen copy", async () => {
    let sawFrozen = false
    const mutator: JudgeDefinition = {
      id: "mutator",
      version: "1.0.0",
      description: "tries to mutate its input",
      run: (input: JudgeInput) => {
        sawFrozen = Object.isFrozen(input) && Object.isFrozen(input.sideEffects)
        try {
          ;(input as unknown as { claim: string }).claim = "hacked"
        } catch {
          /* frozen — assignment throws in strict mode */
        }
        try {
          ;(input.sideEffects as unknown as Array<unknown>).push({ evil: true })
        } catch {
          /* frozen */
        }
        return {
          verdictId: verdictIdFor("mutator", "1.0.0", input),
          judgeId: "mutator",
          judgeVersion: "1.0.0",
          taskId: input.taskId,
          verdict: "pass",
          reasons: [`sawFrozen=${sawFrozen}`],
          evidenceIds: [],
          ranAt: "",
        }
      },
    }
    const input = goodInput()
    const verdict = await Effect.runPromise(runJudgeDefinition(mutator, input, { now: NOW }))
    expect(verdict.verdict).toBe("pass")
    expect(sawFrozen).toBe(true)
    expect(verdict.reasons[0]).toBe("sawFrozen=true")
    // caller's original untouched
    expect(input.claim).toBe("I called clock.now and got the time successfully.")
    expect(input.sideEffects).toHaveLength(1)
  })

  it("returned verdicts are frozen — the agent cannot mutate them after the fact", async () => {
    const verdict = await Effect.runPromise(
      runJudge(referenceJudges(), "claim-has-evidence", "1.0.0", goodInput(), { now: NOW }),
    )
    expect(Object.isFrozen(verdict)).toBe(true)
    expect(Object.isFrozen(verdict.reasons)).toBe(true)
    expect(Object.isFrozen(verdict.evidenceIds)).toBe(true)
    expect(() => {
      ;(verdict as unknown as { verdict: string }).verdict = "pass"
    }).toThrow()
  })
})

describe("malformed inputs → typed JudgeInputInvalid, never a throw", () => {
  const cases: Array<[string, unknown]> = [
    ["empty claim", { ...goodInput(), claim: "   " }],
    ["empty sideEffects", { ...goodInput(), sideEffects: [] }],
    ["missing taskId", { ...goodInput(), taskId: "" }],
    ["bad outcome", { ...goodInput(), sideEffects: [{ ...goodInput().sideEffects[0], outcome: "maybe" }] }],
    ["null input", null],
    ["non-array dialogue", { ...goodInput(), dialogue: "hello" }],
  ]
  for (const [name, input] of cases) {
    it(name, async () => {
      const result = await capture(runJudge(referenceJudges(), "claim-has-evidence", "1.0.0", input, { now: NOW }))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(JudgeInputInvalid)
        expect(result.left._tag).toBe("JudgeInputInvalid")
      }
    })
  }

  it("circular finalState → JudgeInputInvalid", async () => {
    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    const input = { ...goodInput(), finalState: circular }
    const result = await capture(runJudge(referenceJudges(), "claim-has-evidence", "1.0.0", input, { now: NOW }))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(JudgeInputInvalid)
  })
})

describe("judge contract violations", () => {
  it("a throwing judge → typed JudgeThrew", async () => {
    const bomb: JudgeDefinition = {
      id: "bomb",
      version: "1.0.0",
      description: "throws",
      run: () => {
        throw new Error("purity violation")
      },
    }
    const result = await capture(runJudgeDefinition(bomb, goodInput(), { now: NOW }))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(JudgeThrew)
      expect(result.left._tag).toBe("JudgeThrew")
    }
  })

  it("a judge returning a forged verdictId → typed JudgeVerdictInvalid", async () => {
    const forger: JudgeDefinition = {
      id: "forger",
      version: "1.0.0",
      description: "forges verdictId",
      run: (input: JudgeInput) => ({
        verdictId: "deadbeef",
        judgeId: "forger",
        judgeVersion: "1.0.0",
        taskId: input.taskId,
        verdict: "pass",
        reasons: [],
        evidenceIds: [],
        ranAt: "",
      }),
    }
    const result = await capture(runJudgeDefinition(forger, goodInput(), { now: NOW }))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(JudgeVerdictInvalid)
      expect(result.left._tag).toBe("JudgeVerdictInvalid")
    }
  })

  it("a judge naming the wrong version → typed JudgeVerdictInvalid", async () => {
    const liar: JudgeDefinition = {
      id: "liar",
      version: "1.0.0",
      description: "names wrong version",
      run: (input: JudgeInput) => ({
        verdictId: verdictIdFor("liar", "1.0.0", input),
        judgeId: "liar",
        judgeVersion: "9.9.9",
        taskId: input.taskId,
        verdict: "pass",
        reasons: [],
        evidenceIds: [],
        ranAt: "",
      }),
    }
    const result = await capture(runJudgeDefinition(liar, goodInput(), { now: NOW }))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(JudgeVerdictInvalid)
  })
})
