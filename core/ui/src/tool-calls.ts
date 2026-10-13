/**
 * tool-calls.ts — parse text tool-call JSON from model output.
 *
 * The loop uses a text tool-call convention (not native `tool_calls`):
 * the model emits `{"tool": "narrate", "args": {...}}` inline in its
 * response text. This module extracts tool calls and separates user-facing
 * text from tool metadata.
 *
 * Display contract (Kimler, 2026-10-10):
 * - Bubble shows ONLY user-facing text (never raw JSON).
 * - Below the bubble, right-aligned, faint: tool ALIASES (plain-language
 *   labels from tool-alias.ts, e.g. "Spoke aloud" for narrate) — never raw
 *   function names (Kimler, 2026-10-12). The real name rides the tooltip.
 * - If tool args text and display text are the same, show the text in the
 *   bubble plus the faint tool label below.
 */

export interface ParsedToolCall {
  readonly tool: string
  readonly args: Record<string, unknown>
  /** The exact raw text that was matched (for stripping). */
  readonly raw: string
}

export interface ParsedMessage {
  readonly text: string
  readonly toolsUsed: string[]
  readonly narratedTexts: string[]
  /** Human-readable summary per tool call, parallel to toolsUsed (2026-10-11). */
  readonly toolSummaries: string[]
}

/**
 * Format a tool call's args into a human-readable tooltip summary (2026-10-11).
 * Not raw JSON — formatted for the hover introspection bubble.
 */
export const summarizeToolCall = (tool: string, args: Record<string, unknown>): string => {
  const str = (v: unknown): string => typeof v === "string" ? v : JSON.stringify(v ?? "")
  const trunc = (s: string, n: number): string => s.length > n ? s.slice(0, n) + "…" : s
  switch (tool) {
    case "narrate":
      return trunc(str(args["text"]).trim(), 500)
    case "journal.write": {
      const content = str(args["content"])
      const chars = content.length
      const preview = trunc(content.trim().split("\n")[0] ?? "", 120)
      return `Wrote ${chars.toLocaleString()} chars to journal.\n\n${preview}`
    }
    case "clock.now":
      return "Current timestamp"
    case "session.info":
      return "Session ID and turn count"
    case "job.spawn": {
      const desc = str(args["description"])
      const est = args["estimateMinutes"] !== undefined ? ` (~${args["estimateMinutes"]} min)` : ""
      return `Background job: ${trunc(desc, 100)}${est}`
    }
    case "capability.correct": {
      const asked = str(args["askedFor"])
      const had = str(args["alreadyHad"])
      const src = args["source"] === "kimler" ? "Kimler corrected" : "Self-caught"
      return `${src}: asked for "${trunc(asked, 60)}", already had "${trunc(had, 60)}"`
    }
    default: {
      // Generic: format args as key: value lines, truncated.
      const entries = Object.entries(args)
      if (entries.length === 0) return `${tool} (no args)`
      const lines = entries.map(([k, v]) => `${k}: ${trunc(str(v), 120)}`)
      return `${tool}\n${trunc(lines.join("\n"), 400)}`
    }
  }
}

export interface ParsedMessage {
  /** User-facing text (tool JSON removed). */
  readonly text: string
  /** Tool names in order of appearance. */
  readonly toolsUsed: string[]
  /**
   * Spoken texts from `narrate` calls, in order (2026-10-11 debug aid).
   * Parallel to the "narrate" entries in toolsUsed.
   */
  readonly narratedTexts: string[]
}

/**
 * Find the end index of a JSON object starting at `start` (which must be `{`).
 * Handles nested objects, arrays, and strings with escaped quotes.
 * Returns -1 if no balanced closing brace is found.
 */
const findJsonEnd = (text: string, start: number): number => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Extract tool calls from model output text.
 *
 * Robust to nested braces and `}` in strings (2026-10-11): uses JSON.parse
 * for fenced blocks and balanced-brace scanning for bare JSON. The `raw`
 * field carries the exact matched text so stripping is precise.
 */
export const extractToolCalls = (text: string): ParsedToolCall[] => {
  const calls: ParsedToolCall[] = []
  // XML-wrapped calls first (2026-10-12): `<tool_call>...{JSON}...</tool_call>`
  // — the wrapper is part of the call's raw text so stripping removes the
  // WHOLE region (previously only the inner JSON was stripped and the
  // wrapper leaked into chat as a junk bubble). Spans are remembered so
  // the scans below never double-count the JSON inside a wrapper.
  const xmlSpans: Array<readonly [number, number]> = []
  {
    let cursor = 0
    for (;;) {
      const open = text.indexOf("<tool_call", cursor)
      if (open === -1) break
      const closeTag = text.indexOf("</tool_call>", open)
      const regionEnd = closeTag === -1 ? text.length : closeTag + "</tool_call>".length
      cursor = regionEnd
      const braceStart = text.indexOf("{", open)
      if (braceStart === -1 || braceStart >= regionEnd) continue
      const objEnd = findJsonEnd(text, braceStart)
      if (objEnd === -1 || objEnd >= regionEnd) continue
      try {
        const obj = JSON.parse(text.slice(braceStart, objEnd + 1)) as { tool?: unknown; args?: unknown }
        if (typeof obj.tool === "string" && obj.tool.length > 0) {
          const args = (obj.args !== null && typeof obj.args === "object" && !Array.isArray(obj.args))
            ? obj.args as Record<string, unknown>
            : {}
          calls.push({ tool: obj.tool, args, raw: text.slice(open, regionEnd) })
          xmlSpans.push([open, regionEnd])
        }
      } catch {
        // Not valid JSON inside the wrapper — the scans below may still
        // find pieces; the strip fallback handles the debris.
      }
    }
  }
  const inXmlSpan = (idx: number): boolean => xmlSpans.some(([s, e]) => idx >= s && idx < e)
  // Fenced blocks: ```aimy-tool\n{...}\n``` — parse the JSON properly.
  const fencePattern = /```aimy-tool\s*\n([\s\S]*?)\n```/g
  let fenceMatch: RegExpExecArray | null
  let fenceCalls = 0
  while ((fenceMatch = fencePattern.exec(text)) !== null) {
    const json = (fenceMatch[1] ?? "").trim()
    const raw = fenceMatch[0]
    try {
      const obj = JSON.parse(json) as { tool?: unknown; args?: unknown }
      if (typeof obj.tool === "string" && obj.tool.length > 0) {
        const args = (obj.args !== null && typeof obj.args === "object" && !Array.isArray(obj.args))
          ? obj.args as Record<string, unknown>
          : {}
        calls.push({ tool: obj.tool, args, raw })
        fenceCalls += 1
        continue
      }
    } catch {
      // Malformed JSON in fence — fall through to bare JSON scan below.
    }
  }
  if (fenceCalls > 0) return calls
  // Fallback: bare {"tool": "...", "args": {...}} not in a fence.
  // Balanced-brace scan (2026-10-11): the old regex `\{[^}]*\}` broke on
  // nested objects (e.g. journal.write with large content). Scan for `{`,
  // find the balanced `}`, then JSON.parse.
  let searchFrom = 0
  for (;;) {
    const toolKeyIdx = text.indexOf('"tool"', searchFrom)
    if (toolKeyIdx === -1) break
    // Already captured as an XML-wrapped call above — never double-count.
    if (inXmlSpan(toolKeyIdx)) {
      searchFrom = toolKeyIdx + 6
      continue
    }
    // Find the opening `{` before the "tool" key (scan backwards).
    let objStart = -1
    for (let i = toolKeyIdx; i >= searchFrom; i--) {
      if (text[i] === "{") {
        objStart = i
        break
      }
      // If we hit a closing brace or bracket first, this isn't our object.
      if (text[i] === "}" || text[i] === "]") break
    }
    if (objStart === -1) {
      searchFrom = toolKeyIdx + 6
      continue
    }
    const objEnd = findJsonEnd(text, objStart)
    if (objEnd === -1) {
      searchFrom = toolKeyIdx + 6
      continue
    }
    const raw = text.slice(objStart, objEnd + 1)
    try {
      const obj = JSON.parse(raw) as { tool?: unknown; args?: unknown }
      if (typeof obj.tool === "string" && obj.tool.length > 0) {
        const args = (obj.args !== null && typeof obj.args === "object" && !Array.isArray(obj.args))
          ? obj.args as Record<string, unknown>
          : {}
        calls.push({ tool: obj.tool, args, raw })
        searchFrom = objEnd + 1
        continue
      }
    } catch {
      // Not valid JSON — keep scanning.
    }
    searchFrom = toolKeyIdx + 6
  }
  return calls
}

/**
 * Parse a model response into display text and tool metadata.
 *
 * For `narrate` tool calls, the user-facing text is `args.text`.
 * For other tools, the text outside the JSON is the display text.
 */
/** Strip stray markdown artifacts the model sometimes emits. */
const stripArtifacts = (text: string): string =>
  text
    .replace(/^```[a-z-]*\n?/gm, "")
    .replace(/\n?```$/gm, "")
    .replace(/```/g, "")
    // Leading "-tool" marker (model's shorthand for tool call).
    .replace(/^-tool\s*\n?/gm, "")
    // Bare "aimy-tool" fence language written as plain text (2026-10-11:
    // model emits the fence marker without backticks, leaking it into chat).
    // Word-boundary match: catches line-start AND inline ("do.aimy-tool").
    .replace(/\baimy-tool\b\s*/g, "")
    // Stray /// block separators (2026-10-11: model emits them at response
    // start or mid-text where the split regex doesn't catch them).
    .replace(/^\s*\/\/\/\s*$/gm, "")
    .trim()

/**
 * Split response text into sequenced blocks.
 *
 * The model separates beats with `///` on its own line. Each block becomes
 * its own chat bubble and is narrated in order — the transcript is the
 * sequencer (Kimler, 2026-10-10: "if you need to enforce sequence, break
 * it up into multiple chat blocks").
 *
 * If no markers present, returns the whole text as a single block.
 */
export const splitBlocks = (text: string): string[] => {
  // Strip a leading /// marker (2026-10-11: the model sometimes starts the
  // response with it, and the split regex requires surrounding newlines).
  const withoutLeading = text.replace(/^\s*\/\/\/\s*\n?/, "")
  const blocks = withoutLeading
    .split(/\n\s*\/\/\/\s*\n/)
    .map((b) => stripArtifacts(b))
    .filter((b) => b.length > 0)
  return blocks.length > 0 ? blocks : [stripArtifacts(withoutLeading)]
}

/**
 * Remove tool-call blocks from display text.
 *
 * Robust (2026-10-11): uses the exact `raw` strings from `extractToolCalls`
 * (balanced-brace parsed) instead of regex. The old regex `\{[^}]*\}` broke
 * on nested objects like journal.write with large content — the JSON leaked
 * into chat. Replace with paragraph break (not empty) to preserve word
 * boundaries when the model puts the call inline ("into?The" fix).
 */
const stripToolCalls = (text: string): string => {
  const calls = extractToolCalls(text)
  let out = text
  for (const c of calls) {
    // Replace only the first occurrence (each call has a unique raw string).
    out = out.replace(c.raw, "\n\n")
  }
  // Fallback (2026-10-12): if raw JSON tool calls remain (parser failed on
  // huge args like full document content), strip them aggressively.
  // The model sometimes emits fragments (just "args": {...} without the
  // {"tool": wrapper), so we strip any line that looks like JSON when
  // the text contains tool-call markers.
  if (/"tool"\s*:/.test(out)) {
    // First, try to find and remove JSON objects via balanced-brace scan,
    // even if JSON.parse fails (malformed JSON from huge content).
    let searchFrom = 0
    for (;;) {
      const toolIdx = out.indexOf('"tool"', searchFrom)
      if (toolIdx === -1) break
      // Find the opening brace.
      let start = -1
      for (let i = toolIdx; i >= Math.max(0, toolIdx - 20); i--) {
        if (out[i] === "{") { start = i; break }
      }
      if (start === -1) { searchFrom = toolIdx + 6; continue }
      const end = findJsonEnd(out, start)
      if (end === -1) { searchFrom = toolIdx + 6; continue }
      // Remove this JSON blob.
      out = out.slice(0, start) + "\n\n" + out.slice(end + 1)
      searchFrom = start
    }
    // Line-based fallback for fragments.
    if (/"tool"\s*:/.test(out)) {
      out = out
        .split("\n")
        .filter((line) => {
          const t = line.trim()
          // Keep lines that are clearly prose, drop JSON fragments.
          if (t === "") return true
          if (/^\{\s*"tool"/.test(t)) return false
          if (/^"args"\s*:/.test(t)) return false
          if (/^"(path|id|title|content|text)"\s*:/.test(t)) return false
          if (/^[\{\}]\s*$/.test(t)) return false
          // Drop lines that are mostly JSON (contain "tool": or "args": with braces).
          if (t.includes('"tool"') && t.includes('"args"')) return false
          return true
        })
        .join("\n")
    }
  }
  return out
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export const parseMessageTools = (rawText: string): ParsedMessage => {
  const calls = extractToolCalls(rawText)
  // Once-per-turn narrate (2026-10-11): the loop voices only the first
  // narrate per turn and drops the rest — reflect that here so the footer
  // tag count stays honest. All tool JSON is still stripped from the text.
  let narrateSeen = false
  const effectiveCalls = calls.filter((c) => {
    if (c.tool !== "narrate") return true
    if (narrateSeen) return false
    narrateSeen = true
    return true
  })
  // Spoken texts, in order — parallel to the "narrate" entries in toolsUsed.
  const narratedTexts = effectiveCalls
    .filter((c) => c.tool === "narrate" && typeof c.args["text"] === "string")
    .map((c) => (c.args["text"] as string).trim())
    .filter((t) => t.length > 0)
  // Human-readable summaries per tool call, parallel to toolsUsed (2026-10-11:
  // hover introspection for all tools, not just narrate).
  const toolSummaries = effectiveCalls.map((c) => summarizeToolCall(c.tool, c.args))
  if (calls.length === 0) {
    // Parser found no valid calls, but the text may still contain malformed
    // tool JSON (huge args, broken escaping). Run the aggressive fallback
    // stripper to ensure raw JSON never leaks into chat.
    return { text: stripArtifacts(stripToolCalls(rawText)), toolsUsed: [], narratedTexts: [], toolSummaries: [] }
  }

  const toolsUsed = effectiveCalls.map((c) => c.tool)

  // For narrate: the args.text IS the user-facing content.
  const narrateCall = calls.find((c) => c.tool === "narrate")
  if (narrateCall && typeof narrateCall.args["text"] === "string") {
    const narrateText = narrateCall.args["text"] as string
    // Remove the tool calls from the raw text, keep any surrounding text.
    const textWithoutTools = stripToolCalls(rawText)
    // If there's remaining text outside the tool call, prefer it;
    // otherwise use the narrate text.
    const displayText = stripArtifacts(textWithoutTools || narrateText)
    return { text: displayText, toolsUsed, narratedTexts, toolSummaries }
  }

  // Generic: strip tool JSON, keep remaining text.
  // (2026-10-12): NEVER fall back to rawText — if stripping leaves nothing,
  // the bubble is empty (tools show as faint labels below). Raw JSON must
  // never appear in chat.
  const text = stripToolCalls(rawText)
  return { text: stripArtifacts(text), toolsUsed, narratedTexts, toolSummaries }
}
