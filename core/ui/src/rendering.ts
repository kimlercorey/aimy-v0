/**
 * ui/src/rendering.ts — the rendering discipline, as code (architecture §3.11).
 *
 * The decomposition's streaming-renderer pitfalls become structural rules here,
 * not review comments:
 *
 * 1. No per-chunk Markdown rebuilds (Pi #6665): `SegmentBuffer` appends a chunk
 *    to the in-progress tail only. Blocks sealed before the tail are cached by
 *    content hash and never re-parsed; `getSegmenter` constructs each locale's
 *    `Intl.Segmenter` once and caches it (the uncached-Segmenter full-core-pin).
 * 2. Differential rendering safe under long streams (Pi #8584): the view is a
 *    pure function of the Model; stream chunks update only the streaming
 *    segment's subtree. `serializeHtml` gives tests a deterministic DOM
 *    snapshot to assert stability against.
 * 3. Virtualized transcript (Pi #7730): `visibleWindow` computes the rendered
 *    row range from the anchor + overscan; rows outside it are never built.
 * 4. Terminal output is sanitized at the tool-result boundary, before it
 *    becomes a Message (Pi #10504): `sanitizeTerminalOutput` strips ANSI
 *    escapes and control characters. Split sequences cannot corrupt retained
 *    output because they never survive this boundary.
 */
import type { Html } from "foldkit/html"

/* ------------------------------------------------------------------ */
/* 1. cached Intl.Segmenter (Pi #6665)                                 */
/* ------------------------------------------------------------------ */

const segmenterCache = new Map<string, Intl.Segmenter>()

/**
 * One `Intl.Segmenter` per locale, constructed once. Never call `new
 * Intl.Segmenter` in a chunk handler — that pinned a full core in Pi #6665.
 */
export const getSegmenter = (locale: string = "en"): Intl.Segmenter => {
  const cached = segmenterCache.get(locale)
  if (cached !== undefined) return cached
  const created = new Intl.Segmenter(locale, { granularity: "grapheme" })
  segmenterCache.set(locale, created)
  return created
}

/* ------------------------------------------------------------------ */
/* 2. incremental segment buffer (Pi #6665, #8584)                      */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit hex: cheap content hash for the parsed-block cache. */
export const hashBlock = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

export interface SegmentSnapshot {
  /** Sealed blocks (paragraphs) before the tail: cache-stable, never re-parsed. */
  readonly stable: ReadonlyArray<{ readonly hash: string; readonly text: string }>
  /** The in-progress tail: the ONLY part a chunk may invalidate. */
  readonly tail: string
}

/**
 * Incremental transcript segmenter. Blocks are sealed on blank-line
 * boundaries; the tail is everything after the last blank line. Appending a
 * chunk touches the tail only — stable blocks keep their cached parse.
 *
 * The buffer is keyed by stream elsewhere (chat/segment.ts); this class is
 * the pure mechanics, free of any Model.
 */
export class SegmentBuffer {
  private raw = ""
  private sealed: Array<{ hash: string; text: string }> = []
  /** How many times a stable block was re-parsed (must stay 0 in tests). */
  reparses = 0

  /** Append one streamed delta; returns the new snapshot. */
  append(delta: string): SegmentSnapshot {
    this.raw += delta
    const parts = this.raw.split("\n\n")
    const tail = parts.pop() ?? ""
    // Seal every complete block exactly once.
    while (this.sealed.length < parts.length) {
      const text = parts[this.sealed.length] as string
      this.sealed.push({ hash: hashBlock(text), text })
    }
    return this.snapshot(tail)
  }

  snapshot(tail?: string): SegmentSnapshot {
    return {
      stable: this.sealed,
      tail: tail ?? this.tailText(),
    }
  }

  private tailText(): string {
    const parts = this.raw.split("\n\n")
    return parts[parts.length - 1] ?? ""
  }

  /** Full text (for the settled message); not used during streaming. */
  get text(): string {
    return this.raw
  }
}

/* ------------------------------------------------------------------ */
/* 3. virtualization window (Pi #7730)                                 */
/* ------------------------------------------------------------------ */

export interface RowWindow {
  readonly start: number
  readonly end: number
}

/**
 * The rendered row range for a virtualized list: the anchor row plus
 * `overscan` rows on each side, clamped to [0, total). Rows outside this
 * range are never built — the Pi/Hermes lesson for long sessions.
 */
export const visibleWindow = (
  total: number,
  anchorIndex: number,
  overscan: number,
): RowWindow => {
  if (total <= 0) return { start: 0, end: 0 }
  const anchor = Math.max(0, Math.min(total - 1, Math.floor(anchorIndex)))
  const over = Math.max(0, Math.floor(overscan))
  return {
    start: Math.max(0, anchor - over),
    end: Math.min(total, anchor + over + 1),
  }
}

/* ------------------------------------------------------------------ */
/* 4. terminal-output sanitization (Pi #10504)                         */
/* ------------------------------------------------------------------ */

/** ANSI CSI escape sequences, OSC sequences, and stray ESC bytes. */
const ANSI_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-9;?]*[A-Za-z]|\x1B[()][0-9A-Z]|\x1B[>=\d;#?]*[a-zA-Z]|\x1B./g
/** C0/C1 control characters except \n, \r, \t. */
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g
/** A trailing incomplete escape: ESC alone, or ESC [ params with no final byte. */
const TRAILING_PARTIAL_ESCAPE_RE = /\x1B(?:\[[0-9;?]*)?$/

/**
 * Strip ANSI escapes and control characters from a COMPLETE string (a tool
 * result, a settled turn text) BEFORE it becomes a Message. Split escape
 * sequences cannot corrupt retained output because nothing unsanitized ever
 * reaches the Model or the renderer. A trailing incomplete escape is dropped:
 * a complete string has no "next chunk" coming to finish it.
 */
export const sanitizeTerminalOutput = (raw: string): string =>
  raw.replace(TRAILING_PARTIAL_ESCAPE_RE, "").replace(ANSI_RE, "").replace(CONTROL_RE, "")

/**
 * Stateful sanitizer for STREAMED chunks. A chunk boundary can fall inside an
 * escape sequence; sanitizing each chunk independently would either corrupt
 * output or leak escape bytes ("1m" from a split "\x1b[31m"). `push` strips
 * complete escapes and control characters but HOLDS a trailing incomplete
 * escape for the next chunk, so split sequences reassemble before they are
 * judged. One instance per stream (see app.ts `inferenceStream`).
 */
export class ChunkSanitizer {
  private carry = ""

  push(chunk: string): string {
    const text = this.carry + chunk
    this.carry = ""
    const partial = TRAILING_PARTIAL_ESCAPE_RE.exec(text)
    const head = partial ? text.slice(0, partial.index) : text
    if (partial) this.carry = partial[0]
    return head.replace(ANSI_RE, "").replace(CONTROL_RE, "")
  }

  /** Release any held partial (stripped): the stream it belonged to is over. */
  flush(): string {
    const rest = this.carry
    this.carry = ""
    return rest.replace(ANSI_RE, "").replace(CONTROL_RE, "")
  }
}

/* ------------------------------------------------------------------ */
/* 5. deterministic Html serializer (DOM-stability tests)               */
/* ------------------------------------------------------------------ */

type VNodeLike = {
  readonly sel?: string
  readonly text?: string
  readonly children?: ReadonlyArray<VNodeLike | string>
  readonly data?: {
    readonly attrs?: Readonly<Record<string, string | number | boolean>>
    readonly props?: Readonly<Record<string, unknown>>
    readonly class?: Readonly<Record<string, boolean>>
    readonly key?: string | number
    readonly hook?: unknown
  }
  readonly key?: string | number
}

const isVNode = (value: unknown): value is VNodeLike =>
  typeof value === "object" && value !== null && ("sel" in value || "text" in value)

/**
 * Deterministic structural snapshot of a Foldkit `Html` tree: selectors,
 * text, attributes, classes, keys — everything a re-render could corrupt,
 * nothing volatile (event-handler closures are structural constants of the
 * view code, so they are intentionally excluded).
 */
export const serializeHtml = (html: Html): string => {
  const walk = (node: unknown): unknown => {
    if (node === null) return null
    if (typeof node === "string") return { t: node }
    if (!isVNode(node)) return { unknown: typeof node }
    const data = node.data
    return {
      sel: node.sel,
      key: node.key ?? data?.key,
      text: node.text,
      attrs: data?.attrs,
      class: data?.class
        ? Object.keys(data.class).filter((k) => data.class?.[k]).sort()
        : undefined,
      children: node.children?.map((c) =>
        typeof c === "string" ? { t: c } : walk(c),
      ),
    }
  }
  return JSON.stringify(walk(html))
}
