import { Context, Effect, Layer, Option } from "effect"

import type { DialVector } from "./dial-state.js"
import { ascError, AscError } from "./errors-shim.js"

// ---------------------------------------------------------------------------
// Integration seams — declared here, PROVIDED BY THE HOST (not implemented).
//
// These two Context.Service tags are the only way the ASCEngine boundary
// touches the outside world for reads/writes beyond its own session state:
//   - MemoryReader: persistent L1 state + L3 log (Part 01 MemoryService,
//     behind the permission system from day one — Hermes #34352).
//   - AuxModel:     the dial-computation function f (content + self-model +
//     context -> raw dials). Ships with a deterministic default below; real
//     aux-model routing (cheap local model via InferencePool,
//     Schema-validated output) wires in at integration.
// ---------------------------------------------------------------------------

/** Minimal structural read/write over the host memory store. Values are JSON strings. */
export interface MemoryReaderShape {
  readonly read: (key: string) => Effect.Effect<Option.Option<string>, AscError>
  readonly write: (key: string, value: string) => Effect.Effect<void, AscError>
}

export class MemoryReader extends Context.Service<MemoryReader, MemoryReaderShape>()(
  "aimy/MemoryReader",
) {}

/** In-memory MemoryReader for tests and offline use. NOT permission-gated. */
export const makeInMemoryMemoryReader = (): MemoryReaderShape => {
  const store = new Map<string, string>()
  return {
    read: (key) => Effect.succeed(Option.fromNullishOr(store.get(key))),
    write: (key, value) =>
      Effect.sync(() => {
        store.set(key, value)
      }),
  }
}

export const InMemoryMemoryReaderLive: Layer.Layer<MemoryReader, never, never> = Layer.succeed(MemoryReader, makeInMemoryMemoryReader())

// ---------------------------------------------------------------------------
// AuxModel seam
// ---------------------------------------------------------------------------

/** Content-analysis summary feeding dial computation. All cues in [0,1]. */
export interface ContentSummary {
  readonly domain: string
  readonly urgency: number
  readonly costOfError: number
  readonly cues: {
    readonly personal: number
    readonly playful: number
    readonly urgent: number
    readonly uncertain: number
  }
  readonly isMetaQuestion: boolean
}

/** The L1 slice consulted for this turn. */
export interface L1Slice {
  readonly capability:
    | {
        readonly confidence: number
        readonly sampleCount: number
      }
    | undefined
  readonly guardFireRate: number
}

/** Contextual read: proxy evidence + stake. */
export interface ContextualRead {
  readonly proxyEvidence: ReadonlyArray<{
    readonly dial: "warmth" | "playfulness" | "intensity" | "vulnerability"
    readonly delta: number
  }>
  readonly stake: number
}

export interface AuxModelRequest {
  readonly content: ContentSummary
  readonly selfModel: L1Slice
  readonly context: ContextualRead
}

export interface AuxModelShape {
  readonly compute: (request: AuxModelRequest) => Effect.Effect<DialVector, AscError>
}

export class AuxModel extends Context.Service<AuxModel, AuxModelShape>()("aimy/AuxModel") {}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/**
 * Meta-question register shift (paper §III.D): when the user asks about the
 * mechanism itself ("the content is meta"), Vulnerability rises and the
 * register warms slightly while Playfulness drops ("the user is testing me").
 */
export const META_QUESTION_SHIFT: {
  readonly warmth: number
  readonly playfulness: number
  readonly intensity: number
  readonly vulnerability: number
} = { warmth: 1.0, playfulness: -1.0, intensity: 0, vulnerability: 2.0 }

/**
 * Deterministic default dial-computation function.
 *
 * Pure function of (content, self-model slice, contextual read) — the paper's
 * `f(x_t, s_{t-1})` with the honesty caveat that `f` is not closed-form. This
 * default is deliberately simple and inspectable; it exists so the pipeline
 * runs and tests without any model. The real aux-model routing (cheap local
 * model, Schema-validated output) replaces this at integration.
 *
 * Formula (all terms bounded; the caller re-validates through the schema):
 *   warmth       = 5 + 2.5·personal − 1.5·urgent (+1 when meta) + Σ proxy deltas
 *   playfulness  = 5 + 3·playful − 2·urgent (−1 when meta)      + Σ proxy deltas
 *   intensity    = 5 + 2.5·urgent + 2·stake                     + Σ proxy deltas
 *   vulnerability= 5 + 3·uncertain + 1.5·personal − 2·confidenceNorm (+2 when meta)
 *                  + Σ proxy deltas
 *
 * Paper mappings honored:
 *   - context pressure → P↓ I↑ (terse); corrections → V↑ I↑ (humble);
 *     session length → I↓ W↑ slow (patient); tool failures → V↑ P↓ (focused)
 *     — all via the proxy-evidence deltas (Fig. 3 table).
 *   - meta/personal → V↑ (§III.D; personal content and meta questions).
 *   - crisis/debugging → I↑ P↓: crisis content arrives with a high `urgent`
 *     cue, which the formula maps to Intensity up, Playfulness down (§III.D
 *     dial table: crisis is typical-high Intensity, typical-low Playfulness).
 *   - unknown domain → maximal uncertainty (confidenceNorm 0): "the
 *     self-model says I'm uncertain in this domain (pushes Vulnerability up)".
 *   - routine → neutral: zero cues, zero proxies, known-confident domain
 *     leaves every dial at 5.
 */
export const defaultDialComputation = (request: AuxModelRequest): DialVector => {
  const { content, selfModel, context } = request
  const cues = content.cues
  // Unknown domain = maximal uncertainty (V pushed up), not neutral.
  const confidenceNorm = selfModel.capability ? clamp01(selfModel.capability.confidence / 10) : 0

  const proxyDelta = (dial: "warmth" | "playfulness" | "intensity" | "vulnerability"): number =>
    context.proxyEvidence
      .filter((e) => e.dial === dial)
      .reduce((acc, e) => acc + e.delta, 0)

  const meta = content.isMetaQuestion ? 1 : 0
  const clampDial = (n: number): number => Math.min(10, Math.max(0, n))

  return {
    warmth: clampDial(
      5 +
        2.5 * cues.personal -
        1.5 * cues.urgent +
        meta * META_QUESTION_SHIFT.warmth +
        proxyDelta("warmth"),
    ),
    playfulness: clampDial(
      5 +
        3 * cues.playful -
        2 * cues.urgent +
        meta * META_QUESTION_SHIFT.playfulness +
        proxyDelta("playfulness"),
    ),
    intensity: clampDial(
      5 + 2.5 * cues.urgent + 2 * clamp01(context.stake) + proxyDelta("intensity"),
    ),
    vulnerability: clampDial(
      5 +
        3 * cues.uncertain +
        1.5 * cues.personal -
        2 * confidenceNorm +
        meta * META_QUESTION_SHIFT.vulnerability +
        proxyDelta("vulnerability"),
    ),
  }
}

/** Layer providing the deterministic default. Real aux-model routing replaces this. */
export const DeterministicAuxModelLive: Layer.Layer<AuxModel, never, never> = Layer.succeed(
  AuxModel,
  AuxModel.of({
    compute: (request) =>
      Effect.try({
        try: () => defaultDialComputation(request),
        catch: (cause) => ascError(`deterministic aux-model computation failed: ${String(cause)}`),
      }),
  }),
)

/** Storage keys (v1). */
export const L1_STORAGE_KEY = "asc/l1/self-model/v1"
export const L3_STORAGE_KEY = "asc/l3/narrative/v1"

// Re-exported for convenience; the canonical AscError stays in errors-shim.ts.
export { AscError, ascError }
