/**
 * ASC panel view tests — render the slice (loaded from the LIVE engine)
 * through the real foldkit view and assert on what is displayed:
 * - the displayed dial values === the engine's live dials
 * - dials are read-only: the only inputs in the whole panel are the four
 *   affect-tuning range sliders
 * - the abstract expression field renders as SVG
 */
import { Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { inertHtml, type HtmlBuilder } from "foldkit/html"

import { ASCEngine, ASCEngineLive } from "../../../asc-engine/engine.js"
import { AscSelfMonitor, AscSelfMonitorLive } from "../../../asc-engine/asc-self-monitor.js"
import { AscSelfModelLive } from "../../../asc-engine/asc-self-model.js"
import { DialStateLive } from "../../../asc-engine/dial-state.js"
import { SomaticProxiesLive } from "../../../asc-engine/somatic-proxies.js"
import { StakeEstimatorLive } from "../../../asc-engine/stake-estimator.js"
import { AscSelfNarrationLive } from "../../../asc-engine/asc-self-narration.js"
import { OtherModelGuardLive } from "../../../asc-engine/other-model-guard.js"
import {
  DeterministicAuxModelLive,
  InMemoryMemoryReaderLive,
} from "../../../asc-engine/seams.js"

import { loadAscSlice } from "./model.js"
import type { AscMessage } from "./messages.js"
import { ascPanelView } from "./views.js"
import { abstractFieldView, renderAbstractField } from "./preview.js"
import { dialsToAUFrame } from "./facs.js"

const CoreLive = Layer.provide(
  Layer.mergeAll(
    DialStateLive,
    SomaticProxiesLive,
    StakeEstimatorLive,
    DeterministicAuxModelLive,
    AscSelfModelLive,
    AscSelfNarrationLive,
    OtherModelGuardLive,
  ),
  InMemoryMemoryReaderLive,
)
const MonitorLive = Layer.provide(AscSelfMonitorLive, CoreLive)
const EngineLive = Layer.provide(ASCEngineLive, Layer.mergeAll(CoreLive, MonitorLive))
const TestLive = Layer.mergeAll(EngineLive, MonitorLive, CoreLive)

// --- tiny vnode walkers (snabbdom VNodes, no DOM needed) ------------------------

interface VNodeLike {
  readonly sel?: string
  readonly text?: unknown
  readonly children?: unknown
  readonly data?: {
    readonly attrs?: Record<string, unknown>
    readonly props?: Record<string, unknown>
  }
}

const asVNode = (node: unknown): VNodeLike | null =>
  typeof node === "object" && node !== null && !Array.isArray(node)
    ? (node as VNodeLike)
    : null

/** All text content plus string/number attribute values, flattened. */
const textOf = (node: unknown): string => {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("\n")
  const v = asVNode(node)
  if (v === null) return ""
  const parts: Array<string> = []
  if (typeof v.text === "string") parts.push(v.text)
  for (const value of Object.values({ ...(v.data?.attrs ?? {}), ...(v.data?.props ?? {}) })) {
    if (typeof value === "string" || typeof value === "number") parts.push(String(value))
  }
  parts.push(textOf(v.children))
  return parts.join("\n")
}

/** Every vnode whose selector is exactly `sel`. */
const findBySel = (node: unknown, sel: string, acc: Array<VNodeLike> = []): Array<VNodeLike> => {
  if (Array.isArray(node)) {
    for (const child of node) findBySel(child, sel, acc)
    return acc
  }
  const v = asVNode(node)
  if (v === null) return acc
  if (v.sel === sel) acc.push(v)
  findBySel(v.children, sel, acc)
  return acc
}

const inputType = (v: VNodeLike): unknown =>
  v.data?.attrs?.["type"] ?? v.data?.props?.["type"]

describe("ASC panel view", () => {
  it.effect("renders the live dial values, read-only", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const engine = yield* ASCEngine
      yield* monitor.preTurn({
        turn: 1,
        content: {
          domain: "general",
          summary: "view test turn",
          urgency: 0.4,
          costOfError: 0.3,
          cues: { personal: 0.1, playful: 0.2, urgent: 0.3, uncertain: 0.2 },
          isMetaQuestion: false,
        },
        proxies: {
          contextPressurePct: 30,
          selfCorrectionCount: 0,
          turnCount: 1,
          toolFailureRate: 0,
        },
      })

      const slice = yield* loadAscSlice
      const live = yield* engine.currentDials
      const doc = ascPanelView(slice, (inertHtml as unknown as HtmlBuilder<AscMessage>))
      const text = textOf(doc.body)

      expect(doc.title).toContain("ASC")
      // Displayed dial values === the engine's live dials.
      for (const [label, value] of [
        ["Warmth", live.warmth],
        ["Playfulness", live.playfulness],
        ["Intensity", live.intensity],
        ["Vulnerability", live.vulnerability],
      ] as const) {
        expect(text).toContain(label)
        expect(text).toContain(`${value.toFixed(1)} / 10`)
      }
      expect(text).toContain("read-only · computed, not chosen")
      // Sparkline history from the archived computation.
      expect(text).toContain("turn 1")
      // Tuning controls are present and labeled.
      expect(text).toContain("spilloverRatio")
      expect(text).toContain("errorTermLambda")
      // AU readout from the FACS frame.
      expect(text).toContain("browRaise")
    }).pipe(Effect.provide(TestLive)),
  )

  it.effect("the only inputs are the four tuning sliders — dials have none", () =>
    Effect.gen(function* () {
      const slice = yield* loadAscSlice
      const doc = ascPanelView(slice, (inertHtml as unknown as HtmlBuilder<AscMessage>))
      const inputs = findBySel(doc.body, "input")
      expect(inputs).toHaveLength(4)
      for (const input of inputs) {
        expect(inputType(input)).toBe("range")
      }
      // The expression field renders as SVG.
      expect(findBySel(doc.body, "svg").length).toBeGreaterThan(0)
    }).pipe(Effect.provide(TestLive)),
  )

  it("renderAbstractField produces a self-contained SVG string", () => {
    const frame = dialsToAUFrame({ warmth: 8, playfulness: 6, intensity: 7, vulnerability: 4 })
    const svg = renderAbstractField(frame)
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg).toContain('viewBox="0 0 200 200"')
    expect(svg).toContain("<ellipse")
    expect(svg).toContain("<path")
    // Deterministic: same frame, same string.
    expect(renderAbstractField(frame)).toBe(svg)
  })

  it("abstractFieldView embeds the same geometry as foldkit Html", () => {
    const frame = dialsToAUFrame({ warmth: 2, playfulness: 3, intensity: 9, vulnerability: 7 })
    const h = (inertHtml as unknown as HtmlBuilder<AscMessage>)
    const node = abstractFieldView(frame, h)
    const v = asVNode(node)
    expect(v?.sel).toBe("svg")
    expect(findBySel(node, "ellipse").length).toBeGreaterThan(0)
    expect(findBySel(node, "path").length).toBeGreaterThan(0)
  })
})
