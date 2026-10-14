/**
 * Document-link routing (2026-10-13, Kimler's spec): markdown
 * links inside chat and drawer documents come in three kinds.
 * External (http/https) opens in the OS browser. A library
 * link — a planning/ or docs/ path, or a scheme-less *.md
 * path (bare names resolve against the same two roots in the
 * main process) — opens INSIDE the app, with the click's
 * modifiers choosing where:
 *   plain click    → the same drawer space (the one the link
 *                    was clicked in; from chat, the drawer
 *                    focus-or-open behaviour)
 *   Cmd-click      → a new drawer space
 *   Cmd-Opt-click  → the OS default app for the file
 * Anchors (#…) and anything else never navigate the webview.
 *
 * Pure and dependency-free: the desktop main.ts interceptor
 * uses it at click time, and the harness tests it directly.
 */

export type DocLinkKind = "internal" | "external" | "anchor" | "other"

export const classifyHref = (href: string): DocLinkKind => {
  if (href.startsWith("#")) return "anchor"
  if (href.startsWith("http://") || href.startsWith("https://")) return "external"
  if (href.includes("://")) return "other"
  if (href.startsWith("planning/") || href.startsWith("docs/")) return "internal"
  if (href.endsWith(".md") && !href.startsWith("/")) return "internal"
  return "other"
}

export type DocLinkMode = "same" | "new" | "external"

export const modeForClick = (metaKey: boolean, altKey: boolean): DocLinkMode =>
  metaKey && altKey ? "external" : metaKey ? "new" : "same"

/**
 * The id of the drawer space containing an element, or "" when
 * the element is not inside a space (a chat message). Spaces
 * carry their id as a `space-id-<id>` class (chat/drawer.ts).
 */
export const spaceIdOf = (el: HTMLElement | null): string => {
  const space = el?.closest?.(".drawer-space") as HTMLElement | null | undefined
  if (space === null || space === undefined) return ""
  const cls = [...space.classList].find((c) => c.startsWith("space-id-"))
  return cls !== undefined ? cls.slice("space-id-".length) : ""
}
