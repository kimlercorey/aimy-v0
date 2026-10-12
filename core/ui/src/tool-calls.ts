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
 * - Below the bubble, right-aligned, faint: tool names (e.g. "narrate").
 * - If tool args text and display text are the same, show the text in the
 *   bubble plus the faint tool label below.
 */

export interface ParsedToolCall {
  readonly tool: string
  readonly args: Record<string, unknown>
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
 * Extract tool calls from model output text.
 * Primary: ```aimy-tool fenced blocks parsed as JSON (robust to nested
 * braces and `}` in strings). Fallback: regex for bare JSON tool calls.
 */
export const extractToolCalls = (text: string): ParsedToolCall[] => {
  const calls: ParsedToolCall[] = []
  // Fenced blocks: ```aimy-tool\n{...}\n``` — parse the JSON properly.
  const fencePattern = /```aimy-tool\s*\n([\s\S]*?)\n```/g
  let fenceMatch: RegExpExecArray | null
  while ((fenceMatch = fencePattern.exec(text)) !== null) {
    const json = (fenceMatch[1] ?? "").trim()
    try {
      const obj = JSON.parse(json) as { tool?: unknown; args?: unknown }
      if (typeof obj.tool === "string" && obj.tool.length > 0) {
        const args = (obj.args !== null && typeof obj.args === "object" && !Array.isArray(obj.args))
          ? obj.args as Record<string, unknown>
          : {}
        calls.push({ tool: obj.tool, args })
        continue
      }
    } catch {
      // Malformed JSON in fence — fall through to regex below.
    }
  }
  if (calls.length > 0) return calls
  // Fallback: bare {"tool": "...", "args": {...}} not in a fence.
  // Note: fragile if args contain nested `}` — the fence path is preferred.
  const pattern = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[^}]*\})\s*\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const tool = match[1]
    if (!tool) continue
    try {
      const args = JSON.parse(match[2] ?? "{}") as Record<string, unknown>
      calls.push({ tool, args })
    } catch {
      // Malformed args JSON — still record the tool name.
      calls.push({ tool, args: {} })
    }
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

/** Remove fenced tool-call blocks and bare tool JSON from display text. */
const stripToolCalls = (text: string): string =>
  text
    // Replace with a paragraph break (not empty string): if the model puts
    // the fence inline without surrounding newlines, empty-string removal
    // joins the surrounding words without a space (2026-10-11: "into?The").
    .replace(/```aimy-tool[\s\S]*?```/g, "\n\n")
    .replace(/\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^}]*\}\s*\}/g, "\n\n")
    // Collapse 3+ newlines to 2 (paragraph break); preserve word spacing.
    .replace(/\n{3,}/g, "\n\n")
    .trim()

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
  if (calls.length === 0) {
    return { text: stripArtifacts(rawText), toolsUsed: [], narratedTexts: [] }
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
    return { text: displayText, toolsUsed, narratedTexts }
  }

  // Generic: strip tool JSON, keep remaining text.
  const text = stripToolCalls(rawText)
  return { text: stripArtifacts(text || rawText), toolsUsed, narratedTexts }
}
