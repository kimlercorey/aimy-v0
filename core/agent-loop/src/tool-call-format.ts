/**
 * tool-call-format.ts — the M1 tool-call wire format.
 *
 * The model emits tool calls as fenced `aimy-tool` blocks containing one JSON
 * object each:
 *
 * ```aimy-tool
 * { "tool": "clock.now", "args": {} }
 * ```
 *
 * Multiple blocks per message are allowed. A block that is not valid JSON, or
 * that does not have the `{ tool: string, args?: object }` shape, is a typed
 * parse failure — it is reported in `TurnReport.parseFailures` and never
 * crashes the turn.
 */
export interface ParsedToolCall {
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
}

export interface ToolBlockParseFailure {
  /** Truncated block body, for the report. Never the full raw text. */
  readonly block: string
  readonly reason: string
}

export interface ParsedToolBlocks {
  readonly calls: ReadonlyArray<ParsedToolCall>
  readonly failures: ReadonlyArray<ToolBlockParseFailure>
}

const TOOL_BLOCK_RE = /```aimy-tool[ \t]*\r?\n([\s\S]*?)```/g

const truncate = (s: string, max = 200): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Extract `aimy-tool` blocks from assistant text. Never throws: every
 * malformed block becomes a `ToolBlockParseFailure`.
 */
export const parseToolBlocks = (text: string): ParsedToolBlocks => {
  const calls: Array<ParsedToolCall> = []
  const failures: Array<ToolBlockParseFailure> = []
  for (const match of text.matchAll(TOOL_BLOCK_RE)) {
    const body = (match[1] ?? "").trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      failures.push({ block: truncate(body), reason: "malformed JSON in aimy-tool block" })
      continue
    }
    if (!isRecord(parsed) || typeof parsed.tool !== "string") {
      failures.push({
        block: truncate(body),
        reason: 'aimy-tool block must be a JSON object shaped { "tool": string, "args"?: object }'
      })
      continue
    }
    if (parsed.args !== undefined && !isRecord(parsed.args)) {
      failures.push({
        block: truncate(body),
        reason: 'aimy-tool "args" must be a JSON object when present'
      })
      continue
    }
    calls.push({ tool: parsed.tool, args: isRecord(parsed.args) ? parsed.args : {} })
  }
  return { calls, failures }
}
