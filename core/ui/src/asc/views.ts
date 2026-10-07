/**
 * ASC panel view — pure functions of the `asc` slice state.
 *
 * The dials are rendered READ-ONLY: values, sparkline history from the
 * archived computations, and the latest computation's guard/gate summary.
 * There are no dial inputs anywhere in this panel — dials are computed, not
 * chosen, and the view cannot offer what the update function forbids.
 *
 * The only interactive controls are the affect-tuning sliders, which emit
 * `AffectTuningChanged` → the `RecordTuningChange` command → the frozen
 * boundary's `recordEvidence` seam. Everything else is display.
 */
import type { Document, Html, HtmlBuilder } from "foldkit/html"

import { dialsToAUFrame, AU_NAMES } from "./facs.js"
import {
  DIAL_NAMES,
  type AscSlice,
  type DialName,
  type TuningTarget,
} from "./model.js"
import { Message, type AscMessage } from "./messages.js"
import { abstractFieldView } from "./preview.js"

const DIAL_LABELS: Record<DialName, string> = {
  warmth: "Warmth",
  playfulness: "Playfulness",
  intensity: "Intensity",
  vulnerability: "Vulnerability",
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))
const f1 = (n: number): string => (Math.round(n * 10) / 10).toString()

/** Text bar for a 0–10 value (no CSS dependency, testable). */
const textBar = (value: number): string => {
  const filled = Math.round(clamp01(value / 10) * 10)
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

/** Sparkline of one dial's archived values (oldest → newest). */
const sparkline = (
  h: HtmlBuilder<AscMessage>,
  values: ReadonlyArray<number>,
): Html => {
  if (values.length < 2) return h.span([h.Class("spark-empty")], ["—"])
  const pts = values
    .map(
      (v, i) =>
        `${f1((i / (values.length - 1)) * 100)},${f1(40 - clamp01(v / 10) * 36)}`,
    )
    .join(" ")
  return h.svg([h.ViewBox("0 0 100 40"), h.Class("spark")], [
    h.polyline([
      h.Points(pts),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("1.5"),
    ]),
  ])
}

const dialCard = (
  h: HtmlBuilder<AscMessage>,
  model: AscSlice,
  name: DialName,
): Html => {
  const value = model.dials[name]
  const series = model.dialHistory.map((c) => c.finalDials[name])
  return h.div([h.Class("dial-card")], [
    h.div([h.Class("dial-head")], [
      h.span([h.Class("dial-name")], [DIAL_LABELS[name]]),
      h.span([h.Class("dial-value")], [`${value.toFixed(1)} / 10`]),
    ]),
    sparkline(h, series),
    h.span([h.Class("dial-readonly")], ["read-only · computed, not chosen"]),
  ])
}

const dialsSection = (h: HtmlBuilder<AscMessage>, model: AscSlice): Html => {
  const latest = model.dialHistory[model.dialHistory.length - 1]
  return h.section([h.Class("asc-dials")], [
    h.h2([], ["Affective state"]),
    h.div(
      [h.Class("dial-grid")],
      DIAL_NAMES.map((name) => dialCard(h, model, name)),
    ),
    latest === undefined
      ? h.p([h.Class("asc-empty")], ["No archived computations yet."])
      : h.p(
          [h.Class("asc-latest")],
          [
            `turn ${latest.turn} · ${latest.at} · guard ${
              latest.guardFired ? "FIRED" : "quiet"
            } · ${latest.gated ? `gated: ${latest.gateReason}` : "not gated"}`,
          ],
        ),
  ])
}

const guardSection = (h: HtmlBuilder<AscMessage>, model: AscSlice): Html =>
  h.section([h.Class("asc-guards")], [
    h.h2([], ["Other-model guard"]),
    model.guardFeed.length === 0
      ? h.p([h.Class("asc-empty")], ["No guard classifications yet."])
      : h.ul(
          [h.Class("guard-feed")],
          model.guardFeed.slice(0, 10).map((entry) =>
            h.li([h.Class(entry.fired ? "guard-fired" : "guard-quiet")], [
              `turn ${entry.turn} — ${entry.fired ? "FIRED" : "quiet"} (${
                entry.driver
              }): ${entry.reason}`,
            ]),
          ),
        ),
  ])

const errorTermSection = (h: HtmlBuilder<AscMessage>, model: AscSlice): Html =>
  h.section([h.Class("asc-errorterm")], [
    h.h2([], ["Error-term firings"]),
    model.errorFirings.length === 0
      ? h.p([h.Class("asc-empty")], ["No firings recorded."])
      : h.ul(
          [h.Class("firing-feed")],
          model.errorFirings.slice(0, 10).map((f) =>
            h.li([h.Class("firing")], [
              `${f.domain} · turn ${f.turn}: claim ${f1(f.claimConfidence)} vs ` +
                `observed ${f1(f.observedConfidence)} → corrected to ${f1(
                  f.correctedTo,
                )}`,
            ]),
          ),
        ),
  ])

const capabilitySection = (h: HtmlBuilder<AscMessage>, model: AscSlice): Html => {
  const domains = Object.keys(model.capabilityMap).sort()
  return h.section([h.Class("asc-capabilities")], [
    h.h2([], ["Capability map"]),
    domains.length === 0
      ? h.p([h.Class("asc-empty")], ["No capability data yet."])
      : h.div(
          [h.Class("cap-list")],
          domains.map((domain) => {
            const entry = model.capabilityMap[domain]
            if (entry === undefined) return null
            return h.div([h.Class("cap-row")], [
              h.span([h.Class("cap-domain")], [domain]),
              h.span(
                [h.Class("cap-bar")],
                [`conf ${textBar(entry.confidence)} ${f1(entry.confidence)}`],
              ),
              h.span(
                [h.Class("cap-observed")],
                [
                  entry.observed === null
                    ? "observed — (no firing yet)"
                    : `obs ${textBar(entry.observed)} ${f1(entry.observed)}`,
                ],
              ),
              h.span([h.Class("cap-n")], [`n=${entry.sampleCount}`]),
            ])
          }),
        ),
  ])
}

const narrativeSection = (h: HtmlBuilder<AscMessage>, model: AscSlice): Html =>
  h.section([h.Class("asc-narrative")], [
    h.h2([], ["L3 narrative (excerpt)"]),
    model.l3Excerpt.length === 0
      ? h.p([h.Class("asc-empty")], ["No narrative entries yet."])
      : h.ul(
          [h.Class("narrative-feed")],
          model.l3Excerpt.map((n) =>
            h.li([h.Class("narrative-entry")], [`turn ${n.turn}: ${n.text}`]),
          ),
        ),
  ])

const tuningSlider = (
  h: HtmlBuilder<AscMessage>,
  target: TuningTarget,
): Html =>
  h.div([h.Class("tuning-row")], [
    h.label([h.Class("tuning-label")], [
      target.parameter,
      " ",
      h.span([h.Class("tuning-value")], [`${target.value}${target.unit}`]),
    ]),
    h.input([
      h.Type("range"),
      h.Min(String(target.min)),
      h.Max(String(target.max)),
      h.Step(String(target.step)),
      h.Value(String(target.value)),
      h.AriaLabel(`tuning control: ${target.parameter}`),
      h.OnChange((raw) => {
        const parsed = Number.parseFloat(raw)
        const to = Number.isFinite(parsed) ? parsed : target.value
        return Message.AffectTuningChanged({ parameter: target.parameter, to })
      }),
    ]),
    h.p([h.Class("tuning-desc")], [target.description]),
  ])

const tuningSection = (h: HtmlBuilder<AscMessage>, model: AscSlice): Html =>
  h.section([h.Class("asc-tuning")], [
    h.h2([], ["Affect tuning (paper §VII.C)"]),
    h.p(
      [h.Class("tuning-note")],
      [
        "The only legitimate path into ASC state from this panel. Changes land " +
          "in L1's affect-tuning record — auditable, versioned, never a silent overwrite.",
      ],
    ),
    h.div(
      [h.Class("tuning-controls")],
      model.tuning.map((target) => tuningSlider(h, target)),
    ),
    model.tuningError === null
      ? null
      : h.p(
          [h.Class("tuning-error")],
          [
            `rejected: ${model.tuningError.parameter} — ${model.tuningError.reason}`,
          ],
        ),
    model.tuningLog.length === 0
      ? null
      : h.ul(
          [h.Class("tuning-log")],
          model.tuningLog.slice(-5).map((r) =>
            h.li([], [`${r.parameter}: ${r.from} → ${r.to} · ${r.at}`]),
          ),
        ),
  ])

const previewSection = (h: HtmlBuilder<AscMessage>, model: AscSlice): Html => {
  const frame = dialsToAUFrame(model.dials)
  return h.section([h.Class("asc-preview")], [
    h.h2([], ["Expression preview"]),
    h.div([h.Class("renderer-toggle")], [
      h.button(
        [h.OnClick(Message.PreviewRendererChanged({ renderer: "abstract" }))],
        ["Abstract"],
      ),
      h.button(
        [h.OnClick(Message.PreviewRendererChanged({ renderer: "avatar" }))],
        ["Avatar"],
      ),
    ]),
    model.renderer === "abstract"
      ? abstractFieldView(frame, h)
      : h.p(
          [h.Class("asc-empty")],
          ["Avatar rig ships in v1.1 — abstract field is the MVP renderer."],
        ),
    h.ul(
      [h.Class("au-readout")],
      AU_NAMES.map((name) =>
        h.li([h.Class("au-value")], [`${name}: ${f1(frame[name])}`]),
      ).concat([h.li([h.Class("au-value")], [`headTiltDeg: ${f1(frame.headTiltDeg)}`])]),
    ),
  ])
}

/**
 * The ASC panel as an embeddable `Html` section — the view half of the
 * foldChild composition (the integration pass wraps this slice via
 * `Update.foldChild` + `h.submodel`).
 */
export const ascSection = (model: AscSlice, h: HtmlBuilder<AscMessage>): Html =>
  h.section([h.Class("asc-panel")], [
    h.h2([], ["ASC — self-model"]),
    h.p(
      [h.Class("asc-meta")],
      [`interface ${model.interfaceVersion} · dials are read-only`],
    ),
    dialsSection(h, model),
    guardSection(h, model),
    errorTermSection(h, model),
    capabilitySection(h, model),
    narrativeSection(h, model),
    tuningSection(h, model),
    previewSection(h, model),
  ])

/** The ASC panel as a standalone foldkit Document (dev/story testing). */
export const ascPanelView = (
  model: AscSlice,
  h: HtmlBuilder<AscMessage>,
): Document => ({
  title: "ASC — self-model panel",
  body: ascSection(model, h),
})
