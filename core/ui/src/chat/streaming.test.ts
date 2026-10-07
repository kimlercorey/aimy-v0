/**
 * chat/streaming.test.ts — the agent-loop chunk -> Message mapping.
 *
 * Total mapping (nothing silently dropped), sanitization at the boundary
 * (Pi #10504), and correlation-id propagation.
 */
import { describe, expect, it } from "@effect/vitest"
import type { ChatChunk } from "../../../agent-loop/src/index.js"
import { chatChunkToMessage, summarizeToolResult } from "./streaming.js"

const doneChunk = (text: string): ChatChunk => ({
  _tag: "Done",
  report: {
    turnId: "t1",
    text,
    executed: [],
    blocked: [],
    terminated: false,
    parseFailures: [],
    steeringMessages: [],
    followUpMessages: [],
  },
})

describe("chatChunkToMessage", () => {
  it("maps Token chunks to StreamChunkReceived with the stream id", () => {
    const msg = chatChunkToMessage("s1", { _tag: "Token", delta: "hel" })
    expect(msg).toMatchObject({ _tag: "StreamChunkReceived", streamId: "s1", delta: "hel" })
  })

  it("sanitizes ANSI out of deltas before they become Messages", () => {
    const msg = chatChunkToMessage("s1", { _tag: "Token", delta: "\x1b[31mred\x1b[0m" })
    expect(msg).toMatchObject({ _tag: "StreamChunkReceived", delta: "red" })
  })

  it("maps ToolCall chunks to observed tool rows", () => {
    const msg = chatChunkToMessage("s1", {
      _tag: "ToolCall",
      tool: "exec",
      result: { ok: true },
    })
    expect(msg).toMatchObject({
      _tag: "StreamToolCallObserved",
      streamId: "s1",
      tool: "exec",
    })
    expect((msg as { resultSummary: string }).resultSummary).toContain("ok")
  })

  it("maps Done to StreamSettled with sanitized text", () => {
    const msg = chatChunkToMessage("s1", doneChunk("\x1b[1mdone\x1b[0m"))
    expect(msg).toMatchObject({ _tag: "StreamSettled", streamId: "s1", text: "done" })
  })
})

describe("summarizeToolResult", () => {
  it("truncates long results", () => {
    expect(summarizeToolResult("x".repeat(500))).toHaveLength(240)
  })

  it("stringifies objects", () => {
    expect(summarizeToolResult({ a: 1 })).toContain("a")
  })
})
