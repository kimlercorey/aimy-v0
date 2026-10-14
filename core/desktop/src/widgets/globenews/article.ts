/**
 * widgets/globenews/article.ts — article extraction for the
 * drawer (2026-10-13).
 *
 * A deliberately small HTML→markdown reader: <article>/<main>
 * preferred, script/style/chrome blocks stripped, block structure
 * kept (headings, paragraphs, lists, quotes), links absolutised.
 * It is NOT a full readability engine — pages it cannot read yield
 * little text, and the caller falls back to the event's own
 * summary with an honest note rather than an empty drawer.
 * Pure; fixture-tested.
 */

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, ""))

/**
 * Site-chrome link labels (2026-10-13): navigation furniture that
 * survives block-stripping on chrome-heavy pages (the GDACS report
 * page leaked "admin / register/login / contact us" into the
 * drawer). Links with these labels are furniture, not content.
 */
const CHROME_LINK_RE =
  /^(admin|register\/login|log ?in|sign ?in|sign ?up|register|contact us|subscribe( now)?|privacy policy|terms( of use)?|cookie settings|home|menu|search|donate|support us|my account)$/i

/**
 * Machine-readable payloads (JSON API responses — the NWS alert
 * URL returns JSON, not an article page) extract as raw JSON
 * text. Such a document is data, not an article: callers fall
 * back to the event's own text instead (2026-10-13).
 */
export const isMachineReadableDocument = (markdown: string): boolean =>
  markdown.trimStart().startsWith("{")

/** Inline markdown for a fragment (links, emphasis, code). */
const inline = (frag: string, baseUrl: string): string => {
  let s = frag
  s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = stripTags(inner).trim()
    if (text === "" || CHROME_LINK_RE.test(text)) return ""
    try {
      return `[${text}](${new URL(href, baseUrl).toString()})`
    } catch {
      return text
    }
  })
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `**${stripTags(inner).trim()}**`)
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `*${stripTags(inner).trim()}*`)
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${stripTags(inner).trim()}\``)
  s = s.replace(/<[^>]+>/g, "")
  return decodeEntities(s)
}

const DROP_BLOCKS = [
  "script", "style", "noscript", "iframe", "svg", "form", "nav",
  "footer", "aside", "header", "button", "select", "textarea", "video",
]

/** Full HTML page → markdown body (no header; the caller adds it). */
export const htmlToMarkdown = (html: string, baseUrl: string): string => {
  let s = html
  const main =
    s.match(/<article[\s>][\s\S]*?<\/article>/i) ?? s.match(/<main[\s>][\s\S]*?<\/main>/i)
  if (main !== null) s = main[0]
  for (const tag of DROP_BLOCKS) {
    s = s.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi"), " ")
  }
  s = s.replace(/<img[^>]*>/gi, "")
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
  s = s.replace(/<br\s*\/?>/gi, "\n")
  s = s.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, lvl: string, inner: string) => `\n\n${"#".repeat(Math.min(6, Number(lvl) + 1))} ${inline(inner, baseUrl).trim()}\n\n`
  )
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\n\`\`\`\n${stripTags(inner)}\n\`\`\`\n\n`)
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) =>
    `\n\n${inline(inner, baseUrl).trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`
  )
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inline(inner, baseUrl).trim()}`)
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner: string) => `\n\n${inline(inner, baseUrl).trim()}\n\n`)
  s = s.replace(/<\/(div|section|tr|table|ul|ol|figure|figcaption)>/gi, "\n\n")
  s = inline(s, baseUrl)
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    // Lines that are ONLY a chrome link (the GDACS footer pattern).
    .filter((l) => !/^\[[^\]]*\]\([^)]*\)$/.test(l) || !CHROME_LINK_RE.test(l.slice(1, l.indexOf("]"))))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export interface ExtractedArticle {
  readonly markdown: string
  /** Rough prose length (markup/link targets discounted) — the thin-check. */
  readonly textLength: number
}

export const extractArticleMarkdown = (html: string, baseUrl: string): ExtractedArticle => {
  const markdown = htmlToMarkdown(html, baseUrl)
  const textLength = markdown
    .replace(/\[[^\]]*\]\([^)]*\)/g, "x") // links count as their text, roughly
    .replace(/[#*`>_-]/g, "")
    .replace(/\s+/g, " ")
    .trim().length
  return { markdown, textLength }
}
