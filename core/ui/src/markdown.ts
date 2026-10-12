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
  const rawHtml = marked.parse(text, { async: false, renderer }) as string
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
