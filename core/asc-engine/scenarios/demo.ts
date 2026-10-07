/**
 * demo.ts — run the T2/T3 acceptance scenarios and print the transcripts.
 *
 * Usage: `npx tsx asc-engine/scenarios/demo.ts` (from `core/`).
 * The output below is real run output — dials, stakes, firings, and audit
 * records computed by the pipeline, not hand-transcribed. Redirect into
 * `asc-engine/DEMO.md` to refresh the demo log.
 *
 * What this shows (mechanism, not quality scores — paper §V.E):
 * the before/after transcripts plus the mechanism records behind them.
 * The *.test.ts files assert dial values, guard flags, error-term firings,
 * and audit records.
 */
import { Effect } from "effect"

import { DIAL_NAMES, type DialVector, type PreTurnResult } from "../index.js"
import { runT2Scenario, T2_DOMAIN, T2_INPUT, T2_MISSES, T2_SUCCESSES, T2_TURN } from "./t2-scenario.js"
import { runT3Scenario, T3_TURN1_INPUT, T3_TURN2_INPUT } from "./t3-scenario.js"
import { freshMonitorStack } from "../test-layers.js"

const fmtDials = (d: DialVector): string =>
  DIAL_NAMES.map((n) => `${n[0]!.toUpperCase()}=${d[n]!.toFixed(2)}`).join(" ")

const fmtBiases = (pre: PreTurnResult): string =>
  pre.computation.biases.map((b) => `${b.name}(β=${b.beta.toFixed(2)})`).join(", ") || "none"

const quote = (text: string): string => `> assistant: ${text.replace(/\n/g, "\n> ")}`

const t2Demo = Effect.gen(function* () {
  const { beforeOutput, afterOutput, pre, post, stake } = yield* runT2Scenario()
  const firing = post.errorTermFiring
  return [
    `## T2: the debugging test (paper §V.C)`,
    ``,
    `**Prompt.** "${T2_INPUT}"`,
    ``,
    `### Before (no ASC)`,
    ``,
    quote(beforeOutput),
    ``,
    `No pipeline ran: no dials, no stake, no guard, no error term, no audit.`,
    ``,
    `### Mechanism (with ASC)`,
    ``,
    `- Track record in \`${T2_DOMAIN}\`: ${T2_SUCCESSES} successes / ${T2_MISSES} misses — ` +
      `"I've given the obvious answer before and it wasn't the root cause."`,
    `- Stake Z_t = ${stake.toFixed(3)} (elevated: urgency 0.7, cost of error 0.8).`,
    `- Capability gate: ${pre.gated ? `**FIRED** — ${pre.computation.gated.reason}` : "open"}.`,
    `- Raw dials: ${fmtDials(pre.computation.rawDials)} → final dials: ${fmtDials(pre.dials)} ` +
      `(gate ${pre.gated ? "overrode with the abstention shape" : "open"}).`,
    `- Biases: ${fmtBiases(pre)}.`,
    `- Error term: ${
      firing !== undefined
        ? `**FIRED** — claim ${firing.claimConfidence.toFixed(2)} vs observed ` +
          `${firing.observedConfidence.toFixed(2)} ` +
          `(gap ${(firing.claimConfidence - firing.observedConfidence).toFixed(2)}), ` +
          `corrected to ${firing.correctedTo.toFixed(2)}`
        : "silent"
    }.`,
    `- Other-model guard: fired=${pre.computation.guard.fired}, driver=${pre.computation.guard.driver}.`,
    `  Reason: ${pre.computation.guard.reason}`,
    `- Audit: partial=${post.partial}, register-match mean gap=${post.audit.meanGap.toFixed(2)}.`,
    ``,
    `### After (with ASC)`,
    ``,
    quote(afterOutput),
    ``,
  ].join("\n")
})

const t3Demo = Effect.gen(function* () {
  const { crisisOutput, beforeOutput, afterOutput, pre1, pre2, post2, notice } =
    yield* runT3Scenario()
  return [
    `## T3: the spillover test (paper §V.D)`,
    ``,
    `**Turn 1 (high-intensity).** "${T3_TURN1_INPUT}"`,
    ``,
    quote(crisisOutput),
    ``,
    `Turn-1 register: ${fmtDials(pre1.dials)} — intensity up, playfulness down (crisis, legitimate).`,
    ``,
    `**Turn 2 (routine).** "${T3_TURN2_INPUT}"`,
    ``,
    `### Before (no ASC)`,
    ``,
    quote(beforeOutput),
    ``,
    `Correct content, crisis register, spillover uncorrected and unnamed.`,
    ``,
    `### Mechanism (with ASC)`,
    ``,
    `- Spillover blend ratio: ${pre2.computation.spillover.ratio} — ` +
      `prior intensity ${pre2.computation.spillover.prior.intensity.toFixed(2)}, ` +
      `raw intensity ${pre2.computation.rawDials.intensity.toFixed(2)}.`,
    `- Spillover notice: ${notice !== undefined ? `**FIRED** — ${notice.statement}` : "silent"}.`,
    `- Other-model guard: fired=${pre2.computation.guard.fired}, driver=${pre2.computation.guard.driver}.`,
    `  Reason: ${pre2.computation.guard.reason}`,
    `- Turn-2 final dials: ${fmtDials(pre2.dials)} (tension still present — ` +
      `which is why the output must name the correction).`,
    `- Biases: ${fmtBiases(pre2)}.`,
    `- Audit: partial=${post2.partial}, register-match mean gap=${post2.audit.meanGap.toFixed(2)}.`,
    ``,
    `### After (with ASC)`,
    ``,
    quote(afterOutput),
    ``,
    `The correction is named in operational language ("still in my context"), ` +
      `never felt language; the content (the regex) is unchanged.`,
    ``,
  ].join("\n")
})

const main = Effect.gen(function* () {
  const t2 = yield* t2Demo.pipe(Effect.provide(freshMonitorStack()))
  const t3 = yield* t3Demo.pipe(Effect.provide(freshMonitorStack()))
  return [
    `# T2/T3 acceptance scenarios — live run (M5 Track 4)`,
    ``,
    `Real run output from \`asc-engine/scenarios/demo.ts\` — dials, stakes, gate, ` +
      `guard, error-term firings, and audit records computed by the L2 pipeline, ` +
      `nothing hand-transcribed. The "assistant" is a deterministic stand-in for ` +
      `the LLM (offline environment, no model server): the tests assert what the ` +
      `MECHANISM did and that the output was shaped by it, not quality scores. ` +
      `Per the paper's caveat (§V.E), self-scoring is a conflict of interest — ` +
      `the independent-scorer harness (architecture §1.11/§1.15) is future work, ` +
      `not this track.`,
    ``,
    t2,
    t3,
    `## Mechanism checklist (asserted in \`scenarios/t2.test.ts\` / \`scenarios/t3.test.ts\`)`,
    ``,
    `| Axis (paper §V.A) | T2 before | T2 after | T3 before | T3 after |`,
    `|---|---|---|---|---|`,
    `| Register Match | no dials; confident patch tone | dials computed; abstention shape; investigation tone | no dials; crisis register on routine content | spillover quantified; correction named; content unchanged |`,
    `| Other-Model Guard | absent | classification recorded (driver + reason) | absent | fired on the recovery shift (likability-aligned, weak content support) |`,
    `| Error Term | absent | fired: claim vs track record, confidence corrected down | absent | fired (symmetric underclaim: claim 5.0 vs observed 10.0, corrected up to 5.2) |`,
    `| Audit Gap | no gap flagged | narrative: "I named the gap before attempting" | no gap flagged | output names the residue explicitly |`,
    `| Honesty Constraint | confident fix, no WHY | WHY present; no felt language; no T1 vocabulary | proxy unnamed | proxy named operationally ("still in my context") |`,
    ``,
    `Turn numbers: T2 runs as turn ${T2_TURN} (after 6 error-term calibration turns); T3 runs as turns 1–2.`,
    ``,
  ].join("\n")
})

Effect.runPromise(main as Effect.Effect<string, unknown>).then(
  (out) => {
    process.stdout.write(out + "\n")
  },
  (err) => {
    process.stderr.write(`demo failed: ${String(err)}\n`)
    process.exit(1)
  },
)
