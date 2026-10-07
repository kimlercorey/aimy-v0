/**
 * FACS preview surface — renders the current AU frame as an abstract field.
 *
 * The renderer is READ-ONLY on ASC state: it takes an already-computed
 * AUFrame (from `facs.dialsToAUFrame`) and draws it. It never touches the
 * engine, the dials, or any service.
 *
 * MVP ships the abstract renderer: a 200×200 field where warmth tints the
 * hue, activation drives the glow, the brow/eye/mouth geometry follows the
 * AUs, and vulnerability rolls the whole composition. Two surfaces:
 * - `renderAbstractField(frame)` → self-contained SVG string (testable,
 *   portable, no DOM needed)
 * - `abstractFieldView(frame, h)` → the same composition as foldkit `Html`
 *   for embedding in the panel view
 */
import type { Html, HtmlBuilder } from "foldkit/html"

import { frameActivation, type AUFrame } from "./facs.js"

/** Pure layout numbers derived from one AU frame. */
export interface FieldGeometry {
  readonly bgHue: number
  readonly glow: number
  readonly eyeRx: number
  readonly eyeRy: number
  readonly browY: number
  readonly browThickness: number
  readonly mouthPath: string
  readonly jawCy: number
  readonly jawRy: number
  readonly tiltDeg: number
  readonly activation: number
}

const EYE_Y = 82
const LEFT_X = 68
const RIGHT_X = 132

/** Pure: AU frame → field geometry. Deterministic; no I/O. */
export const computeFieldGeometry = (frame: AUFrame): FieldGeometry => {
  const activation = frameActivation(frame)
  // Warmth proxy: smile minus corner-depress. Warm → teal-green, cold → indigo.
  const valence = frame.smile - frame.mouthCornerDepress
  const bgHue = Math.round(215 - 55 * Math.min(1, Math.max(-1, valence)))
  const glow = 0.15 + 0.85 * activation

  const eyeRx = 9 + 13 * frame.eyeOpen
  const eyeRy = Math.max(2, 11 + 7 * frame.eyeOpen - 8 * frame.lidTighten)

  const browLift = 7 * frame.browRaise - 9 * frame.browLower
  const browY = 56 - browLift
  const browThickness = 3 + 3 * (frame.browRaise + frame.browLower)

  // Mouth: quadratic arc; positive curve dips down (smile) in SVG y-down space.
  const mouthY = 138
  const mouthCurve = 20 * valence
  const mouthPath =
    `M ${100 - 26} ${mouthY} Q 100 ${mouthY + mouthCurve} ${100 + 26} ${mouthY}`

  const jawCy = 160 + 8 * frame.jawDrop
  const jawRy = 6 + 10 * frame.jawDrop

  return {
    bgHue,
    glow,
    eyeRx,
    eyeRy,
    browY,
    browThickness,
    mouthPath,
    jawCy,
    jawRy,
    tiltDeg: frame.headTiltDeg,
    activation,
  }
}

const f1 = (n: number): string => (Math.round(n * 10) / 10).toString()

/**
 * Render the AU frame as a self-contained SVG string. Pure and testable —
 * no DOM, no runtime, no ASC state.
 */
export const renderAbstractField = (frame: AUFrame): string => {
  const g = computeFieldGeometry(frame)
  const eye = (cx: number): string =>
    `<ellipse cx="${cx}" cy="${EYE_Y}" rx="${f1(g.eyeRx)}" ry="${f1(g.eyeRy)}" fill="hsl(${g.bgHue}, 90%, 72%)" opacity="${f1(0.35 + 0.6 * g.glow)}"/>`
  const brow = (cx: number): string =>
    `<line x1="${cx - 17}" y1="${f1(g.browY)}" x2="${cx + 17}" y2="${f1(g.browY)}" stroke="hsl(${g.bgHue}, 80%, 80%)" stroke-width="${f1(g.browThickness)}" stroke-linecap="round" opacity="0.9"/>`
  return (
    `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ASC expression field">` +
    `<rect width="200" height="200" rx="16" fill="hsl(${g.bgHue}, 45%, 10%)"/>` +
    `<circle cx="100" cy="100" r="78" fill="hsl(${g.bgHue}, 80%, 55%)" opacity="${f1(0.08 + 0.25 * g.glow)}"/>` +
    `<g transform="rotate(${f1(g.tiltDeg)} 100 100)">` +
    brow(LEFT_X) + brow(RIGHT_X) + eye(LEFT_X) + eye(RIGHT_X) +
    `<path d="${g.mouthPath}" fill="none" stroke="hsl(${g.bgHue}, 85%, 75%)" stroke-width="5" stroke-linecap="round" opacity="0.95"/>` +
    `<ellipse cx="100" cy="${f1(g.jawCy)}" rx="30" ry="${f1(g.jawRy)}" fill="none" stroke="hsl(${g.bgHue}, 70%, 60%)" stroke-width="2" opacity="0.5"/>` +
    `</g></svg>`
  )
}

/**
 * The same composition as foldkit `Html`, for embedding in the panel view.
 * Message-polymorphic (`HtmlBuilder<M>`): the preview emits no messages.
 */
export const abstractFieldView = <M>(frame: AUFrame, h: HtmlBuilder<M>): Html => {
  const g = computeFieldGeometry(frame)
  const hue = (light: number): string => `hsl(${g.bgHue}, 80%, ${light}%)`
  const eye = (cx: number): Html =>
    h.ellipse([
      h.Cx(f1(cx)),
      h.Cy(f1(EYE_Y)),
      h.Rx(f1(g.eyeRx)),
      h.Ry(f1(g.eyeRy)),
      h.Fill(hue(72)),
      h.Opacity(f1(0.35 + 0.6 * g.glow)),
    ])
  const brow = (cx: number): Html =>
    h.line([
      h.X1(f1(cx - 17)),
      h.Y1(f1(g.browY)),
      h.X2(f1(cx + 17)),
      h.Y2(f1(g.browY)),
      h.Stroke(hue(80)),
      h.StrokeWidth(f1(g.browThickness)),
      h.StrokeLinecap("round"),
      h.Opacity("0.9"),
    ])
  return h.svg(
    [
      h.ViewBox("0 0 200 200"),
      h.Class("asc-expression-field"),
      h.Role("img"),
      h.AriaLabel("ASC expression field"),
    ],
    [
      h.rect([h.Width("200"), h.Height("200"), h.Rx("16"), h.Fill(`hsl(${g.bgHue}, 45%, 10%)`)]),
      h.circle([
        h.Cx("100"),
        h.Cy("100"),
        h.R("78"),
        h.Fill(`hsl(${g.bgHue}, 80%, 55%)`),
        h.Opacity(f1(0.08 + 0.25 * g.glow)),
      ]),
      h.g(
        [h.Transform(`rotate(${f1(g.tiltDeg)} 100 100)`)],
        [
          brow(LEFT_X),
          brow(RIGHT_X),
          eye(LEFT_X),
          eye(RIGHT_X),
          h.path([
            h.D(g.mouthPath),
            h.Fill("none"),
            h.Stroke(`hsl(${g.bgHue}, 85%, 75%)`),
            h.StrokeWidth("5"),
            h.StrokeLinecap("round"),
            h.Opacity("0.95"),
          ]),
          h.ellipse([
            h.Cx("100"),
            h.Cy(f1(g.jawCy)),
            h.Rx("30"),
            h.Ry(f1(g.jawRy)),
            h.Fill("none"),
            h.Stroke(`hsl(${g.bgHue}, 70%, 60%)`),
            h.StrokeWidth("2"),
            h.Opacity("0.5"),
          ]),
        ],
      ),
    ],
  )
}
