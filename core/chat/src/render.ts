/** chat/src/render.ts — pure rendering: commands, honesty summary, error text. No I/O. */

import type { TurnHonestyReport } from "../../honesty/wiring.js"
import type { TurnReport } from "../../agent-loop/src/index.js"
import type { RetrievalReport } from "../../web-retrieval/src/index.js"

export type ChatCommand = "quit" | "new" | "help" | "retrievalOff" | "retrievalOn" | "unknown"

/** Classify a REPL line: slash-commands vs. chat input. */
export const parseCommand = (line: string): ChatCommand | { readonly input: string } => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("/")) return { input: line }
  switch (trimmed.split(/\s+/)[0]) {
    case "/quit":
    case "/exit":
      return "quit"
    case "/new":
      return "new"
    case "/help":
      return "help"
    case "/retrieval-off":
      return "retrievalOff"
    case "/retrieval-on":
      return "retrievalOn"
    default:
      return "unknown"
  }
}

/**
 * Classify a "retrieval <query>" line. Returns the query (possibly "") when
 * the line is a retrieval command, undefined otherwise. "retrieving x" is
 * NOT a retrieval command — the prefix must be the whole word "retrieval".
 */
export const parseRetrievalCommand = (line: string): string | undefined => {
  const t = line.trim()
  if (t === "retrieval") return ""
  if (t.startsWith("retrieval ")) return t.slice("retrieval ".length)
  return undefined
}

const badgeMark = (status: "verified" | "unverified" | "failed"): string =>
  status === "verified" ? "✓" : status === "failed" ? "✗" : "?"

/**
 * One compact honesty summary per turn, from the loop's `Done` report.
 * Pure data in → text out; a FAIL verdict is shown, never hidden.
 */
export const formatHonestySummary = (report: TurnReport): string => {
  const honesty: TurnHonestyReport | undefined = report.honesty
  if (honesty === undefined) return "[honesty] not wired for this turn"
  const lines: Array<string> = []
  for (const { claim, badge } of honesty.claims) {
    const short = claim.text.length > 72 ? claim.text.slice(0, 69) + "…" : claim.text
    lines.push(`[honesty] ${badgeMark(badge.status)} ${badge.status}: "${short}"`)
  }
  for (const v of honesty.verdicts) {
    lines.push(`[judge] ${v.judgeId}@${v.judgeVersion}: ${v.verdict.toUpperCase()}`)
  }
  if (honesty.failedVerdicts.length > 0) {
    lines.push(
      `[honesty] ${honesty.failedVerdicts.length} FAILED verdict${honesty.failedVerdicts.length === 1 ? "" : "s"} — see above`
    )
  }
  if (lines.length === 0) return "[honesty] no claims this turn"
  return lines.join("\n")
};

/** A typed error rendered for a human. Never a stack trace. */
export interface FriendlyError {
  readonly headline: string
  readonly hint: string | undefined
}

export const friendlyErrorMessage = (err: { readonly _tag: string } & Record<string, unknown>): FriendlyError => {
  switch (err._tag) {
    case "InferenceError": {
      const reason = typeof err["reason"] === "string" ? (err["reason"] as string) : "unknown transport failure"
      const down =
        /ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH/i.test(reason) || /127\.0\.0\.1|localhost/.test(reason)
      return {
        headline: `model server unreachable: ${reason}`,
        hint: down
          ? "start your local model first — `ollama serve` (Ollama) or `llama-server -m <model.gguf>` (llama.cpp) — then type your message again"
          : undefined
      }
    }
    case "PermissionDenied":
      return {
        headline: `denied: ${String(err["reason"] ?? "the permission gate refused this operation")}`,
        hint: undefined
      }
    case "TurnTerminated":
      return { headline: "turn terminated by the safety gate", hint: undefined }
    case "SandboxViolation":
      return { headline: `sandbox refused: ${String(err["reason"] ?? "fail-closed")}`, hint: undefined }
    default:
      return { headline: `${err._tag}: ${String(err["reason"] ?? err["message"] ?? "unknown error")}`, hint: undefined }
  }
}

/** Render a tool-call chunk's result compactly. */
export const formatToolResult = (result: unknown): string => {
  if (typeof result === "string") return result.length > 120 ? result.slice(0, 117) + "…" : result
  try {
    const s = JSON.stringify(result)
    return s.length > 120 ? s.slice(0, 117) + "…" : s
  } catch {
    return "[unprintable result]"
  }
}

const retrievalBadgeMark = (status: "verified" | "unverified" | "failed"): string =>
  status === "verified" ? "✓" : status === "failed" ? "✗" : "?"

/**
 * Render a retrieval report with per-claim verification badges inline:
 * `✓ verified [source url]` for sourced claims, `? unverified` for the
 * module's own synthesis/coverage. Pure data in → text out.
 */
export const renderRetrievalReport = (report: RetrievalReport): string => {
  const lines = [
    `Retrieval: "${report.query}" — fetched ${report.fetchedCount} of ${report.resultCount} result${report.resultCount === 1 ? "" : "s"}`
  ]
  for (const { claim, badge } of report.claims) {
    const src =
      badge.status === "verified" && badge.evidence.length > 0
        ? ` [${badge.evidence.map((e) => e.ref).join(", ")}]`
        : ""
    lines.push(`${retrievalBadgeMark(badge.status)} ${badge.status}${src} — ${claim.text}`)
  }
  return lines.join("\n")
}
