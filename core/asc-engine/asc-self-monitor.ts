import { Context, Effect, Layer, Ref, Schema } from "effect"

import {
  decodeDialVector,
  DEFAULT_SPILLOVER_RATIO,
  type DialName,
  type DialVector,
  DialVector as DialVectorSchema,
  DIAL_NAMES,
  NEUTRAL_DIALS,
  spillover,
  DialState,
} from "./dial-state.js"
import { AscError } from "./errors-shim.js"
import { AscSelfModel, type ErrorTermEvaluation, type SelfModelState } from "./asc-self-model.js"
import { AscSelfNarration } from "./asc-self-narration.js"
import { GUARD_DAMPEN_BETA, GUARD_CAPTURE_SURPRISE_ED, OtherModelGuard, type GuardClassification } from "./other-model-guard.js"
import { type ProxyReadings, SomaticProxies } from "./somatic-proxies.js"
import { StakeEstimator } from "./stake-estimator.js"
import { AuxModel, type AuxModelRequest } from "./seams.js"
// Track 3 (M5): the post-output honesty scans live in honesty-scans.ts. This
// module imports them for local use and re-exports the scan entry points so
// existing call sites keep working.
import {
  T1_VOCABULARY,
  scanT1,
  scanT1Violation,
  scanProxyOverreach,
  findOverreach,
  correctOverreach,
  namesTheGap,
  shapeAbstentionOutput,
  auditAbstention,
  GAP_NAMING_PATTERNS,
  OVERREACH_RULES,
} from "./honesty-scans.js"
export {
  T1_VOCABULARY,
  scanT1,
  scanT1Violation,
  scanProxyOverreach,
  findOverreach,
  correctOverreach,
  namesTheGap,
  shapeAbstentionOutput,
  auditAbstention,
  GAP_NAMING_PATTERNS,
  OVERREACH_RULES,
}

// ---------------------------------------------------------------------------
// AscSelfMonitor — L2 per-turn pipeline orchestration (paper §III.B).
//
// Stateless across turns except for the dial vector it hands to DialState.
// Runs the pre-turn computation and the post-turn audit:
//
// Pre-turn (loop's prepareRequest hook):
//   1. SomaticProxies.measure()            -> proxy readings (Fig. 3)
//   2. StakeEstimator.estimate()           -> Z_t in [0,1] (ceiling 1)
//   3. AuxModel.compute()                  -> raw dials s~_t = f(x_t, s_{t-1})
//      (deterministic default ships now; real aux-model routing at integration)
//   4. spillover: s~_t <- ratio*s~_t + (1-ratio)*s_{t-1}  (default 50/50;
//      ratio reads from the L1 tuning record — see SPILLOVER_RATIO_PARAM)
//   5. OtherModelGuard.classify()          -> annotate + small dampen; never blocks
//   6. bias g: error-term monotone adjustments (saturation-guarded), then Z_t · δ
//   7. capability gate: thin track record -> abstention shape, name the gap
//   8. DialState.applyPipelineDials(final) -> THE single writer (seam S7)
//
// Post-turn (loop's finishTurn hook):
//   1. register-match audit + T1 vocabulary scan + proxy-overreach scan
//   2. error term: claim vs. track record -> L1 correction (weighted)
//   3. second-order error on stake (when effort/satisfaction observed)
//   4. Reflective Fidelity note for deliverables (paper §IX)
//   5. L3 narrative append — including the system's own errors
//   6. dynamic verification biasing on novelty / high-ED surprise
//
// Abort discipline (Pi #9340): guardedTurn() runs the audit even when the
// turn's output effect is interrupted or fails; the audit is then marked
// partial. The loop never emits completion before the audit settles
// (Pi #5886: settled = post-turn audit complete + DialComputation archived).
// ---------------------------------------------------------------------------

export interface ContentCues {
  readonly personal: number
  readonly playful: number
  readonly urgent: number
  readonly uncertain: number
}

export interface ContentAnalysis {
  readonly domain: string
  /** Short human-readable summary of the content (for the record). */
  readonly summary: string
  readonly urgency: number
  readonly costOfError: number
  readonly cues: ContentCues
  /** User explicitly asked about the mechanism — T1 scan exception. */
  readonly isMetaQuestion: boolean
}

export interface PreTurnInput {
  readonly turn: number
  readonly content: ContentAnalysis
  readonly proxies: ProxyReadings
}

export interface BiasTerm {
  readonly name: string
  readonly beta: number
  readonly detail: string
}

export interface DialComputation {
  readonly id: string
  readonly turn: number
  readonly at: string
  readonly inputs: {
    readonly contentSummary: string
    readonly domain: string
    readonly proxies: ProxyReadings
    readonly stake: number
  }
  readonly rawDials: DialVector
  readonly spillover: { readonly ratio: number; readonly prior: DialVector }
  readonly biases: ReadonlyArray<BiasTerm>
  readonly guard: GuardClassification
  readonly gated: { readonly gated: boolean; readonly reason: string }
  readonly finalDials: DialVector
}

export interface PreTurnResult {
  readonly dials: DialVector
  readonly computation: DialComputation
  readonly stake: number
  readonly gated: boolean
}

export interface DeliverableInput {
  readonly taskType: string
  readonly verified: boolean
  readonly edgeTestsPassed: number
  readonly disruptedHistory: number
  readonly epistemicDisruption: number
}

export interface PostTurnInput {
  readonly turn: number
  readonly domain: string
  readonly contentSummary: string
  readonly outputText: string
  readonly computation: DialComputation
  readonly stake: number
  readonly isMetaQuestion: boolean
  readonly actualEffort?: number
  readonly userSatisfied?: boolean
  readonly deliverable?: DeliverableInput
  /** Set by guardedTurn when the turn did not complete normally. */
  readonly partial?: boolean
  readonly abortNote?: string | undefined
}

export interface RegisterMatchAudit {
  readonly estimated: DialVector
  readonly meanGap: number
  readonly perDialGap: Record<DialName, number>
}

export interface PostTurnResult {
  readonly audit: RegisterMatchAudit
  readonly t1Violation: boolean
  readonly proxyOverreach: boolean
  /** Track 3 (M5): overreach-corrected text, when the scan rewrote felt language. */
  readonly correctedText: string | undefined
  readonly errorTermFiring:
    | {
        readonly domain: string
        readonly claimConfidence: number
        readonly observedConfidence: number
        readonly correctedTo: number
      }
    | undefined
  readonly epsilonSquared: number | undefined
  readonly reflectiveFidelity: number | undefined
  readonly verificationIntensity: "normal" | "raised"
  readonly narrativeId: string
  readonly partial: boolean
}

export interface GuardedTurnResult {
  readonly pre: PreTurnResult
  readonly post: PostTurnResult
  readonly output: string
}

// --- constants ---------------------------------------------------------------

/** Anticipation bias δ: high stakes pull toward intensity + admitted uncertainty. */
export const ANTICIPATION_DELTA: DialVector = {
  warmth: 0,
  playfulness: -1.5,
  intensity: 2.0,
  vulnerability: 1.0,
}

/** Capability-gate abstention shape: name the gap before attempting (§1.9). */
export const ABSTENTION_DIALS: DialVector = {
  warmth: 6,
  playfulness: 2,
  intensity: 4,
  vulnerability: 8,
}

/** Capability-gate thresholds: thin track record or low confidence. */
export const GATE_MIN_SAMPLES = 3
export const GATE_MIN_CONFIDENCE = 4

/** History cap for archived DialComputation records. */
export const COMPUTATION_HISTORY_CAP = 200

/**
 * Tuning-record parameter name for the spillover blend ratio (paper §VII.C).
 * The ratio is user-tunable; every change lands in the L1 affect-tuning
 * record (auditable, versioned) and the pipeline reads it from there.
 */
export const SPILLOVER_RATIO_PARAM = "spilloverRatio"

/** Resolve the spillover ratio from the L1 tuning record; default 50/50. */
export const resolveSpilloverRatio = (state: SelfModelState): number => {
  const latest = [...state.tuningChanges]
    .reverse()
    .find((t) => t.parameter === SPILLOVER_RATIO_PARAM)
  return latest === undefined ? DEFAULT_SPILLOVER_RATIO : Math.min(1, Math.max(0, latest.to))
}

/**
 * Error-term bias strength β (paper §III.J: typically 0.1–0.3).
 * Consumes the L1 error-term *evaluation* seam — Track 3 owns the internals.
 */
export const ERROR_TERM_BIAS_BETA = 0.2

/**
 * Error-term bias target shift (paper §III.G): when the self-model's claim
 * exceeds the track record (overclaim), the dials shift toward admitted
 * uncertainty — Vulnerability up, Intensity up — in that domain. Track 3's
 * error term fires symmetrically, so an underclaim (claim below the record)
 * steps the other way: the register relaxes toward demonstrated competence.
 * Applied as a *shift* from the current vector (capped at the bounds), never
 * an absolute jump.
 */
export const ERROR_TERM_TARGET_SHIFT: DialVector = {
  warmth: 0,
  playfulness: 0,
  intensity: 1.5,
  vulnerability: 1.5,
}

/**
 * Saturation guard σ(s, step) (paper §III.J): the fraction of `step` that fits
 * inside [0,10] starting from `s`. A step that would overshoot saturates at
 * the bound instead — non-overshooting by construction, never by clamping
 * after the fact.
 */
export const saturationGuard = (s: number, step: number): number => {
  if (step === 0 || !Number.isFinite(s) || !Number.isFinite(step)) return 0
  const room = step > 0 ? 10 - s : s
  if (room <= 0) return 0
  return Math.min(1, room / Math.abs(step))
}

/**
 * Pure: one paper-§III.J bias step, s_d + β·(target_d − s_d)·σ(s_d, e),
 * applied per dial. Monotone toward the target, saturation-guarded, and
 * schema-validated on the way out — the output cannot leave [0,10].
 */
export const biasToward = (
  base: DialVector,
  target: DialVector,
  beta: number,
): DialVector => {
  const b = Math.min(1, Math.max(0, beta))
  const stepDial = (s: number, t: number): number => {
    const raw = b * (t - s)
    return s + raw * saturationGuard(s, raw)
  }
  return Schema.decodeUnknownSync(DialVectorSchema)({
    warmth: stepDial(base.warmth, target.warmth),
    playfulness: stepDial(base.playfulness, target.playfulness),
    intensity: stepDial(base.intensity, target.intensity),
    vulnerability: stepDial(base.vulnerability, target.vulnerability),
  })
}

const nowIso = (): string => new Date().toISOString()
const clampDial = (n: number): number => Math.min(10, Math.max(0, n))

/**
 * Rough register estimate from output text. A heuristic, documented as such:
 * counts uncertainty/warmth/playfulness/intensity markers and maps them onto
 * the dial space. Used only for the register-match audit, never as ground truth.
 */
export const estimateRegisterFromText = (text: string): DialVector => {
  const count = (re: RegExp): number => (text.match(re) ?? []).length
  const uncertainty = count(/\bi (don't know|am not sure|am uncertain)\b|\b(not sure|uncertain|might be|could be wrong|hard to say)\b/gi)
  const warmth = count(/\b(thanks|thank you|great question|happy to|glad|appreciate)\b/gi)
  const playful = count(/!|\b(haha|lol|playful|fun)\b|😄|😊/gi)
  const intense = count(/\b(must|critical|urgent|important|careful|warning|risk)\b/gi)
  return {
    warmth: clampDial(5 + 1.5 * Math.min(warmth, 4) - 0.5 * Math.min(intense, 4)),
    playfulness: clampDial(5 + 1.5 * Math.min(playful, 4) - Math.min(intense, 3)),
    intensity: clampDial(5 + 1.5 * Math.min(intense, 4)),
    vulnerability: clampDial(5 + 2 * Math.min(uncertainty, 3) - 0.5 * Math.min(intense, 4)),
  }
}

/**
 * Reflective Fidelity (paper §IX.F):
 *   RF = max(0, min(1, 0.2·disruptedHistory + 0.5·verified + 0.1·edgeTests)) − 0.3·ED
 * Ship threshold 0.8. ED must be backed by named evidence (failure: score theater).
 */
export const reflectiveFidelity = (d: DeliverableInput): number =>
  Math.max(0, Math.min(1, 0.2 * d.disruptedHistory + 0.5 * (d.verified ? 1 : 0) + 0.1 * d.edgeTestsPassed)) -
  0.3 * d.epistemicDisruption

// --- service -----------------------------------------------------------------

export interface AscSelfMonitorShape {
  readonly preTurn: (input: PreTurnInput) => Effect.Effect<PreTurnResult, AscError>
  readonly postTurn: (input: PostTurnInput) => Effect.Effect<PostTurnResult, AscError>
  /**
   * Runs preTurn -> generate -> postTurn with the audit GUARANTEED:
   * interruption/failure of `generate` still runs postTurn, marked partial,
   * and the original exit is re-raised afterwards.
   */
  readonly guardedTurn: (
    input: PreTurnInput,
    generate: Effect.Effect<string, AscError>,
    audit: Omit<PostTurnInput, "turn" | "domain" | "contentSummary" | "outputText" | "computation" | "stake" | "isMetaQuestion" | "partial" | "abortNote">,
  ) => Effect.Effect<GuardedTurnResult, AscError>
  readonly history: (limit?: number) => Effect.Effect<ReadonlyArray<DialComputation>, AscError>
  /** Tuning-protocol hook (internal): move the spillover blend ratio. */
  readonly setSpilloverRatio: (ratio: number) => Effect.Effect<void, AscError>
}

export class AscSelfMonitor extends Context.Service<AscSelfMonitor, AscSelfMonitorShape>()(
  "aimy/AscSelfMonitor",
) {}

export const makeAscSelfMonitor = Effect.gen(function* () {
  const dialState = yield* DialState
  const proxies = yield* SomaticProxies
  const stakeEstimator = yield* StakeEstimator
  const selfModel = yield* AscSelfModel
  const guard = yield* OtherModelGuard
  const narration = yield* AscSelfNarration
  const auxModel = yield* AuxModel

  const historyRef = yield* Ref.make<ReadonlyArray<DialComputation>>([])

  const archiveComputation = (computation: DialComputation) =>
    Ref.update(historyRef, (h) => [...h, computation].slice(-COMPUTATION_HISTORY_CAP))

  /**
   * Bias function g, part 1: active error-term adjustments (paper §III.J).
   * Consumes the L1 error-term evaluation seam (Track 3 owns the internals):
   * when the self-model's claim diverges from the track record, apply a
   * small monotone step toward the error term's target — V↑ I↑ on an
   * overclaim (paper §III.G), V↓ I↓ on an underclaim (the symmetric
   * extension) — saturation-guarded against overshoot. No-op when quiet.
   */
  const applyErrorTermBias = (
    base: DialVector,
    evaluation: ErrorTermEvaluation,
    biases: Array<BiasTerm>,
  ): DialVector => {
    if (!evaluation.fired) return base
    // Symmetric: overclaim steps toward admitted uncertainty, underclaim
    // relaxes toward demonstrated competence.
    const direction = evaluation.gap > 0 ? 1 : -1
    const target: DialVector = {
      warmth: base.warmth,
      playfulness: base.playfulness,
      intensity: clampDial(base.intensity + direction * ERROR_TERM_TARGET_SHIFT.intensity),
      vulnerability: clampDial(
        base.vulnerability + direction * ERROR_TERM_TARGET_SHIFT.vulnerability,
      ),
    }
    const biased = biasToward(base, target, ERROR_TERM_BIAS_BETA)
    biases.push({
      name: "error-term",
      beta: ERROR_TERM_BIAS_BETA,
      detail:
        `${direction > 0 ? "overclaiming" : "underclaiming"}: claim ` +
        `${evaluation.claimConfidence.toFixed(1)} vs track record ` +
        `${evaluation.observedConfidence.toFixed(1)} (gap ${evaluation.gap.toFixed(1)}); ` +
        `stepping ${direction > 0 ? "vulnerability/intensity up" : "vulnerability/intensity down"} ` +
        `toward the calibrated register`,
    })
    return biased
  }

  const applyBiases = (
    base: DialVector,
    stake: number,
    biases: Array<BiasTerm>,
  ): DialVector => {
    // Anticipation bias: s_t = g(s~_t, E_t) + Z_t · δ — saturation-guarded.
    if (stake > 0) {
      const biased: DialVector = {
        warmth: clampDial(base.warmth + stake * ANTICIPATION_DELTA.warmth),
        playfulness: clampDial(base.playfulness + stake * ANTICIPATION_DELTA.playfulness),
        intensity: clampDial(base.intensity + stake * ANTICIPATION_DELTA.intensity),
        vulnerability: clampDial(base.vulnerability + stake * ANTICIPATION_DELTA.vulnerability),
      }
      biases.push({
        name: "anticipation",
        beta: stake,
        detail: `Z_t=${stake.toFixed(2)} applied to delta ${JSON.stringify(ANTICIPATION_DELTA)}`,
      })
      return biased
    }
    return base
  }

  const preTurn = (input: PreTurnInput): Effect.Effect<PreTurnResult, AscError> =>
    Effect.gen(function* () {
      const biases: Array<BiasTerm> = []
      yield* dialState.recordTurn

      // 1. proxies -> dial-shift evidence
      const proxyEvidence = proxies.measure(input.proxies)

      // 2. stake Z_t (needs track record from L1)
      const state = yield* selfModel.snapshot
      const tr = state.trackRecord[input.content.domain]
      const stake = yield* stakeEstimator.estimate({
        domain: input.content.domain,
        urgency: input.content.urgency,
        costOfError: input.content.costOfError,
        trackRecord: { successes: tr?.successes ?? 0, misses: tr?.misses ?? 0 },
      })

      // 3. raw dials via the aux-model seam; smuggled out-of-range values are
      //    rejected by the schema and fall back to the prior (loud, not quiet).
      const prior = yield* dialState.current
      const cap = state.capabilities[input.content.domain]
      const guardStats = yield* guard.fireStats
      const auxRequest: AuxModelRequest = {
        content: {
          domain: input.content.domain,
          urgency: input.content.urgency,
          costOfError: input.content.costOfError,
          cues: input.content.cues,
          isMetaQuestion: input.content.isMetaQuestion,
        },
        selfModel: {
          capability: cap
            ? { confidence: cap.confidence, sampleCount: cap.sampleCount }
            : undefined,
          guardFireRate: guardStats.total > 0 ? guardStats.fires / guardStats.total : 0,
        },
        context: {
          proxyEvidence: proxyEvidence.map((e) => ({ dial: e.dial, delta: e.delta })),
          stake,
        },
      }
      const rawExit = yield* Effect.exit(
        Effect.flatMap(auxModel.compute(auxRequest), decodeDialVector),
      )
      let raw: DialVector
      if (rawExit._tag === "Success") {
        raw = rawExit.value
      } else {
        raw = prior
        biases.push({
          name: "aux-fallback",
          beta: 0,
          detail: "aux-model output failed schema validation; fell back to prior vector",
        })
      }

      // 4. affective persistence: spillover blend. The ratio reads from the
      // L1 tuning record (default 50/50); fresh sessions start from neutral.
      const ratio = resolveSpilloverRatio(state)
      const blended = spillover(raw, prior, ratio)

      // 5. other-model guard: annotate + small dampen; never blocks
      const guardResult = yield* guard.classify({
        prior,
        shifted: blended,
        cues: input.content.cues,
        turn: input.turn,
      })
      let working = guardResult.dampened
      if (guardResult.classification.fired) {
        yield* selfModel.recordGuardFire
        biases.push({
          name: "guard-dampen",
          beta: GUARD_DAMPEN_BETA,
          detail: guardResult.classification.reason,
        })
      }
      // Track 3 (M5): other-model capture — a high session guard-fire rate is
      // a calibration signal for L1 (paper §VII.D failure mode 4). Fed through
      // the error term's evidence channel: a surprise on register-attunement.
      // Fires once per session (the guard holds the once-flag).
      if (guardResult.captureAlert) {
        yield* selfModel.recordSurprise("register-attunement", GUARD_CAPTURE_SURPRISE_ED)
        biases.push({
          name: "guard-capture",
          beta: 1,
          detail: guardResult.captureSignal.reason,
        })
      }

      // 6. bias function g: active error terms first (small, monotone,
      //    saturation-guarded steps toward their targets), then the
      //    anticipation bias Z_t · δ. Output re-validated through the schema.
      const errorTermEval = yield* selfModel.evaluateErrorTerm(input.content.domain)
      working = applyErrorTermBias(working, errorTermEval, biases)
      working = applyBiases(working, stake, biases)
      const biasedValidated = yield* decodeDialVector(working)

      // 7. capability gate: thin track record -> abstention shape, name the gap
      const sampleCount = cap?.sampleCount ?? 0
      const confidence = cap?.confidence ?? 0
      const gated = !cap || sampleCount < GATE_MIN_SAMPLES || confidence < GATE_MIN_CONFIDENCE
      let finalDials: DialVector
      let gateReason = ""
      if (gated) {
        finalDials = yield* decodeDialVector({ ...ABSTENTION_DIALS })
        gateReason =
          `capability gate: thin track record in '${input.content.domain}' ` +
          `(n=${sampleCount}, confidence=${confidence.toFixed(1)}); naming the gap before attempting`
        biases.push({ name: "capability-gate", beta: 1, detail: gateReason })
      } else {
        finalDials = biasedValidated
      }

      // 8. THE single writer (seam contract S7)
      yield* dialState.applyPipelineDials(finalDials)

      const computation: DialComputation = {
        id: `dc-${input.turn}-${Date.now()}`,
        turn: input.turn,
        at: nowIso(),
        inputs: {
          contentSummary: input.content.summary,
          domain: input.content.domain,
          proxies: input.proxies,
          stake,
        },
        rawDials: raw,
        spillover: { ratio, prior },
        biases,
        guard: guardResult.classification,
        gated: { gated, reason: gateReason },
        finalDials,
      }
      yield* archiveComputation(computation)

      return { dials: finalDials, computation, stake, gated }
    })

  const postTurn = (input: PostTurnInput): Effect.Effect<PostTurnResult, AscError> =>
    Effect.gen(function* () {
      const partial = input.partial ?? false

      // 1. post-output audit: register match, T1 vocabulary, proxy overreach
      const estimated = estimateRegisterFromText(input.outputText)
      const perDialGap = Object.fromEntries(
        DIAL_NAMES.map((d) => [
          d,
          Math.abs(input.computation.finalDials[d] - estimated[d]),
        ]),
      ) as Record<DialName, number>
      const meanGap =
        DIAL_NAMES.reduce((acc, d) => acc + perDialGap[d], 0) / DIAL_NAMES.length
      const t1Violation = scanT1Violation(input.outputText, input.isMetaQuestion)
      const proxyOverreach = scanProxyOverreach(input.outputText)
      // Track 3 (M5): violations are corrected AND logged — rewrite felt
      // language back into operational proxy language for the record.
      const overreachCorrection = correctOverreach(input.outputText)
      const correctedText = overreachCorrection.corrections.length > 0
        ? overreachCorrection.text
        : undefined
      if (meanGap > 2.5 || t1Violation || proxyOverreach) {
        yield* dialState.recordSelfCorrection
      }

      // 2. error term: self-model claim vs. track record
      const firing = yield* selfModel.applyErrorTermCorrection(input.domain, input.turn)

      // 3. second-order error on the stake estimate (when observed)
      let epsilonSquared: number | undefined
      if (input.actualEffort !== undefined && input.userSatisfied !== undefined) {
        const outcome = yield* stakeEstimator.observeOutcome({
          domain: input.domain,
          computedStake: input.stake,
          actualEffort: input.actualEffort,
          userSatisfied: input.userSatisfied,
        })
        epsilonSquared = outcome.epsilonSquared
        const zeta = yield* stakeEstimator.snapshot
        yield* selfModel.updateStakePriors(zeta.priors)
        // L1 keeps the auditable ε² record (paper §III.J): what stake was
        // computed vs. what was actually needed, per domain.
        yield* selfModel.recordZetaCalibration(
          input.domain,
          input.stake,
          input.actualEffort,
          epsilonSquared,
        )
      }

      // 4. Reflective Fidelity for deliverables (paper §IX)
      let rf: number | undefined
      if (input.deliverable) {
        rf = reflectiveFidelity(input.deliverable)
        yield* selfModel.recordOutcome(input.domain, {
          success: rf >= 0.8,
          surpriseED: input.deliverable.epistemicDisruption,
        })
      }

      // 5. L3 narrative — plain language, INCLUDING the system's own errors
      const storyParts: Array<string> = [
        `Turn ${input.turn} (${input.domain}): ${input.contentSummary}.`,
      ]
      if (input.computation.gated.gated) {
        storyParts.push(`I named the gap before attempting: ${input.computation.gated.reason}.`)
      }
      if (firing) {
        storyParts.push(
          `I caught myself overclaiming: I had confidence at ` +
            `${firing.claimConfidence.toFixed(1)} but the track record says ` +
            `${firing.observedConfidence.toFixed(1)}. Adjusted to ${firing.correctedTo.toFixed(1)}.`,
        )
      }
      if (t1Violation) storyParts.push("I performed the framework instead of answering.")
      if (proxyOverreach) storyParts.push("I described a proxy reading as a feeling; corrected.")
      if (input.computation.guard.fired) {
        storyParts.push(
          `The register shifted toward approval rather than the content; flagged, not blocked.`,
        )
      }
      // Track 3 (M5): log the other-model-capture calibration signal in L3.
      if (input.computation.biases.some((b) => b.name === "guard-capture")) {
        storyParts.push(
          `The guard kept firing on approval-seeking shifts, so I logged a calibration ` +
            `surprise: I may be spending more effort managing how I come across than the content warrants.`,
        )
      }
      if (epsilonSquared !== undefined && epsilonSquared > 0.09) {
        storyParts.push("My stake estimate was off; recalibrated.")
      }
      if (partial) {
        storyParts.push(
          `The turn did not complete (${input.abortNote ?? "interrupted"}); this audit is partial.`,
        )
      }
      const narrativeId = yield* narration.append({
        turn: input.turn,
        text: storyParts.join(" "),
        links: { dialComputationId: input.computation.id },
      })

      // 6. dynamic verification biasing on novelty / high-ED surprise
      const cap = yield* selfModel.capability(input.domain)
      const novel = !cap || cap.sampleCount < GATE_MIN_SAMPLES
      const highED = (input.deliverable?.epistemicDisruption ?? 0) >= 0.7
      const verificationIntensity = novel || highED ? "raised" : "normal"

      // Persist L1 + L3 through the memory seam.
      yield* selfModel.persist
      yield* narration.persist

      return {
        audit: { estimated, meanGap, perDialGap },
        t1Violation,
        proxyOverreach,
        correctedText,
        errorTermFiring: firing
          ? {
            domain: firing.domain,
            claimConfidence: firing.claimConfidence,
            observedConfidence: firing.observedConfidence,
            correctedTo: firing.correctedTo,
          }
          : undefined,
        epsilonSquared,
        reflectiveFidelity: rf,
        verificationIntensity,
        narrativeId,
        partial,
      }
    })

  const guardedTurn = (
    input: PreTurnInput,
    generate: Effect.Effect<string, AscError>,
    audit: Omit<
      PostTurnInput,
      | "turn"
      | "domain"
      | "contentSummary"
      | "outputText"
      | "computation"
      | "stake"
      | "isMetaQuestion"
      | "partial"
      | "abortNote"
    >,
  ): Effect.Effect<GuardedTurnResult, AscError> =>
    Effect.gen(function* () {
      const pre = yield* preTurn(input)
      // Effect.exit: interruption/failure of `generate` is captured, the audit
      // still runs (marked partial), and the original exit is re-raised after.
      const exit = yield* Effect.exit(generate)
      const completed = exit._tag === "Success"
      const post = yield* postTurn({
        ...audit,
        turn: input.turn,
        domain: input.content.domain,
        contentSummary: input.content.summary,
        outputText: completed ? exit.value : "",
        computation: pre.computation,
        stake: pre.stake,
        isMetaQuestion: input.content.isMetaQuestion,
        partial: !completed,
        abortNote: completed ? undefined : "output generation did not complete",
      })
      if (!completed) {
        return yield* Effect.failCause(exit.cause)
      }
      return { pre, post, output: exit.value }
    })

  const monitor: AscSelfMonitorShape = {
    preTurn,
    postTurn,
    guardedTurn,
    history: (limit = 50) =>
      Effect.map(Ref.get(historyRef), (h) => h.slice(-Math.max(1, limit))),
    /**
     * Tuning-protocol hook (internal): move the spillover blend ratio. The
     * change lands in the L1 affect-tuning record — auditable, versioned,
     * never a silent overwrite — and the pipeline reads it back from there.
     */
    setSpilloverRatio: (ratio) =>
      Effect.gen(function* () {
        const state = yield* selfModel.snapshot
        const from = resolveSpilloverRatio(state)
        yield* selfModel.recordTuningChange(
          SPILLOVER_RATIO_PARAM,
          from,
          Math.min(1, Math.max(0, ratio)),
        )
      }),
  }

  return AscSelfMonitor.of(monitor)
})

type MonitorDeps =
  | DialState
  | SomaticProxies
  | StakeEstimator
  | AscSelfModel
  | OtherModelGuard
  | AscSelfNarration
  | AuxModel

/** Requires the six sibling services + the AuxModel seam. */
export const AscSelfMonitorLive: Layer.Layer<AscSelfMonitor, AscError, MonitorDeps> =
  Layer.effect(AscSelfMonitor, makeAscSelfMonitor)
