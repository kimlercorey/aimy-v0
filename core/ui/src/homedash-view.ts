/**
 * The HomeDash (2026-10-13, workplan Part 8): a stage of widget
 * layers, composited by priority — priority IS screen depth
 * (1–1000, higher on top). Three platform widgets:
 *
 *   WorkOn    — HTML: the greeting + chips, with the active
 *               project / live jobs / needs-you as a status strip.
 *   GlobeNews — the vector earth (renderer engine on .mirror-field-hook).
 *   MindMap   — the organism graph (renderer engine on .mindmap-hook).
 *
 * Widget state (enabled set, manifests, effective settings) arrives
 * via the HomedashIpc seam into session.drawer.dash. Before the
 * first load lands, FALLBACK_WIDGETS renders the same stage with
 * manifest defaults — the dash is never a blank wait.
 *
 * The same view renders in two homes: the Home destination panel
 * and the chat empty state (a new chat's empty state IS the dash).
 */
import type { Html, HtmlBuilder } from "foldkit/html"
import { buildFieldGraph, formatEta } from "./field-graph.js"
import type { HomeData, HomedashWidget, SessionSlice } from "./model.js"
import { Message } from "./messages.js"

type H = HtmlBuilder<Message>
type Settings = Record<string, string | number | boolean>

const settingsOf = (w: HomedashWidget): Settings => {
  const out: Settings = {}
  for (const s of w.settings) out[s.key] = s.value
  return out
}

/** The bundled widgets at their manifest defaults (pre-load stage). */
const FALLBACK_WIDGETS: ReadonlyArray<HomedashWidget> = [
  {
    id: "workon", name: "WorkOn", description: "", version: "1.0.0", priority: 1000,
    settings: [
      { key: "showNeedsYou", type: "toggle", label: "Show what needs you", value: true },
      { key: "showJobs", type: "toggle", label: "Show running jobs", value: true },
    ],
  },
  {
    id: "globenews", name: "GlobeNews", description: "", version: "1.0.0", priority: 400,
    settings: [
      { key: "spinMinutes", type: "slider", label: "Spin", value: 2 },
      { key: "density", type: "select", label: "Dot density", value: "rich" },
      { key: "glowPx", type: "slider", label: "Rim glow reach", value: 20 },
      { key: "tiltDeg", type: "slider", label: "Tilt", value: -24 },
    ],
  },
  {
    id: "mindmap", name: "MindMap", description: "", version: "1.0.0", priority: 300,
    settings: [
      { key: "breeze", type: "toggle", label: "Breeze", value: true },
      { key: "labels", type: "toggle", label: "Permanent node labels", value: true },
    ],
  },
]

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * WorkOn: the greeting IS the widget (Kimler, 2026-10-13) — the
 * "What should we work on?" block with its suggestion chips, not
 * furniture under the stage. Under the chips, a quiet status strip
 * carries what the card used to say (active project, running jobs,
 * what needs you), governed by the widget's toggles. The chips
 * dispatch the same UserSentMessage they always did.
 */
const workOnView = (h: H, w: HomedashWidget, home: HomeData | undefined): Html => {
  const s = settingsOf(w)
  const now = Date.now()
  const parts: Array<Html> = [
    h.h2([h.Class("workon-title")], ["What should we work on?"]),
    h.p([h.Class("workon-sub")], [
      "Aimy runs on your machine. Ask anything, build something, or just talk.",
    ]),
    h.div([h.Class("workon-chips")], [
      h.button(
        [h.Class("suggestion-chip"), h.OnClick(Message.UserSentMessage({ id: `msg-${now}`, text: "What can you do?", at: now }))],
        ["What can you do?"]
      ),
      h.button(
        [h.Class("suggestion-chip"), h.OnClick(Message.UserSentMessage({ id: `msg-${now}`, text: "Help me plan my day", at: now }))],
        ["Plan my day"]
      ),
      h.button(
        [h.Class("suggestion-chip"), h.OnClick(Message.UserSentMessage({ id: `msg-${now}-2`, text: "Write something with me", at: now }))],
        ["Write with me"]
      ),
    ]),
  ]
  if (home !== undefined && home.project !== null) {
    const project = home.project
    const strip: Array<Html> = [
      h.div([h.Class("workon-strip-line")], [
        h.span([h.Class("workon-strip-label")], ["WORKING ON"]),
        h.span([h.Class("workon-strip-project")], [project.name]),
        ...(project.purpose !== ""
          ? [h.span([h.Class("workon-strip-purpose")], [trunc(project.purpose, 90)])]
          : []),
      ]),
    ]
    if (s["showJobs"] !== false) {
      const active = project.runs.filter((r) => r.status === "running" || r.status === "scheduled")
      for (const r of active.slice(0, 3)) {
        strip.push(
          h.div([h.Class("workon-strip-line")], [
            h.span([], [trunc(r.query, 44)]),
            h.span([h.Class("workon-row-eta")], [`about ${formatEta(r.etaMs)} left`]),
          ])
        )
      }
    }
    if (s["showNeedsYou"] !== false && home.requests.length > 0) {
      strip.push(
        h.div([h.Class("workon-strip-line")], [
          h.span([h.Class("workon-strip-label")], [`NEEDS YOU · ${home.requests.length}`]),
          h.span([], [home.requests.slice(0, 3).map((r) => r.capability).join(" · ")]),
        ])
      )
    }
    parts.push(h.div([h.Class("workon-strip")], strip))
  }
  return h.div([h.Class("workon-hero")], parts)
}

interface Geo { x: number; y: number; w: number; h: number }

/**
 * Layer geometry in stage percentages — user-editable in place
 * (Cmd+right-click the dash) and stored per widget in the HomeDash
 * settings (geoX/geoY/geoW/geoH), the same store the Settings panel
 * writes. Defaults reproduce the composed look: the two canvas
 * widgets fill the stage; WorkOn sits top-right.
 */
const geometryOf = (w: HomedashWidget): Geo => {
  const s = settingsOf(w)
  const d: Geo = w.id === "workon" ? { x: 24, y: 24, w: 52, h: 52 } : { x: 0, y: 0, w: 100, h: 100 }
  const num = (v: string | number | boolean | undefined, fb: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fb
  return {
    x: num(s["geoX"], d.x),
    y: num(s["geoY"], d.y),
    w: num(s["geoW"], d.w),
    h: num(s["geoH"], d.h),
  }
}

const layer = (h: H, w: HomedashWidget, home: HomeData | undefined): Html => {
  const g = geometryOf(w)
  const attrs = [
    // Keyed by widget id: the dash re-renders on every save, and an
    // unkeyed positional patch repurposes layer DOM across widgets
    // (the 2026-10-13 scramble: MindMap's badge and canvas landed
    // inside WorkOn's box when fallback order flipped to loaded
    // order). Identity must survive re-renders.
    h.Key(w.id),
    h.Class(`homedash-layer homedash-layer-${w.id}`),
    h.Style({
      "z-index": String(w.priority),
      left: `${g.x}%`,
      top: `${g.y}%`,
      width: `${g.w}%`,
      height: `${g.h}%`,
    }),
  ]
  // The in-place editor (desktop homedash-edit.ts) reads this meta.
  const meta = h.span([h.Class("homedash-layer-meta")], [
    JSON.stringify({ id: w.id, name: w.name, priority: w.priority }),
  ])
  switch (w.id) {
    case "workon":
      return h.div(attrs, [meta, workOnView(h, w, home)])
    case "globenews":
      // The globe engine (desktop mirror-field.ts) attaches here; its
      // settings ride the hidden span — the established DOM pattern.
      return h.div(attrs, [
        meta,
        h.div([h.Class("mirror-field-hook")], [
          h.span([h.Class("mirror-field-settings")], [JSON.stringify(settingsOf(w))]),
        ]),
      ])
    case "mindmap":
      // The mind map engine (desktop mindmap.ts): graph JSON from
      // real home data + its settings, both as hidden spans.
      return h.div(attrs, [
        meta,
        h.div([h.Class("mindmap-hook")], [
          ...(home !== undefined
            ? [h.span([h.Class("mindmap-data")], [JSON.stringify(buildFieldGraph(home))])]
            : []),
          h.span([h.Class("mindmap-settings")], [JSON.stringify(settingsOf(w))]),
        ]),
      ])
    default:
      // An enabled widget with no compiled renderer yet: an honest
      // empty layer — its folder and settings are real, its view
      // arrives with its code (bundle system).
      return h.div(attrs, [meta])
  }
}

/** The dash itself: layers sorted by priority ascending (DOM + z). */
export const homeDashView = (h: H, session: SessionSlice): Html => {
  const dash = session.drawer.dash
  const widgets = [...(dash !== undefined ? dash.widgets : FALLBACK_WIDGETS)].sort((a, b) => a.priority - b.priority)
  return h.div(
    [h.Class("homedash-stage")],
    widgets.map((w) => layer(h, w, session.drawer.homeData))
  )
}
