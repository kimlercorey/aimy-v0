/**
 * html-text.ts — single-pass HTML → plain-text extraction.
 *
 * WHY THIS EXISTS (CodeQL, 2026-10-07): the previous implementation stripped
 * tags and decoded entities with chained regex replaces. CodeQL flagged three
 * real pattern problems:
 *
 * - "Bad HTML filtering regexp" — /<[^>]*>/g is bypassable and mangles input.
 * - "Double escaping or unescaping" — sequential entity replaces re-scan
 *   already-decoded output, so `&amp;lt;` decoded all the way to `<`.
 * - "Incomplete multi-character sanitization" — chained replaces don't
 *   compose over nested or overlapping input.
 *
 * The fix is structural, not a better regex: ONE left-to-right pass over the
 * input. Tags are skipped by a quote-aware scanner (no filter regex exists to
 * bypass), and each `&entity;` is decoded exactly once at the position where
 * it appears — decoded output is never re-scanned, so double-unescaping is
 * impossible by construction.
 *
 * SCOPE: this is a text extractor for feeding page content to the model, not
 * a browser. It does not execute CSS/JS, does not build a DOM, and its output
 * is never rendered as HTML. Malformed markup degrades to best-effort text.
 */

/** Elements whose content is raw text (never surfaced) — script/style/etc. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "noscript", "template"])

/** Common named entities. Unknown entities are left literal (never destroyed). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "•",
  middot: "·",
  dagger: "†",
  Dagger: "‡",
  para: "¶",
  sect: "§",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
}

/** Matches one entity at a sticky position: &#123; &#x1F600; &amp; — strict `;` required. */
const ENTITY_RE = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/y

const isValidCodePoint = (cp: number): boolean =>
  Number.isSafeInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)

/**
 * Decode the single entity starting at `i` (where html[i] === "&").
 * Returns the decoded text and the index just past the entity. A non-entity
 * `&` (or unknown entity) is returned literally — never destroyed.
 *
 * Exported for readability.ts, which decodes text during tree construction
 * (single pass, same no-double-decode guarantee as htmlToText).
 */
export const decodeEntityAt = (html: string, i: number): { text: string; next: number } => {
  ENTITY_RE.lastIndex = i
  const m = ENTITY_RE.exec(html)
  if (m === null || m[1] === undefined) return { text: "&", next: i + 1 }
  const body = m[1]
  const end = i + m[0].length
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X"
    const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
    if (isValidCodePoint(cp)) return { text: String.fromCodePoint(cp), next: end }
    return { text: m[0], next: end } // out-of-range: leave literal, never throw
  }
  const named = NAMED_ENTITIES[body]
  if (named !== undefined) return { text: named, next: end }
  return { text: m[0], next: end } // unknown entity: leave literal
}

/** Case-insensitive indexOf for ASCII needles (tag names). */
const indexOfAsciiCI = (haystack: string, needle: string, from: number): number => {
  const nl = needle.toLowerCase()
  outer: for (let i = from; i + nl.length <= haystack.length; i++) {
    for (let k = 0; k < nl.length; k++) {
      if (haystack[i + k]!.toLowerCase() !== nl[k]) continue outer
    }
    return i
  }
  return -1
}

/**
 * Find the closing tag `</name>` at or after `from` (case-insensitive,
 * tolerates whitespace before `>`). Returns the span of the close tag,
 * or null if absent.
 *
 * Exported for readability.ts, which skips raw-text subtrees (script/style)
 * with the same tolerant close-tag search.
 */
export const findCloseTag = (html: string, from: number, name: string): { start: number; end: number } | null => {
  const needle = "</" + name
  let idx = from
  while (true) {
    idx = indexOfAsciiCI(html, needle, idx)
    if (idx === -1) return null
    let k = idx + needle.length
    while (k < html.length && /\s/.test(html[k]!)) k++
    if (html[k] === ">") return { start: idx, end: k + 1 }
    idx += needle.length
  }
}

/**
 * Extract the raw inner text of the first `<name>…</name>` element
 * (RCDATA semantics: entities decoded, tags not parsed). Empty if absent.
 */
export const extractRawElementText = (html: string, name: string): string => {
  const openAt = indexOfAsciiCI(html, "<" + name, 0)
  if (openAt === -1) return ""
  // Scan the open tag with quote awareness to find its end.
  let j = openAt + 1
  let quote: string | null = null
  while (j < html.length) {
    const c = html[j]!
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === ">") {
      break
    }
    j++
  }
  if (j >= html.length) return ""
  const contentStart = j + 1
  const close = findCloseTag(html, contentStart, name)
  const raw = close === null ? html.slice(contentStart) : html.slice(contentStart, close.start)
  // Decode entities in a single pass over the raw text.
  const out: Array<string> = []
  let i = 0
  while (i < raw.length) {
    if (raw[i] === "&") {
      const { text, next } = decodeEntityAt(raw, i)
      out.push(text)
      i = next
    } else {
      out.push(raw[i]!)
      i++
    }
  }
  return out.join("")
}

/**
 * Convert HTML to visible plain text in a single pass. Skips comments,
 * declarations, tags (quote-aware), and raw-text elements
 * (script/style/noscript/template). Each entity decoded exactly once.
 * A space is emitted per skipped tag so words don't fuse across elements.
 */
export const htmlToText = (html: string): string => {
  const out: Array<string> = []
  const n = html.length
  let i = 0
  while (i < n) {
    const ch = html[i]!
    if (ch === "<") {
      if (html.startsWith("!--", i + 1)) {
        const end = html.indexOf("-->", i + 4)
        i = end === -1 ? n : end + 3
        continue
      }
      // Scan the tag with quote awareness (handles `>` inside attributes).
      let j = i + 1
      let quote: string | null = null
      while (j < n) {
        const c = html[j]!
        if (quote !== null) {
          if (c === quote) quote = null
        } else if (c === '"' || c === "'") {
          quote = c
        } else if (c === ">") {
          break
        }
        j++
      }
      const inner = html.slice(i + 1, j)
      const isClose = inner.startsWith("/")
      const name = inner
        .slice(isClose ? 1 : 0)
        .split(/[\s/>]/, 1)[0]
        ?.toLowerCase() ?? ""
      i = j < n ? j + 1 : n
      if (!isClose && RAW_TEXT_ELEMENTS.has(name)) {
        const close = findCloseTag(html, i, name)
        i = close === null ? n : close.end
        continue
      }
      out.push(" ")
      continue
    }
    if (ch === "&") {
      const { text, next } = decodeEntityAt(html, i)
      out.push(text)
      i = next
      continue
    }
    out.push(ch)
    i++
  }
  return out.join("")
}
