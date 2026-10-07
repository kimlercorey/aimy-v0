/**
 * ui/src/shared/text.ts — VNode text extraction for tests and the demo.
 *
 * Walks a foldkit `Html` tree (snabbdom VNodes) and collects every rendered
 * string, so integration tests can assert "displayed values === service
 * state" without a DOM. Handles raw string children as well as normalized
 * text vnodes.
 */
import type { Html } from "foldkit/html"

interface Textish {
  readonly text?: string | undefined
  readonly children?: ReadonlyArray<unknown> | undefined
}

const isTextish = (value: unknown): value is Textish =>
  typeof value === "object" && value !== null

export const textOf = (html: Html | ReadonlyArray<Html> | string): string => {
  if (html === null || html === undefined) return ""
  if (typeof html === "string") return html
  if (Array.isArray(html)) return html.map(textOf).join("")
  if (!isTextish(html)) return ""
  const parts: Array<string> = []
  if (typeof html.text === "string") parts.push(html.text)
  if (Array.isArray(html.children)) {
    for (const child of html.children) {
      parts.push(
        textOf(child as Html | ReadonlyArray<Html> | string),
      )
    }
  }
  return parts.join("")
}

/** Normalize whitespace for stable assertions. */
export const normalized = (text: string): string =>
  text.replace(/\s+/g, " ").trim()
