import { Context, Effect, Layer, Option, Ref, Schema } from "effect"

import { AscError } from "./errors-shim.js"
import { L1_STORAGE_KEY, MemoryReader } from "./seams.js"

// ---------------------------------------------------------------------------
// AscSelfModel — L1 persistent state (paper §III.A).
//
// Schema-defined records, keyed by install UUID (Part 02) in production;
// here keyed under L1_STORAGE_KEY via the MemoryReader seam. Holds:
//   - capability map: domain -> { confidence 0-10, sampleCount, lastUpdated, lastSurprise }
//   - track record: domain -> task outcomes (the error term's input, §III.G)
//   - domain freshness: subject -> { confidence, freshness, halfLifeDays,
//     lastTouched } — freshness decays exponentially between touches
//   - stake-estimator parameters: per-domain stake priors + the ζ calibration
//     record (the ε² correction audit trail, §III.J / §VIII.C)
//   - affect-tuning record: user tuning choices + history (auditable) AND the
//     live tuning targets (parameter -> value) the tuning seam writes through
//     recordEvidence({ kind: "tuningChange" })
//   - guard-fire frequency (other-model capture calibration signal, §VII.D.4)
//
// Update discipline: error-term firings adjust the model toward the track
// record, weighted by recency, confidence, and SAMPLE SIZE (paper §VII.D
// failure mode 2): a thin track record must not collapse confidence — the
// correction weight n/(n+k) keeps thin-record corrections small. The error
// term is a correction signal, not a punishment: it fires SYMMETRICALLY,
// whether the claim overshoots or undershoots the track record, moving the
// claim toward the observed value without overshooting (rate < 1 by
// construction). The tuning-seam λ (default 0.3, paper §VII.C) scales the
// effective learning rate: α·(1−λ)·w — the user's "corrects too slowly /
// too fast" dial. Updates are VERSIONED — the prior value is retained in
// the revision log, never silently overwritten (unattended-write discipline:
// autonomous updates may add, never replace without provenance).
// ---------------------------------------------------------------------------

const Confidence = Schema.Number.pipe(
  Schema.refine((n): n is number => Number.isFinite(n) && n >= 0 && n <= 10, {
    message: "confidence out of bounds [0,10]",
  }),
)
const NonNegativeInt = Schema.Number.pipe(
  Schema.refine((n): n is number => Number.isInteger(n) && n >= 0, {
    message: "expected non-negative integer",
  }),
)
const UnitInterval = Schema.Number.pipe(
  Schema.refine((n): n is number => Number.isFinite(n) && n >= 0 && n <= 1, {
    message: "expected value in [0,1]",
  }),
)

const CapabilityEntry = Schema.Struct({
  confidence: Confidence,
  sampleCount: NonNegativeInt,
  lastUpdated: Schema.String,
  lastSurprise: Schema.Number,
})
export type CapabilityEntry = Schema.Schema.Type<typeof CapabilityEntry>

const SurpriseRecord = Schema.Struct({
  ed: Schema.Number,
  at: Schema.String,
})

const TrackRecordEntry = Schema.Struct({
  successes: NonNegativeInt,
  misses: NonNegativeInt,
  surprises: Schema.Array(SurpriseRecord),
  receipts: Schema.Array(Schema.String),
})
export type TrackRecordEntry = Schema.Schema.Type<typeof TrackRecordEntry>

const DomainFreshness = Schema.Struct({
  confidence: Confidence,
  /** Stored freshness at lastTouched; decays exponentially on read. */
  freshness: UnitInterval,
  halfLifeDays: Schema.Number,
  lastTouched: Schema.optional(Schema.String),
})
export type DomainFreshness = Schema.Schema.Type<typeof DomainFreshness>

const TuningChange = Schema.Struct({
  at: Schema.String,
  parameter: Schema.String,
  from: Schema.Number,
  to: Schema.Number,
})
export type TuningChange = Schema.Schema.Type<typeof TuningChange>

/**
 * ζ calibration record (paper §III.J, §VIII.C): the second-order error ε²
 * audit trail — what stake was computed vs. what was actually needed, per
 * domain. The ζ parameters themselves live in the StakeEstimator service;
 * L1 keeps this record so the calibration is auditable.
 */
const ZetaCalibrationRecord = Schema.Struct({
  at: Schema.String,
  domain: Schema.String,
  computed: UnitInterval,
  actual: UnitInterval,
  epsilonSquared: Schema.Number,
})
export type ZetaCalibrationRecord = Schema.Schema.Type<typeof ZetaCalibrationRecord>

const Revision = Schema.Struct({
  version: NonNegativeInt,
  at: Schema.String,
  change: Schema.String,
  previous: Schema.String,
})

const SelfModelState = Schema.Struct({
  version: NonNegativeInt,
  capabilities: Schema.Record(Schema.String, CapabilityEntry),
  trackRecord: Schema.Record(Schema.String, TrackRecordEntry),
  freshness: Schema.Record(Schema.String, DomainFreshness),
  stakePriors: Schema.Record(Schema.String, UnitInterval),
  /** ε² calibration audit trail (second-order stake error, §III.J). */
  zetaCalibration: Schema.Array(ZetaCalibrationRecord),
  tuningChanges: Schema.Array(TuningChange),
  /** Live tuning targets: parameter -> value (the tuning seam's current state). */
  tuningTargets: Schema.Record(Schema.String, Schema.Number),
  guardFireCount: NonNegativeInt,
  revisions: Schema.Array(Revision),
})
export type SelfModelState = Schema.Schema.Type<typeof SelfModelState>

export interface ErrorTermFiring {
  readonly id: string
  readonly turn: number
  readonly at: string
  readonly domain: string
  readonly claimConfidence: number
  readonly observedConfidence: number
  readonly sampleWeight: number
  readonly recencyWeight: number
  readonly correctedTo: number
}

/** Error-term learning-rate analog (paper §III.J: α typically 0.1–0.2). */
export const ERROR_TERM_ALPHA = 0.15
/** Sample-size constant for the over-calibration guard weight n/(n+k). */
export const ERROR_TERM_SAMPLE_K = 5
/** Gap |claim − observed| above which the error term fires (symmetric). */
export const ERROR_TERM_FIRE_THRESHOLD = 1.5
/** Recency half-life in days for correction weighting. */
export const ERROR_TERM_RECENCY_HALFLIFE_DAYS = 30
/**
 * Tuning-seam key for the error-term decay λ (paper §VII.C: "Error term
 * decay: Exponential, λ=0.3"). The effective correction rate is
 * α·(1−λ)·sampleWeight·recencyWeight — the user's "corrects too slowly /
 * too fast" dial. Tunable via recordEvidence({ kind: "tuningChange" }).
 */
export const ERROR_TERM_LAMBDA_KEY = "errorTermLambda"
/** Paper default λ = 0.3 (VII.C). */
export const ERROR_TERM_LAMBDA_DEFAULT = 0.3
/** Hard ceiling: λ < 1 always leaves a non-zero correction rate. */
export const ERROR_TERM_LAMBDA_MAX = 0.9
/** Revision log cap (bounded growth). */
export const REVISION_CAP = 50
/** Tuning-history cap (bounded growth; the record is audit, not archive). */
export const TUNING_HISTORY_CAP = 200
/** ζ calibration-record cap (bounded growth). */
export const ZETA_CALIBRATION_CAP = 50
/** Default knowledge-freshness half-life in days when a subject is first touched. */
export const DEFAULT_FRESHNESS_HALFLIFE_DAYS = 30

const nowIso = (): string => new Date().toISOString()

const emptyState = (): SelfModelState => ({
  version: 0,
  capabilities: {},
  trackRecord: {},
  freshness: {},
  stakePriors: {},
  zetaCalibration: [],
  tuningChanges: [],
  tuningTargets: {},
  guardFireCount: 0,
  revisions: [],
})

const decodeState = (json: string): Effect.Effect<SelfModelState, AscError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(SelfModelState)(JSON.parse(json)),
    catch: (cause) => new AscError({ reason: `L1 self-model state failed validation: ${String(cause)}` }),
  })

const encodeState = (state: SelfModelState): Effect.Effect<string, AscError> =>
  Effect.try({
    try: () => JSON.stringify(Schema.encodeSync(SelfModelState)(state)),
    catch: (cause) => new AscError({ reason: `L1 self-model state failed encoding: ${String(cause)}` }),
  })

export interface OutcomeInput {
  readonly success: boolean
  /** Epistemic-disruption value of a surprise, when this outcome surprised. */
  readonly surpriseED?: number | undefined
  /** Verification receipt id attaching evidence to the claim. */
  readonly receiptId?: string | undefined
}

export interface ErrorTermEvaluation {
  readonly fired: boolean
  readonly domain: string
  readonly claimConfidence: number
  readonly observedConfidence: number
  readonly sampleWeight: number
  readonly recencyWeight: number
  readonly gap: number
  /** Live λ from the tuning targets (paper §VII.C). */
  readonly lambda: number
  /** Effective correction rate: α·(1−λ)·sampleWeight·recencyWeight (< 1, no overshoot). */
  readonly rate: number
}

const recencyWeight = (lastUpdatedIso: string): number => {
  const ageMs = Date.now() - Date.parse(lastUpdatedIso)
  const ageDays = Math.max(0, ageMs / 86_400_000)
  return Math.max(0.25, Math.pow(0.5, ageDays / ERROR_TERM_RECENCY_HALFLIFE_DAYS))
}

/** Live λ from the tuning targets, clamped to [0, λ_max]. */
const errorTermLambda = (state: SelfModelState): number => {
  const raw = state.tuningTargets[ERROR_TERM_LAMBDA_KEY] ?? ERROR_TERM_LAMBDA_DEFAULT
  return Math.min(ERROR_TERM_LAMBDA_MAX, Math.max(0, raw))
}

export interface FreshnessInput {
  readonly confidence?: number | undefined
  readonly halfLifeDays?: number | undefined
}

export interface FreshnessReading {
  readonly confidence: number
  /** Freshness decayed by 2^(−ageDays/halfLifeDays) since last touch. */
  readonly freshness: number
  readonly halfLifeDays: number
}

export interface AscSelfModelShape {
  /** Load from MemoryReader; initialize defaults when absent. */
  readonly load: Effect.Effect<void, AscError>
  /** Persist current state. */
  readonly persist: Effect.Effect<void, AscError>
  /** Full state snapshot (internal reads). */
  readonly snapshot: Effect.Effect<SelfModelState, AscError>
  /** Capability-map snapshot for the frozen boundary (confidence/sampleCount/lastUpdated). */
  readonly capabilityMap: Effect.Effect<
    Readonly<Record<string, { confidence: number; sampleCount: number; lastUpdated: string }>>,
    AscError
  >
  readonly capability: (domain: string) => Effect.Effect<CapabilityEntry | undefined, AscError>
  /** Record a task outcome into the track record (versioned). */
  readonly recordOutcome: (domain: string, outcome: OutcomeInput) => Effect.Effect<void, AscError>
  /**
   * Record a surprise (epistemic disruption) WITHOUT fabricating a
   * success/miss outcome — surprises are evidence, not verdicts.
   */
  readonly recordSurprise: (domain: string, epistemicDisruption: number) => Effect.Effect<void, AscError>
  /** Evaluate the error term: claim vs. track record. */
  readonly evaluateErrorTerm: (domain: string) => Effect.Effect<ErrorTermEvaluation, AscError>
  /**
   * Apply an error-term correction: move confidence toward the observed
   * track-record value (from either side — the term fires on over- AND
   * under-confidence), weighted by sample size (over-calibration guard),
   * recency, and the tuning-seam λ. Returns the firing record; no-op when
   * the term doesn't fire. The rate is < 1 by construction: the claim can
   * never overshoot the track record in a single step.
   */
  readonly applyErrorTermCorrection: (
    domain: string,
    turn: number,
  ) => Effect.Effect<ErrorTermFiring | undefined, AscError>
  /** Other-model guard fired this turn — persistent calibration signal. */
  readonly recordGuardFire: Effect.Effect<void, AscError>
  readonly guardFireCount: Effect.Effect<number, AscError>
  /**
   * User tuning choice (paper §VII.C) — auditable, versioned. Appends to the
   * tuning history AND sets the live tuning target (never a silent overwrite:
   * the previous target is captured in the revision log). Live targets drive
   * the error term (errorTermLambda), spillover (via the L2 pipeline), etc.
   */
  readonly recordTuningChange: (
    parameter: string,
    from: number,
    to: number,
  ) => Effect.Effect<void, AscError>
  /** Auditable tuning history, newest last. */
  readonly tuningHistory: (limit?: number) => Effect.Effect<ReadonlyArray<TuningChange>, AscError>
  /** Live tuning targets (parameter -> value), as set by the tuning seam. */
  readonly tuningTargets: Effect.Effect<Readonly<Record<string, number>>, AscError>
  /**
   * Touch domain knowledge: refresh a subject's freshness (paper §III.A).
   * Freshness decays exponentially (half-life per subject) between touches.
   */
  readonly touchFreshness: (
    subject: string,
    input: FreshnessInput,
  ) => Effect.Effect<void, AscError>
  /** Freshness reading with time-decayed freshness, or undefined. */
  readonly getFreshness: (
    subject: string,
  ) => Effect.Effect<FreshnessReading | undefined, AscError>
  /**
   * Record a ζ (stake-estimation) calibration — the second-order error ε²
   * audit trail (paper §III.J, §VIII.C). The ζ parameters themselves live in
   * the StakeEstimator service; L1 keeps the auditable record.
   */
  readonly recordZetaCalibration: (
    domain: string,
    computed: number,
    actual: number,
    epsilonSquared: number,
  ) => Effect.Effect<void, AscError>
  /** ζ calibration records, newest last. */
  readonly zetaCalibration: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ZetaCalibrationRecord>, AscError>
  readonly getStakePriors: Effect.Effect<Readonly<Record<string, number>>, AscError>
  readonly updateStakePriors: (priors: Readonly<Record<string, number>>) => Effect.Effect<void, AscError>
  readonly errorTermFirings: (limit?: number) => Effect.Effect<ReadonlyArray<ErrorTermFiring>, AscError>
}

export class AscSelfModel extends Context.Service<AscSelfModel, AscSelfModelShape>()(
  "aimy/AscSelfModel",
) {}

export const makeAscSelfModel = Effect.gen(function* () {
  const memory = yield* MemoryReader
  const stateRef = yield* Ref.make<SelfModelState>(emptyState())
  const firingsRef = yield* Ref.make<ReadonlyArray<ErrorTermFiring>>([])
  /** Monotonic firing sequence — firing ids are unique, not just per-turn. */
  const firingSeqRef = yield* Ref.make(0)

  const bump = (
    state: SelfModelState,
    change: string,
    previous: string,
  ): SelfModelState => ({
    ...state,
    version: state.version + 1,
    revisions: [
      ...state.revisions.slice(-(REVISION_CAP - 1)),
      { version: state.version + 1, at: nowIso(), change, previous },
    ],
  })

  const load = Effect.gen(function* () {
    const raw = yield* memory.read(L1_STORAGE_KEY)
    if (Option.isNone(raw)) {
      yield* Ref.set(stateRef, emptyState())
      return
    }
    const state = yield* decodeState(raw.value)
    yield* Ref.set(stateRef, state)
  })

  const persist = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef)
    const json = yield* encodeState(state)
    yield* memory.write(L1_STORAGE_KEY, json)
  })

  const evaluate = (state: SelfModelState, domain: string): ErrorTermEvaluation => {
    const cap = state.capabilities[domain]
    const tr = state.trackRecord[domain]
    const n = tr ? tr.successes + tr.misses : 0
    const lambda = errorTermLambda(state)
    if (!cap || !tr || n === 0) {
      return {
        fired: false,
        domain,
        claimConfidence: cap?.confidence ?? 0,
        observedConfidence: 0,
        sampleWeight: 0,
        recencyWeight: 0,
        gap: 0,
        lambda,
        rate: 0,
      }
    }
    const observed = (10 * tr.successes) / n
    const gap = cap.confidence - observed
    const sampleWeight = n / (n + ERROR_TERM_SAMPLE_K)
    const wRecency = recencyWeight(cap.lastUpdated)
    // Symmetric firing: the term corrects overconfidence AND underconfidence.
    // The correction rate stays < 1 by construction, so the claim can never
    // overshoot the track record in a single step.
    return {
      fired: Math.abs(gap) > ERROR_TERM_FIRE_THRESHOLD,
      domain,
      claimConfidence: cap.confidence,
      observedConfidence: observed,
      sampleWeight,
      recencyWeight: wRecency,
      gap,
      lambda,
      rate: ERROR_TERM_ALPHA * (1 - lambda) * sampleWeight * wRecency,
    }
  }

  return AscSelfModel.of({
    load,
    persist,
    snapshot: Ref.get(stateRef),
    capabilityMap: Effect.map(Ref.get(stateRef), (state) =>
      Object.fromEntries(
        Object.entries(state.capabilities).map(([domain, cap]) => [
          domain,
          { confidence: cap.confidence, sampleCount: cap.sampleCount, lastUpdated: cap.lastUpdated },
        ]),
      )),
    capability: (domain) => Effect.map(Ref.get(stateRef), (state) => state.capabilities[domain]),
    recordOutcome: (domain, outcome) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const prev = state.trackRecord[domain] ?? {
          successes: 0,
          misses: 0,
          surprises: [],
          receipts: [],
        }
        const next: TrackRecordEntry = {
          successes: prev.successes + (outcome.success ? 1 : 0),
          misses: prev.misses + (outcome.success ? 0 : 1),
          surprises: outcome.surpriseED !== undefined
            ? [...prev.surprises, { ed: outcome.surpriseED, at: nowIso() }].slice(-50)
            : prev.surprises,
          receipts: outcome.receiptId ? [...prev.receipts, outcome.receiptId].slice(-50) : prev.receipts,
        }
        // First observation seeds the capability entry at a neutral 5 with
        // the observed outcome as its first sample — a claim anchored in
        // evidence, not a guess. Every outcome is a capability sample.
        const capPrev = state.capabilities[domain]
        const capabilities: Record<string, CapabilityEntry> = capPrev
          ? {
            ...state.capabilities,
            [domain]: {
              ...capPrev,
              sampleCount: capPrev.sampleCount + 1,
              lastUpdated: nowIso(),
            },
          }
          : {
            ...state.capabilities,
            [domain]: {
              confidence: 5,
              sampleCount: 1,
              lastUpdated: nowIso(),
              lastSurprise: 0,
            } satisfies CapabilityEntry,
          }
        yield* Ref.set(
          stateRef,
          bump(
            { ...state, trackRecord: { ...state.trackRecord, [domain]: next }, capabilities },
            `recordOutcome(${domain}, success=${outcome.success})`,
            JSON.stringify(prev),
          ),
        )
      }),
    recordSurprise: (domain, epistemicDisruption) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const prev = state.trackRecord[domain] ?? {
          successes: 0,
          misses: 0,
          surprises: [],
          receipts: [],
        }
        const next: TrackRecordEntry = {
          ...prev,
          surprises: [...prev.surprises, { ed: epistemicDisruption, at: nowIso() }].slice(-50),
        }
        const capPrev = state.capabilities[domain]
        const capabilities = capPrev
          ? {
            ...state.capabilities,
            [domain]: { ...capPrev, lastSurprise: epistemicDisruption, lastUpdated: nowIso() },
          }
          : state.capabilities
        yield* Ref.set(
          stateRef,
          bump(
            { ...state, trackRecord: { ...state.trackRecord, [domain]: next }, capabilities },
            `recordSurprise(${domain}, ed=${epistemicDisruption})`,
            JSON.stringify(prev.surprises[prev.surprises.length - 1] ?? null),
          ),
        )
      }),
    evaluateErrorTerm: (domain) => Effect.map(Ref.get(stateRef), (state) => evaluate(state, domain)),
    applyErrorTermCorrection: (domain, turn) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const ev = evaluate(state, domain)
        if (!ev.fired) return undefined
        const cap = state.capabilities[domain]
        if (!cap) return undefined
        // rate < 1 by construction: the claim moves toward the observed
        // value but can never overshoot it in a single step. Correction is a
        // signal, not a punishment — the model is calibrated, not penalized.
        const correctedTo = Math.min(
          10,
          Math.max(0, cap.confidence + ev.rate * (ev.observedConfidence - cap.confidence)),
        )
        const previous = JSON.stringify(cap)
        const nextCap: CapabilityEntry = { ...cap, confidence: correctedTo, lastUpdated: nowIso() }
        yield* Ref.set(
          stateRef,
          bump(
            {
              ...state,
              capabilities: { ...state.capabilities, [domain]: nextCap },
            },
            `errorTerm correction(${domain}): ${cap.confidence.toFixed(2)} -> ${correctedTo.toFixed(2)} (rate=${ev.rate.toFixed(4)}, λ=${ev.lambda.toFixed(2)})`,
            previous,
          ),
        )
        const seq = yield* Ref.getAndUpdate(firingSeqRef, (n) => n + 1)
        const firing: ErrorTermFiring = {
          id: `err-t${turn}-${domain}-s${seq}`,
          turn,
          at: nowIso(),
          domain,
          claimConfidence: ev.claimConfidence,
          observedConfidence: ev.observedConfidence,
          sampleWeight: ev.sampleWeight,
          recencyWeight: ev.recencyWeight,
          correctedTo,
        }
        yield* Ref.update(firingsRef, (fs) => [...fs, firing].slice(-200))
        return firing
      }),
    recordGuardFire: Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      yield* Ref.set(
        stateRef,
        bump(
          { ...state, guardFireCount: state.guardFireCount + 1 },
          "guardFire",
          `count=${state.guardFireCount}`,
        ),
      )
    }),
    guardFireCount: Effect.map(Ref.get(stateRef), (s) => s.guardFireCount),
    recordTuningChange: (parameter, from, to) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const change = { at: nowIso(), parameter, from, to }
        const previousTarget = state.tuningTargets[parameter]
        yield* Ref.set(
          stateRef,
          bump(
            {
              ...state,
              tuningChanges: [...state.tuningChanges, change].slice(-TUNING_HISTORY_CAP),
              // The live target moves WITH the history entry — auditable,
              // never a silent overwrite. The revision log captures the
              // previous target, so every change has provenance.
              tuningTargets: { ...state.tuningTargets, [parameter]: to },
            },
            `tuningChange(${parameter}: ${from} -> ${to})`,
            JSON.stringify({
              previousTarget: previousTarget ?? null,
              lastChange: state.tuningChanges[state.tuningChanges.length - 1] ?? null,
            }),
          ),
        )
      }),
    tuningHistory: (limit = 50) =>
      Effect.map(Ref.get(stateRef), (s) => s.tuningChanges.slice(-Math.max(1, limit))),
    tuningTargets: Effect.map(Ref.get(stateRef), (s) => s.tuningTargets),
    touchFreshness: (subject, input) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const prev = state.freshness[subject]
        const confidence = Math.min(
          10,
          Math.max(0, input.confidence ?? prev?.confidence ?? 5),
        )
        const next: DomainFreshness = {
          confidence,
          freshness: 1,
          halfLifeDays: Math.max(
            1,
            input.halfLifeDays ?? prev?.halfLifeDays ?? DEFAULT_FRESHNESS_HALFLIFE_DAYS,
          ),
          lastTouched: nowIso(),
        }
        yield* Ref.set(
          stateRef,
          bump(
            { ...state, freshness: { ...state.freshness, [subject]: next } },
            `touchFreshness(${subject})`,
            JSON.stringify(prev ?? null),
          ),
        )
      }),
    getFreshness: (subject) =>
      Effect.map(Ref.get(stateRef), (state): FreshnessReading | undefined => {
        const f = state.freshness[subject]
        if (!f) return undefined
        let decayed = f.freshness
        if (f.lastTouched) {
          const ageDays = Math.max(0, (Date.now() - Date.parse(f.lastTouched)) / 86_400_000)
          decayed = f.freshness * Math.pow(0.5, ageDays / f.halfLifeDays)
        }
        return { confidence: f.confidence, freshness: decayed, halfLifeDays: f.halfLifeDays }
      }),
    recordZetaCalibration: (domain, computed, actual, epsilonSquared) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const entry: ZetaCalibrationRecord = {
          at: nowIso(),
          domain,
          computed: Math.min(1, Math.max(0, computed)),
          actual: Math.min(1, Math.max(0, actual)),
          epsilonSquared: Math.max(0, epsilonSquared),
        }
        yield* Ref.set(
          stateRef,
          bump(
            {
              ...state,
              zetaCalibration: [...state.zetaCalibration, entry].slice(-ZETA_CALIBRATION_CAP),
            },
            `zetaCalibration(${domain}): computed=${entry.computed.toFixed(2)} actual=${entry.actual.toFixed(2)} ε²=${entry.epsilonSquared.toFixed(4)}`,
            `records=${state.zetaCalibration.length}`,
          ),
        )
      }),
    zetaCalibration: (limit = 50) =>
      Effect.map(Ref.get(stateRef), (s) => s.zetaCalibration.slice(-Math.max(1, limit))),
    getStakePriors: Effect.map(Ref.get(stateRef), (s) => s.stakePriors),
    updateStakePriors: (priors) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        yield* Ref.set(
          stateRef,
          bump(
            { ...state, stakePriors: { ...priors } },
            "stakePriors update",
            JSON.stringify(state.stakePriors),
          ),
        )
      }),
    errorTermFirings: (limit = 50) =>
      Effect.map(Ref.get(firingsRef), (fs) => fs.slice(-Math.max(1, limit))),
  })
})

/** Requires MemoryReader in the environment (integration seam). */
export const AscSelfModelLive: Layer.Layer<AscSelfModel, AscError, MemoryReader> =
  Layer.effect(AscSelfModel, makeAscSelfModel)
