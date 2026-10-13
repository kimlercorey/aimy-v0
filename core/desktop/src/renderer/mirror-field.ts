/**
 * mirror-field.ts — GlobeNews: the vector earth (2026-10-13).
 *
 * A dotted earth from real coastlines (public-domain country
 * outlines rasterised at 120×60), phosphor above the horizon, its
 * ember reflection warped below — the outer world, spinning
 * slowly, wrapped in a cyan rim glow. GRABBABLE: drag to
 * reposition the spin and set the tilt; release and it keeps
 * turning, fling inertia easing back to the base rate.
 *
 * A HomeDash widget engine: it mounts on .mirror-field-hook
 * inside the dash stage and reads its settings (spin, density,
 * glow, tilt) from the hook's hidden .mirror-field-settings span —
 * values the widget declared in its manifest and the user set in
 * Settings. Renderer-owned DOM effect (the mermaid.ts pattern).
 * Guardrails: loop dies with the element, pauses when hidden,
 * reduced motion gets one static frame (drag still re-frames).
 */
// ── Pure geometry (unit-tested from the harness) ────────────────────

export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export const rotateY = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }
}

export const rotateX = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c }
}

export const rotateZ = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z }
}

/** Perspective projection (y-up world → y-down screen; front is -z). */
export const project = (
  v: Vec3,
  cx: number,
  cy: number,
  scale: number,
  focal: number,
): { readonly x: number; readonly y: number } => {
  const k = focal / (focal + v.z)
  return { x: cx + v.x * scale * k, y: cy - v.y * scale * k }
}

/** Mirror a screen y across a horizontal axis (the horizon). */
export const reflectY = (y: number, axis: number): number => 2 * axis - y

// ── Land mask ───────────────────────────────────────────────────────
// Coastlines: public-domain country outlines (Natural Earth via
// johan/world.geo.json) rasterised to a 120×60 equirectangular grid,
// one bit per cell, base64. Stylised at this resolution by design.

export const LAND_W = 120
export const LAND_H = 60
const LAND_MASK_B64 =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD////wAAAAAQAAAAAAAD/////gH8PAA/AAAAAAAf/+///AD4A+B/4H4A" +
  "AAA//+D//AAABx///zwAh/////x/+AA/h///////7////78/7wD///////////////4/HwP/////////H////P4cAAf/////////" +
  "D+///H8AADf////////4B4H///+AAHP///////HgAAH////AAP////////HAAAB////gAD////////gAAAA////gAD////////AA" +
  "AAA///4AAP/9//////gAAAA///gAAP///////zAAAAA///AAAP///////2AAAAAf/+AAAH+b////++AAAAAP/8IAAP//////+YAA" +
  "AAAH/+AAAf//////+AAAAAAD8OAAA///////+AAAAwAB8+AAA////z//+AAAAYAA/34AA////x//yAAAAAAAf64AA////g8fmAAA" +
  "AAAAB4gAA////A4PjAAAAAAAAf8AA////AYPngAAAAAAAP/AAf//+AcPPgAAAAAAAD/gAP//+AIedAAAAAAAAH/wAAH/8AAO/gAA" +
  "AAAAAH/+AAP/4AAH//IAAAAAAP//gAH/wAADf/8AAAAAAP//gAD/wAAB/v/AAAAAAH//gAD/wAAAPdZgAAAAAD//AAD/2AAAB9gQ" +
  "gAAAAD//AAH/+AAAD/gRAAAAAA/+AAH/uAAAP/wxAAAAAA/+AAD/MAAAf/4wAAAAAA/4AAD/MAAAf/8AAAAAAA/wAAB+AAAAP/8A" +
  "AAAAAA/wAAB+AAAAP/8AAAAAAB/gAAA8AAAAPP4GAAAAAB/AAAAAAAAAAD4HAAAAAB4AAAAAAAAAAAwHAAAAAB4AAAAAAAAAAAwM" +
  "AAAAAD4AAAAAAAAAAAAYAAAAAD4AAAAAADAAAAAAAAAAAD2AAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAABgACQEAAAAAAAA8AAAABf/P///8AAAAAcD8AAP/////////8AAf/f/8AA//////////8" +
  "Af////4I///////////gB//////8///////////wEf/////////////////4////////////////////AAAAAAAAAAAAAAAAAAAA"

let landBits: Uint8Array | null = null
const bits = (): Uint8Array => {
  if (landBits === null) {
    const bin = atob(LAND_MASK_B64)
    landBits = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) landBits[i] = bin.charCodeAt(i)
  }
  return landBits
}

export const landAt = (lon: number, lat: number): boolean => {
  const x = Math.min(LAND_W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * LAND_W)))
  const y = Math.min(LAND_H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * LAND_H)))
  const idx = y * LAND_W + x
  return (bits()[idx >> 3]! & (1 << (7 - (idx & 7)))) !== 0
}

export interface GlobePoint {
  readonly vec: Vec3
  readonly lon: number
  readonly lat: number
}

/** Land points on the sphere, near-even density, deterministic.
 * Step 1.7° ≈ double the density of the original 2.4° sampling
 * (Kimler, 2026-10-13) — about five thousand points. */
export const buildGlobePoints = (stepDeg = 1.7): ReadonlyArray<GlobePoint> => {
  const pts: Array<GlobePoint> = []
  let row = 0
  for (let lat = -57; lat <= 84; lat += stepDeg, row++) {
    const phi = (lat * Math.PI) / 180
    const lonStep = stepDeg / Math.max(0.35, Math.cos(phi))
    const offset = row % 2 === 0 ? 0 : lonStep / 2
    for (let lon = -180 + offset; lon < 180; lon += lonStep) {
      if (!landAt(lon, lat)) continue
      const lam = (lon * Math.PI) / 180
      pts.push({
        vec: {
          x: Math.cos(phi) * Math.sin(lam),
          y: Math.sin(phi),
          z: -Math.cos(phi) * Math.cos(lam),
        },
        lon,
        lat,
      })
    }
  }
  return pts
}

/** The user's home (Tucson, AZ) — the field's one fixed star. */
export const HOME = { lon: -110.9, lat: 32.2 } as const


interface GlobeSettings {
  readonly spinMs: number
  readonly density: string
  readonly glowPx: number
  readonly tiltDeg: number
}

const parseSettings = (hook: HTMLElement): GlobeSettings => {
  const d: GlobeSettings = { spinMs: SPIN_MS, density: "rich", glowPx: 20, tiltDeg: -24 }
  const el = hook.querySelector(".mirror-field-settings")
  if (el === null || el.textContent === null || el.textContent.trim() === "") return d
  try {
    const raw = JSON.parse(el.textContent) as Record<string, unknown>
    return {
      spinMs: typeof raw["spinMinutes"] === "number" ? Math.max(10_000, raw["spinMinutes"] * 60_000) : d.spinMs,
      density: typeof raw["density"] === "string" ? raw["density"] : d.density,
      glowPx: typeof raw["glowPx"] === "number" ? raw["glowPx"] : d.glowPx,
      tiltDeg: typeof raw["tiltDeg"] === "number" ? raw["tiltDeg"] : d.tiltDeg,
    }
  } catch {
    return d
  }
}

// ── Canvas engine ───────────────────────────────────────────────────

const SPIN_MS = 120_000
const HOME_SPIN = (-110.9 * Math.PI) / 180 // Americas facing us (harness-verified sign)
const LEAN = -0.16
/**
 * Default tilt: rotateX(θ) centres the disc on latitude −θ, so
 * −0.42 rad centres ~24°N — the USA stays in the visible band
 * through the whole rotation instead of riding the top limb.
 */
export const DEFAULT_TILT = -0.42
export const TILT_MIN = -1.05
export const TILT_MAX = 0.4
/** The latitude at the centre of the visible disc for a tilt. */
export const discCenterLatitude = (tilt: number): number => (-tilt * 180) / Math.PI
/**
 * Grab math (pure): dragging right carries the surface with the
 * cursor (spin decreases per rotateY's convention); dragging down
 * pulls the front face down, tipping the view northward (tilt
 * decreases). Tilt is clamped to a sane band.
 */
export const applyDrag = (
  spin: number,
  tilt: number,
  dx: number,
  dy: number,
  radius: number,
): { spin: number; tilt: number } => ({
  spin: spin - dx * (Math.PI / Math.max(60, radius)),
  tilt: Math.min(TILT_MAX, Math.max(TILT_MIN, tilt - dy * 0.005)),
})
const PHOSPHOR = "0, 255, 65"
const EMBER = "232, 180, 74"
export interface GlobeFrame {
  readonly cx: number
  readonly axis: number
  readonly R: number
  /** Content slot as hook fractions "fx,fy,fw,fh" for the dash editor. */
  readonly slot: string
}
/**
 * Globe fitted to the frame (2026-10-13): the widget's content is
 * the disc — the ember reflection lives INSIDE its lower half,
 * mirrored across the horizon — so the content is 2R tall in all,
 * plus the rim-glow margin. R is set by whichever frame dimension
 * binds the disc. The published slot is the disc rect plus that
 * same margin, which makes editor fitting a fixed point: fitting
 * the frame to the slot lands on exactly the same R. (An earlier
 * version budgeted 1.6R, which oversized R and clipped the disc's
 * lower quarter at the canvas edge whenever height bound it.)
 */
export const globeFrame = (w: number, h: number, glowPx: number): GlobeFrame => {
  const pad = glowPx + 4
  // R is consumed 2x across and 2x down (the disc; the reflection
  // shares its lower half), so each bound must reserve the margin
  // at its own scale.
  const R = Math.max(0, Math.min(w / 2 - pad, (h - 2 * pad) / 2))
  const cx = w / 2
  const axis = (h - 2 * R) / 2 + R
  const fx = w > 0 ? (cx - R - pad) / w : 0
  const fy = h > 0 ? (axis - R - pad) / h : 0
  const fw = w > 0 ? (2 * R + 2 * pad) / w : 0
  const fh = h > 0 ? (2 * R + 2 * pad) / h : 0
  return { cx, axis, R, slot: `${fx.toFixed(4)},${fy.toFixed(4)},${fw.toFixed(4)},${fh.toFixed(4)}` }
}
const startEngine = (hook: HTMLElement): void => {
  let settings = parseSettings(hook)
  const canvas = document.createElement("canvas")
  hook.appendChild(canvas)
  const ctx = canvas.getContext("2d")
  if (ctx === null) return
  let globe = buildGlobePoints(settings.density === "calm" ? 2.4 : 1.7)
  const wallStart = Date.now()

  let width = 0
  let height = 0
  const resize = (): void => {
    const rect = hook.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    width = Math.max(0, Math.floor(rect.width))
    height = Math.max(0, Math.floor(rect.height))
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(hook)

  // View state: the globe can be GRABBED (2026-10-13) — drag to
  // reposition the spin and adjust the tilt; release and it keeps
  // spinning, fling inertia easing back to the base rate.
  let baseVel = -(Math.PI * 2) / settings.spinMs
  const view = { spin: HOME_SPIN, tilt: (settings.tiltDeg * Math.PI) / 180, vel: baseVel, dragging: false }
  const geom = { cx: 0, axis: 0, R: 0 }
  // Live settings (2026-10-13): settings ride a hidden span the view
  // re-renders on change; the engine starts once per hook, so watch
  // the span and re-derive what was baked at start (spin rate, dot
  // density, tilt). Same freeze class as the mind map's graph.
  let settingsText = hook.querySelector(".mirror-field-settings")?.textContent ?? ""
  console.warn(`[aimy] globenews: engine start — spinMs=${settings.spinMs} density=${settings.density} glow=${settings.glowPx} tilt=${settings.tiltDeg}`)
  const spanWatch = new MutationObserver(() => {
    if (!canvas.isConnected) {
      spanWatch.disconnect()
      return
    }
    const nextText = hook.querySelector(".mirror-field-settings")?.textContent ?? ""
    if (nextText === settingsText) return
    settingsText = nextText
    const prev = settings
    settings = parseSettings(hook)
    baseVel = -(Math.PI * 2) / settings.spinMs
    if (settings.density !== prev.density) {
      globe = buildGlobePoints(settings.density === "calm" ? 2.4 : 1.7)
    }
    if (!view.dragging) view.tilt = (settings.tiltDeg * Math.PI) / 180
    console.warn(`[aimy] globenews: settings reloaded — spinMs=${settings.spinMs} density=${settings.density} glow=${settings.glowPx} tilt=${settings.tiltDeg}`)
  })
  spanWatch.observe(hook, { childList: true, subtree: true, characterData: true })
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  let dragLast: { x: number; y: number; t: number } | null = null
  let dragVel = 0

  canvas.addEventListener("pointermove", (e) => {
    if (view.dragging && dragLast !== null) {
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const dx = px - dragLast.x
      const dy = py - dragLast.y
      const next = applyDrag(view.spin, view.tilt, dx, dy, geom.R)
      const now = performance.now()
      const dtMs = Math.max(1, now - dragLast.t)
      dragVel = (next.spin - view.spin) / dtMs
      view.spin = next.spin
      view.tilt = next.tilt
      dragLast = { x: px, y: py, t: now }
      if (reducedMotion) draw(performance.now())
    }
  })
  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    if (Math.hypot(px - geom.cx, py - geom.axis) <= geom.R * 1.15 && geom.R > 0) {
      view.dragging = true
      dragVel = 0
      dragLast = { x: px, y: py, t: performance.now() }
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = "grabbing"
    }
  })
  const endDrag = (): void => {
    if (!view.dragging) return
    view.dragging = false
    view.vel = Math.max(-0.012, Math.min(0.012, dragVel))
    dragLast = null
  }
  canvas.addEventListener("pointerup", endDrag)
  canvas.addEventListener("pointercancel", endDrag)

  const draw = (tMs: number): void => {
    if (width === 0 || height === 0) return
    ctx.clearRect(0, 0, width, height)
    const frame = globeFrame(width, height, settings.glowPx)
    const cx = frame.cx
    const axis = frame.axis
    const R = frame.R
    geom.cx = cx
    geom.axis = axis
    geom.R = R
    if (hook.dataset.content !== frame.slot) hook.dataset.content = frame.slot
    canvas.style.cursor = view.dragging ? "grabbing" : "grab"
    const focal = 3.4
    const breath = 0.92 + 0.08 * Math.sin((tMs * Math.PI * 2) / 6000)
    const spinV = (p: GlobePoint): Vec3 => rotateX(rotateZ(rotateY(p.vec, view.spin), LEAN), view.tilt)

    // ── The earth above ──
    for (const p of globe) {
      const v = spinV(p)
      const s = project(v, cx, axis, R, focal)
      const facing = Math.max(0, -v.z)
      const back = v.z > 0
      const a = (back ? 0.028 : 0.05 + 0.30 * facing) * breath
      ctx.beginPath()
      ctx.arc(s.x, s.y, back ? 0.9 : 1.25, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(196, 255, 210, ${a.toFixed(3)})`
      ctx.fill()
    }
    // Cyan glow around the rim (2026-10-13): layered strokes falling
    // off outward — the widest band reaches ~20px past the rim.
    const GLOW_BANDS: ReadonlyArray<readonly [number, number]> = [
      [2.2, 0.014],
      [1.2, 0.03],
      [0.5, 0.06],
      [0.125, 0.1],
      [0.05, 0.16],
    ]
    const glowBands: ReadonlyArray<readonly [number, number]> =
      settings.glowPx <= 0
        ? []
        : GLOW_BANDS.map(([f, a]) => [Math.max(0.6, f * settings.glowPx), a] as const)
    for (const [lw, a] of glowBands) {
      ctx.beginPath()
      ctx.arc(cx, axis, R * 1.02, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(34, 211, 238, ${a})`
      ctx.lineWidth = lw
      ctx.stroke()
    }
    const homePhi = (HOME.lat * Math.PI) / 180
    const homeLam = (HOME.lon * Math.PI) / 180
    const homeVec: Vec3 = {
      x: Math.cos(homePhi) * Math.sin(homeLam),
      y: Math.sin(homePhi),
      z: -Math.cos(homePhi) * Math.cos(homeLam),
    }
    const hv = spinV({ vec: homeVec, lon: HOME.lon, lat: HOME.lat })
    if (hv.z < 0.15) {
      const hs = project(hv, cx, axis, R, focal)
      const pulse = 0.55 + 0.35 * Math.sin(tMs / 900)
      ctx.beginPath()
      ctx.arc(hs.x, hs.y, 5.5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${PHOSPHOR}, ${(0.10 * pulse).toFixed(3)})`
      ctx.fill()
      ctx.beginPath()
      ctx.arc(hs.x, hs.y, 2.1, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(235, 255, 240, ${(0.55 * pulse + 0.25).toFixed(3)})`
      ctx.fill()
    }
    const grad = ctx.createLinearGradient(0, 0, width, 0)
    grad.addColorStop(0, "rgba(255, 255, 255, 0)")
    grad.addColorStop(0.5, "rgba(255, 255, 255, 0.10)")
    grad.addColorStop(1, "rgba(255, 255, 255, 0)")
    ctx.fillStyle = grad
    ctx.fillRect(0, axis - 0.5, width, 1)

    // ── The reflection: the earth, warped ──
    for (const p of globe) {
      const v = spinV(p)
      const s = project(v, cx, axis, R, focal)
      const ry = axis + (reflectY(s.y, axis) - axis) * 0.60
      const rx = s.x + Math.sin(ry * 0.045 + tMs * 0.0006) * 1.5
      if (ry < axis + 4) continue
      const facing = Math.max(0, -v.z)
      ctx.beginPath()
      ctx.arc(rx, ry, 1.05, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${EMBER}, ${((0.012 + 0.05 * facing) * breath).toFixed(3)})`
      ctx.fill()
    }

  }


  if (reducedMotion) {
    draw(0)
    canvas.classList.add("on")
    // No loop — but a deliberate drag still re-frames the globe:
    // the pointermove handler redraws on drag. The ResizeObserver
    // stays attached for the same reason.
    return
  }
  let raf = 0
  let last = performance.now()
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
    const dt = Math.min(now - last, 100)
    last = now
    if (!document.hidden) {
      if (!view.dragging) {
        // Fling inertia eases back to the base spin rate (~0.8 s).
        view.vel += (baseVel - view.vel) * (1 - Math.exp(-dt / 800))
        view.spin += view.vel * dt
      }
      draw(now)
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  requestAnimationFrame(() => canvas.classList.add("on"))
}


/** Boot entry (called from main.ts): watch for the hook, start engines. */
export const startMirrorField = (): void => {
  const started = new WeakSet<HTMLElement>()
  const scan = (): void => {
    document.querySelectorAll<HTMLElement>(".mirror-field-hook").forEach((hook) => {
      if (!started.has(hook)) {
        started.add(hook)
        startEngine(hook)
      }
    })
  }
  scan()
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
}
