/**
 * deep-research/test/planner.test.ts — the planner's parse/validate/fallback contract.
 *
 * parsePlan is pure: valid JSON, fenced JSON, and every malformed shape.
 * planWithFallback uses a stubbed PlanModel: model success → model plan;
 * model error or garbage → the honest single-query fallback (fromModel: false).
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  fallbackPlan,
  parsePlan,
  planWithFallback,
  PLANNER_PROMPT_VERSION,
  type PlanModel,
} from "../src/planner.js"
import { MalformedPlan, PlanError } from "../src/errors.js"

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

const VALID_JSON = JSON.stringify({
  subQuestions: [
    { question: "what is solid-state battery", intent: "background" },
    { question: "Toyota solid-state battery 2026", intent: "evidence", siteScope: "site:reuters.com" },
    { question: "solid-state battery skepticism", intent: "counterpoint" },
    { question: "solid-state battery arxiv", intent: "primary-source", siteScope: "site:arxiv.org" },
  ],
})

const stubModel = (output: string | Error): PlanModel => ({
  generateText: () =>
    output instanceof Error
      ? Effect.fail(new PlanError({ reason: output.message }))
      : Effect.succeed(output),
})

describe("parsePlan", () => {
  it("accepts valid planner JSON", async () => {
    const plan = await run(parsePlan(VALID_JSON))
    expect(plan.fromModel).toBe(true)
    expect(plan.subQuestions).toHaveLength(4)
    expect(plan.subQuestions[1]?.siteScope).toBe("site:reuters.com")
    expect(plan.subQuestions[0]?.siteScope).toBeUndefined()
  })

  it("strips markdown fences", async () => {
    const plan = await run(parsePlan("```json\n" + VALID_JSON + "\n```"))
    expect(plan.subQuestions).toHaveLength(4)
  })

  it("rejects non-JSON", async () => {
    const e = await run(Effect.flip(parsePlan("not json at all")))
    expect(e).toBeInstanceOf(MalformedPlan)
    expect(e.reason).toContain("not valid JSON")
  })

  it("rejects missing subQuestions array", async () => {
    const e = await run(Effect.flip(parsePlan(JSON.stringify({ foo: 1 }))))
    expect(e).toBeInstanceOf(MalformedPlan)
    expect(e.reason).toContain("subQuestions")
  })

  it("rejects empty sub-questions", async () => {
    const e = await run(Effect.flip(parsePlan(JSON.stringify({ subQuestions: [] }))))
    expect(e).toBeInstanceOf(MalformedPlan)
    expect(e.reason).toContain("zero sub-questions")
  })

  it("rejects invalid intent", async () => {
    const bad = JSON.stringify({ subQuestions: [{ question: "q", intent: "vibes" }] })
    const e = await run(Effect.flip(parsePlan(bad)))
    expect(e).toBeInstanceOf(MalformedPlan)
    expect(e.reason).toContain("#0")
  })

  it("rejects empty question", async () => {
    const bad = JSON.stringify({ subQuestions: [{ question: "  ", intent: "evidence" }] })
    const e = await run(Effect.flip(parsePlan(bad)))
    expect(e).toBeInstanceOf(MalformedPlan)
  })
})

describe("fallbackPlan", () => {
  it("is the honest single-query plan", () => {
    const plan = fallbackPlan("solid-state batteries")
    expect(plan.fromModel).toBe(false)
    expect(plan.subQuestions).toHaveLength(1)
    expect(plan.subQuestions[0]?.question).toBe("solid-state batteries")
    expect(plan.subQuestions[0]?.intent).toBe("evidence")
  })
})

describe("planWithFallback", () => {
  it("uses the model plan when the model cooperates", async () => {
    const plan = await run(planWithFallback(stubModel(VALID_JSON), "q"))
    expect(plan.fromModel).toBe(true)
    expect(plan.subQuestions).toHaveLength(4)
  })

  it("falls back honestly on model error", async () => {
    const plan = await run(planWithFallback(stubModel(new Error("timeout")), "my query"))
    expect(plan.fromModel).toBe(false)
    expect(plan.subQuestions[0]?.question).toBe("my query")
  })

  it("falls back honestly on garbage output", async () => {
    const plan = await run(planWithFallback(stubModel("lol not json"), "my query"))
    expect(plan.fromModel).toBe(false)
  })

  it("prompt version is pinned for learning-loop refinement", () => {
    expect(PLANNER_PROMPT_VERSION).toBe("planner/v1")
  })
})
