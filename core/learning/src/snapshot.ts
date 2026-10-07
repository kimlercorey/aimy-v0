/**
 * snapshot.ts — immutable conversation snapshots + compact digests.
 *
 * A review fork never holds a live reference to the conversation: it gets a
 * `ConversationSnapshot`, a deep-copied, deep-frozen value built from the
 * finished turn. The main conversation and the prompt cache are untouched by
 * construction — the fork cannot reach them because it is never given them.
 *
 * When the review is routed to a different (aux) model, the fork replays a
 * `CompactDigest` — a token-capped rendering of the snapshot — never the
 * full snapshot (architecture §3.5, §4.5).
 */
import type { TurnReport } from "../../agent-loop/src/index.js"

/** One turn as the reviewer sees it: roles, text, and tool-call outcomes. */
export interface SnapshotTurn {
  readonly role: "user" | "assistant"
  readonly text: string
  readonly toolCalls: ReadonlyArray<SnapshotToolCall>
}

export interface SnapshotToolCall {
  readonly tool: string
  /** `executed` (with a summarized outcome), `blocked`, or `terminated`. */
  readonly status: "executed" | "blocked" | "terminated"
  readonly outcomeSummary: string
}

/**
 * Immutable snapshot of the conversation handed to a review fork.
 * Built by value (never a live reference); deep-frozen at construction.
 */
export interface ConversationSnapshot {
  readonly sessionId: string
  readonly capturedAt: string
  readonly turns: ReadonlyArray<SnapshotTurn>
}

const freezeDeep = (value: unknown, seen: Set<object>): unknown => {
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen)
    return Object.freeze(value)
  }
  for (const key of Object.keys(value)) {
    freezeDeep((value as Record<string, unknown>)[key], seen)
  }
  return Object.freeze(value)
}

/** Deep-freeze a value (cycle-safe). Returns the same reference, frozen. */
export const deepFreeze = <A>(value: A): A => freezeDeep(value, new Set()) as A

const summarizeOutcome = (result: unknown): string => {
  if (result !== null && typeof result === "object") {
    const tag = (result as Record<string, unknown>)["_tag"]
    if (tag === "IoError") {
      const reason = (result as Record<string, unknown>)["reason"]
      return `io-error: ${typeof reason === "string" ? reason.slice(0, 120) : "unknown"}`
    }
  }
  const text = typeof result === "string" ? result : JSON.stringify(result) ?? "?"
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/**
 * Build an immutable snapshot from a finished turn's `TurnReport` plus the
 * user input that opened the turn. Copies every field by value — later
 * mutation of the report cannot leak into the snapshot.
 */
export const snapshotFromTurn = (
  sessionId: string,
  input: string,
  report: TurnReport,
  now: string = new Date().toISOString()
): ConversationSnapshot => {
  const toolCalls: Array<SnapshotToolCall> = [
    ...report.executed.map((e) => ({
      tool: e.tool,
      status: "executed" as const,
      outcomeSummary: summarizeOutcome(e.result)
    })),
    ...report.blocked.map((b) => ({
      tool: b.tool,
      status: (report.terminated ? "terminated" : "blocked") as "blocked" | "terminated",
      outcomeSummary: b.reason
    }))
  ]
  const turns: Array<SnapshotTurn> = [
    { role: "user", text: input, toolCalls: [] },
    { role: "assistant", text: report.text, toolCalls }
  ]
  return deepFreeze({ sessionId, capturedAt: now, turns })
}

/**
 * Render a token-capped digest of the snapshot for aux-model routing.
 * Role-labeled turns, per-turn text truncated, tool outcomes one line each,
 * hard-capped at `charBudget` with an explicit truncation marker.
 */
export const makeDigest = (snapshot: ConversationSnapshot, charBudget: number): string => {
  const lines: Array<string> = [
    `[review digest of session ${snapshot.sessionId}, captured ${snapshot.capturedAt}]`
  ]
  const perTurnBudget = Math.max(200, Math.floor(charBudget / Math.max(1, snapshot.turns.length + 1)))
  for (const turn of snapshot.turns) {
    const text = turn.text.length > perTurnBudget ? `${turn.text.slice(0, perTurnBudget)}…` : turn.text
    lines.push(`${turn.role}: ${text}`)
    for (const call of turn.toolCalls) {
      lines.push(`  tool ${call.tool} → ${call.status}: ${call.outcomeSummary}`)
    }
  }
  let digest = lines.join("\n")
  if (digest.length > charBudget) {
    digest = `${digest.slice(0, charBudget)}\n[digest truncated at ${charBudget} chars]`
  }
  return digest
}
