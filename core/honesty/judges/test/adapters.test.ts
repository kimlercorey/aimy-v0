/**
 * `sideEffectsFromTurn` adapts agent-loop TurnReport shapes into judge inputs.
 */
import { describe, expect, it } from "@effect/vitest"

import type { BlockedToolCall, ExecutedToolCall } from "../../../agent-loop/src/index.js"
import { sideEffectsFromTurn } from "../src/index.js"

describe("sideEffectsFromTurn", () => {
  it("maps Ok results → ok and IoError results → io-error", () => {
    const executed: ReadonlyArray<ExecutedToolCall> = [
      { id: "c1", tool: "clock.now", result: "2026-10-07T11:30:00Z" },
      { id: "c2", tool: "web.fetch", result: { _tag: "IoError", reason: "dial timeout" } },
    ]
    const records = sideEffectsFromTurn(executed, [])
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ toolCallId: "c1", tool: "clock.now", outcome: "ok" })
    expect(records[0]?.resultSummary).toContain("2026-10-07T11:30:00Z")
    expect(records[1]).toMatchObject({ toolCallId: "c2", tool: "web.fetch", outcome: "io-error" })
    expect(records[1]?.resultSummary).toContain("dial timeout")
  })

  it("maps blocked calls → blocked with the gate reason", () => {
    const blocked: ReadonlyArray<BlockedToolCall> = [{ tool: "fs.write", reason: "T2 needs approval" }]
    const records = sideEffectsFromTurn([], blocked)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tool: "fs.write", outcome: "blocked" })
    expect(records[0]?.resultSummary).toContain("T2 needs approval")
    expect(records[0]?.toolCallId).toBe("blocked-0")
  })

  it("preserves turn order: executed first, then blocked", () => {
    const executed: ReadonlyArray<ExecutedToolCall> = [{ id: "c1", tool: "a", result: 1 }]
    const blocked: ReadonlyArray<BlockedToolCall> = [{ tool: "b", reason: "no" }]
    const records = sideEffectsFromTurn(executed, blocked)
    expect(records.map((r) => r.tool)).toEqual(["a", "b"])
  })

  it("summaries are bounded (long values truncated)", () => {
    const executed: ReadonlyArray<ExecutedToolCall> = [{ id: "c1", tool: "a", result: "x".repeat(500) }]
    const records = sideEffectsFromTurn(executed, [])
    expect((records[0]?.resultSummary ?? "").length).toBeLessThanOrEqual(121)
  })
})
