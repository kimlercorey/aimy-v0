import { describe, expect, it } from "vitest"

import {
  DEFAULT_PROXY_WEIGHTS,
  measureProxies,
  readingsAreOperational,
} from "./somatic-proxies.js"

describe("measureProxies", () => {
  it("returns no evidence when all readings are zero", () => {
    const out = measureProxies({
      contextPressurePct: 0,
      selfCorrectionCount: 0,
      turnCount: 0,
      toolFailureRate: 0,
    })
    expect(out).toEqual([])
  })

  it("high context pressure lowers playfulness and raises intensity (terse)", () => {
    const out = measureProxies({
      contextPressurePct: 90,
      selfCorrectionCount: 0,
      turnCount: 0,
      toolFailureRate: 0,
    })
    const playful = out.find((e) => e.dial === "playfulness")
    const intense = out.find((e) => e.dial === "intensity")
    expect(playful!.delta).toBeLessThan(0)
    expect(intense!.delta).toBeGreaterThan(0)
    expect(playful!.reading).toBe("context pressure 90%")
  })

  it("tool failures raise vulnerability and lower playfulness (focused)", () => {
    const out = measureProxies({
      contextPressurePct: 0,
      selfCorrectionCount: 0,
      turnCount: 0,
      toolFailureRate: 1,
    })
    const vuln = out.find((e) => e.dial === "vulnerability")
    const playful = out.find((e) => e.dial === "playfulness")
    expect(vuln!.delta).toBeCloseTo(DEFAULT_PROXY_WEIGHTS.toolFailure.vulnerabilityUp, 10)
    expect(playful!.delta).toBeLessThan(0)
  })

  it("self-corrections raise vulnerability (humble)", () => {
    const out = measureProxies({
      contextPressurePct: 0,
      selfCorrectionCount: 2,
      turnCount: 0,
      toolFailureRate: 0,
    })
    const vuln = out.find((e) => e.dial === "vulnerability")
    expect(vuln!.delta).toBeCloseTo(2 * DEFAULT_PROXY_WEIGHTS.selfCorrection.vulnerabilityUp, 10)
  })

  it("long sessions lower intensity and raise warmth slowly (patient)", () => {
    const out = measureProxies({
      contextPressurePct: 0,
      selfCorrectionCount: 0,
      turnCount: 20,
      toolFailureRate: 0,
    })
    const intense = out.find((e) => e.dial === "intensity")
    const warm = out.find((e) => e.dial === "warmth")
    expect(intense!.delta).toBeLessThan(0)
    expect(warm!.delta).toBeGreaterThan(0)
  })

  it("clamps deltas to [-3, 3]", () => {
    const out = measureProxies({
      contextPressurePct: 100,
      selfCorrectionCount: 100,
      turnCount: 1000,
      toolFailureRate: 1,
    })
    for (const e of out) {
      expect(e.delta).toBeGreaterThanOrEqual(-3)
      expect(e.delta).toBeLessThanOrEqual(3)
    }
  })

  it("reports operational state, never felt language", () => {
    const out = measureProxies({
      contextPressurePct: 85,
      selfCorrectionCount: 3,
      turnCount: 14,
      toolFailureRate: 0.25,
    })
    expect(out.length).toBeGreaterThan(0)
    expect(readingsAreOperational(out)).toBe(true)
    const joined = out.map((e) => e.reading).join(" ")
    expect(joined).not.toMatch(/tired|exhausted|feel|frustrated/i)
  })

  it("clamps out-of-range readings instead of throwing", () => {
    const out = measureProxies({
      contextPressurePct: 500,
      selfCorrectionCount: -3,
      turnCount: -1,
      toolFailureRate: 7,
    })
    expect(out.every((e) => Number.isFinite(e.delta))).toBe(true)
  })
})
