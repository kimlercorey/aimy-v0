/**
 * markdown.ts — render model markdown as functional HTML.
 */

import { marked } from "marked"
import hljs from "highlight.js"

marked.setOptions({ breaks: true, gfm: true })

const sanitizeHtml = (html: string): string => {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\s*on\w+\s*=\s*[^\s>]+/gi, "")
}

/**
 * Container blocks (2026-10-12): `:::name` ... `:::` expands to a styled
 * div BEFORE marked runs, with blank lines so the inner markdown parses.
 * Without this, the container syntax rendered as literal text ("seeing the
 * code") — AImy's callouts never survived the renderer.
 *
 *   :::aside                        -> <div class="md-callout md-callout-aside">
 *   :::aside {style="background:…"} -> same, with the inline style applied
 *
 * Code fences are passed through untouched; an unterminated container is
 * closed at end of input. Inline HTML with style attributes (spans, divs
 * with blank lines) already worked and still does — containers are the
 * reliable block-level tool.
 */
const expandContainers = (text: string): string => {
  const lines = text.split("\n")
  const out: Array<string> = []
  let inFence = false
  let inContainer = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && !inContainer) {
      const open = line.match(
        /^:::\s*([a-zA-Z][\w-]*)?\s*(?:\{\s*style="([^"]*)"\s*\}|\{\s*style='([^']*)'\s*\})?\s*$/
      )
      if (open) {
        const name = open[1] ?? "note"
        const style = open[2] ?? open[3]
        out.push(
          `<div class="md-callout md-callout-${name}"${style ? ` style="${style}"` : ""}>`,
          ""
        )
        inContainer = true
        continue
      }
    } else if (!inFence && inContainer && /^:::\s*$/.test(line)) {
      out.push("", "</div>")
      inContainer = false
      continue
    }
    out.push(line)
  }
  if (inContainer) out.push("", "</div>")
  return out.join("\n")
}

export const renderMarkdown = (text: string): string => {
  const renderer = new marked.Renderer()
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    if (lang === "mermaid") {
      return `<pre class="mermaid-block"><code class="language-mermaid">${escapeHtml(text)}</code></pre>`
    }
    let highlighted: string
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(text, { language: lang }).value
      } catch {
        highlighted = escapeHtml(text)
      }
    } else {
      highlighted = escapeHtml(text)
    }
    return `<pre><code class="hljs${lang ? ` language-${lang}` : ""}">${highlighted}</code></pre>`
  }
  // Document references (2026-10-13): an inline-code span that IS
  // a document name — a bare `name.md` or a planning/ or docs/
  // path — renders as a .doc-ref chip. The renderer's click pump
  // routes a click on it to the drawer-open flow, and the drawer
  // space it lands in is part of her per-turn state, so she knows
  // which document he is looking at. Anything else stays plain code.
  renderer.codespan = ({ text }: { text: string }) => {
    const t = text.trim()
    if (/^(?:(?:planning|docs)\/)?[\w.-]+\.md$/.test(t) && !t.includes("..")) {
      return `<code class="doc-ref" title="Open in the drawer">${escapeHtml(t)}</code>`
    }
    return `<code>${escapeHtml(text)}</code>`
  }
  const rawHtml = marked.parse(expandContainers(text), { async: false, renderer }) as string
  // Collapse whitespace between tags (prevents phantom line boxes).
  // Safe: code content is HTML-escaped, so no literal > < inside pre.
  const compact = rawHtml.replace(/>\s+</g, "><")
  return sanitizeHtml(compact)
}

const escapeHtml = (raw: string): string =>
  raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export const looksLikeMarkdown = (text: string): boolean => {
  return (
    /^#{1,6}\s/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /\*[^*]+\*/.test(text) ||
    /```/.test(text) ||
    /`[^`]+`/.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /\|.*\|/.test(text) ||
    /\[.+\]\(.+\)/.test(text)
  )
}
