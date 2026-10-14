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
  stop: (h: H): Html =>
    h.span([h.InnerHTML(svgFilled('<rect width="14" height="14" x="5" y="5" rx="2"/>', 14))], []),
  trash: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>', 12))], []),
  info: (h: H): Html =>
    h.span([h.InnerHTML(svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>', 12))], []),
  mic: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'))], []),
  copy: (h: H): Html =>
    h.span([h.InnerHTML(svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>', 12))], []),
  x: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 14))], []),
  history: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>', 14))], []),
  download: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>', 14))], []),
  save: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>', 14))], []),
  pencil: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>', 14))], []),
  fileText: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>', 14))], []),
  check: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M20 6 9 17l-5-5"/>', 14))], []),
  plus: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M5 12h14"/><path d="M12 5v14"/>'))], []),
  eye: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', 14))], []),
  // ── Navigation set (2026-10-12, UI workplan Part 1B) ──────────────
  // One icon per destination/concept, rail size class 20px (Part 5
  // token pass may revisit sizes globally; the registry is the single
  // place that knows them). Header-class icons are 18px (panelLeft).
  messageCircle: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>', 20))], []),
  folder: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>', 20))], []),
  bookOpen: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>', 20))], []),
  user: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', 20))], []),
  briefcase: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>', 20))], []),
  bell: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>', 20))], []),
  mail: (h: H): Html =>
    h.span([h.InnerHTML(svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>', 20))], []),
  shield: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>', 20))], []),
  lock: (h: H): Html =>
    h.span([h.InnerHTML(svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', 20))], []),
  upload: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>', 20))], []),
  panelLeft: (h: H): Html =>
    h.span([h.InnerHTML(svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>', 18))], []),
  panelRight: (h: H): Html =>
    h.span([h.InnerHTML(svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>', 14))], []),
  /**
   * The homedash door (2026-10-13): NOT the stock house glyph —
   * Kimler called it dusty and overused. This is the product's own
   * mark: two tetrahedra apex-to-apex across the horizon gap, as
   * above, so below. Stroke form for chrome; the filled duotone
   * lives in the brand assets.
   */
  home: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M12 2.5 L19.5 10.5 L4.5 10.5 Z"/><path d="M12 21.5 L4.5 13.5 L19.5 13.5 Z"/>', 20))], []),
  /** GlobeNews category glyphs (2026-10-13) — feed chips share the globe dots' category colours. */
  crosshair: (h: H): Html =>
    h.span([h.InnerHTML(svg('<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>', 13))], []),
  megaphone: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>', 13))], []),
  activity: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>', 13))], []),
  flame: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>', 13))], []),
  cloudLightning: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/>', 13))], []),
  waves: (h: H): Html =>
    h.span([h.InnerHTML(svg('<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>', 13))], []),
} as const

export type IconName = keyof typeof icon
