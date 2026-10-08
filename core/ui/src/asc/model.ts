/**
 * ASC panel slice — the foldkit Model for Track 2 of M8 (Foldkit desktop shell).
 *
 * This is the §3.1 `asc` slice: the current dial vector (READ-ONLY — dials are
 * computed, not chosen; there is no message and no command in this slice that
 * can mutate them), the latest archived DialComputation summaries, the
 * other-model guard flag feed, recent error-term firings, the capability map
 * (confidence vs. observed per domain), the L3 narrative excerpt, the
 * affect-tuning targets (paper §VII.C), and the expression-preview renderer
 * selection (abstract/avatar, §3.4).
 *
 * The slice is populated ONLY through the frozen ASCEngine boundary reads
 * (see `loadAscSlice`); the UI never reimplements ASC internals.
 */
import { Effect, Schema } from "effect"

import { ASCEngine } from "../../../asc-engine/engine.js"
import type { AscError } from "../../../asc-engine/errors-shim.js"

// --- bounded feed sizes -------------------------------------------------------

/** Archived dial computations kept for the sparkline history. */
export const DIAL_HISTORY_CAP = 50
/** Other-model guard classifications kept in the feed. */
export const GUARD_FEED_CAP = 30
/** Error-term firings kept in the feed. */
export const ERROR_FIRING_CAP = 30
/** L3 narrative entries shown in the excerpt. */
export const L3_EXCERPT_COUNT = 5
/** Affect-tuning change records kept in the slice log. */
export const TUNING_LOG_CAP = 50

// --- schema -------------------------------------------------------------------

/** The 4-vector as a plain view record. Mirrors the engine's DialVector. */
export const DialSummary = Schema.Struct({
  warmth: Schema.Number,
  playfulness: Schema.Number,
  intensity: Schema.Number,
  vulnerability: Schema.Number,
})
export type DialSummary = typeof DialSummary.Type

/** The dial names in display order (W, P, I, V). */
export const DIAL_NAMES = ["warmth", "playfulness", "intensity", "vulnerability"] as const
export type DialName = (typeof DIAL_NAMES)[number]

/**
 * A per-turn DialComputation, trimmed to what the panel displays. The full
 * record lives in the engine's archive; this is the read-only view summary.
 */
export const ArchivedComputation = Schema.Struct({
  id: Schema.String,
  turn: Schema.Number,
  at: Schema.String,
  finalDials: DialSummary,
  guardFired: Schema.Boolean,
  gated: Schema.Boolean,
  gateReason: Schema.String,
})
export type ArchivedComputation = typeof ArchivedComputation.Type

/** One other-model guard classification (operational language, never felt). */
export const GuardFlagEntry = Schema.Struct({
  turn: Schema.Number,
  at: Schema.String,
  fired: Schema.Boolean,
  driver: Schema.String,
  reason: Schema.String,
})
export type GuardFlagEntry = typeof GuardFlagEntry.Type

/** One error-term firing: claim vs. track record, correction applied. */
export const ErrorTermEntry = Schema.Struct({
  id: Schema.String,
  turn: Schema.Number,
  at: Schema.String,
  domain: Schema.String,
  claimConfidence: Schema.Number,
  observedConfidence: Schema.Number,
  correctedTo: Schema.Number,
})
export type ErrorTermEntry = typeof ErrorTermEntry.Type

/**
 * One capability-map domain: the L1 confidence plus the latest observed
 * confidence from the error-term firings (null when the error term has never
 * fired in this domain — honesty about what is measured vs. asserted).
 */
export const CapabilityEntry = Schema.Struct({
  confidence: Schema.Number,
  sampleCount: Schema.Number,
  lastUpdated: Schema.String,
  observed: Schema.NullOr(Schema.Number),
})
export type CapabilityEntry = typeof CapabilityEntry.Type

/** One L3 narrative entry, plain language, chronological. */
export const NarrativeExcerptEntry = Schema.Struct({
  id: Schema.String,
  turn: Schema.Number,
  at: Schema.String,
  text: Schema.String,
})
export type NarrativeExcerptEntry = typeof NarrativeExcerptEntry.Type

/**
 * One user-tunable affect parameter (paper §VII.C). `value` is the slice's
 * current target; the authoritative value lives in L1's affect-tuning record
 * (the frozen boundary does not expose it as a read — see `loadAscSlice`).
 */
export const TuningTarget = Schema.Struct({
  parameter: Schema.String,
  value: Schema.Number,
  min: Schema.Number,
  max: Schema.Number,
  step: Schema.Number,
  unit: Schema.String,
  description: Schema.String,
})
export type TuningTarget = typeof TuningTarget.Type

/** One confirmed affect-tuning change (the slice's audit trail). */
export const TuningChangeRecord = Schema.Struct({
  at: Schema.String,
  parameter: Schema.String,
  from: Schema.Number,
  to: Schema.Number,
})
export type TuningChangeRecord = typeof TuningChangeRecord.Type

/** A rejected tuning change — surfaced, never silently dropped. */
export const TuningError = Schema.Struct({
  at: Schema.String,
  parameter: Schema.String,
  reason: Schema.String,
})
export type TuningError = typeof TuningError.Type

/** The monthly diagnostic summary (paper §VII.C), as landed by JobRunner. */
export const DiagnosticSummary = Schema.Struct({
  at: Schema.String,
  passed: Schema.Number,
  total: Schema.Number,
  regressedDomains: Schema.Array(Schema.String),
})
export type DiagnosticSummary = typeof DiagnosticSummary.Type

/** The expression-preview renderer selection (§3.4). MVP ships abstract. */
export const RendererSelection = Schema.Literals(["abstract", "avatar"])
export type RendererSelection = typeof RendererSelection.Type

/** One FACS AU frame — the wire shape the channels fan-out produces. */
export const AUFrameSchema = Schema.Struct({
  browRaise: Schema.Number,
  browLower: Schema.Number,
  eyeOpen: Schema.Number,
  lidTighten: Schema.Number,
  smile: Schema.Number,
  mouthCornerDepress: Schema.Number,
  lipPress: Schema.Number,
  jawDrop: Schema.Number,
  headTiltDeg: Schema.Number,
})
export type AUFrame = typeof AUFrameSchema.Type

/** The full ASC view slice (§3.1 `asc`). */
export const AscSlice = Schema.Struct({
  /** Live dial vector, READ-ONLY. Only the ASC pipeline writes dials. */
  dials: DialSummary,
  dialHistory: Schema.Array(ArchivedComputation),
  guardFeed: Schema.Array(GuardFlagEntry),
  errorFirings: Schema.Array(ErrorTermEntry),
  capabilityMap: Schema.Record(Schema.String, CapabilityEntry),
  l3Excerpt: Schema.Array(NarrativeExcerptEntry),
  tuning: Schema.Array(TuningTarget),
  tuningLog: Schema.Array(TuningChangeRecord),
  tuningError: Schema.NullOr(TuningError),
  diagnostic: Schema.NullOr(DiagnosticSummary),
  renderer: RendererSelection,
  interfaceVersion: Schema.String,
  /**
   * Live expression override: while a voice turn plays, the channels
   * fan-out drives the preview through the utterance's AU timeline instead
   * of the dial-derived frame. Cleared when speech ends — the dials (the
   * ASC truth) take over again.
   */
  expressionFrame: Schema.optional(AUFrameSchema),
})
export type AscSlice = typeof AscSlice.Type

// --- tuning parameter definitions (paper §VII.C) ------------------------------

/**
 * The four paper §VII.C tuning parameters with their defaults and ranges.
 *
 * Live-consumption note (honest, not aspirational):
 * - `spilloverRatio` and `errorTermLambda` are consumed live by the current
 *   engine: the L2 pipeline reads the spillover ratio from L1's tuning record
 *   every turn, and the error term reads λ from the live targets.
 * - `proxyWeightScale` and `diagnosticCadenceDays` are recorded to the
 *   auditable L1 affect-tuning record through the same seam; the proxy
 *   pipeline and the JobRunner monthly diagnostic consume them at
 *   integration. They are shown as targets, not as live dials.
 */
export const TUNING_TARGETS: ReadonlyArray<TuningTarget> = [
  {
    parameter: "spilloverRatio",
    value: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
    unit: "",
    description:
      "Affective persistence blend: share of the prior register carried into this turn (paper default 0.5 = 50/50). Live in the L2 pipeline.",
  },
  {
    parameter: "errorTermLambda",
    value: 0.3,
    min: 0,
    max: 0.9,
    step: 0.01,
    unit: "",
    description:
      "Error-term decay λ: higher = corrections land softer (paper default 0.3). Live in the error term.",
  },
  {
    parameter: "proxyWeightScale",
    value: 1.0,
    min: 0,
    max: 2,
    step: 0.05,
    unit: "×",
    description:
      "Proxy evidence weight scale: how strongly somatic proxies shift dials (paper defaults = 1×). Recorded; consumed by the proxy pipeline at integration.",
  },
  {
    parameter: "diagnosticCadenceDays",
    value: 30,
    min: 7,
    max: 90,
    step: 1,
    unit: "days",
    description:
      "Diagnostic re-run cadence for the 16-item checklist (paper default: monthly). Recorded; consumed by the JobRunner diagnostic at integration.",
  },
]

/** The slice before any engine reads: neutral dials, paper-default tuning. */
export const initialAscSlice: AscSlice = {
  dials: { warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 },
  dialHistory: [],
  guardFeed: [],
  errorFirings: [],
  capabilityMap: {},
  l3Excerpt: [],
  tuning: [...TUNING_TARGETS],
  tuningLog: [],
  tuningError: null,
  diagnostic: null,
  renderer: "abstract",
  interfaceVersion: "unloaded",
}

// --- loading from the frozen boundary ----------------------------------------

/**
 * Build the slice from the live ASCEngine boundary reads. Reads ONLY through
 * the seven frozen reads (`currentDials`, `dialHistory`, `errorTermFirings`,
 * `guardFlags`, `narrative`, `capabilityMap`, `interfaceVersion`).
 *
 * Tuning targets initialize from the paper defaults: the frozen boundary
 * intentionally exposes no tuning-target read (rich-READ covers ASC state;
 * the tuning record is write-audited through `recordEvidence`), so the slice
 * tracks confirmed changes via `TuningChangeRecorded` instead.
 */
export const loadAscSlice: Effect.Effect<AscSlice, AscError, ASCEngine> = Effect.gen(
  function* () {
    const engine = yield* ASCEngine
    const [dials, history, firings, guards, narrative, capabilities, version] =
      yield* Effect.all(
        [
          engine.currentDials,
          engine.dialHistory(DIAL_HISTORY_CAP),
          engine.errorTermFirings(ERROR_FIRING_CAP),
          engine.guardFlags(GUARD_FEED_CAP),
          engine.narrative(L3_EXCERPT_COUNT),
          engine.capabilityMap,
          engine.interfaceVersion,
        ],
        { concurrency: "unbounded" },
      )

    // Latest observed confidence per domain, from the error-term firings.
    const observedByDomain = new Map<string, number>()
    for (const firing of firings) {
      observedByDomain.set(firing.domain, firing.observedConfidence)
    }

    const capabilityMap: Record<string, CapabilityEntry> = {}
    for (const [domain, entry] of Object.entries(capabilities)) {
      capabilityMap[domain] = {
        confidence: entry.confidence,
        sampleCount: entry.sampleCount,
        lastUpdated: entry.lastUpdated,
        observed: observedByDomain.get(domain) ?? null,
      }
    }

    const byTurnDesc = <A extends { turn: number }>(xs: ReadonlyArray<A>): Array<A> =>
      [...xs].sort((a, b) => b.turn - a.turn)

    return {
      dials: {
        warmth: dials.warmth,
        playfulness: dials.playfulness,
        intensity: dials.intensity,
        vulnerability: dials.vulnerability,
      },
      dialHistory: history.map((c) => ({
        id: c.id,
        turn: c.turn,
        at: c.at,
        finalDials: {
          warmth: c.finalDials.warmth,
          playfulness: c.finalDials.playfulness,
          intensity: c.finalDials.intensity,
          vulnerability: c.finalDials.vulnerability,
        },
        guardFired: c.guard.fired,
        gated: c.gated.gated,
        gateReason: c.gated.reason,
      })),
      guardFeed: byTurnDesc(guards).map((g) => ({
        turn: g.turn,
        at: g.at,
        fired: g.fired,
        driver: g.driver,
        reason: g.reason,
      })),
      errorFirings: byTurnDesc(firings).map((f) => ({
        id: f.id,
        turn: f.turn,
        at: f.at,
        domain: f.domain,
        claimConfidence: f.claimConfidence,
        observedConfidence: f.observedConfidence,
        correctedTo: f.correctedTo,
      })),
      capabilityMap,
      l3Excerpt: narrative.slice(-L3_EXCERPT_COUNT).map((n) => ({
        id: n.id,
        turn: n.turn,
        at: n.at,
        text: n.text,
      })),
      tuning: [...TUNING_TARGETS],
      tuningLog: [],
      tuningError: null,
      diagnostic: null,
      renderer: "abstract",
      interfaceVersion: version,
    }
  },
)
