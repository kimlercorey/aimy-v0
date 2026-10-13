/**
 * mindmap.ts — MindMap: the organism graph (2026-10-13).
 *
 * The HomeDash's MindMap widget: typed nodes (project / asset /
 * job / subject / chat / memory / journal, each its own colour)
 * laid out with topological pull plus TIME GRAVITY — a node's
 * height comes from its recency, recent things sink toward the
 * bottom (OLDER / RECENT rim labels name the axis). A continuous
 * spring simulation keeps it alive: a soft breeze, neighbour
 * repulsion, and a hover tug along real edges. Active jobs are
 * large blue hearts with their ETA in the centre; finished jobs
 * turn green with a check, briefly. Hover previews; click routes
 * each node home (document → drawer, project → active + Projects,
 * chat / memory / subject → Memory, hub → Presence).
 *
 * Data: ui/field-graph.ts derives the graph from real home data;
 * it rides in the hook's hidden .mindmap-data span; the widget's
 * settings (breeze, labels) ride .mindmap-settings. Renderer-owned
 * DOM effect (the mermaid.ts pattern); actions leave through
 * `aimy:field-*` CustomEvents pumped by subscriptions.ts. When
 * the hook mounts with no data span, the engine asks for the
 * cold-start load (`aimy:field-refresh`). Loop dies with the
 * element, pauses when hidden, reduced motion = one frame.
 */
import { formatEta } from "../../../ui/src/field-graph.js"

const EMBER = "232, 180, 74"
const PHOSPHOR = "0, 255, 65"


export interface FieldNode {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly sub: string
  readonly weight: number
  readonly atMs: number
  readonly preview?: string | undefined
  readonly path?: string | undefined
  readonly projectId?: string | undefined
  readonly panelTarget?: string | undefined
  readonly jobState?: "active" | "done" | undefined
  readonly etaMs?: number | null | undefined
}
export interface FieldEdge {
  readonly a: string
  readonly b: string
  readonly style: "solid" | "dotted"
}
export interface FieldGraph {
  readonly nodes: ReadonlyArray<FieldNode>
  readonly edges: ReadonlyArray<FieldEdge>
}

const GOLDEN = 2.399963
const RING: Record<string, number> = {
  project: 0.34,
  knowledge: 0.28,
  door: 0.5,
  subject: 0.62,
  asset: 0.78,
  job: 0.55,
  chat: 0.85,
  memory: 0.92,
  recent: 0.97,
}

/**
 * Deterministic layout: golden-spiral anchors, edge springs,
 * pairwise repulsion, and time gravity — a node's target height
 * comes from its recency (recent sinks toward the composer at the
 * bottom). The hub is pinned at the centre. ~160 relax iterations
 * over ≤54 nodes is well under a frame of main-thread time.
 */
export const layoutField = (
  nodes: ReadonlyArray<FieldNode>,
  edges: ReadonlyArray<FieldEdge>,
  cx: number,
  cy: number,
  discR: number,
): Map<string, { x: number; y: number; age: number }> => {
  const pos = new Map<string, { x: number; y: number; age: number }>()
  const anchor = new Map<string, { x: number; y: number }>()
  let i = 0
  for (const n of nodes) {
    if (n.kind === "hub") {
      pos.set(n.id, { x: cx, y: cy, age: 0.75 })
      anchor.set(n.id, { x: cx, y: cy })
      continue
    }
    const ring = RING[n.kind] ?? 0.85
    const angle = i * GOLDEN + ring * 5.0
    const rad = discR * ring * (0.82 + 0.18 * (((i * 37) % 10) / 10))
    const p = { x: cx + Math.cos(angle) * rad, y: cy + Math.sin(angle) * rad * 0.6 }
    pos.set(n.id, { ...p, age: 0.5 })
    anchor.set(n.id, p)
    i++
  }
  const movable = nodes.filter((n) => n.kind !== "hub")
  const ats = movable.map((n) => n.atMs)
  const minAt = ats.length ? Math.min(...ats) : 0
  const maxAt = ats.length ? Math.max(...ats) : 1
  // Recency owns the vertical axis (2026-10-13): RANK-based, so the
  // newest node always lands at the bottom rim and the oldest at the
  // top, whatever the timestamps' spread. Age (value-based) rides in
  // the result for the renderer: brightness and size by freshness.
  const rankOf = new Map<string, number>()
  ;[...movable]
    .sort((a, b) => a.atMs - b.atMs)
    .forEach((n, idx) => {
      rankOf.set(n.id, movable.length > 1 ? idx / (movable.length - 1) : 0.5)
    })
  const targetY = (n: FieldNode): number =>
    cy + ((rankOf.get(n.id) ?? 0.5) - 0.5) * discR * 0.98
  for (let iter = 0; iter < 160; iter++) {
    for (const e of edges) {
      const a = pos.get(e.a)
      const b = pos.get(e.b)
      if (a === undefined || b === undefined) continue
      const rest = discR * (e.a === "hub" || e.b === "hub" ? 0.36 : 0.30)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.hypot(dx, dy) || 1
      const f = ((dist - rest) / dist) * 0.012
      // Anisotropic: edges arrange x/topology freely but may only
      // nudge y — the vertical axis belongs to time.
      if (e.a !== "hub") {
        a.x += dx * f * 0.5
        a.y += dy * f * 0.5 * 0.35
      }
      if (e.b !== "hub") {
        b.x -= dx * f * 0.5
        b.y -= dy * f * 0.5 * 0.35
      }
    }
    for (let a = 0; a < movable.length; a++) {
      for (let b = a + 1; b < movable.length; b++) {
        const pa = pos.get(movable[a]!.id)!
        const pb = pos.get(movable[b]!.id)!
        const dx = pb.x - pa.x
        const dy = pb.y - pa.y
        const dist = Math.hypot(dx, dy)
        const minDist = discR * 0.15
        if (dist > 0.01 && dist < minDist) {
          const push = ((minDist - dist) / dist) * 0.045
          pa.x -= dx * push
          pa.y -= dy * push
          pb.x += dx * push
          pb.y += dy * push
        }
      }
    }
    for (const n of movable) {
      const p = pos.get(n.id)!
      const an = anchor.get(n.id)!
      p.x += (an.x - p.x) * 0.008
      p.y += (targetY(n) - p.y) * 0.055
      const ex = (p.x - cx) / discR
      const ey = (p.y - cy) / (discR * 0.6)
      const q = ex * ex + ey * ey
      if (q > 0.9) {
        const s = Math.sqrt(0.9 / q)
        p.x = cx + ex * s * discR
        p.y = cy + ey * s * discR * 0.6
      }
    }
  }
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (p !== undefined && n.kind !== "hub") {
      p.age = maxAt > minAt ? (n.atMs - minAt) / (maxAt - minAt) : 0.5
    }
  }
  return pos
}

const parseGraph = (hook: HTMLElement): FieldGraph => {
  try {
    const raw = hook.querySelector(".mindmap-data")?.textContent ?? ""
    const parsed = JSON.parse(raw) as FieldGraph
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) return parsed
  } catch { /* fall through to empty */ }
  return { nodes: [], edges: [] }
}

const KIND_RGB: Record<string, string> = {
  hub: PHOSPHOR,
  project: EMBER,
  knowledge: "240, 200, 120",
  asset: "230, 237, 243",
  recent: "200, 209, 217",
  subject: "167, 139, 250",
  chat: "45, 212, 191",
  memory: "224, 138, 150",
  journal: "186, 172, 224",
  door: "139, 148, 158",
}
const JOB_RGB = "96, 165, 250"
const JOB_DONE_RGB = "87, 201, 118"
const LABEL_KINDS = new Set(["hub", "project", "knowledge", "door", "job", "journal"])

interface Placed {
  readonly node: FieldNode
  x: number
  y: number
  /** Freshness 0..1 from the layout: brightness/size by recency. */
  readonly age: number
  readonly phase: number
}

export interface SimDot {
  ox: number
  oy: number
  vx: number
  vy: number
}

/**
 * One step of the organism's physics (2026-10-13). The baked layout
 * gives each node an anchor; the simulation lets it LIVE around that
 * anchor: a soft spring home, the shared breeze as a force, gentle
 * repulsion from close neighbours, and a tug toward the hovered node
 * along real edges — the graph leans in when you touch it. Offsets
 * clamp at 30px, so topology survives: flexible, never chaotic.
 */
export const stepFieldSim = (
  dots: Map<string, SimDot>,
  anchors: ReadonlyArray<Placed>,
  edges: ReadonlyArray<FieldEdge>,
  hoveredId: string | null,
  tMs: number,
  dtMs: number,
): void => {
  const dt = Math.max(0.25, Math.min(50, dtMs) / 16.667)
  const byId = new Map(anchors.map((p) => [p.node.id, p]))
  const get = (id: string): SimDot => {
    let d = dots.get(id)
    if (d === undefined) {
      d = { ox: 0, oy: 0, vx: 0, vy: 0 }
      dots.set(id, d)
    }
    return d
  }
  for (const p of anchors) {
    const d = get(p.node.id)
    d.vx += -d.ox * 0.011 * dt
    d.vy += -d.oy * 0.011 * dt
    d.vx += Math.sin(tMs * 0.00011 + p.y * 0.006 + p.phase) * 0.014 * dt
    d.vy += Math.cos(tMs * 0.00009 + p.x * 0.005 + p.phase * 1.3) * 0.009 * dt
  }
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const a = anchors[i]!
      const b = anchors[j]!
      const da = get(a.node.id)
      const db = get(b.node.id)
      const dx = b.x + db.ox - (a.x + da.ox)
      const dy = b.y + db.oy - (a.y + da.oy)
      const dist = Math.hypot(dx, dy)
      if (dist > 0.01 && dist < 42) {
        const f = ((42 - dist) / dist) * 0.0035 * dt
        da.vx -= dx * f
        da.vy -= dy * f
        db.vx += dx * f
        db.vy += dy * f
      }
    }
  }
  if (hoveredId !== null) {
    const hp = byId.get(hoveredId)
    const hd = dots.get(hoveredId)
    if (hp !== undefined && hd !== undefined) {
      const hx = hp.x + hd.ox
      const hy = hp.y + hd.oy
      for (const e of edges) {
        const other = e.a === hoveredId ? e.b : e.b === hoveredId ? e.a : null
        if (other === null) continue
        const op = byId.get(other)
        if (op === undefined) continue
        const od = get(other)
        const dx = hx - (op.x + od.ox)
        const dy = hy - (op.y + od.oy)
        const dist = Math.hypot(dx, dy) || 1
        od.vx += (dx / dist) * 0.028 * dt
        od.vy += (dy / dist) * 0.028 * dt
      }
    }
  }
  for (const d of dots.values()) {
    d.vx *= 0.94
    d.vy *= 0.94
    d.ox += d.vx * dt
    d.oy += d.vy * dt
    const m = Math.hypot(d.ox, d.oy)
    if (m > 30) {
      d.ox *= 30 / m
      d.oy *= 30 / m
    }
  }
}

interface MapSettings {
  readonly breeze: boolean
  readonly labels: boolean
}

const parseSettings = (hook: HTMLElement): MapSettings => {
  const d: MapSettings = { breeze: true, labels: true }
  const el = hook.querySelector(".mindmap-settings")
  if (el === null || el.textContent === null || el.textContent.trim() === "") return d
  try {
    const raw = JSON.parse(el.textContent) as Record<string, unknown>
    return {
      breeze: typeof raw["breeze"] === "boolean" ? raw["breeze"] : d.breeze,
      labels: typeof raw["labels"] === "boolean" ? raw["labels"] : d.labels,
    }
  } catch {
    return d
  }
}

const startEngine = (hook: HTMLElement): void => {
  let graph = parseGraph(hook)
  let settings = parseSettings(hook)
  const wallStart = Date.now()
  const canvas = document.createElement("canvas")
  hook.appendChild(canvas)
  const ctx = canvas.getContext("2d")
  if (ctx === null) return

  let width = 0
  let height = 0
  let layoutKey = ""
  let basePlaced: ReadonlyArray<Placed> = []
  const simDots = new Map<string, SimDot>()
  let prevT = 0
  const resize = (): void => {
    const rect = hook.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    width = Math.max(0, Math.floor(rect.width))
    height = Math.max(0, Math.floor(rect.height))
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Content slot for the dash editor: the ellipse inscription
    // fills the frame, so the widget's content box IS its frame
    // (fractions of the hook box: fx, fy, fw, fh).
    if (width > 0 && height > 0 && hook.dataset.content !== "0,0,1,1") {
      hook.dataset.content = "0,0,1,1"
    }
    layoutKey = ""
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(hook)
  // Live data (2026-10-13): the graph and settings ride hidden spans
  // the view re-renders when home data lands or a setting changes.
  // The engine starts ONCE per hook — on a cold start that is BEFORE
  // home data arrives, so without this watch it would draw the
  // empty fallback graph forever. (Exactly what froze the map,
  // invisibly, through a full UAT session.)
  let dataText = hook.querySelector(".mindmap-data")?.textContent ?? ""
  let settingsText = hook.querySelector(".mindmap-settings")?.textContent ?? ""
  console.warn(`[aimy] mindmap: engine start — ${graph.nodes.length} nodes, ${graph.edges.length} edges`)
  const spanWatch = new MutationObserver(() => {
    if (!canvas.isConnected) {
      spanWatch.disconnect()
      return
    }
    const nextData = hook.querySelector(".mindmap-data")?.textContent ?? ""
    if (nextData !== dataText) {
      dataText = nextData
      graph = parseGraph(hook)
      layoutKey = ""
      console.warn(`[aimy] mindmap: graph reloaded — ${graph.nodes.length} nodes, ${graph.edges.length} edges`)
    }
    const nextSettings = hook.querySelector(".mindmap-settings")?.textContent ?? ""
    if (nextSettings !== settingsText) {
      settingsText = nextSettings
      settings = parseSettings(hook)
      console.warn(`[aimy] mindmap: settings reloaded — breeze=${settings.breeze} labels=${settings.labels}`)
    }
  })
  spanWatch.observe(hook, { childList: true, subtree: true, characterData: true })
  // Cold-start refresh (2026-10-13): the one-shot field-refresh
  // dispatch races the subscriptions pump at boot — if the pump is
  // not listening yet, the event is gone and home data NEVER loads
  // (a full UAT session ran on the fallback dash, map empty, WorkOn
  // strip missing, exactly this way). Keep asking until the data
  // span exists; asking is idempotent (the pump folds both loads).
  if (dataText === "") {
    const refreshTimer = setInterval(() => {
      if (!canvas.isConnected || (hook.querySelector(".mindmap-data")?.textContent ?? "") !== "") {
        clearInterval(refreshTimer)
        return
      }
      console.warn("[aimy] mindmap: still no data — re-requesting home data")
      window.dispatchEvent(new CustomEvent("aimy:field-refresh"))
    }, 1500)
  }
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

  let mouse: { x: number; y: number } | null = null
  let hovered: Placed | null = null
  let downPos: { x: number; y: number } | null = null
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect()
    mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  })
  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect()
    downPos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  })
  canvas.addEventListener("pointerup", (e) => {
    const rect = canvas.getBoundingClientRect()
    const up = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const wasClick = downPos !== null && Math.hypot(up.x - downPos.x, up.y - downPos.y) < 6
    downPos = null
    if (!wasClick || hovered === null) return
    const n = hovered.node
    if (n.path !== undefined) {
      window.dispatchEvent(new CustomEvent("aimy:field-open", { detail: { path: n.path } }))
    } else if (n.kind === "project" && n.projectId !== undefined) {
      window.dispatchEvent(new CustomEvent("aimy:field-project", { detail: { id: n.projectId } }))
      window.dispatchEvent(new CustomEvent("aimy:field-panel", { detail: { panel: "projects" } }))
    } else if (n.panelTarget !== undefined) {
      window.dispatchEvent(new CustomEvent("aimy:field-panel", { detail: { panel: n.panelTarget } }))
    } else if (n.projectId !== undefined) {
      window.dispatchEvent(new CustomEvent("aimy:field-project", { detail: { id: n.projectId } }))
    }
  })
  canvas.addEventListener("pointerleave", () => {
    mouse = null
    downPos = null
  })

  const draw = (tMs: number): void => {
    if (width === 0 || height === 0) return
    ctx.clearRect(0, 0, width, height)
    const cx = width / 2
    const my = height / 2
    // Ellipse inscription (2026-10-13): the organism fills its frame
    // — on the dash the frame IS the content box, whitespace belongs
    // to the stage. The layout runs in unit disc space and maps onto
    // an ellipse inscribed in the hook, less a fixed 10px margin
    // the editor counts as the widget's own.
    const rx = Math.max(0, width / 2 - 10)
    const ry = Math.max(0, height / 2 - 10)
    if (rx > 40 && ry > 24 && graph.nodes.length > 0) {
      const key = `${width}x${height}`
      if (key !== layoutKey) {
        layoutKey = key
        const placed = layoutField(graph.nodes, graph.edges, 0, 0, 1)
        let pi = 0
        basePlaced = graph.nodes.map((node) => {
          const p = placed.get(node.id) ?? { x: 0, y: 0, age: 0.5 }
          return { node, x: cx + p.x * rx * 0.98, y: my + p.y * ry * 1.55, age: p.age, phase: (pi++ * 1.7) % (Math.PI * 2) }
        })
        simDots.clear()
      }
      // The living layer: continuous spring physics around the baked
      // anchors, plus a whisper of pointer parallax for depth.
      if (!reducedMotion && settings.breeze) {
        stepFieldSim(simDots, basePlaced, graph.edges, hovered?.node.id ?? null, tMs, prevT > 0 ? tMs - prevT : 16)
      }
      prevT = tMs
      const parX = mouse !== null ? ((mouse.x - width / 2) / Math.max(1, width)) * 7 : 0
      const parY = mouse !== null ? ((mouse.y - height / 2) / Math.max(1, height)) * 4 : 0
      const placedNow: ReadonlyArray<Placed> = basePlaced.map((pn) => {
        const s = simDots.get(pn.node.id)
        return { ...pn, x: pn.x + (s?.ox ?? 0) + parX, y: pn.y + (s?.oy ?? 0) + parY }
      })
      const byId = new Map(placedNow.map((pn) => [pn.node.id, pn]))
      hovered = null
      if (mouse !== null) {
        let best = 20
        for (const pn of placedNow) {
          const d = Math.hypot(pn.x - mouse.x, pn.y - mouse.y)
          if (d < best) {
            best = d
            hovered = pn
          }
        }
      }
      canvas.style.cursor =
        hovered !== null &&
        (hovered.node.path !== undefined || hovered.node.panelTarget !== undefined || hovered.node.projectId !== undefined)
          ? "pointer"
          : "default"
      // No backdrop (Kimler, 2026-10-13): the map paints no disc or
      // wash of its own — layers behind it (the globe) stay fully
      // visible. The organism is its nodes and edges; the rim
      // labels name the recency axis so the spatial encoding can
      // be read (fresh things live low, near the composer).
      ctx.font = "600 7px -apple-system, 'Segoe UI', sans-serif"
      ctx.textAlign = "right"
      ctx.fillStyle = "rgba(200, 209, 217, 0.38)"
      ctx.fillText("O L D E R", cx + rx * 0.97, my - ry * 0.78)
      ctx.fillText("R E C E N T", cx + rx * 0.97, my + ry * 0.86)
      ctx.textAlign = "start"
      for (const e of graph.edges) {
        const a = byId.get(e.a)
        const b = byId.get(e.b)
        if (a === undefined || b === undefined) continue
        const hot = hovered !== null && (hovered.node.id === e.a || hovered.node.id === e.b)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.setLineDash(e.style === "dotted" ? [2, 3] : [])
        ctx.strokeStyle = `rgba(${EMBER}, ${hot ? 0.38 : e.style === "dotted" ? 0.07 : 0.10})`
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.setLineDash([])
      }
      const nowWall = Date.now()
      for (const pn of placedNow) {
        const n = pn.node
        const isHot = hovered !== null && hovered.node.id === n.id
        if (n.kind === "job") {
          const done = n.jobState === "done"
          const rgb = done ? JOB_DONE_RGB : JOB_RGB
          const jr = done ? 12 : 15
          if (!done) {
            ctx.beginPath()
            ctx.arc(pn.x, pn.y, jr + 2.5 + 1.6 * Math.sin(tMs / 430), 0, Math.PI * 2)
            ctx.strokeStyle = `rgba(${JOB_RGB}, 0.35)`
            ctx.lineWidth = 1.5
            ctx.stroke()
          }
          ctx.beginPath()
          ctx.arc(pn.x, pn.y, jr, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${rgb}, ${done ? 0.30 : 0.26})`
          ctx.fill()
          ctx.strokeStyle = `rgba(${rgb}, 0.9)`
          ctx.lineWidth = 1.5
          ctx.stroke()
          if (done) {
            ctx.beginPath()
            ctx.moveTo(pn.x - 4.6, pn.y + 0.4)
            ctx.lineTo(pn.x - 1.4, pn.y + 3.6)
            ctx.lineTo(pn.x + 5.0, pn.y - 3.8)
            ctx.strokeStyle = "#d3f8db"
            ctx.lineWidth = 2
            ctx.lineCap = "round"
            ctx.lineJoin = "round"
            ctx.stroke()
          } else {
            const remaining = n.etaMs === null || n.etaMs === undefined ? null : n.etaMs - (nowWall - wallStart)
            ctx.font = "600 10px -apple-system, 'Segoe UI', sans-serif"
            ctx.textAlign = "center"
            ctx.textBaseline = "middle"
            ctx.fillStyle = "#dbeafe"
            ctx.fillText(formatEta(remaining), pn.x, pn.y)
            ctx.textAlign = "start"
            ctx.textBaseline = "alphabetic"
          }
        } else {
          const rgb = KIND_RGB[n.kind] ?? EMBER
          // Freshness is visible: newer nodes burn brighter and a
          // touch larger; older ones recede. The hub never fades.
          const sizeF = n.kind === "hub" ? 1 : 0.85 + 0.3 * pn.age
          const r = (n.kind === "hub" ? 4 : n.kind === "project" ? 5 : n.kind === "knowledge" ? 4.5 : 1.3 + n.weight * 0.55) * sizeF * (isHot ? 1.5 : 1)
          ctx.beginPath()
          ctx.arc(pn.x, pn.y, r + 3.5, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${rgb}, ${isHot ? 0.20 : 0.03 + 0.05 * pn.age})`
          ctx.fill()
          ctx.beginPath()
          ctx.arc(pn.x, pn.y, r, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${rgb}, ${isHot ? 0.95 : 0.22 + 0.45 * pn.age})`
          ctx.fill()
          if (n.kind === "project" || n.kind === "hub" || n.kind === "knowledge") {
            ctx.beginPath()
            ctx.arc(pn.x, pn.y, r + 1.8, 0, Math.PI * 2)
            ctx.strokeStyle = `rgba(${rgb}, 0.35)`
            ctx.lineWidth = 1
            ctx.stroke()
          }
        }
        // Tiny permanent labels on the structural nodes only.
        if (settings.labels && (LABEL_KINDS.has(n.kind) || n.weight >= 3)) {
          ctx.font = "9px -apple-system, 'Segoe UI', sans-serif"
          ctx.textAlign = "center"
          ctx.fillStyle = "rgba(230, 237, 243, 0.52)"
          ctx.fillText(n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label, pn.x, pn.y + (n.kind === "job" ? 27 : 15))
          ctx.textAlign = "start"
        }
      }
      // Hover card: name, conclusion, and a preview where one exists.
      if (hovered !== null) {
        const n = hovered.node
        const lines: Array<{ text: string; font: string; color: string }> = [
          { text: n.label, font: "600 12px -apple-system, 'Segoe UI', sans-serif", color: "#e6edf3" },
          { text: n.sub, font: "10px -apple-system, 'Segoe UI', sans-serif", color: "#8b949e" },
        ]
        if (n.preview !== undefined && n.preview !== "") {
          lines.push({ text: n.preview, font: "italic 10px -apple-system, 'Segoe UI', sans-serif", color: "#a8c0d8" })
        }
        let w = 0
        for (const l of lines) {
          ctx.font = l.font
          w = Math.max(w, ctx.measureText(l.text).width)
        }
        w += 16
        const hgt = 8 + lines.length * 12 + 4
        const lx = Math.min(Math.max(hovered.x - w / 2, 4), width - w - 4)
        const ly = Math.max(4, hovered.y - hgt - 14)
        ctx.fillStyle = "rgba(10, 13, 18, 0.85)"
        ctx.beginPath()
        ctx.roundRect(lx, ly, w, hgt, 6)
        ctx.fill()
        lines.forEach((l, li) => {
          ctx.font = l.font
          ctx.fillStyle = l.color
          ctx.fillText(l.text, lx + 8, ly + 15 + li * 12)
        })
      }
    }
  }

  if (reducedMotion) {
    draw(0)
    canvas.classList.add("on")
    return
  }
  let raf = 0
  let stopped = false
  const stop = (): void => {
    stopped = true
    cancelAnimationFrame(raf)
    ro.disconnect()
  }
  const tick = (now: number): void => {
    if (stopped) return
    if (!canvas.isConnected) {
      stop()
      return
    }
    if (!document.hidden) draw(now)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  requestAnimationFrame(() => canvas.classList.add("on"))
}

/** Boot entry (called from main.ts): watch for the hook, start engines. */
export const startMindMap = (): void => {
  const started = new WeakSet<HTMLElement>()
  const scan = (): void => {
    document.querySelectorAll<HTMLElement>(".mindmap-hook").forEach((hook) => {
      if (!started.has(hook)) {
        started.add(hook)
        // Cold start: no data span means home data has never
        // loaded this session — ask; the re-render replaces us.
        if (hook.querySelector(".mindmap-data") === null) {
          window.dispatchEvent(new CustomEvent("aimy:field-refresh"))
        }
        startEngine(hook)
      }
    })
  }
  scan()
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
}

