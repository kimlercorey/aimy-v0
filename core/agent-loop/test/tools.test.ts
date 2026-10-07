/**
 * tools.test.ts — the extensible tool registry.
 *
 * Built-ins stay fixed; hosts register module tools (e.g. retrieval.query)
 * via layer opts. These tests prove: extras appear in the system prompt,
 * route through runTool at their declared tier, and unknown names still
 * fail as IoError-shaped Errors (never a crash).
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  buildSystemPrompt,
  builtinToolNames,
  resolveToolTier,
  runTool,
  SYSTEM_PROMPT,
  type AgentToolDef,
  type BuiltinToolContext
} from "../src/tools.js"

const ctx: BuiltinToolContext = { sessionId: "s1", turnCount: 0, turnId: "t1" }

const extra: AgentToolDef = {
  name: "retrieval.query",
  tier: "T1",
  description: "Search the public web.",
  argsHint: '{ "query": "..." }',
  run: (args) => Effect.succeed({ query: args["query"] })
}

describe("extensible tool registry", () => {
  it("built-ins are unchanged and the default prompt lists only them", () => {
    expect(builtinToolNames).toEqual(["clock.now", "session.info"])
    expect(SYSTEM_PROMPT).toContain("clock.now")
    expect(SYSTEM_PROMPT).toContain("session.info")
    expect(SYSTEM_PROMPT).not.toContain("retrieval.query")
  })

  it("registered tools appear in the built prompt with description and args", () => {
    const prompt = buildSystemPrompt([extra])
    expect(prompt).toContain("retrieval.query")
    expect(prompt).toContain("Search the public web.")
    expect(prompt).toContain('{ "query": "..." }')
    // built-ins still listed
    expect(prompt).toContain("clock.now")
  })

  it("registered tools route at their declared tier", async () => {
    expect(resolveToolTier("retrieval.query", [extra])).toBe("T1")
    expect(resolveToolTier("clock.now", [extra])).toBe("T0")
    expect(resolveToolTier("nope.nope", [extra])).toBe("T0")
    const out = await Effect.runPromise(runTool("retrieval.query", { query: "q" }, ctx, [extra]))
    expect(out).toEqual({ query: "q" })
  })

  it("an extra tool shadows nothing: same name as a built-in keeps the built-in", async () => {
    const shadow: AgentToolDef = { ...extra, name: "clock.now", run: () => Effect.succeed("shadow") }
    const out = await Effect.runPromise(runTool("clock.now", {}, ctx, [shadow]))
    // built-in wins (registry lookup first) — the shadow never runs
    expect(typeof out).toBe("string")
    expect(out).not.toBe("shadow")
  })

  it("unknown tool fails with a listing, never throws synchronously", async () => {
    const err = await Effect.runPromise(Effect.flip(runTool("nope.nope", {}, ctx, [extra])))
    expect(String(err)).toContain('unknown tool "nope.nope"')
    expect(String(err)).toContain("retrieval.query")
  })

  it("a failing extra tool's typed error flows through untouched", async () => {
    const tagged = { _tag: "RetrievalFailed", reason: "boom" }
    const failing: AgentToolDef = { ...extra, name: "x.fail", run: () => Effect.fail(tagged) }
    const err = await Effect.runPromise(Effect.flip(runTool("x.fail", {}, ctx, [failing])))
    expect(err).toBe(tagged)
  })
})
