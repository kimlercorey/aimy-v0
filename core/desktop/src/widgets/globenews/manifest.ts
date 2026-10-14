/**
 * widgets/globenews/manifest.ts — the GlobeNews manifest, the
 * single source the platform seeds ~/.aimy/homedash/available/
 * globenews/widget.json from (handlers' homedash.list).
 *
 * The widget has THREE components (Kimler, 2026-10-13): the globe
 * itself, the news feed queue, and the intel desk. The feed is a separate space
 * on the dash — its own layer, geometry and depth — but the same
 * widget: enabling GlobeNews enables both, and they share the
 * widget's events. The platform expands `components` into extra
 * layer entries named `<widgetId>-<componentId>`.
 */
export const GLOBENEWS_MANIFEST: Record<string, unknown> = {
  id: "globenews",
  name: "GlobeNews",
  description: "The vector earth: grab it, tilt it, watch the world on it.",
  version: "1.4.0",
  priority: 400,
  settings: [
    { key: "spinMinutes", type: "slider", label: "Spin — minutes per turn", min: 0.5, max: 6, step: 0.5, default: 2 },
    { key: "density", type: "select", label: "Dot density", options: ["calm", "rich"], default: "rich" },
    { key: "glowPx", type: "slider", label: "Rim glow reach (px)", min: 0, max: 40, step: 1, default: 20 },
    { key: "tiltDeg", type: "slider", label: "Tilt — disc-centre latitude", min: -60, max: 24, step: 1, default: -24 },
    { key: "cinematic", type: "toggle", label: "Director — idle fly-to broadcast", default: true },
    { key: "dwellSec", type: "slider", label: "Director dwell (seconds per threat)", min: 4, max: 30, step: 1, default: 10 },
    { key: "announce", type: "toggle", label: "Voice alerts — spoken, repeating until silenced", default: true },
    { key: "repeatMinutes", type: "slider", label: "Voice alert repeat (minutes)", min: 1, max: 15, step: 1, default: 3 },
  ],
  components: [
    {
      id: "feed",
      name: "GlobeNews — News feed",
      description: "The queue of world events found by the hourly scan. Click one to draw a line to it on the globe.",
      priority: 500,
      settings: [
        { key: "maxItems", type: "slider", label: "Feed items shown", min: 5, max: 40, step: 5, default: 15 },
      ],
    },
    {
      id: "desk",
      name: "GlobeNews — Intel desk",
      description: "The focused threat in depth: facts, the alert's own text, related signals. Follows your selection and the director's features.",
      priority: 450,
      settings: [],
    },
  ],
}
