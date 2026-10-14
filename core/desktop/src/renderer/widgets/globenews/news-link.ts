/**
 * widgets/globenews/news-link.ts — the feed↔globe link (2026-10-13).
 *
 * Owns the SELECTION between the GlobeNews feed component and the
 * globe's event dots. Selecting either side draws a cyan line
 * across the dash stage to the other:
 *   feed row click → line to the dot (and the event is marked
 *     read: `aimy:news-read`);
 *   globe dot pick (the engine's `aimy:news-select`) → line to
 *     the row, which scrolls into view.
 * The globe turns, so the line tracks per frame: the engine
 * publishes dot positions on its hook (dataset.dots, HOOK CSS
 * px — the hook's own coordinate system, wherever the canvas
 * element itself sits); this module converts to stage
 * coordinates and draws on an
 * SVG overlay above the widget layers (z 1500, below the edit
 * plane's 2000). The line STAYS CONNECTED (Kimler, 2026-10-13):
 * when the event rotates to the far side, the line pins to the
 * globe's limb at the event's bearing — a hollow marker rides the
 * rim and meets the dot exactly as it emerges. Esc, a click on
 * the stage background, or re-clicking the selected row clears
 * the selection. A feed click also opens the article in the
 * drawer (`aimy:news-open`).
 *
 * Renderer-owned DOM module (the mermaid.ts pattern): no foldkit
 * messages, no IPC — read-marking rides the DOM event channel.
 */

interface DotPos {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly v: number
}

let selectedId: string | null = null
let overlay: SVGSVGElement | null = null
let raf = 0

const stageEl = (): HTMLElement | null => document.querySelector<HTMLElement>(".homedash-stage")
const hookEl = (): HTMLElement | null => document.querySelector<HTMLElement>(".mirror-field-hook")

const rowFor = (id: string): HTMLElement | null => {
  for (const row of document.querySelectorAll<HTMLElement>(".news-item")) {
    if (row.querySelector(".news-item-id")?.textContent === id) return row
  }
  return null
}

const parseDots = (hook: HTMLElement): ReadonlyArray<DotPos> => {
  try {
    const raw = JSON.parse(hook.dataset.dots ?? "[]") as Array<DotPos>
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/** Disc geometry the engine publishes (hook CSS px): cx, cy, R. */
const parseDisc = (hook: HTMLElement): { cx: number; cy: number; R: number } | null => {
  const parts = (hook.dataset.disc ?? "").split(",").map((s) => Number(s))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return { cx: parts[0]!, cy: parts[1]!, R: parts[2]! }
}

/**
 * The limb point at a dot's bearing (pure; tested): from the disc
 * centre toward the dot's projected position, out to the rim.
 * This is where a far-side event "is" from the viewer's seat —
 * the line stays connected to the location as the globe turns.
 */
export const limbEndpoint = (
  center: { x: number; y: number },
  R: number,
  dot: { x: number; y: number }
): { x: number; y: number } => {
  const dx = dot.x - center.x
  const dy = dot.y - center.y
  const len = Math.hypot(dx, dy)
  if (len < 0.001) return { x: center.x + R, y: center.y }
  return { x: center.x + (dx / len) * R, y: center.y + (dy / len) * R }
}

const ensureOverlay = (stage: HTMLElement): SVGSVGElement => {
  if (overlay !== null && overlay.isConnected && overlay.parentElement === stage) return overlay
  overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  overlay.setAttribute("class", "news-link-overlay")
  overlay.innerHTML =
    `<line class="news-link-line" stroke="#22d3ee" stroke-width="1.5" opacity="0.9" stroke-dasharray="1 0"/>` +
    `<circle class="news-link-dot" r="3" fill="#22d3ee"/>` +
    `<circle class="news-link-rowdot" r="2.5" fill="#22d3ee"/>`
  stage.appendChild(overlay)
  return overlay
}

const setPartsVisible = (svg: SVGSVGElement, visible: boolean): void => {
  const display = visible ? "" : "none"
  for (const el of svg.querySelectorAll("line, circle")) {
    if ((el as SVGElement).style.display !== display) (el as SVGElement).style.display = display
  }
}

/**
 * Line endpoints in stage coordinates (pure; tested): the row end
 * anchors on the row edge nearest the globe hook; the dot end is
 * the HOOK origin plus the engine's hook-space position. The
 * canvas element's rect must NOT anchor this: the globe canvas
 * covers the whole main column while the engine publishes in
 * hook coordinates — anchoring on the canvas put the line's end
 * in empty space the moment the cover changed (2026-10-13).
 */
export const linkEndpoints = (
  stage: { left: number; top: number },
  row: { left: number; right: number; top: number; height: number },
  hook: { left: number; top: number; width: number },
  dot: { x: number; y: number }
): { x1: number; y1: number; x2: number; y2: number } => {
  const hookCx = hook.left + hook.width / 2
  const rowCx = row.left + (row.right - row.left) / 2
  const x1 = (rowCx < hookCx ? row.right : row.left) - stage.left
  return {
    x1,
    y1: row.top + row.height / 2 - stage.top,
    x2: hook.left - stage.left + dot.x,
    y2: hook.top - stage.top + dot.y,
  }
}

const syncRowClass = (): void => {
  for (const row of document.querySelectorAll<HTMLElement>(".news-item")) {
    const id = row.querySelector(".news-item-id")?.textContent
    const want = id !== undefined && id === selectedId
    if (row.classList.contains("news-selected") !== want) row.classList.toggle("news-selected", want)
  }
}

/**
 * Director features (Threat Channel §5): while the camera is on a
 * threat, its feed row glows. Rows are foldkit-rendered and get
 * replaced on re-renders mid-feature, so the class is re-applied
 * on a short interval for the feature's life — bounded and
 * self-terminating, never a permanent poll.
 */
let featuredId: string | null = null
let featuredTimer: ReturnType<typeof setInterval> | undefined

const syncFeaturedClass = (): void => {
  for (const row of document.querySelectorAll<HTMLElement>(".news-item")) {
    const id = row.querySelector(".news-item-id")?.textContent
    const want = id !== undefined && id === featuredId
    if (row.classList.contains("news-featured") !== want) row.classList.toggle("news-featured", want)
  }
}

const setFeatured = (id: string | null): void => {
  featuredId = id
  syncFeaturedClass()
  if (featuredTimer !== undefined) {
    clearInterval(featuredTimer)
    featuredTimer = undefined
  }
  if (id !== null) {
    featuredTimer = setInterval(syncFeaturedClass, 400)
    const row = rowFor(id)
    try {
      row?.scrollIntoView({ block: "nearest" })
    } catch {
      // Older engines: the glow alone still lands.
    }
  }
}

const tick = (): void => {
  raf = 0
  if (selectedId === null) return
  raf = requestAnimationFrame(tick)
  const stage = stageEl()
  const hook = hookEl()
  const row = rowFor(selectedId)
  if (stage === null || hook === null || row === null) {
    if (overlay !== null && overlay.isConnected) setPartsVisible(overlay, false)
    return
  }
  const svg = ensureOverlay(stage)
  syncRowClass()
  const canvas = hook.querySelector("canvas")
  const dot = parseDots(hook).find((d) => d.id === selectedId)
  if (canvas === null || dot === undefined) {
    setPartsVisible(svg, false)
    return
  }
  const sr = stage.getBoundingClientRect()
  const rr = row.getBoundingClientRect()
  const hr = hook.getBoundingClientRect()
  const p = linkEndpoints(
    { left: sr.left, top: sr.top },
    { left: rr.left, right: rr.right, top: rr.top, height: rr.height },
    { left: hr.left, top: hr.top, width: hr.width },
    dot
  )
  // The dot end: on the dot while it faces us; on the LIMB at the
  // event's bearing while it is around the back — the line stays
  // connected to the location as the globe turns (Kimler,
  // 2026-10-13). The rim marker goes hollow so "behind the earth,
  // this way" reads at a glance.
  let x2 = p.x2
  let y2 = p.y2
  let hollow = false
  if (dot.v !== 1) {
    const disc = parseDisc(hook)
    if (disc === null) {
      setPartsVisible(svg, false)
      return
    }
    const center = { x: hr.left - sr.left + disc.cx, y: hr.top - sr.top + disc.cy }
    const limb = limbEndpoint(center, disc.R, { x: p.x2, y: p.y2 })
    x2 = limb.x
    y2 = limb.y
    hollow = true
  }
  const line = svg.querySelector("line")
  const dotC = svg.querySelector(".news-link-dot")
  const rowC = svg.querySelector(".news-link-rowdot")
  if (line !== null) {
    line.setAttribute("x1", String(p.x1))
    line.setAttribute("y1", String(p.y1))
    line.setAttribute("x2", String(x2))
    line.setAttribute("y2", String(y2))
  }
  if (dotC !== null) {
    dotC.setAttribute("cx", String(x2))
    dotC.setAttribute("cy", String(y2))
    const wantFill = hollow ? "none" : "#22d3ee"
    if (dotC.getAttribute("fill") !== wantFill) dotC.setAttribute("fill", wantFill)
    if (hollow) {
      dotC.setAttribute("stroke", "#22d3ee")
      dotC.setAttribute("stroke-width", "1.5")
    } else if (dotC.hasAttribute("stroke")) {
      dotC.removeAttribute("stroke")
    }
  }
  if (rowC !== null) {
    rowC.setAttribute("cx", String(p.x1))
    rowC.setAttribute("cy", String(p.y1))
  }
  setPartsVisible(svg, true)
}

const startLoop = (): void => {
  if (raf === 0) raf = requestAnimationFrame(tick)
}

const select = (id: string, origin: "feed" | "globe"): void => {
  selectedId = id
  syncRowClass()
  if (origin === "globe") {
    rowFor(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }
  console.warn(`[aimy] globenews link: selected ${id} (from ${origin})`)
  startLoop()
}

const clear = (why: string): void => {
  if (selectedId === null) return
  console.warn(`[aimy] globenews link: cleared (${why})`)
  const id = selectedId
  selectedId = null
  syncRowClass()
  if (overlay !== null && overlay.isConnected) setPartsVisible(overlay, false)
  // The globe's director holds its camera on the selection;
  // it must hear the lift or the camera stays parked.
  window.dispatchEvent(new CustomEvent("aimy:news-clear", { detail: JSON.stringify({ id }) }))
}

/** Boot entry (called from main.ts): listeners only; the overlay is lazy. */
export const startNewsLink = (): void => {
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement
    const row = typeof t.closest === "function" ? t.closest<HTMLElement>(".news-item") : null
    if (row !== null) {
      const id = row.querySelector(".news-item-id")?.textContent
      if (id !== undefined && id !== "") {
        if (id === selectedId) {
          clear("row re-clicked")
        } else {
          select(id, "feed")
          window.dispatchEvent(
            new CustomEvent("aimy:news-read", { detail: JSON.stringify({ id }) })
          )
          window.dispatchEvent(
            new CustomEvent("aimy:news-open", { detail: JSON.stringify({ id }) })
          )
        }
      }
      return
    }
    // A click on the stage background (not a canvas, not the feed)
    // clears. Canvas clicks are the globe's own business (grabs
    // and dot picks), so drags never clear by accident.
    if (selectedId !== null && (t.classList?.contains("homedash-stage") || t.classList?.contains("homedash-layer"))) {
      clear("stage background")
    }
  })
  window.addEventListener("aimy:news-select", (e) => {
    try {
      const detail = JSON.parse((e as CustomEvent).detail as string) as { id?: unknown }
      if (typeof detail.id === "string" && detail.id !== "") select(detail.id, "globe")
    } catch {
      // Malformed event ignored.
    }
  })
  window.addEventListener("aimy:news-feature", (e) => {
    try {
      const detail = JSON.parse((e as CustomEvent).detail as string) as { id?: unknown }
      if (typeof detail.id === "string" && detail.id !== "") setFeatured(detail.id)
    } catch {
      // Malformed event ignored.
    }
  })
  window.addEventListener("aimy:news-feature-end", () => setFeatured(null))
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clear("escape")
  })
}
