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
import { bearingFromWatched, buildFieldGraph, formatEta, isLocalEvent, isUsEvent } from "./field-graph.js"

/** Threat Channel scopes (design §2): default Local. */
type NewsScope = "global" | "national" | "local"
import type { HomeData, HomedashNewsEvent, HomedashVoiceAlert, HomedashWidget, SessionSlice } from "./model.js"
import { icon } from "./icons.js"
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
    id: "globenews-feed", name: "GlobeNews — News feed", description: "", version: "1.1.0", priority: 500,
    settings: [{ key: "maxItems", type: "slider", label: "Feed items shown", value: 15 }],
  },
  {
    id: "globenews-desk", name: "GlobeNews — Intel desk", description: "", version: "1.3.0", priority: 450,
    settings: [],
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

const NEWS_CATEGORY_LABEL: Record<string, string> = {
  conflict: "Conflict",
  unrest: "Unrest",
  earthquake: "Earthquake",
  fire: "Fire",
  weather: "Weather",
  disaster: "Disaster",
  // Legacy stores (pre-2026-10-13 widening) may still carry this
  // until the next scan replaces them.
  catastrophe: "Disaster",
}

/** Category → Lucide glyph for the feed chips (colours in styles.css). */
const NEWS_CATEGORY_ICON: Record<string, (h: H) => Html> = {
  conflict: icon.crosshair,
  unrest: icon.megaphone,
  earthquake: icon.activity,
  fire: icon.flame,
  weather: icon.cloudLightning,
  disaster: icon.waves,
  catastrophe: icon.waves,
}

const agoShort = (atMs: number, now: number): string => {
  const mins = Math.max(1, Math.round((now - atMs) / 60000))
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

/**
 * The GlobeNews feed component (2026-10-13): the queue of world
 * events the hourly scan found — a separate space on the dash,
 * but the same widget as the globe. Rows are inert DOM (the id
 * rides a hidden span); the renderer link module
 * (widgets/globenews/news-link.ts) owns row clicks, selection
 * and the cyan line to the event's dot on the globe. Each row
 * leads with a category chip — Lucide glyph in the category
 * colour the globe dots use; read rows ring the chip cyan.
 * The footer's "last updated" label is a button (class hook
 * js-news-refresh): a delegated listener in subscriptions runs
 * a manual scan — no foldkit command, per the DOM rule.
 */
/**
 * The voice alert strip (Threat Channel §8): while the alerts
 * voice is repeating a threat, the desk and the feed carry its
 * silence control — the ONLY thing that stops the repetition
 * (short of the announce setting). The button is inert DOM;
 * a delegated listener in subscriptions dispatches the dismiss.
 */
const voiceAlertStripView = (h: H, alerts: ReadonlyArray<HomedashVoiceAlert>): Html | undefined => {
  if (alerts.length === 0) return undefined
  return h.div(
    [h.Class("news-voice-alerts")],
    alerts.slice(0, 3).map((a) =>
      h.div([h.Class(`news-voice-alert news-voice-${a.severity}`)], [
        h.span([h.Class("news-voice-label")], [
          a.severity === "critical" ? "CRITICAL VOICE ALERT" : "VOICE ALERT — REPEATING",
        ]),
        h.span([h.Class("news-voice-title")], [a.title]),
        h.button(
          [h.Class("news-voice-dismiss js-voice-dismiss"), h.Title("Silence this alert — stops the repeating announcement")],
          [h.span([h.Class("voice-alert-id")], [a.id]), h.span([], ["Silence"])]
        ),
      ])
    )
  )
}

const newsFeedView = (h: H, w: HomedashWidget, scope: NewsScope, voiceAlerts: ReadonlyArray<HomedashVoiceAlert>): Html => {
  const s = settingsOf(w)
  const maxItems = typeof s["maxItems"] === "number" ? (s["maxItems"] as number) : 15
  const now = Date.now()
  const all = w.news ?? []
  const events = (
    scope === "national"
      ? all.filter((e) => isUsEvent(e))
      : scope === "local"
        ? all.filter((e) => isLocalEvent(e))
        : all
  ).slice(0, Math.max(1, maxItems))
  // Scope switch (Threat Channel design §2, 2026-10-13): the
  // feed's header IS the switch — Global / National / Local,
  // defaulting to Local. View state; the globe is unaffected.
  const regionBtn = (label: string, region: string, active: boolean) =>
    h.button(
      [
        h.Class(active ? "news-region-btn news-region-on" : "news-region-btn"),
        h.OnClick(Message.NewsRegionToggled({ region })),
      ],
      [label]
    )
  const head = h.div([h.Class("news-feed-head")], [
    h.span([h.Class("news-region-toggle")], [
      regionBtn("Global", "global", scope === "global"),
      regionBtn("National", "national", scope === "national"),
      regionBtn("Local", "local", scope === "local"),
    ]),
  ])
  const foot = h.button(
    [
      h.Class("news-updated js-news-refresh"),
      h.Title("Update now — run the world-news scan"),
    ],
    [
      w.newsUpdatedAt !== undefined && w.newsUpdatedAt > 0
        ? `last updated: ${agoShort(w.newsUpdatedAt, now)} ago`
        : "last updated: never",
    ]
  )
  const strip = voiceAlertStripView(h, voiceAlerts)
  if (events.length === 0) {
    return h.div([h.Class("news-feed")], [
      head,
      ...(strip !== undefined ? [strip] : []),
      h.div([h.Class("news-empty")], [
        all.length === 0
          ? "No events yet — the hourly scan will fill this in."
          : scope === "local"
            ? "Nothing near Tucson or Tall Timbers in the last 5 days — the scan keeps watching."
            : "No US events in the last 5 days — the hourly scan keeps looking.",
      ]),
      foot,
    ])
  }
  const rows = events.map((e) =>
    h.div([h.Class(`news-item news-item-${e.category}${e.read ? " news-item-read" : ""}`)], [
      h.span([h.Class("news-item-id")], [e.id]),
      h.span([h.Class(`news-cat news-cat-${e.category}${e.read ? " news-cat-read" : ""}`)], [
        (NEWS_CATEGORY_ICON[e.category] ?? icon.waves)(h),
      ]),
      h.div([h.Class("news-item-main")], [
        h.div([h.Class("news-item-title")], [e.title]),
        h.div([h.Class("news-item-meta")], [
          [e.source, e.place ?? "", `${agoShort(e.atMs, now)} ago`, NEWS_CATEGORY_LABEL[e.category] ?? e.category]
            .filter((x) => x !== "")
            .join(" · "),
        ]),
      ]),
    ])
  )
  return h.div([h.Class("news-feed")], [head, ...(strip !== undefined ? [strip] : []), ...rows, foot])
}

/**
 * The intel desk (Threat Channel design §7): the third GlobeNews
 * component — the focused threat in depth: a facts strip
 * (distance + bearing from the nearest watched place, age,
 * source), the event's own text, and same-category related
 * signals. Focus comes from the model (NewsFocusChanged): a
 * user selection, a director feature, or — with neither — the
 * freshest local event, so the desk is never dead air. Its
 * buttons are inert DOM (js-news-desk-open + a hidden id span);
 * a delegated listener in subscriptions opens the article.
 */
const intelDeskView = (
  h: H,
  w: HomedashWidget,
  focusId: string | undefined,
  focusKind: string | undefined,
  voiceAlerts: ReadonlyArray<HomedashVoiceAlert>
): Html => {
  const now = Date.now()
  const events = w.news ?? []
  const focused =
    focusId !== undefined && focusId !== "" ? events.find((e) => e.id === focusId) : undefined
  const ev = focused ?? events.find((e) => isLocalEvent(e)) ?? events[0]
  const strip = voiceAlertStripView(h, voiceAlerts)
  if (ev === undefined) {
    return h.div([h.Class("news-desk")], [
      ...(strip !== undefined ? [strip] : []),
      h.div([h.Class("news-desk-kicker")], ["INTEL DESK"]),
      h.div([h.Class("news-desk-empty")], [
        "Standing by — no signals in the window. The scan keeps watching.",
      ]),
    ])
  }
  const near = bearingFromWatched(ev)
  const facts = [
    near !== undefined ? `${Math.round(near.km)} km ${near.bearing} of ${near.place}` : (ev.place ?? ""),
    `${agoShort(ev.atMs, now)} ago`,
    ev.source,
    NEWS_CATEGORY_LABEL[ev.category] ?? ev.category,
  ]
    .filter((x) => x !== "")
    .join(" · ")
  const body = ev.detail !== undefined && ev.detail !== "" ? ev.detail : (ev.summary ?? "")
  const related = events.filter((e) => e.id !== ev.id && e.category === ev.category).slice(0, 3)
  const openBtn = (id: string, label: string, cls: string): Html =>
    h.button([h.Class(cls)], [
      h.span([h.Class("news-item-id")], [id]),
      h.span([], [label]),
    ])
  return h.div([h.Class(`news-desk news-item-${ev.category}`)], [
    ...(strip !== undefined ? [strip] : []),
    h.div([h.Class("news-desk-head")], [
      h.span([h.Class(`news-cat news-cat-${ev.category}`)], [
        (NEWS_CATEGORY_ICON[ev.category] ?? icon.waves)(h),
      ]),
      h.span([h.Class("news-desk-kicker")], [
        focused !== undefined
          ? focusKind === "featured"
            ? "INTEL DESK — ON AIR"
            : "INTEL DESK — SELECTED"
          : "INTEL DESK — LATEST LOCAL",
      ]),
    ]),
    h.div([h.Class("news-desk-title news-item-title")], [ev.title]),
    h.div([h.Class("news-desk-facts")], [facts]),
    ...(body !== "" ? [h.div([h.Class("news-desk-body")], [trunc(body, 720)])] : []),
    openBtn(ev.id, "Open the full report", "news-desk-open js-news-desk-open"),
    ...(related.length > 0
      ? [
          h.div([h.Class("news-desk-related")], [
            h.div([h.Class("news-desk-related-label")], ["RELATED SIGNALS"]),
            ...related.map((r) =>
              openBtn(r.id, `${r.title} · ${agoShort(r.atMs, now)} ago`, "news-desk-related-item js-news-desk-open")
            ),
          ]),
        ]
      : []),
  ])
}

/**
 * The broadcast lower-third (design §5): stage furniture, not a
 * layer — while the director features a threat, its headline
 * rides the bottom of the stage in the severity grammar (the
 * category colour carries the band). Follows the model focus;
 * user selections don't raise it (the desk covers those).
 */
const lowerThirdView = (
  h: H,
  globe: HomedashWidget | undefined,
  focusId: string | undefined,
  focusKind: string | undefined
): Html | undefined => {
  if (globe === undefined || focusKind !== "featured" || focusId === undefined || focusId === "") {
    return undefined
  }
  const ev = (globe.news ?? []).find((e) => e.id === focusId)
  if (ev === undefined) return undefined
  const now = Date.now()
  const near = bearingFromWatched(ev)
  const facts = [
    NEWS_CATEGORY_LABEL[ev.category] ?? ev.category,
    near !== undefined ? `${Math.round(near.km)} km ${near.bearing} of ${near.place}` : (ev.place ?? ""),
    `${agoShort(ev.atMs, now)} ago`,
    ev.source,
  ]
    .filter((x) => x !== "")
    .join(" · ")
  return h.div([h.Class(`news-lower-third news-item-${ev.category}`)], [
    h.div([h.Class("news-lt-band")], [facts]),
    h.div([h.Class("news-lt-title news-item-title")], [ev.title]),
  ])
}

/**
 * The crawl (design §5): the channel's ticker along the stage
 * bottom — fresh, unread headlines, looping. Items are inert
 * buttons (js-crawl-item + hidden id span) on the same
 * delegated open path as the desk. No fresh headlines, no
 * crawl: the channel does not pad.
 */
const crawlView = (h: H, globe: HomedashWidget | undefined): Html | undefined => {
  if (globe === undefined) return undefined
  const now = Date.now()
  const items = (globe.news ?? [])
    .filter((e) => !e.read && now - e.atMs < 24 * 60 * 60 * 1000)
    .slice(0, 8)
  if (items.length === 0) return undefined
  const item = (e: HomedashNewsEvent): Html =>
    h.button([h.Class("news-crawl-item js-crawl-item")], [
      h.span([h.Class("news-item-id")], [e.id]),
      h.span([], [
        `${(NEWS_CATEGORY_LABEL[e.category] ?? e.category).toUpperCase()} — ${e.title}${e.place !== undefined && e.place !== "" ? ` · ${e.place}` : ""}`,
      ]),
    ])
  const pass = items.map(item)
  return h.div([h.Class("news-crawl")], [
    h.div([h.Class("news-crawl-track")], [...pass, ...items.map(item)]),
  ])
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
  const d: Geo =
    w.id === "workon"
      ? { x: 24, y: 24, w: 52, h: 52 }
      : w.id === "globenews-feed"
        ? { x: 74, y: 36, w: 26, h: 58 }
        : w.id === "globenews-desk"
          ? { x: 1.5, y: 56, w: 25, h: 42 }
          : { x: 0, y: 0, w: 100, h: 100 }
  const num = (v: string | number | boolean | undefined, fb: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fb
  return {
    x: num(s["geoX"], d.x),
    y: num(s["geoY"], d.y),
    w: num(s["geoW"], d.w),
    h: num(s["geoH"], d.h),
  }
}

const layer = (
  h: H,
  w: HomedashWidget,
  home: HomeData | undefined,
  scope: NewsScope,
  focusId: string | undefined,
  focusKind: string | undefined,
  voiceAlerts: ReadonlyArray<HomedashVoiceAlert>
): Html => {
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
      // The globe engine (renderer widgets/globenews/engine.ts)
      // attaches here; its
      // settings ride the hidden span — the established DOM pattern.
      // The widget's world events ride a second span the same way:
      // the engine draws them as dots (2026-10-13).
      return h.div(attrs, [
        meta,
        h.div([h.Class("mirror-field-hook")], [
          h.span([h.Class("mirror-field-settings")], [JSON.stringify(settingsOf(w))]),
          h.span([h.Class("globenews-events")], [JSON.stringify(w.news ?? [])]),
        ]),
      ])
    case "globenews-feed":
      return h.div(attrs, [meta, newsFeedView(h, w, scope, voiceAlerts)])
    case "globenews-desk":
      return h.div(attrs, [meta, intelDeskView(h, w, focusId, focusKind, voiceAlerts)])
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

/** The dash itself: layers sorted by priority ascending (DOM + z),
 * plus the broadcast stage furniture (lower-third + crawl) that
 * belongs to the stage, not to any one layer. */
export const homeDashView = (h: H, session: SessionSlice): Html => {
  const dash = session.drawer.dash
  const widgets = [...(dash !== undefined ? dash.widgets : FALLBACK_WIDGETS)].sort((a, b) => a.priority - b.priority)
  const scope: NewsScope =
    session.drawer.newsRegion === "global"
      ? "global"
      : session.drawer.newsRegion === "national" || session.drawer.newsRegion === "usa"
        ? "national"
        : "local"
  const focusId = session.drawer.newsFocusId
  const focusKind = session.drawer.newsFocusKind
  const voiceAlerts = session.drawer.voiceAlerts ?? []
  const globe = widgets.find((w) => w.id === "globenews")
  const furniture: Array<Html> = []
  const lt = lowerThirdView(h, globe, focusId, focusKind)
  if (lt !== undefined) furniture.push(lt)
  const crawl = crawlView(h, globe)
  if (crawl !== undefined) furniture.push(crawl)
  return h.div(
    [h.Class("homedash-stage")],
    [
      ...widgets.map((w) => layer(h, w, session.drawer.homeData, scope, focusId, focusKind, voiceAlerts)),
      ...furniture,
    ]
  )
}
