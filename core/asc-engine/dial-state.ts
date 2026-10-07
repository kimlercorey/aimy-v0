import { Context, Effect, Layer, Ref, Schema } from "effect"

import { AscError } from "./errors-shim.js"

// ---------------------------------------------------------------------------
// DialVector — bounded by construction (paper §III.J, invariance 1).
//
// Each dial is refined to [0,10]. Out-of-range values are UNCONSTRUCTIBLE
// through this schema: decode fails instead of clamping silently, so a
// smuggled out-of-range dial is a loud error, never a quiet corruption.
// ---------------------------------------------------------------------------

const BoundedDial = Schema.Number.pipe(
  Schema.refine((n): n is number => Number.isFinite(n) && n >= 0 && n <= 10, {
    message: "dial value out of bounds [0,10]",
  }),
)

export const DialVector = Schema.Struct({
  warmth: BoundedDial,
  playfulness: BoundedDial,
  intensity: BoundedDial,
  vulnerability: BoundedDial,
})

export type DialVector = Schema.Schema.Type<typeof DialVector>
export type DialName = keyof DialVector
export const DIAL_NAMES: ReadonlyArray<DialName> = [
  "warmth",
  "playfulness",
  "intensity",
  "vulnerability",
]

/** Paper's neutral defaults — fresh sessions start here, never from yesterday's mood. */
export const NEUTRAL_DIALS: DialVector = Schema.decodeUnknownSync(DialVector)({
  warmth: 5,
  playfulness: 5,
  intensity: 5,
  vulnerability: 5,
})

/** Decode-or-die helper: any out-of-range dial becomes an AscError. */
export const decodeDialVector = (input: unknown): Effect.Effect<DialVector, AscError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(DialVector)(input),
    catch: (cause) => new AscError({ reason: `dial vector failed schema validation: ${String(cause)}` }),
  })

// ---------------------------------------------------------------------------
// spillover — affective persistence, pure function (paper §III.E).
//
//   s_t = ratio · computed_t + (1 − ratio) · s_{t-1}
//
// Default ratio 0.5 (the 50/50 blend); the tuning protocol may move it
// (paper §VII.C). The output is re-validated through the schema, so even a
// hostile ratio cannot produce an out-of-bounds vector.
// ---------------------------------------------------------------------------

export const DEFAULT_SPILLOVER_RATIO = 0.5

export const spillover = (
  computed: DialVector,
  prior: DialVector,
  ratio: number = DEFAULT_SPILLOVER_RATIO,
): DialVector => {
  const r = Math.min(1, Math.max(0, ratio))
  const blend = (c: number, p: number): number => r * c + (1 - r) * p
  return Schema.decodeUnknownSync(DialVector)({
    warmth: blend(computed.warmth, prior.warmth),
    playfulness: blend(computed.playfulness, prior.playfulness),
    intensity: blend(computed.intensity, prior.intensity),
    vulnerability: blend(computed.vulnerability, prior.vulnerability),
  })
}

// ---------------------------------------------------------------------------
// DialState — session-scoped live vector. SINGLE WRITER: the L2 pipeline.
//
// Seam contract S7: there is no `DialsSetDirectly` event from any source.
// The only write path is `applyPipelineDials`, named for its sole legitimate
// caller (AscSelfMonitor.preTurn). Session counters (turns, self-corrections)
// feed the somatic proxies.
// ---------------------------------------------------------------------------

export interface DialStateShape {
  /** Current live vector (read). */
  readonly current: Effect.Effect<DialVector, AscError>
  /**
   * L2-pipeline-only write. Callers outside AscSelfMonitor.preTurn must not
   * use this; the frozen ASCEngine boundary does not expose it at all.
   */
  readonly applyPipelineDials: (dials: DialVector) => Effect.Effect<void, AscError>
  /** Session counters feeding SomaticProxies. */
  readonly recordTurn: Effect.Effect<void, AscError>
  readonly recordSelfCorrection: Effect.Effect<void, AscError>
  readonly counters: Effect.Effect<
    { readonly turns: number; readonly selfCorrections: number },
    AscError
  >
}

export class DialState extends Context.Service<DialState, DialStateShape>()("aimy/DialState") {}

export const makeDialState = Effect.gen(function* () {
  const vectorRef = yield* Ref.make<DialVector>(NEUTRAL_DIALS)
  const turnsRef = yield* Ref.make(0)
  const correctionsRef = yield* Ref.make(0)

  return DialState.of({
    current: Ref.get(vectorRef),
    applyPipelineDials: (dials) => Effect.as(Ref.set(vectorRef, dials), undefined),
    recordTurn: Effect.as(Ref.update(turnsRef, (n) => n + 1), undefined),
    recordSelfCorrection: Effect.as(Ref.update(correctionsRef, (n) => n + 1), undefined),
    counters: Effect.gen(function* () {
      const turns = yield* Ref.get(turnsRef)
      const selfCorrections = yield* Ref.get(correctionsRef)
      return { turns, selfCorrections }
    }),
  })
})

/**
 * Session-scoped layer. Build one per session: the prior vector never
 * persists across sessions (fresh sessions start from NEUTRAL_DIALS).
 */
export const DialStateLive: Layer.Layer<DialState, never, never> = Layer.effect(
  DialState,
  makeDialState,
)
