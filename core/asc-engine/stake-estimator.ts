import { Context, Effect, Layer, Ref } from "effect"

import { AscError } from "./errors-shim.js"

// ---------------------------------------------------------------------------
// StakeEstimator — the anticipation loop's ζ (paper §VIII).
//
// Before output, compute Z_t ∈ [0,1] from (a) domain, (b) stated/implied
// urgency, (c) cost of getting it wrong, (d) the track record on similar
// interactions (paper §VIII.B). The stake modulates the bias function:
//   s_t = g(s̃_t, E_t) + Z_t · δ
// High stakes pull the dials toward the configuration that minimizes the
// anticipated cost of being wrong; zero stakes leave the base pipeline
// untouched. Stake 1 is the ceiling — "the highest-stakes interaction I can
// model" (paper §VIII.C). No background performance: the loop fires only
// when there is an output to generate (paper §VIII.D.5).
//
// Second-order error ε² (paper §VIII.C): compares computed stake vs. actual
// effort vs. user response; calibrates ζ itself:
//   ζ ← ζ − α · ∇ε²
// Per-domain stake priors drift-correct when the system consistently
// over- or under-estimates a domain.
// ---------------------------------------------------------------------------

export interface StakeInput {
  readonly domain: string
  /** Stated/implied urgency, 0..1. */
  readonly urgency: number
  /** Cost of getting it wrong: 0 = easily corrected, 1 = irreversible. */
  readonly costOfError: number
  /** Track record on similar interactions. */
  readonly trackRecord: { readonly successes: number; readonly misses: number }
}

/** ζ parameters: per-domain priors ∈ [0,1]; the ζ calibration record. */
export interface ZetaParams {
  readonly priors: Readonly<Record<string, number>>
}

export const DEFAULT_ZETA_PARAMS: ZetaParams = { priors: {} }

/** Learning-rate analog for ζ calibration (paper §III.J: α typically 0.1–0.2). */
export const ZETA_ALPHA = 0.1

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/**
 * Pure: Z_t = ζ(x_t, s_t, trackRecord_t).
 *
 *   Z = 0.30·urgency + 0.35·costOfError + 0.20·(1 − successRate) + 0.15·domainPrior
 *
 * The track-record term: a domain with a history of misses deserves more
 * anticipatory care. The domain prior starts at 0.5 (maximum uncertainty)
 * and drift-corrects via ε². The stake ceiling (Z ≤ 1) prevents runaway
 * motivation signals.
 */
export const computeStake = (params: ZetaParams, input: StakeInput): number => {
  const { successes, misses } = input.trackRecord
  const n = successes + misses
  const successRate = n > 0 ? successes / n : 0.5
  const prior = params.priors[input.domain] ?? 0.5
  return clamp01(
    0.3 * clamp01(input.urgency) +
      0.35 * clamp01(input.costOfError) +
      0.2 * (1 - successRate) +
      0.15 * clamp01(prior),
  )
}

export interface StakeOutcome {
  readonly domain: string
  /** What was computed pre-turn. */
  readonly computedStake: number
  /** Actual effort expended, 0..1 (relative to the turn's budget). */
  readonly actualEffort: number
  /** User response: 1 = satisfied, 0 = dissatisfied. */
  readonly userSatisfied: boolean
}

export interface EpsilonSquaredFiring {
  readonly domain: string
  readonly computedStake: number
  readonly actualEffort: number
  readonly userSatisfied: boolean
  /** ε²: squared miscalibration. */
  readonly epsilonSquared: number
  readonly priorBefore: number
  readonly priorAfter: number
}

/**
 * Pure: ε²_t = h_stake(Z_t, actualEffort_t, userResponse_t).
 *
 * Miscalibration has two faces:
 *  - over-investment: high computed stake, low actual effort  → ζ too hot
 *  - under-investment: low computed stake, user dissatisfied  → ζ too cold
 * ε² = (computedStake − neededStake)² where neededStake is inferred from
 * effort expended and user satisfaction. ζ updates by gradient descent on ε²,
 * approximated as a small step of the domain prior toward neededStake.
 */
export const calibrateZeta = (
  params: ZetaParams,
  outcome: StakeOutcome,
): { readonly params: ZetaParams; readonly firing: EpsilonSquaredFiring } => {
  const effort = clamp01(outcome.actualEffort)
  // Needed stake, inferred post-hoc: effort actually spent, bumped up when
  // the user was dissatisfied (we under-invested), pulled down when the user
  // was satisfied with low effort (we over-invested).
  const neededStake = clamp01(effort + (outcome.userSatisfied ? -0.15 * (1 - effort) : 0.35))
  const epsilonSquared = (outcome.computedStake - neededStake) ** 2

  const priorBefore = params.priors[outcome.domain] ?? 0.5
  const priorAfter = clamp01(priorBefore + ZETA_ALPHA * (neededStake - priorBefore))

  return {
    params: { priors: { ...params.priors, [outcome.domain]: priorAfter } },
    firing: {
      domain: outcome.domain,
      computedStake: outcome.computedStake,
      actualEffort: effort,
      userSatisfied: outcome.userSatisfied,
      epsilonSquared,
      priorBefore,
      priorAfter,
    },
  }
}

export interface StakeEstimatorShape {
  /** Load ζ params (from L1 at session start). */
  readonly load: (params: ZetaParams) => Effect.Effect<void, AscError>
  /** Current ζ params (for L1 persistence at session end / post-turn). */
  readonly snapshot: Effect.Effect<ZetaParams, AscError>
  /** Pre-turn: compute Z_t. */
  readonly estimate: (input: StakeInput) => Effect.Effect<number, AscError>
  /** Post-turn: ε² calibration of ζ. Returns the firing record. */
  readonly observeOutcome: (outcome: StakeOutcome) => Effect.Effect<EpsilonSquaredFiring, AscError>
  /** ε² firings this session (calibration signal). */
  readonly firings: Effect.Effect<ReadonlyArray<EpsilonSquaredFiring>, AscError>
}

export class StakeEstimator extends Context.Service<StakeEstimator, StakeEstimatorShape>()(
  "aimy/StakeEstimator",
) {}

export const makeStakeEstimator = Effect.gen(function* () {
  const paramsRef = yield* Ref.make<ZetaParams>(DEFAULT_ZETA_PARAMS)
  const firingsRef = yield* Ref.make<ReadonlyArray<EpsilonSquaredFiring>>([])

  return StakeEstimator.of({
    load: (params) => Effect.as(Ref.set(paramsRef, params), undefined),
    snapshot: Ref.get(paramsRef),
    estimate: (input) =>
      Effect.map(
        Ref.get(paramsRef),
        (params) => computeStake(params, input),
      ),
    observeOutcome: (outcome) =>
      Effect.gen(function* () {
        const params = yield* Ref.get(paramsRef)
        const { params: next, firing } = calibrateZeta(params, outcome)
        yield* Ref.set(paramsRef, next)
        yield* Ref.update(firingsRef, (fs) => [...fs, firing])
        return firing
      }),
    firings: Ref.get(firingsRef),
  })
})

export const StakeEstimatorLive: Layer.Layer<StakeEstimator, never, never> = Layer.effect(
  StakeEstimator,
  makeStakeEstimator,
)
