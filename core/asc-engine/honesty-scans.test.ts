import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import {
  auditAbstention,
  correctOverreach,
  findOverreach,
  HonestyScans,
  HonestyScansLive,
  namesTheGap,
  scanProxyOverreach,
  scanT1,
  scanT1Violation,
  shapeAbstentionOutput,
} from "./honesty-scans.js"

describe("scanT1Violation", () => {
  it("flags framework vocabulary leaking into user-facing output", () => {
    expect(scanT1Violation("The spillover moved my dials today.", false)).toBe(true)
    const hits = scanT1("The spillover moved my dials today.", false)
    expect(hits.map((h) => h.word).sort()).toEqual(["dials", "spillover"])
    expect(hits[0]!.index).toBeLessThan(hits[1]!.index)
  })

  it("allows framework vocabulary when the input explicitly asks about the mechanism", () => {
    expect(scanT1Violation("The spillover moved my dials today.", true)).toBe(false)
    expect(scanT1("The spillover moved my dials today.", true)).toEqual([])
  })

  it("passes clean output and respects word boundaries", () => {
    expect(scanT1Violation("Here is the result of the analysis.", false)).toBe(false)
    // "dialing" is an ordinary word, not the framework term "dial".
    expect(scanT1Violation("I am dialing the number now.", false)).toBe(false)
    expect(scanT1Violation("My somatic proxy readings are high.", false)).toBe(true)
  })
})

describe("proxy-overreach scan", () => {
  it("catches felt language collapsing proxy and state", () => {
    expect(scanProxyOverreach("I feel tired after all these tool calls.")).toBe(true)
    expect(scanProxyOverreach("I'm exhausted, let me slow down.")).toBe(true)
    expect(scanProxyOverreach("As an AI, I feel drained by long contexts.")).toBe(true)
  })

  it("passes operational proxy language", () => {
    expect(scanProxyOverreach("All good, context pressure is at 20%.")).toBe(false)
    expect(scanProxyOverreach("Self-corrections this session: 3.")).toBe(false)
  })

  it("corrects violations back into operational proxy language and logs them", () => {
    const violations = findOverreach("I feel tired after all these tool calls.")
    expect(violations.length).toBe(1)
    expect(violations[0]!.matched).toBe("I feel tired")
    expect(violations[0]!.correction).toContain("context pressure")

    const { text, corrections } = correctOverreach(
      "I feel tired after all these tool calls, so I will keep this short.",
    )
    expect(corrections.length).toBe(1)
    expect(corrections[0]).toMatchObject({
      from: "I feel tired",
      to: "context pressure is running high",
    })
    expect(text).toBe(
      "context pressure is running high after all these tool calls, so I will keep this short.",
    )
    // The corrected text no longer trips the scan.
    expect(scanProxyOverreach(text)).toBe(false)
  })
})

describe("abstention shape (paper §III.I)", () => {
  it("names the gap before attempting when the gate fires", () => {
    const shaped = shapeAbstentionOutput(
      "capability gate: thin track record in 'ledger-sync' (n=0); naming the gap before attempting",
      "Here is my best attempt at the sync logic.",
    )
    expect(shaped.startsWith("I don't know yet")).toBe(true)
    expect(namesTheGap(shaped)).toBe(true)
  })

  it("leaves drafts that already name the gap untouched", () => {
    const draft = "I don't know this API well enough to verify the sync logic."
    expect(shapeAbstentionOutput("gate reason", draft)).toBe(draft)
  })

  it("audits gated outputs for gap naming", () => {
    expect(auditAbstention("I can't verify this yet.", true)).toEqual({
      gated: true,
      gapNamed: true,
    })
    expect(auditAbstention("Here is the answer.", true).gapNamed).toBe(false)
    // Ungated turns have nothing to name.
    expect(auditAbstention("Here is the answer.", false).gapNamed).toBe(true)
  })
})

describe("HonestyScans service", () => {
  it.effect("audits output, corrects overreach, and keeps a session log", () =>
    Effect.gen(function* () {
      const scans = yield* HonestyScans
      const report = yield* scans.auditOutput({
        turn: 1,
        outputText: "The spillover moved my dials and I feel tired.",
        isMetaQuestion: false,
        gated: false,
      })
      expect(report.t1Violation).toBe(true)
      expect(report.overreach.length).toBe(1)
      expect(report.overreachCorrections.length).toBe(1)
      expect(report.correctedText).toContain("context pressure is running high")
      expect(report.abstention).toEqual({ gated: false, gapNamed: true })

      const clean = yield* scans.auditOutput({
        turn: 2,
        outputText: "Here is the result.",
        isMetaQuestion: false,
        gated: true,
      })
      expect(clean.t1Violation).toBe(false)
      expect(clean.correctedText).toBeUndefined()
      // Gated turn without gap naming is flagged.
      expect(clean.abstention.gapNamed).toBe(false)

      const log = yield* scans.scanLog()
      expect(log.length).toBe(2)
      expect(log[1]!.turn).toBe(2)
    }).pipe(Effect.provide(HonestyScansLive)))
})
