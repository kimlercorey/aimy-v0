/**
 * rendering.test.ts — the rendering discipline (§3.11), tested structurally.
 *
 * - Pi #6665: the Intl.Segmenter is constructed once per locale, never per chunk;
 *   appended chunks never re-parse sealed blocks (reparses stays 0).
 * - Pi #8584: differential streaming — only the tail changes between chunks.
 * - Pi #7730: the list is windowed; rows outside the window are never built.
 * - Pi #10504: terminal output is sanitized before it can reach the Model.
 * - No content loss on re-render: identical state -> identical tree.
 */
import { describe, expect, it } from "@effect/vitest"
import { inertHtml } from "foldkit/html"
import type { HtmlBuilder } from "foldkit/html"
import { chatPanelView } from "./chat/view.js"
import { segmentStreamingText } from "./chat/segment.js"
import { initialModel } from "./model.js"
import type { Message } from "./messages.js"
import {
  ChunkSanitizer,
  SegmentBuffer,
  getSegmenter,
  sanitizeTerminalOutput,
  serializeHtml,
  visibleWindow,
} from "./rendering.js"

// inertHtml is the framework's process-wide builder singleton retyped to
// `never`; the markup it builds is identical to the live builder's. The cast
// recovers this test's Message universe (documented use, not a backdoor).
const h = inertHtml as unknown as HtmlBuilder<Message>

describe("segmenter cache (Pi #6665)", () => {
  it("constructs one Intl.Segmenter per locale", () => {
    expect(getSegmenter("en")).toBe(getSegmenter("en"))
    expect(getSegmenter("en")).not.toBe(getSegmenter("de"))
  })
})

describe("SegmentBuffer: no per-chunk rebuilds (Pi #6665)", () => {
  it("seals blocks once; chunks touch the tail only", () => {
    const buf = new SegmentBuffer()
    buf.append("para one.")
    buf.append("\n\npara two.")
    const snap1 = buf.append(" more")
    expect(snap1.stable).toHaveLength(1)
    expect(snap1.stable[0]?.text).toBe("para one.")
    expect(snap1.tail).toBe("para two. more")
    // Streaming the tail further never re-parses the sealed block.
    buf.append(" and more")
    buf.append(" and more")
    expect(buf.reparses).toBe(0)
    expect(buf.snapshot().stable).toHaveLength(1)
  })
})

describe("differential streaming (Pi #8584)", () => {
  it("only the tail changes between chunks", () => {
    const a = segmentStreamingText("stable block.\n\ntail one")
    const b = segmentStreamingText("stable block.\n\ntail one two")
    expect(a.stable[0]).toBe(b.stable[0]) // identical block object: memoized
    expect(a.tail.text).not.toBe(b.tail.text)
  })
})

describe("virtualized window (Pi #7730)", () => {
  it("renders anchor +/- overscan, clamped", () => {
    expect(visibleWindow(100, 50, 8)).toEqual({ start: 42, end: 59 })
    expect(visibleWindow(100, 0, 8)).toEqual({ start: 0, end: 9 })
    expect(visibleWindow(100, 99, 8)).toEqual({ start: 91, end: 100 })
    expect(visibleWindow(0, 0, 8)).toEqual({ start: 0, end: 0 })
    expect(visibleWindow(5, 999, 8)).toEqual({ start: 0, end: 5 })
  })

  it("the chat view only builds rows inside the window", () => {
    const model = initialModel()
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      role: "user" as const,
      text: `message ${i}`,
      at: i,
    }))
    const session = {
      ...model.session,
      messages,
      listWindow: { anchorIndex: 100, overscan: 5 },
    }
    const tree = serializeHtml(chatPanelView(session, h))
    const built = (tree.match(/message \d+/g) ?? []).length
    // anchor 100 +/- 5 -> 11 rows; everything else is never built.
    expect(built).toBe(11)
    expect(tree).toContain("message 100")
    expect(tree).not.toContain('"t":"message 0"')
    expect(tree).not.toContain('"t":"message 199"')
  })
})

describe("terminal sanitization (Pi #10504)", () => {
  it("strips ANSI escapes and control characters, keeps newlines", () => {
    const raw = "\x1b[31mred\x1b[0m\nok\x07\x1b]0;title\x07"
    expect(sanitizeTerminalOutput(raw)).toBe("red\nok")
  })

  it("split escape sequences cannot survive the boundary", () => {
    expect(sanitizeTerminalOutput("\x1b[3")).toBe("")
  })

  it("does not strip a bare bracket with no ESC", () => {
    expect(sanitizeTerminalOutput("array[0]")).toBe("array[0]")
  })
})

describe("ChunkSanitizer: split escapes across chunks", () => {
  it("reassembles a sequence split across chunks, then strips it", () => {
    const s = new ChunkSanitizer()
    expect(s.push("\x1b[3")).toBe("")
    expect(s.push("1mred")).toBe("red")
  })

  it("strips complete sequences while holding a trailing partial", () => {
    const s = new ChunkSanitizer()
    expect(s.push("a\x1b[31mb\x1b[")).toBe("ab")
    expect(s.flush()).toBe("")
  })

  it("passes plain text through untouched", () => {
    const s = new ChunkSanitizer()
    expect(s.push("hello ")).toBe("hello ")
    expect(s.push("world")).toBe("world")
    expect(s.flush()).toBe("")
  })
})

describe("no content loss on re-render", () => {
  it("identical state renders an identical tree, twice", () => {
    const model = initialModel()
    const session = {
      ...model.session,
      messages: [
        { id: "m1", role: "user" as const, text: "hello", at: 1 },
        { id: "m2", role: "assistant" as const, text: "hi there", at: 2 },
      ],
      streaming: { active: true, streamId: "m3", text: "partial…", startedAt: 3 },
      contextMeter: {
        ...model.session.contextMeter,
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 40,
        ceiling: 200000,
      },
    }
    const first = serializeHtml(chatPanelView(session, h))
    const second = serializeHtml(chatPanelView(session, h))
    expect(second).toBe(first)
    // And the content is all there: both rows, the streaming tail, the meter.
    expect(first).toContain("hello")
    expect(first).toContain("hi there")
    expect(first).toContain("partial…")
    expect(first).toContain("reasoning 40")
  })
})
