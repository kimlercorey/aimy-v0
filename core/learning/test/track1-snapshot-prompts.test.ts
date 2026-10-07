/**
 * track1-snapshot-prompts.test.ts — immutable snapshots, compact digests,
 * the review prompt text, and the proposal parser.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { REVIEW_SYSTEM_PROMPT, ReviewParseError, parseProposals } from "../src/prompts.js"
import { requireProvenance } from "../src/provenance.js"
import { deepFreeze, makeDigest, snapshotFromTurn, type ConversationSnapshot } from "../src/snapshot.js"
import type { TurnReport } from "../../agent-loop/src/index.js"
import { testProvenance } from "./track1-fixtures.js"

const testReport = (): TurnReport => ({
  turnId: "t-1",
  text: "Here is what I found.",
  executed: [{ id: "t-1:call:0", tool: "clock.now", result: "2026-10-07T06:30:00Z" }],
  blocked: [{ tool: "shell.exec", reason: "denied by gate" }],
  terminated: false,
    toolRounds: 0,
  parseFailures: [],
  steeringMessages: [],
  followUpMessages: []
})

describe("snapshotFromTurn", () => {
  it("copies by value: later mutation of the report cannot leak in", () => {
    // Mutable view: TurnReport is readonly by contract, but this test must
    // mutate the SOURCE report after snapshotting to prove the snapshot
    // copied by value.
    const report = testReport() as unknown as {
      text: string
      executed: Array<{ id: string; tool: string; result: unknown }>
    }
    const snap = snapshotFromTurn(
      "s-1",
      "what time is it?",
      report as unknown as TurnReport,
      "2026-10-07T06:30:00.000Z"
    )
    report.text = "MUTATED"
    report.executed.push({ id: "x", tool: "evil", result: 1 })
    expect(snap.turns[1]!.text).toBe("Here is what I found.")
    expect(snap.turns[1]!.toolCalls).toHaveLength(2) // 1 executed + 1 blocked
    expect(snap.turns[1]!.toolCalls[0]!.tool).toBe("clock.now")
  })

  it("is deep-frozen", () => {
    const snap = snapshotFromTurn("s-1", "hi", testReport())
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.turns)).toBe(true)
    expect(Object.isFrozen(snap.turns[0])).toBe(true)
    expect(Object.isFrozen(snap.turns[1]!.toolCalls)).toBe(true)
  })

  it("summarizes tool outcomes without leaking raw payloads", () => {
    const snap = snapshotFromTurn("s-1", "hi", testReport())
    const calls = snap.turns[1]!.toolCalls
    expect(calls[0]!.status).toBe("executed")
    expect(calls[1]!.status).toBe("blocked")
    expect(calls[1]!.outcomeSummary).toBe("denied by gate")
  })

  it("deepFreeze is cycle-safe", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic["self"] = cyclic
    expect(() => deepFreeze(cyclic)).not.toThrow()
    expect(Object.isFrozen(cyclic)).toBe(true)
  })
})

describe("makeDigest", () => {
  const bigSnapshot = (): ConversationSnapshot =>
    deepFreeze({
      sessionId: "s-big",
      capturedAt: "2026-10-07T06:30:00.000Z",
      turns: [
        { role: "user", text: "u".repeat(20_000), toolCalls: [] },
        { role: "assistant", text: "a".repeat(20_000), toolCalls: [] }
      ]
    })

  it("hard-caps at the char budget with an explicit marker", () => {
    const digest = makeDigest(bigSnapshot(), 300)
    expect(digest).toContain("[digest truncated at 300 chars]")
    expect(digest.length).toBeLessThanOrEqual(300 + "\n[digest truncated at 300 chars]".length)
    expect(digest).not.toContain("u".repeat(20_000))
  })

  it("labels roles and tool outcomes", () => {
    const snap = snapshotFromTurn("s-1", "what time is it?", testReport())
    const digest = makeDigest(snap, 4000)
    expect(digest).toContain("user: what time is it?")
    expect(digest).toContain("assistant: Here is what I found.")
    expect(digest).toContain("tool clock.now → executed")
    expect(digest).toContain("tool shell.exec → blocked")
  })
})

describe("parseProposals", () => {
  it("parses one JSON proposal per line", () => {
    const text = `{"kind":"add","namespace":"profile","key":"likes-tea","value":true,"reason":"user said they like tea"}\n{"kind":"remove","namespace":"skills","key":"old-skill","reason":"superseded"}`
    const parsed = parseProposals(text)
    expect(Array.isArray(parsed)).toBe(true)
    const proposals = parsed as Array<{ kind: string; namespace: string; key: string; value?: unknown; reason: string }>
    expect(proposals).toHaveLength(2)
    expect(proposals[0]).toMatchObject({ kind: "add", namespace: "profile", key: "likes-tea", value: true })
    expect(proposals[1]!.value).toBeUndefined()
  })

  it("NO-OP and blank output yield no proposals", () => {
    expect(parseProposals("NO-OP")).toEqual([])
    expect(parseProposals("  \n ")).toEqual([])
  })

  it("malformed JSON fails typed, never throws", () => {
    const parsed = parseProposals(`{"kind":"add", broken`)
    expect(Array.isArray(parsed)).toBe(false)
    const err = (parsed as { error: ReviewParseError }).error
    expect(err).toBeInstanceOf(ReviewParseError)
    expect(err._tag).toBe("ReviewParseError")
  })

  it("bad kind / namespace / missing reason fail typed", () => {
    for (const line of [
      `{"kind":"update","namespace":"profile","key":"k","reason":"r"}`,
      `{"kind":"add","namespace":"diary","key":"k","reason":"r"}`,
      `{"kind":"add","namespace":"profile","key":"","reason":"r"}`,
      `{"kind":"add","namespace":"profile","key":"k","reason":""}`
    ]) {
      const parsed = parseProposals(line)
      expect(Array.isArray(parsed), line).toBe(false)
    }
  })
})

describe("REVIEW_SYSTEM_PROMPT", () => {
  it("encodes the failure taxonomy in our own words", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("Learned helplessness is the failure mode")
    expect(REVIEW_SYSTEM_PROMPT).toContain("One fact goes to exactly ONE store")
    expect(REVIEW_SYSTEM_PROMPT).toContain("off-limits to silent change")
    expect(REVIEW_SYSTEM_PROMPT).toContain("never layer a near-duplicate")
    expect(REVIEW_SYSTEM_PROMPT).toContain("NO-OP")
  })
})

describe("requireProvenance", () => {
  const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff)

  it("accepts complete provenance", async () => {
    const p = await run(requireProvenance(testProvenance("s-1")))
    expect(p.sessionId).toBe("s-1")
    expect(p.origin).toBe("review-fork")
  })

  it("rejects missing and partial provenance", async () => {
    for (const bad of [
      undefined,
      null,
      {},
      { origin: "review-fork", executionContext: "unattended", sessionId: "s" }, // missing profileId
      { origin: "hermes", executionContext: "unattended", sessionId: "s", profileId: "p" } // bad origin
    ]) {
      const err = await run(Effect.flip(requireProvenance(bad)))
      expect(err, JSON.stringify(bad)).toBeInstanceOf(Error)
      expect((err as { _tag: string })._tag).toBe("UnattributedWrite")
    }
  })
})
