/**
 * web-research/readability.ts — main-content extraction for fetched pages.
 *
 * THE PROBLEM: fetcher.extractText returns a page's full visible text —
 * nav, headers, footers, sidebars, cookie banners and all. On modern pages
 * the actual article is a fraction of that, so the model reasons over
 * boilerplate. This module identifies the main-content subtree with a
 * Readability-style scoring pass and extracts text from it.
 *
 * THE METHOD (no DOM library, no regex tag filtering — same discipline as
 * html-text.ts):
 *  1. Build a tolerant element tree with a quote-aware single-pass scanner.
 *     Raw-text subtrees (script/style/...) are skipped whole; void elements
 *     never take children; mismatched close tags pop tolerantly.
 *  2. Strip "unlikely candidate" subtrees by class/id (nav/sidebar/footer/
 *     cookie/banner/ad/comment/...) unless they also look like content
 *     (article/content/main/...). Tag names are never filtered by regex.
 *  3. Score text-bearing blocks (p/pre/blockquote/h2-h6/li): +1 per block,
 *     +1 per comma (max 3), +length/100 (max 3). Each block's score goes to
 *     its parent in full and its grandparent at half — the container holding
 *     the article accumulates the most.
 *  4. The top-scoring container wins; siblings scoring >= 20% of the top
 *     are included (multi-part articles). A bare <article>/<main> with the
 *     longest text is the fallback when nothing scores (div-soup pages).
 *
 * HONESTY: extraction reports what it did. `mainContent: true` means the
 * text is the scored article subtree, boilerplate removed. `mainContent:
 * false` means no article passed the bar — the caller falls back to
 * full-page text and says so (see fetcher.extractMainText). A page is never
 * silently presented as "the article" when it is really nav chrome.
 * `isJsShell` separately detects script-heavy pages with almost no visible
 * text so the fetch error can say "requires JavaScript" instead of the
 * generic "no readable text".
 */

import { decodeEntityAt, findCloseTag, htmlToText } from "./html-text.js"

export interface MainContent {
  readonly text: string
  /** True when `text` is the scored article subtree (boilerplate removed). */
  readonly mainContent: boolean
}

/** Minimum article characters before the extraction counts as main content. */
export const MIN_MAIN_CHARS = 140
/** Visible-text floor under which a script-heavy page counts as a JS shell. */
export const JS_SHELL_TEXT_CHARS = 300
/** Script bytes above which a low-text page is "probably needs JavaScript". */
export const JS_SHELL_SCRIPT_CHARS = 2000

interface ElNode {
  readonly tag: string
  readonly cls: string
  readonly id: string
  readonly children: Array<ElNode>
  readonly parent: ElNode | null
  text: string
  score: number
  full: string
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
])

/** Subtrees skipped whole — never content, never scored. */
const SKIP_SUBTREE = new Set([
  "script", "style", "noscript", "template", "svg", "canvas",
  "iframe", "object", "embed", "form", "button", "select", "textarea",
])

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
  "pre", "article", "section", "main", "br", "tr", "ul", "ol", "hr", "table",
])

/** Blocks whose text feeds the scoring pass. Readability's set (p/pre) plus
 *  blockquote and sub-headings; notably NOT li — list items let nav menus
 *  and reference lists outscore the article they annotate. */
const SCORE_TAGS = new Set(["p", "pre", "blockquote", "h2", "h3", "h4", "h5", "h6"])

/** Block elements that implicitly close an open <p> (HTML5 parsing rule). */
const P_CLOSING_BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "div",
  "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav",
  "ol", "p", "pre", "section", "table", "ul",
])

/**
 * Class/id fragments that mark boilerplate. A node matching these is
 * stripped — unless it ALSO matches MAYBE_CONTENT (a "content-sidebar"
 * keeps its content; a "sidebar" does not).
 */
const UNLIKELY_RE =
  /-ad-|ai2html|banner|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|modal|nav|pager|pagination|popup|references|reflist|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|cookie|subscribe|newsletter|share|widget|breadcrumb|toolbar|dropdown|login|signup|overlay|drawer/i
const MAYBE_CONTENT_RE = /and|article|body|column|content|entry|main|page|post|text|blog|story/i

interface Tag {
  readonly inner: string
  readonly end: number
  readonly isClose: boolean
  readonly isSelfClose: boolean
}

/** Quote-aware tag scan starting at html[i] === "<". Null on unterminated. */
const scanTag = (html: string, i: number): Tag | null => {
  let j = i + 1
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
  if (j >= html.length) return null
  let inner = html.slice(i + 1, j)
  const isClose = inner.startsWith("/")
  if (isClose) inner = inner.slice(1)
  const isSelfClose = /\/\s*$/.test(inner)
  if (isSelfClose) inner = inner.replace(/\/\s*$/, "")
  return { inner, end: j + 1, isClose, isSelfClose }
}

const tagNameOf = (inner: string): string =>
  inner.split(/[\s/>]/, 1)[0]?.toLowerCase() ?? ""

/** Manual attribute reader — no regex over markup, boundary-checked. */
const attrValue = (inner: string, name: string): string => {
  const li = inner.toLowerCase()
  const nm = name.toLowerCase()
  let i = li.indexOf(nm)
  while (i !== -1) {
    const before = i === 0 ? " " : li[i - 1]!
    if (before !== " " && before !== "\t" && before !== "\n" && before !== "\r" && before !== "\f") {
      i = li.indexOf(nm, i + 1)
      continue
    }
    let j = i + nm.length
    while (j < li.length && /\s/.test(li[j]!)) j++
    if (li[j] !== "=") {
      i = li.indexOf(nm, i + 1)
      continue
    }
    j++
    while (j < li.length && /\s/.test(li[j]!)) j++
    const q = inner[j]
    if (q === '"' || q === "'") {
      const end = inner.indexOf(q, j + 1)
      return end === -1 ? "" : inner.slice(j + 1, end)
    }
    let k = j
    while (k < inner.length && !/[\s>]/.test(inner[k]!)) k++
    return inner.slice(j, k)
  }
  return ""
}

/** Decode entities in a raw text run — single pass, never re-scanned. */
const decodeText = (raw: string): string => {
  const out: Array<string> = []
  let k = 0
  while (k < raw.length) {
    if (raw[k] === "&") {
      const { text, next } = decodeEntityAt(raw, k)
      out.push(text)
      k = next
    } else {
      out.push(raw[k]!)
      k++
    }
  }
  return out.join("")
}

/** Tolerant HTML → element tree. Malformed markup degrades, never throws. */
const buildTree = (html: string): ElNode => {
  const root: ElNode = { tag: "#root", cls: "", id: "", children: [], parent: null, text: "", score: 0, full: "" }
  const stack: Array<ElNode> = [root]
  let i = 0
  const n = html.length
  let buf = ""
  const flush = (): void => {
    if (buf !== "") {
      stack[stack.length - 1]!.text += decodeText(buf)
      buf = ""
    }
  }
  while (i < n) {
    if (html[i] === "<") {
      if (html.startsWith("!--", i + 1)) {
        flush()
        const end = html.indexOf("-->", i + 4)
        i = end === -1 ? n : end + 3
        continue
      }
      if (html[i + 1] === "!" || html[i + 1] === "?") {
        flush()
        const t = scanTag(html, i)
        i = t === null ? n : t.end
        continue
      }
      const t = scanTag(html, i)
      if (t === null) {
        buf += html[i]!
        i++
        continue
      }
      flush()
      const name = tagNameOf(t.inner)
      if (t.isClose) {
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s]!.tag === name) {
            stack.length = s
            break
          }
        }
      } else if (SKIP_SUBTREE.has(name)) {
        const close = findCloseTag(html, t.end, name)
        i = close === null ? n : close.end
        continue
      } else if (name !== "") {
        if (P_CLOSING_BLOCKS.has(name)) {
          while (stack.length > 1 && stack[stack.length - 1]!.tag === "p") stack.pop()
        }
        const node: ElNode = {
          tag: name,
          cls: attrValue(t.inner, "class").toLowerCase(),
          id: attrValue(t.inner, "id").toLowerCase(),
          children: [],
          parent: stack[stack.length - 1]!,
          text: "",
          score: 0,
          full: "",
        }
        stack[stack.length - 1]!.children.push(node)
        if (!t.isSelfClose && !VOID_ELEMENTS.has(name)) stack.push(node)
      }
      i = t.end
    } else {
      buf += html[i]!
      i++
    }
  }
  flush()
  return root
}

const isUnlikely = (node: ElNode): boolean => {
  if (node.tag === "#root") return false
  const hay = `${node.cls} ${node.id}`
  return UNLIKELY_RE.test(hay) && !MAYBE_CONTENT_RE.test(hay)
}

const stripUnlikely = (node: ElNode): void => {
  for (let i = node.children.length - 1; i >= 0; i--) {
    if (isUnlikely(node.children[i]!)) node.children.splice(i, 1)
  }
  for (const c of node.children) stripUnlikely(c)
}

/** Post-order: full descendant text per node (memoized on the node). */
const computeFull = (node: ElNode): string => {
  let s = node.text
  for (const c of node.children) s += " " + computeFull(c)
  node.full = s
  return s
}

const scoreParagraphs = (node: ElNode): void => {
  if (SCORE_TAGS.has(node.tag)) {
    const t = node.full.trim()
    if (t.length >= 25) {
      const commas = Math.min((t.match(/,/g) ?? []).length, 3)
      const s = 1 + commas + Math.min(t.length / 100, 3)
      if (node.parent !== null) node.parent.score += s
      const grand = node.parent?.parent ?? null
      if (grand !== null) grand.score += s / 2
    }
  }
  for (const c of node.children) scoreParagraphs(c)
}

const findBest = (node: ElNode, best: { node: ElNode | null; score: number }): void => {
  if (node.tag !== "#root" && node.score > best.score) {
    best.score = node.score
    best.node = node
  }
  for (const c of node.children) findBest(c, best)
}

const collectByTag = (node: ElNode, tags: ReadonlySet<string>, out: Array<ElNode>): void => {
  if (tags.has(node.tag)) out.push(node)
  for (const c of node.children) collectByTag(c, tags, out)
}

/** Fallback for div-soup pages: longest <article>/<main> with real text. */
const longestArticleSection = (root: ElNode): ElNode | null => {
  const sections: Array<ElNode> = []
  collectByTag(root, new Set(["article", "main"]), sections)
  let best: ElNode | null = null
  let bestLen = 0
  for (const s of sections) {
    const len = s.full.trim().length
    if (len > bestLen) {
      bestLen = len
      best = s
    }
  }
  return bestLen >= MIN_MAIN_CHARS ? best : null
}

const renderNodeText = (node: ElNode, out: Array<string>): void => {
  const t = node.text.trim()
  if (t !== "") out.push(t)
  for (const c of node.children) {
    if (BLOCK_TAGS.has(c.tag)) out.push("\n")
    renderNodeText(c, out)
    if (BLOCK_TAGS.has(c.tag)) out.push("\n")
  }
}

const cleanText = (s: string): string =>
  s.replace(/[ \t\f\v\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()

/**
 * Extract the page's main content. Pure over the HTML string — no network.
 * Returns mainContent: false (with empty text) when nothing scores as an
 * article; the caller falls back to full-page text and says so.
 */
export const extractMainContent = (html: string): MainContent => {
  const root = buildTree(html)
  stripUnlikely(root)
  computeFull(root)
  scoreParagraphs(root)
  const best = { node: null as ElNode | null, score: 0 }
  findBest(root, best)

  let target: ElNode | null = best.node
  // Include high-scoring siblings (multi-part articles), in document order —
  // but only on the scored path. The article/main fallback takes the section
  // alone: with best.score at zero every sibling would qualify, which is how
  // nav chrome leaked back in.
  let nodes: Array<ElNode>
  if (target === null) {
    target = longestArticleSection(root)
    nodes = target !== null ? [target] : []
  } else {
    const parent = target.parent
    nodes =
      parent !== null
        ? parent.children.filter((c) => c === target || c.score >= best.score * 0.2)
        : [target]
  }
  if (target === null) return { text: "", mainContent: false }
  const out: Array<string> = []
  for (const nd of nodes) renderNodeText(nd, out)
  const text = cleanText(out.join("\n"))
  if (text.length < MIN_MAIN_CHARS) return { text: "", mainContent: false }
  return { text, mainContent: true }
}

/**
 * Heuristic: script-heavy page with almost no visible text. Such pages need
 * a JS engine to render — this module has none, so the honest fetch error
 * names that instead of "no readable text".
 */
export const isJsShell = (html: string): boolean => {
  const visible = htmlToText(html).replace(/\s+/g, " ").trim()
  if (visible.length >= JS_SHELL_TEXT_CHARS) return false
  let scriptChars = 0
  let from = 0
  while (true) {
    const openAt = html.toLowerCase().indexOf("<script", from)
    if (openAt === -1) break
    // Find the end of the open tag (quote-aware is overkill here; ">" scan suffices for sizing).
    const tagEnd = html.indexOf(">", openAt)
    if (tagEnd === -1) break
    const close = findCloseTag(html, tagEnd + 1, "script")
    if (close === null) break
    scriptChars += close.start - (tagEnd + 1)
    from = close.end
    if (scriptChars > JS_SHELL_SCRIPT_CHARS) return true
  }
  return scriptChars > JS_SHELL_SCRIPT_CHARS
}
