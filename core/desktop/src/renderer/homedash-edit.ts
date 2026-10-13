/**
 * HomeDash in-place editor (2026-10-13): until a Settings
 * configurator exists, the dash edits itself. Cmd+right-click the
 * dash background toggles edit mode: every widget gets an outline
 * and a badge (name, an EDITABLE priority = screen depth, live size
 * readout). Drag a widget to move it, pull its bottom-right corner
 * to resize — all in stage percentages. Esc (or Cmd+right-click
 * again) saves and leaves edit mode.
 *
 * Frames fit content (Kimler's principle, 2026-10-13): a widget's
 * outline is determined by its CONTENT, not its whitespace —
 * whitespace belongs to the stage, and arranging it is what the
 * editing is for. On entry, each layer is fitted to the content
 * slot its widget declares: canvas engines publish theirs as
 * fractions on their hook (`data-content`), and WorkOn's is the
 * measured bounds of its hero stack. Fits are held locally and
 * saved on exit with everything else.
 *
 * Edit surfaces live on a PLANE above the whole layer stack: the
 * priority orders how widgets RENDER, never whether they can be
 * edited. A buried widget's badge and drag surface stay reachable
 * no matter what covers the widget itself (a design rule, after a
 * session where WorkOn's frame and the hint chip between them
 * covered every other widget's controls).
 *
 * Nothing here persists directly: changes dispatch
 * `aimy:homedash-setting` DOM events, which the subscriptions pump
 * folds into the normal HomedashSettingChanged path — the same
 * settings.json store the Settings panel writes (priority + geoX /
 * geoY / geoW / geoH per widget). The future configurator reads and
 * writes the same values.
 *
 * The geometry math is pure and exported for the harness; all DOM
 * work happens inside startHomedashEdit().
 */

export interface Geo {
  x: number
  y: number
  w: number
  h: number
}

/** A widget's content bounds as fractions of its layer box. */
export interface SlotRect {
  fx: number
  fy: number
  fw: number
  fh: number
}

export const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * How far past the stage's top/bottom edge a frame may travel, in
 * pixels (Kimler, 2026-10-13): the point is placing a widget's
 * CONTENT precisely — the frame's edge is not the limit. The stage
 * itself never grows and never scrolls.
 */
export const OVER_TRAVEL_PX = 200

const clampN = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * Sanity band for stored geometry (percentages): sizes stay useful,
 * and positions may sit past an edge — a frame parked in the
 * over-travel range must round-trip through here untouched. The
 * precise travel limit lives in dragGeo, which knows the stage's
 * pixel height; this band only rejects absurd values.
 */
export const clampGeo = (g: Geo): Geo => {
  // The band must contain every value dragGeo can legally produce
  // — including a frame resized INTO the over-travel (height past
  // 100%) — or reading a layer back would shrink what the user set.
  const w = clampN(g.w, 5, 300)
  const h = clampN(g.h, 5, 300)
  return {
    x: clampN(g.x, -100, 200),
    y: clampN(g.y, -100, 200),
    w,
    h,
  }
}

/**
 * A drag in pixels becomes a geometry in stage percentages. Move
 * shifts the origin; resize grows width/height from the origin.
 */
export const dragGeo = (
  start: Geo,
  mode: "move" | "resize",
  dxPx: number,
  dyPx: number,
  stageW: number,
  stageH: number
): Geo => {
  const dx = (dxPx / Math.max(1, stageW)) * 100
  const dy = (dyPx / Math.max(1, stageH)) * 100
  // Vertical over-travel, in stage percent: frames may hang
  // OVER_TRAVEL_PX past the top or bottom edge; horizontally a
  // frame still stays fully on stage.
  const overY = (OVER_TRAVEL_PX / Math.max(1, stageH)) * 100
  if (mode === "resize") {
    // The origin is fixed when resizing: the size clamps to the
    // space remaining (plus over-travel at the bottom), it never
    // pushes the origin around.
    return {
      x: start.x,
      y: start.y,
      w: clampN(start.w + dx, 5, Math.max(5, 100 - start.x)),
      h: clampN(start.h + dy, 5, Math.max(5, 100 + overY - start.y)),
    }
  }
  return {
    x: clampN(start.x + dx, 0, 100 - start.w),
    y: clampN(start.y + dy, -overY, 100 + overY - start.h),
    w: start.w,
    h: start.h,
  }
}

/**
 * Fit a layer's frame to its content slot: the slot rect, expressed
 * in stage percentages, becomes the layer's new geometry (clamped
 * on stage). A full-frame slot (0,0,1,1) is the identity — widgets
 * whose content already fills their frame don't move.
 */
export const fitGeo = (layer: Geo, slot: SlotRect): Geo =>
  clampGeo({
    x: layer.x + slot.fx * layer.w,
    y: layer.y + slot.fy * layer.h,
    w: Math.max(5, slot.fw * layer.w),
    h: Math.max(5, slot.fh * layer.h),
  })

/** Priority is screen depth: an integer 1–1000. */
export const clampPriority = (n: number): number =>
  Number.isFinite(n) ? Math.min(1000, Math.max(1, Math.round(n))) : 500

interface LayerMeta {
  id: string
  name: string
  priority: number
}

export const startHomedashEdit = (): void => {
  let editing = false
  let stage: HTMLElement | null = null
  let plane: HTMLElement | null = null
  let hint: HTMLElement | null = null
  let exitTimer: ReturnType<typeof setTimeout> | null = null
  let drag: {
    layer: HTMLElement
    surface: HTMLElement
    widgetId: string
    mode: "move" | "resize"
    startX: number
    startY: number
    start: Geo
    sizeEl: HTMLElement | null
  } | null = null
  // Frames fitted to content on entry, held until exit saves them:
  // a mid-edit re-render would otherwise snap a fitted layer back
  // to the geometry the model still holds.
  const pendingFit = new Map<string, { layer: HTMLElement; from: Geo; to: Geo }>()

  const log = (msg: string) => console.warn(`[aimy] homedash-edit: ${msg}`)

  const dispatchSetting = (widgetId: string, key: string, value: string | number | boolean): void => {
    window.dispatchEvent(
      new CustomEvent("aimy:homedash-setting", {
        detail: JSON.stringify({ widgetId, key, value }),
      })
    )
  }

  const dispatchGeoDiff = (widgetId: string, from: Geo, to: Geo): void => {
    if (round1(from.x) !== round1(to.x)) dispatchSetting(widgetId, "geoX", round1(to.x))
    if (round1(from.y) !== round1(to.y)) dispatchSetting(widgetId, "geoY", round1(to.y))
    if (round1(from.w) !== round1(to.w)) dispatchSetting(widgetId, "geoW", round1(to.w))
    if (round1(from.h) !== round1(to.h)) dispatchSetting(widgetId, "geoH", round1(to.h))
  }

  const metaOf = (layer: HTMLElement): LayerMeta | null => {
    const el = layer.querySelector(".homedash-layer-meta")
    if (el === null || el.textContent === null) return null
    try {
      const m = JSON.parse(el.textContent) as Partial<LayerMeta>
      if (typeof m.id !== "string") return null
      return {
        id: m.id,
        name: typeof m.name === "string" ? m.name : m.id,
        priority: typeof m.priority === "number" ? m.priority : 500,
      }
    } catch {
      return null
    }
  }

  /** The CURRENT layer element for a widget (layers can be rebuilt). */
  const layerFor = (st: HTMLElement, id: string): HTMLElement | null => {
    let found: HTMLElement | null = null
    st.querySelectorAll<HTMLElement>(".homedash-layer").forEach((layer) => {
      if (found === null && metaOf(layer)?.id === id) found = layer
    })
    return found
  }

  const pct = (v: string): number => {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? n : Number.NaN
  }

  const geoOf = (layer: HTMLElement): Geo => {
    const g: Geo = {
      x: pct(layer.style.left),
      y: pct(layer.style.top),
      w: pct(layer.style.width),
      h: pct(layer.style.height),
    }
    return clampGeo({
      x: Number.isFinite(g.x) ? g.x : 0,
      y: Number.isFinite(g.y) ? g.y : 0,
      w: Number.isFinite(g.w) ? g.w : 100,
      h: Number.isFinite(g.h) ? g.h : 100,
    })
  }

  const applyGeo = (layer: HTMLElement, g: Geo): void => {
    layer.style.left = `${round1(g.x)}%`
    layer.style.top = `${round1(g.y)}%`
    layer.style.width = `${round1(g.w)}%`
    layer.style.height = `${round1(g.h)}%`
  }

  /** Mirror a layer's geometry onto its plane surface (guarded). */
  const setSurfaceGeo = (surface: HTMLElement, g: Geo): void => {
    const set = (prop: "left" | "top" | "width" | "height", v: number): void => {
      const s = `${round1(v)}%`
      if (surface.style[prop] !== s) surface.style[prop] = s
    }
    set("left", g.x)
    set("top", g.y)
    set("width", g.w)
    set("height", g.h)
  }

  const sizeText = (g: Geo): string => `${round1(g.w)}% × ${round1(g.h)}%`

  /**
   * The widget's declared content bounds, as fractions of its layer
   * box. Canvas engines publish theirs on their hook's data-content
   * attribute; WorkOn's content is its hero stack, measured live.
   * Null when the widget declares nothing (no fit).
   */
  const slotOf = (layer: HTMLElement): SlotRect | null => {
    const hookEl = layer.querySelector<HTMLElement>("[data-content]")
    const raw = hookEl?.dataset.content
    if (typeof raw === "string" && raw !== "") {
      const parts = raw.split(",").map((s) => Number.parseFloat(s))
      const [fx, fy, fw, fh] = parts as [number, number, number, number]
      if (
        parts.length === 4 &&
        parts.every((n) => Number.isFinite(n)) &&
        fx >= -0.05 && fy >= -0.05 && fw > 0.02 && fh > 0.02 && fw <= 1.05 && fh <= 1.05
      ) {
        return { fx, fy, fw, fh }
      }
    }
    const hero = layer.querySelector<HTMLElement>(".workon-hero")
    if (hero !== null && hero.children.length > 0) {
      const box = layer.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) {
        let left = Number.POSITIVE_INFINITY
        let top = Number.POSITIVE_INFINITY
        let right = Number.NEGATIVE_INFINITY
        let bottom = Number.NEGATIVE_INFINITY
        for (const child of Array.from(hero.children)) {
          const r = (child as HTMLElement).getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          left = Math.min(left, r.left)
          top = Math.min(top, r.top)
          right = Math.max(right, r.right)
          bottom = Math.max(bottom, r.bottom)
        }
        if (Number.isFinite(left) && right > left && bottom > top) {
          return {
            fx: (left - box.left) / box.width,
            fy: (top - box.top) / box.height,
            fw: (right - left) / box.width,
            fh: (bottom - top) / box.height,
          }
        }
      }
    }
    return null
  }

  const geoDiffers = (a: Geo, b: Geo): boolean =>
    Math.abs(a.x - b.x) > 0.15 || Math.abs(a.y - b.y) > 0.15 ||
    Math.abs(a.w - b.w) > 0.15 || Math.abs(a.h - b.h) > 0.15

  /** Fit every layer on the stage to its declared content slot. */
  const fitPass = (st: HTMLElement): void => {
    st.querySelectorAll<HTMLElement>(".homedash-layer").forEach((layer) => {
      const meta = metaOf(layer)
      if (meta === null) return
      const slot = slotOf(layer)
      if (slot === null) return
      const current = geoOf(layer)
      const fitted = fitGeo(current, slot)
      if (!geoDiffers(current, fitted)) return
      const held = pendingFit.get(meta.id)
      pendingFit.set(meta.id, {
        layer,
        from: held !== undefined ? held.from : current,
        to: fitted,
      })
      applyGeo(layer, fitted)
      log(`${meta.id}: frame fitted to content — ${sizeText(fitted)} at ${round1(fitted.x)}%, ${round1(fitted.y)}%`)
    })
  }

  /** The edit plane: one per stage, above every layer (z in CSS). */
  const ensurePlane = (st: HTMLElement): HTMLElement => {
    if (plane !== null && plane.parentElement === st) return plane
    plane = document.createElement("div")
    plane.className = "homedash-edit-plane"
    st.appendChild(plane)
    return plane
  }

  const buildSurface = (pl: HTMLElement, layer: HTMLElement, meta: LayerMeta): HTMLElement => {
    const surface = document.createElement("div")
    surface.className = "homedash-edit-surface"
    surface.dataset.widgetId = meta.id
    const badge = document.createElement("div")
    badge.className = "homedash-edit-badge"
    const name = document.createElement("span")
    name.className = "hd-name"
    name.textContent = meta.name
    const depthLabel = document.createElement("span")
    depthLabel.textContent = "depth"
    const input = document.createElement("input")
    input.type = "number"
    input.min = "1"
    input.max = "1000"
    input.step = "1"
    input.value = String(meta.priority)
    input.dataset.original = String(meta.priority)
    input.title = "Priority = screen depth (1–1000, higher on top)"
    input.addEventListener("change", () => {
      const next = clampPriority(Number.parseFloat(input.value))
      input.value = String(next)
      const owner = stage !== null ? layerFor(stage, meta.id) : null
      const current = (owner !== null ? metaOf(owner)?.priority : undefined) ?? meta.priority
      if (next !== current) {
        log(`${meta.id}: priority ${current} → ${next}`)
        dispatchSetting(meta.id, "priority", next)
      }
    })
    const size = document.createElement("span")
    size.className = "hd-size"
    size.textContent = sizeText(geoOf(layer))
    badge.append(name, depthLabel, input, size)
    const handle = document.createElement("div")
    handle.className = "homedash-edit-handle"
    handle.title = "Drag to resize"
    surface.append(badge, handle)
    surface.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).tagName === "INPUT") return
      if (stage === null) return
      // Resolve the layer NOW: surfaces live on the plane and
      // outlive layer rebuilds, so a captured element can be stale.
      const owner = layerFor(stage, meta.id)
      if (owner === null) return
      // First touch commits the entry fit. The fit is a proposal
      // until the user grabs the widget; from here their geometry
      // wins, and the held fit must not snap the layer back under
      // the drag (it did — the observer re-applied it on every
      // badge-text mutation, gluing fitted widgets in place).
      const heldFit = pendingFit.get(meta.id)
      if (heldFit !== undefined) {
        pendingFit.delete(meta.id)
        dispatchGeoDiff(meta.id, heldFit.from, heldFit.to)
        log(`${meta.id}: entry fit committed on first grab`)
      }
      const mode = (e.target as HTMLElement).closest(".homedash-edit-handle") !== null ? "resize" : "move"
      drag = {
        layer: owner,
        surface,
        widgetId: meta.id,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        start: geoOf(owner),
        sizeEl: size,
      }
      e.preventDefault()
    })
    pl.appendChild(surface)
    setSurfaceGeo(surface, geoOf(layer))
    return surface
  }

  const buildOverlays = (st: HTMLElement): void => {
    const pl = ensurePlane(st)
    st.querySelectorAll<HTMLElement>(".homedash-layer").forEach((layer) => {
      const meta = metaOf(layer)
      if (meta === null) return
      // A fitted frame lives only in pendingFit until exit; keep the
      // layer at the fitted geometry across re-renders.
      const held = pendingFit.get(meta.id)
      if (held !== undefined) {
        held.layer = layer
        applyGeo(layer, held.to)
      }
      let surface: HTMLElement | null = null
      pl.querySelectorAll<HTMLElement>(".homedash-edit-surface").forEach((s) => {
        if (s.dataset.widgetId === meta.id) surface = s
      })
      if (surface === null) {
        buildSurface(pl, layer, meta)
        return
      }
      const surf: HTMLElement = surface
      // Keep a surviving badge honest: size from the layer's live
      // geometry, priority from the layer's live meta (never yank a
      // value out from under a typing user). Every write MUST be
      // change-guarded: this pass runs from a MutationObserver, and
      // an unguarded textContent assignment is itself a mutation —
      // write, observe, write again is an endless microtask loop
      // that wedges the renderer solid (it froze the app 2026-10-13).
      setSurfaceGeo(surf, geoOf(layer))
      const sizeEl = surf.querySelector<HTMLElement>(".hd-size")
      if (sizeEl !== null) {
        const nextSize = sizeText(geoOf(layer))
        if (sizeEl.textContent !== nextSize) sizeEl.textContent = nextSize
      }
      const input = surf.querySelector<HTMLInputElement>("input")
      if (input !== null && document.activeElement !== input && input.value !== String(meta.priority)) {
        input.value = String(meta.priority)
        input.dataset.original = String(meta.priority)
      }
    })
    // Drop surfaces whose widget has left the dash.
    const live = new Set<string>()
    st.querySelectorAll<HTMLElement>(".homedash-layer").forEach((layer) => {
      const m = metaOf(layer)
      if (m !== null) live.add(m.id)
    })
    pl.querySelectorAll<HTMLElement>(".homedash-edit-surface").forEach((s) => {
      if (s.dataset.widgetId === undefined || !live.has(s.dataset.widgetId)) s.remove()
    })
  }

  const teardown = (): void => {
    if (plane !== null) {
      plane.remove()
      plane = null
    }
    document.querySelectorAll(".homedash-edit-surface").forEach((el) => el.remove())
    if (hint !== null) {
      hint.remove()
      hint = null
    }
    if (stage !== null) stage.classList.remove("homedash-editing")
  }

  const enter = (st: HTMLElement): void => {
    editing = true
    stage = st
    pendingFit.clear()
    st.classList.add("homedash-editing")
    fitPass(st)
    buildOverlays(st)
    hint = document.createElement("div")
    hint.className = "homedash-edit-hint"
    hint.textContent = "Editing the dash — drag to move, pull the corner to resize, Esc when done"
    st.appendChild(hint)
    log("edit mode on")
  }

  const exit = (): void => {
    if (!editing) return
    editing = false
    drag = null
    // Save-and-exit (Kimler's spec): every drag already saved on
    // release; flush what entry fitted to content and any priority
    // that was typed but never committed (no blur/Enter yet), so
    // leaving edit mode loses nothing.
    pendingFit.forEach((heldFit, id) => {
      if (geoDiffers(heldFit.from, heldFit.to)) {
        log(`${id}: fitted frame saved — ${sizeText(heldFit.to)} at ${round1(heldFit.to.x)}%, ${round1(heldFit.to.y)}%`)
        dispatchGeoDiff(id, heldFit.from, heldFit.to)
      }
    })
    pendingFit.clear()
    document.querySelectorAll<HTMLElement>(".homedash-edit-surface").forEach((surface) => {
      const id = surface.dataset.widgetId
      const input = surface.querySelector("input")
      if (id === undefined || input === null) return
      const next = clampPriority(Number.parseFloat(input.value))
      if (String(next) !== (input.dataset.original ?? "")) {
        log(`${id}: priority ${input.dataset.original ?? "?"} → ${next} (flushed on exit)`)
        dispatchSetting(id, "priority", next)
      }
    })
    teardown()
    stage = null
    log("edit mode off")
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      const target = e.target as HTMLElement | null
      const st = target !== null && typeof target.closest === "function"
        ? (target.closest(".homedash-stage") as HTMLElement | null)
        : null
      if (e.metaKey && st !== null) {
        e.preventDefault()
        // The gesture toggles: first Cmd+right-click enters, the
        // next one saves and leaves — regardless of which stage
        // element the re-renders have swapped in underneath.
        if (editing) exit()
        else enter(st)
      } else if (editing && st !== null) {
        // No native menu over the dash while it is being edited.
        e.preventDefault()
      }
    },
    true
  )

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editing) exit()
  })

  document.addEventListener("pointermove", (e) => {
    if (drag === null || stage === null) return
    const rect = stage.getBoundingClientRect()
    const next = dragGeo(drag.start, drag.mode, e.clientX - drag.startX, e.clientY - drag.startY, rect.width, rect.height)
    applyGeo(drag.layer, next)
    setSurfaceGeo(drag.surface, next)
    if (drag.sizeEl !== null) drag.sizeEl.textContent = sizeText(next)
  })

  document.addEventListener("pointerup", () => {
    if (drag === null) return
    const done = drag
    drag = null
    const final = geoOf(done.layer)
    if (done.mode === "move") {
      if (round1(final.x) !== round1(done.start.x)) dispatchSetting(done.widgetId, "geoX", round1(final.x))
      if (round1(final.y) !== round1(done.start.y)) dispatchSetting(done.widgetId, "geoY", round1(final.y))
      log(`${done.widgetId}: moved to ${round1(final.x)}%, ${round1(final.y)}%`)
    } else {
      if (round1(final.w) !== round1(done.start.w)) dispatchSetting(done.widgetId, "geoW", round1(final.w))
      if (round1(final.h) !== round1(done.start.h)) dispatchSetting(done.widgetId, "geoH", round1(final.h))
      log(`${done.widgetId}: resized to ${round1(final.w)}% × ${round1(final.h)}%`)
    }
  })

  // Follow the stage across re-renders: a save reloads the dash and
  // foldkit rebuilds the layers — adopt the fresh stage instead of
  // dropping out of edit mode; exit only when no dash exists at all.
  const observer = new MutationObserver(() => {
    if (!editing) return
    if (stage !== null && document.contains(stage)) {
      buildOverlays(stage)
      return
    }
    const next = document.querySelector<HTMLElement>(".homedash-stage")
    if (next !== null) {
      stage = next
      next.classList.add("homedash-editing")
      buildOverlays(next)
      if (hint === null || !next.contains(hint)) {
        hint = document.createElement("div")
        hint.className = "homedash-edit-hint"
        hint.textContent = "Editing the dash — drag to move, pull the corner to resize, Esc when done"
        next.appendChild(hint)
      }
      return
    }
    if (exitTimer === null) {
      exitTimer = setTimeout(() => {
        exitTimer = null
        if (editing && document.querySelector(".homedash-stage") === null) exit()
      }, 300)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}
