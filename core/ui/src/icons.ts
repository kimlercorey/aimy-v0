/**
 * ui/src/icons.ts — solid icons from Lucide (MIT licensed).
 *
 * Rendered via h.InnerHTML with inline SVG. All paths from lucide.dev (ISC/MIT).
 * Use: h.span([h.Class("icon-wrap")], [icon.sparkles(h)])
 */
import type { Html, HtmlBuilder } from "foldkit/html"

type H = HtmlBuilder<any>

const svg = (inner: string, size = 16): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" aria-hidden="true">' + inner + '</svg>'

const svgFilled = (inner: string, size = 16): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" aria-hidden="true">' + inner + '</svg>'

export const icon = {
  sparkles: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/>'))], []),
  volumeOn: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'))], []),
  volumeOff: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'))], []),
  settings: (h: H): Html =>
    h.span([h.InnerHTML(svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'))], []),
  menu: (h: H): Html =>
    h.span([h.InnerHTML(svg('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>'))], []),
  chevronLeft: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="m15 18-6-6 6-6"/>'))], []),
  chevronDown: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="m6 9 6 6 6-6"/>', 12))], []),
  cornerDownLeft: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M9 10l-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>'))], []),
  star: (h: H): Html =>
    h.span([h.InnerHTML(svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', 12))], []),
  starFilled: (h: H): Html =>
    h.span([h.InnerHTML(svgFilled('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', 12))], []),
  play: (h: H): Html =>
    h.span([h.InnerHTML(svg('<polygon points="6 3 20 12 6 21 6 3"/>', 12))], []),
  trash: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>', 12))], []),
  info: (h: H): Html =>
    h.span([h.InnerHTML(svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>', 12))], []),
  mic: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'))], []),
  copy: (h: H): Html =>
    h.span([h.InnerHTML(svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>', 12))], []),
} as const

export type IconName = keyof typeof icon
