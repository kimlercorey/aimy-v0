/** EgressGate: network egress classes enforced fail-closed, exact-match only. */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { CapabilityDenied, checkEgress, normalizeHost } from "../src/index.js"
import { testManifest } from "./fixtures.js"

const req = (moduleId: string, host: string) => ({ moduleId, host })
const ctx = (firstPartyHosts: ReadonlyArray<string> = []) => ({ firstPartyHosts })

const expectDenied = (eff: Effect.Effect<void, CapabilityDenied>) =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(eff)
    expect(err).toBeInstanceOf(CapabilityDenied)
    expect(err.capability).toBe("network.egress")
    return err
  })

describe("EgressGate", () => {
  it.effect("'none' denies every host", () =>
    Effect.gen(function* () {
      const m = testManifest({ network: "none" })
      const err = yield* expectDenied(checkEgress(m, req("mod", "api.example"), ctx()))
      expect(err.reason).toContain("network 'none'")
    })
  )

  it.effect("'first-party' allows paired hosts, denies everything else", () =>
    Effect.gen(function* () {
      const m = testManifest({ network: "first-party" })
      yield* checkEgress(m, req("mod", "office.lan"), ctx(["office.lan", "phone.lan"]))
      const err = yield* expectDenied(checkEgress(m, req("mod", "evil.example"), ctx(["office.lan"])))
      expect(err.reason).toContain("not a paired first-party host")
      // Unpaired (empty pair list): everything denied.
      yield* expectDenied(checkEgress(m, req("mod", "office.lan"), ctx([])))
    })
  )

  it.effect("declared-vendor-hosts means exactly those hosts, nothing more", () =>
    Effect.gen(function* () {
      const m = testManifest({ network: { vendorHosts: ["api.search.example", "cdn.fetch.example"] } })
      yield* checkEgress(m, req("mod", "api.search.example"), ctx())
      yield* checkEgress(m, req("mod", "cdn.fetch.example"), ctx())
      // Subdomain of a declared host: denied.
      const sub = yield* expectDenied(checkEgress(m, req("mod", "internal.api.search.example"), ctx()))
      expect(sub.reason).toContain("exactly those hosts")
      // Sibling / lookalike: denied.
      yield* expectDenied(checkEgress(m, req("mod", "api.search.example.evil.com"), ctx()))
      yield* expectDenied(checkEgress(m, req("mod", "notdeclared.example"), ctx()))
    })
  )

  it.effect("normalization cannot widen the allowlist", () =>
    Effect.gen(function* () {
      const m = testManifest({ network: { vendorHosts: ["api.search.example"] } })
      // Case, trailing dot, and explicit port all normalize to the declared host.
      yield* checkEgress(m, req("mod", "API.Search.Example"), ctx())
      yield* checkEgress(m, req("mod", "api.search.example."), ctx())
      yield* checkEgress(m, req("mod", "api.search.example:443"), ctx())
      // But an undeclared host stays denied however it is cased.
      yield* expectDenied(checkEgress(m, req("mod", "OTHER.EXAMPLE"), ctx()))
      // Empty host is denied, not vacuously allowed.
      yield* expectDenied(checkEgress(m, req("mod", "   "), ctx()))
    })
  )

  it("normalizeHost strips case, trailing dot, and ports", () => {
    expect(normalizeHost("API.Example.COM.")).toBe("api.example.com")
    expect(normalizeHost("api.example.com:8443")).toBe("api.example.com")
    expect(normalizeHost("[::1]:8080")).toBe("::1")
    expect(normalizeHost("  cdn.fetch.example  ")).toBe("cdn.fetch.example")
  })
})
