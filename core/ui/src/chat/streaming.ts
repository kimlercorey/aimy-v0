/**
 * ui/src/chat/streaming.ts — pure mapping from agent-loop chunks to Messages.
 *
 * Kept separate from app.ts so the streaming protocol is unit-testable without
 * importing the foldkit runtime (which needs a DOM-capable host). The
 * `inferenceStream` subscription in app.ts is a thin runner over this.
 *
 * Sanitization happens here, at the boundary, before deltas become Messages
 * (Pi #10504): split ANSI sequences cannot corrupt retained output because
 * they never survive this mapping.
 */
import type { ChatChunk } from "../../../agent-loop/src/index.js"
import { sanitizeTerminalOutput } from "../rendering.js"
import { Message } from "../messages.js"

/** Truncated, sanitized one-line summary of a tool result for the transcript. */
export const summarizeToolResult = (result: unknown): string => {
  const text =
    typeof result === "string" ? result : (JSON.stringify(result) ?? String(result))
  return sanitizeTerminalOutput(text).slice(0, 240)
}

/**
 * Map one `AgentLoop.chat` chunk to the Message the UI handles. Total:
 * every chunk the loop can emit has a mapping — nothing is silently dropped.
 */
export const chatChunkToMessage = (streamId: string, chunk: ChatChunk): Message => {
  switch (chunk._tag) {
    case "Token":
      return Message.StreamChunkReceived({
        streamId,
        delta: sanitizeTerminalOutput(chunk.delta),
      })
    case "ToolCall":
      return Message.StreamToolCallObserved({
        streamId,
        tool: chunk.tool,
        resultSummary: summarizeToolResult(chunk.result),
      })
    case "Done":
      return Message.StreamSettled({
        streamId,
        text: sanitizeTerminalOutput(chunk.report.text),
        at: Date.now(),
      })
  }
}
