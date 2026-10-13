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

const truncate = (s: string, max = 200): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Remove every `aimy-tool` region from assistant text, returning only
 * the prose. Scanner-based (same brace-balance rules as parseToolBlocks):
 * a balanced block is removed whole; an UNTERMINATED block removes
 * through end-of-text — its tail is JSON debris, never prose. The
 * never-silent safety net depends on this distinction: a truncated
 * preview once left a JSON tail that a regex strip miscounted as a
 * prose answer, so the turn ended in silence (2026-10-12).
 */
/**
 * Strip XML-wrapped tool calls (`<tool_call>...</tool_call>`) — the
 * model-native wrapper local models drift into (2026-10-12: a narrate
 * call wrapped this way was never executed AND its wrapper leaked into
 * chat as a junk bubble). Runs AFTER fence stripping, so a literal
 * "<tool_call>" inside a fenced call's args is already gone and can
 * never be mangled. An unterminated wrapper removes through end-of-text.
 */
const stripXmlToolCalls = (text: string): string => {
  let out = ""
  let cursor = 0
  for (;;) {
    const open = text.indexOf("<tool_call", cursor)
    if (open === -1) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, open)
    const close = text.indexOf("</tool_call>", open)
    if (close === -1) break // unterminated wrapper: the rest is debris
    cursor = close + "</tool_call>".length
  }
  return out
}

export const stripToolBlocks = (text: string): string => {
  const OPENER = "```aimy-tool"
  let out = ""
  let cursor = 0
  for (;;) {
    const open = text.indexOf(OPENER, cursor)
    if (open === -1) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, open)
    const braceStart = text.indexOf("{", open + OPENER.length)
    if (braceStart === -1) break // opener with no JSON: the rest is debris
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = braceStart; i < text.length; i++) {
      const ch = text[i]!
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) break // unterminated block: the rest is debris
    cursor = end + 1
    // Skip the block's closing fence when it directly follows.
    const rest = text.slice(cursor)
    const fenceMatch = /^\s*```/.exec(rest)
    if (fenceMatch !== null) cursor += fenceMatch[0].length
  }
  return stripXmlToolCalls(out)
}

/**
 * Extract `aimy-tool` blocks from assistant text. Never throws: every
 * malformed block becomes a `ToolBlockParseFailure`.
 *
 * Extraction is a string-aware brace-balance scan, NOT a fence regex
 * (2026-10-12): tool args routinely carry document content, and content
 * may itself contain ``` code fences (e.g. a mermaid block inside a
 * drawer.preview). The old regex stopped the block at the first ```
 * ANYWHERE — including inside a JSON string — truncating the JSON, so
 * the call silently failed to parse, never executed, and the turn ended
 * with no follow-up and no acknowledgment. Only the brace that closes
 * the top-level object ends a block; fences, braces, and quotes inside
 * strings are inert.
 */
export const parseToolBlocks = (text: string): ParsedToolBlocks => {
  const calls: Array<ParsedToolCall> = []
  const failures: Array<ToolBlockParseFailure> = []
  const fenceSpans: Array<readonly [number, number]> = []
  const OPENER = "```aimy-tool"
  let cursor = 0
  for (;;) {
    const open = text.indexOf(OPENER, cursor)
    if (open === -1) break
    const braceStart = text.indexOf("{", open + OPENER.length)
    if (braceStart === -1) {
      failures.push({
        block: truncate(text.slice(open)),
        reason: "aimy-tool block has no JSON object"
      })
      break
    }
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = braceStart; i < text.length; i++) {
      const ch = text[i]!
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) {
      failures.push({
        block: truncate(text.slice(braceStart)),
        reason: "aimy-tool JSON object never closes"
      })
      fenceSpans.push([braceStart, text.length])
      break
    }
    const body = text.slice(braceStart, end + 1)
    fenceSpans.push([braceStart, end])
    cursor = end + 1
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
  // XML-wrapped calls (2026-10-12): local models drift into the
  // model-native wrapper — `<tool_call><function=aimy-tool {JSON}` —
  // which is unambiguous tool intent, so accept it (and log the drift)
  // instead of leaving the call unexecuted and the turn silent. Regions
  // inside a fenced call's JSON span are content, never wrappers.
  let xmlCursor = 0
  for (;;) {
    const open = text.indexOf("<tool_call", xmlCursor)
    if (open === -1) break
    xmlCursor = open + 1
    if (fenceSpans.some(([s, e]) => open >= s && open <= e)) continue
    const closeTag = text.indexOf("</tool_call>", open)
    const regionEnd = closeTag === -1 ? Math.min(text.length, open + 20000) : closeTag
    const braceStart = text.indexOf("{", open)
    if (braceStart === -1 || braceStart >= regionEnd) {
      failures.push({ block: truncate(text.slice(open, regionEnd)), reason: "XML-wrapped tool call has no JSON object" })
      continue
    }
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = braceStart; i < text.length; i++) {
      const ch = text[i]!
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) {
      failures.push({ block: truncate(text.slice(braceStart)), reason: "XML-wrapped tool call JSON never closes" })
      continue
    }
    const body = text.slice(braceStart, end + 1)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      failures.push({ block: truncate(body), reason: "malformed JSON in XML-wrapped tool call" })
      continue
    }
    if (!isRecord(parsed) || typeof parsed.tool !== "string" || (parsed.args !== undefined && !isRecord(parsed.args))) {
      failures.push({ block: truncate(body), reason: 'XML-wrapped tool call must be a JSON object shaped { "tool": string, "args"?: object }' })
      continue
    }
    console.warn(`[diag] tool-format: accepted XML-wrapped tool call (${parsed.tool}) — model drifted from the aimy-tool fence format`)
    calls.push({ tool: parsed.tool, args: isRecord(parsed.args) ? parsed.args : {} })
  }
  return { calls, failures }
}

/**
 * Unkept-promise detection (2026-10-12): find a sentence in the CLOSING
 * stretch of a response that announces a concrete imminent action —
 * "I'll check…", "Let me take a look…", "Grabbing it now" — in a
 * round that carried no tool call to perform it. She ended two turns in
 * a row on announcements alone, then invented an inventory instead of
 * calling doc.list: the turn "completes" but nothing was ever done.
 *
 * Deliberately narrow: only first-person announcements with a concrete
 * action verb, only in the last ~600 chars of prose (tool blocks
 * stripped). Conversational closings ("let me know", "I'll be here")
 * do not match. Returns the LAST matching sentence (≤240 chars) or null.
 * Every fire is logged by the caller with the sentence, so the pattern
 * set can be tuned from evidence rather than vibes.
 */
const PROMISE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bI(?:'|’)ll\s+(?:just\s+)?(check|open|read|fetch|get|grab|look|pull|find|search|list|re-?check|dig|show|load|pull up|bring up)\b/i,
  /\blet me\s+(check|open|read|fetch|get|grab|look|pull|find|search|list|re-?check|dig|pull up|take a look)\b/i,
  /\bI(?:'|’)m\s+(?:going to|about to)\s+(check|open|read|fetch|get|grab|look|pull|find|search|list|re-?check|dig)\b/i,
  /\b(grabbing|opening|checking|fetching|pulling up|loading)\b[^.!?\n]{0,60}\bnow\b/i
]

export const findUnkeptPromise = (text: string): string | null => {
  const prose = stripToolBlocks(text).trim()
  if (prose === "") return null
  const tail = prose.slice(-600)
  const sentences = tail.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s !== "")
  let found: string | null = null
  for (const s of sentences) {
    if (PROMISE_PATTERNS.some((p) => p.test(s))) found = s
  }
  return found === null ? null : found.slice(0, 240)
}
