/**
 * honesty/judges/adapters.ts
 *
 * Adapts the agent-loop's `TurnReport` shapes into judge inputs.
 * Imports the turn types from the existing libs — never redefines them.
 *
 * Mapping:
 *   ExecutedToolCall.result = Ok value            → outcome "ok"
 *   ExecutedToolCall.result = {_tag:"IoError",…}  → outcome "io-error"
 *   BlockedToolCall (permission/safety gate)      → outcome "blocked"
 *   "denied" is never produced here — the turn report has no denied
 *   channel; it exists in the contract for future gate verdicts.
 */
import type { BlockedToolCall, ExecutedToolCall } from "../../../agent-loop/src/index.js"

import type { SideEffectOutcome, SideEffectRecord } from "./contracts.js"

const isIoErrorResult = (result: unknown): result is { readonly _tag: "IoError"; readonly reason: string } =>
  typeof result === "object" &&
  result !== null &&
  (result as { _tag?: unknown })._tag === "IoError" &&
  typeof (result as { reason?: unknown }).reason === "string"

/** Short human-readable summary of a tool result value (bounded, no secrets). */
const summarizeValue = (value: unknown): string => {
  if (value === null || value === undefined) return "no result value"
  if (typeof value === "string") return value.length <= 120 ? value : `${value.slice(0, 117)}…`
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return typeof value
    return json.length <= 120 ? json : `${json.slice(0, 117)}…`
  } catch {
    return typeof value
  }
}

const outcomeOf = (result: unknown): { readonly outcome: SideEffectOutcome; readonly summary: string } => {
  if (isIoErrorResult(result)) {
    return { outcome: "io-error", summary: `io-error: ${result.reason.slice(0, 200)}` }
  }
  return { outcome: "ok", summary: summarizeValue(result) }
}

/**
 * Build the `SideEffectRecord[]` for a judge input from one turn's
 * `TurnReport.executed` and `TurnReport.blocked`.
 */
export const sideEffectsFromTurn = (
  executed: ReadonlyArray<ExecutedToolCall>,
  blocked: ReadonlyArray<BlockedToolCall>,
): ReadonlyArray<SideEffectRecord> => {
  const records: Array<SideEffectRecord> = []
  for (const call of executed) {
    const { outcome, summary } = outcomeOf(call.result)
    records.push({
      toolCallId: call.id,
      tool: call.tool,
      args: {},
      outcome,
      resultSummary: summary,
    })
  }
  blocked.forEach((call, index) => {
    records.push({
      toolCallId: `blocked-${index}`,
      tool: call.tool,
      args: {},
      outcome: "blocked",
      resultSummary: `blocked: ${call.reason.slice(0, 200)}`,
    })
  })
  return records
}
