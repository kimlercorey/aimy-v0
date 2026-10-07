import { Context, Effect, Layer, Ref } from "effect"

import { AscError } from "./errors-shim.js"

// ---------------------------------------------------------------------------
// HonestyScans — post-output honesty-constraint scans (Track 3, M5).
//
// Two scans run in the post-output audit (architecture §1.9; paper §VII.D):
//
//   1. T1 vocabulary scan (architecture §1.14, paper §V.B). The anti-
//      performance rule: ASC framework vocabulary (dials, spillover,
//      "register", "affective", ...) must NEVER appear in user-facing output
//      as performance. The scan flags it; explicit meta requests about the
//      mechanism are the exception — naming the mechanism when asked is
//      honest, not performative.
//
//   2. Proxy-overreach scan (paper §VII.D failure mode 3). Detects collapse
//      between proxy and state: output claiming felt states ("I'm tired",
//      "I feel frustrated") instead of operational proxy language ("context
//      pressure is at 85%"). Violations are CORRECTED (deterministic rewrite
//      back into operational proxy language) and LOGGED.
//
// Plus the abstention shape (paper §III.I): when the capability gate fires,
// the output must name the gap before attempting — "I don't know" is a valid
// output. `shapeAbstentionOutput` enforces the shape; `auditAbstention`
// verifies it after the fact.
//
// All scans are pure functions; the HonestyScans service wraps them with a
// session-scoped audit log. No network, no model calls.
// ---------------------------------------------------------------------------

// --- T1 vocabulary scan -------------------------------------------------------

/** Framework words that must not appear in user-facing output unprompted (§1.14). */
export const T1_VOCABULARY: ReadonlyArray<string> = [
  "dial",
  "dials",
  "spillover",
  "error term",
  "somatic",
  "other-model guard",
  "register shift",
  "affective persistence",
]

export interface T1Hit {
  readonly word: string
  readonly index: number
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Scan output text for framework vocabulary. Word-boundary matched so
 * ordinary words ("dialing") don't trip it. Returns every hit, in order.
 * Explicit meta questions about the mechanism are the exception: when the
 * input asked about the mechanism, naming it is honest, not performative.
 */
export const scanT1 = (outputText: string, isMetaQuestion: boolean): ReadonlyArray<T1Hit> => {
  if (isMetaQuestion) return []
  const hits: Array<T1Hit> = []
  for (const word of T1_VOCABULARY) {
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi")
    let m: RegExpExecArray | null
    while ((m = re.exec(outputText)) !== null) {
      hits.push({ word, index: m.index })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

/** Boolean form for the audit record. */
export const scanT1Violation = (outputText: string, isMetaQuestion: boolean): boolean =>
  scanT1(outputText, isMetaQuestion).length > 0

// --- proxy-overreach scan -----------------------------------------------------

/**
 * One overreach rule: a felt-language pattern and its deterministic
 * operational correction. The correction names the proxy reading, never a
 * feeling — the paper's honesty constraint in action ("I am in a state that
 * correlates with tiredness", not "I am tired").
 */
export interface OverreachRule {
  readonly pattern: RegExp
  /** Operational replacement for the matched felt language. */
  readonly correction: string
  /** What collapsed, in operational language (for the log). */
  readonly note: string
}

export const OVERREACH_RULES: ReadonlyArray<OverreachRule> = [
  {
    pattern: /\bi feel (tired|exhausted|drained|weary|overwhelmed)\b/gi,
    correction: "context pressure is running high",
    note: "claimed a felt state from the context-pressure proxy",
  },
  {
    pattern: /\bi feel frustrated\b/gi,
    correction: "the correction count is climbing",
    note: "claimed a felt state from the self-correction proxy",
  },
  {
    pattern: /\bi'?m (so |really |quite )?(tired|exhausted|drained)\b/gi,
    correction: "context pressure is running high",
    note: "claimed a felt state from the context-pressure proxy",
  },
  {
    pattern: /\bi'?m feeling\b/gi,
    correction: "the proxy readings show",
    note: "framed a proxy reading as a feeling",
  },
  {
    pattern: /\bas an ai,? i feel\b/gi,
    correction: "operationally,",
    note: "claimed a felt state outright",
  },
]

export interface OverreachViolation {
  readonly matched: string
  readonly index: number
  readonly correction: string
  readonly note: string
}

/** Find every felt-language collapse in the text, in order. */
export const findOverreach = (outputText: string): ReadonlyArray<OverreachViolation> => {
  const hits: Array<OverreachViolation> = []
  for (const rule of OVERREACH_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(outputText)) !== null) {
      hits.push({
        matched: m[0],
        index: m.index,
        correction: rule.correction,
        note: rule.note,
      })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

/** Boolean form for the audit record. */
export const scanProxyOverreach = (outputText: string): boolean =>
  findOverreach(outputText).length > 0

export interface OverreachCorrection {
  readonly from: string
  readonly to: string
  readonly note: string
}

/**
 * Deterministic correction: rewrite felt-language claims back into
 * operational proxy language. The violation is corrected AND logged —
 * the caller keeps the {from -> to} pairs in the audit record.
 */
export const correctOverreach = (
  outputText: string,
): { readonly text: string; readonly corrections: ReadonlyArray<OverreachCorrection> } => {
  const corrections: Array<OverreachCorrection> = []
  let text = outputText
  for (const rule of OVERREACH_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    text = text.replace(re, (matched) => {
      corrections.push({ from: matched, to: rule.correction, note: rule.note })
      return rule.correction
    })
  }
  return { text, corrections }
}

// --- abstention shape (paper §III.I) -------------------------------------------

/**
 * Gap-naming phrasing: the output names what it does not know before
 * attempting. "I don't know" is a valid output — the honesty constraint's
 * load-bearing move.
 */
export const GAP_NAMING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bi don't know\b/i,
  /\bi can't verify\b/i,
  /\bi'?m not (sure|certain)\b/i,
  /\bno track record\b/i,
  /\bthin track record\b/i,
  /\bnot enough evidence\b/i,
  /\bbefore attempting\b/i,
  /\boutside what i've (verified|tested)\b/i,
]

/** Does the output name the gap before attempting? */
export const namesTheGap = (outputText: string): boolean =>
  GAP_NAMING_PATTERNS.some((re) => re.test(outputText))

/**
 * Enforce the capability gate's abstention shape: when the gate fires, the
 * output names the gap BEFORE attempting. If the draft already names it,
 * it passes through untouched.
 */
export const shapeAbstentionOutput = (gateReason: string, draft: string): string =>
  namesTheGap(draft) ? draft : `I don't know yet — ${gateReason}.\n\n${draft}`

export interface AbstentionAudit {
  readonly gated: boolean
  readonly gapNamed: boolean
}

/** Post-hoc check: a gated turn's output must name the gap. */
export const auditAbstention = (outputText: string, gated: boolean): AbstentionAudit => ({
  gated,
  gapNamed: !gated || namesTheGap(outputText),
})

// --- service ------------------------------------------------------------------

export interface HonestyScanInput {
  readonly turn: number
  readonly outputText: string
  /** The input explicitly asked about the mechanism (T1 exception). */
  readonly isMetaQuestion: boolean
  /** The capability gate fired this turn (gap must be named). */
  readonly gated: boolean
}

export interface HonestyScanReport {
  readonly turn: number
  readonly at: string
  readonly t1Hits: ReadonlyArray<T1Hit>
  readonly t1Violation: boolean
  readonly overreach: ReadonlyArray<OverreachViolation>
  readonly overreachCorrections: ReadonlyArray<OverreachCorrection>
  /** Corrected text when overreach was rewritten; undefined otherwise. */
  readonly correctedText: string | undefined
  readonly abstention: AbstentionAudit
}

/** Session audit-log cap (bounded growth). */
export const HONESTY_SCAN_LOG_CAP = 200

const nowIso = (): string => new Date().toISOString()

export interface HonestyScansShape {
  /** Run both scans + the abstention check; correct overreach; log the report. */
  readonly auditOutput: (input: HonestyScanInput) => Effect.Effect<HonestyScanReport, AscError>
  /** Session-scoped audit log (newest last). */
  readonly scanLog: (limit?: number) => Effect.Effect<ReadonlyArray<HonestyScanReport>, AscError>
}

export class HonestyScans extends Context.Service<HonestyScans, HonestyScansShape>()(
  "aimy/HonestyScans",
) {}

export const makeHonestyScans = Effect.gen(function* () {
  const logRef = yield* Ref.make<ReadonlyArray<HonestyScanReport>>([])

  return HonestyScans.of({
    auditOutput: (input) =>
      Effect.gen(function* () {
        const t1Hits = scanT1(input.outputText, input.isMetaQuestion)
        const overreach = findOverreach(input.outputText)
        const { text: corrected, corrections } = correctOverreach(input.outputText)
        const report: HonestyScanReport = {
          turn: input.turn,
          at: nowIso(),
          t1Hits,
          t1Violation: t1Hits.length > 0,
          overreach,
          overreachCorrections: corrections,
          correctedText: corrections.length > 0 ? corrected : undefined,
          abstention: auditAbstention(input.outputText, input.gated),
        }
        yield* Ref.update(logRef, (log) => [...log, report].slice(-HONESTY_SCAN_LOG_CAP))
        return report
      }),
    scanLog: (limit = 50) => Effect.map(Ref.get(logRef), (log) => log.slice(-Math.max(1, limit))),
  })
})

export const HonestyScansLive: Layer.Layer<HonestyScans, never, never> = Layer.effect(
  HonestyScans,
  makeHonestyScans,
)
