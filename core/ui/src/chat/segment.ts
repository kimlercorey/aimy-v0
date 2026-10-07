/**
 * ui/src/chat/segment.ts — memoized block segmentation for the streaming view.
 *
 * The view calls `segmentStreamingText(streaming.text)` on every render. The
 * function is deterministic in its inputs (same text -> same blocks); the
 * module-level cache is memoization, not state — it only avoids re-splitting
 * and re-classifying blocks the renderer has already seen. The tail block is
 * the only one that changes between chunks (Pi #6665: no per-chunk rebuild).
 */
import { hashBlock } from "../rendering.js"

export type BlockKind = "code" | "text"

export interface ParsedBlock {
  readonly hash: string
  readonly kind: BlockKind
  readonly text: string
}

export interface StreamingSegments {
  /** Sealed paragraphs before the tail — render from cache. */
  readonly stable: ReadonlyArray<ParsedBlock>
  /** The in-progress tail — the only block re-rendered per chunk. */
  readonly tail: ParsedBlock
}

const blockCache = new Map<string, ParsedBlock>()

const classify = (text: string): BlockKind =>
  text.trimStart().startsWith("```") ? "code" : "text"

const parseBlock = (text: string): ParsedBlock => {
  const hash = hashBlock(text)
  const cached = blockCache.get(hash)
  // Hash collision across differing text is ignored by design (32-bit is a
  // cache key, not an identity): correctness comes from the text itself.
  if (cached !== undefined && cached.text === text) return cached
  const parsed: ParsedBlock = { hash, kind: classify(text), text }
  blockCache.set(hash, parsed)
  return parsed
}

/** For tests: how many distinct blocks are currently memoized. */
export const cachedBlockCount = (): number => blockCache.size

/** For tests: reset the memoization cache. */
export const clearBlockCache = (): void => {
  blockCache.clear()
}

/**
 * Split in-progress streaming text into sealed blocks + tail. Pure in its
 * observable behavior: identical input always yields identical output.
 */
export const segmentStreamingText = (text: string): StreamingSegments => {
  if (text.length === 0) {
    return { stable: [], tail: parseBlock("") }
  }
  const parts = text.split("\n\n")
  const tailText = parts.pop() as string
  return {
    stable: parts.map(parseBlock),
    tail: parseBlock(tailText),
  }
}
