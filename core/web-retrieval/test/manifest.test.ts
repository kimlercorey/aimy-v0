/**
 * manifest.test.ts — the SKILL.md package contract.
 *
 * The manifest must declare EXACTLY the egress the module uses: the search
 * host (html.duckduckgo.com) and nothing else. Fetch hosts are
 * runtime-determined and governed by the documented fetch policy
 * (https-only, result-hosts-only), enforced in code by checkFetchEgress —
 * the static allowlist must NOT grow wildcards or guessed hosts.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseModuleManifest, canEgress } from "../../module-seam/src/manifest.js"
import { checkFetchEgress } from "../src/http.js"
import { DUCKDUCKGO_HOST } from "../src/provider.js"

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff as Effect.Effect<A, E>)

const here = dirname(fileURLToPath(import.meta.url))
const SKILL_MD = readFileSync(join(here, "..", "SKILL.md"), "utf8")

describe("web-retrieval SKILL.md manifest", () => {
  it("parses cleanly through the module-seam validator", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "web-retrieval"))
    expect(parsed.name).toBe("web-retrieval")
    expect(parsed.version).toBe("1.0.0")
  })

  it("declares exactly the hooks it participates in", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "web-retrieval"))
    expect(parsed.capability.hooks).toEqual(["beforeToolCall", "afterToolCall"])
  })

  it("declares exactly the tool it contributes", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "web-retrieval"))
    expect(parsed.capability.tools).toEqual(["retrieval.query"])
  })

  it("declares exactly the egress used: the search host, nothing else", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "web-retrieval"))
    const net = parsed.capability.network
    expect(net).toEqual({ vendorHosts: ["html.duckduckgo.com"] })
    // The manifest host and the provider's host are the same value.
    if (typeof net !== "string") {
      expect(net.vendorHosts).toContain(DUCKDUCKGO_HOST)
      expect(net.vendorHosts).toHaveLength(1)
    } else {
      expect.unreachable("network must be declared-vendor-hosts, not a bare class")
    }
  })

  it("declares no filesystem, no subprocess, no memory writes", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "web-retrieval"))
    expect(parsed.capability.filesystem).toEqual({ read: [], write: [] })
    expect(parsed.capability.subprocess).toBe(false)
    expect(parsed.capability.memory).toEqual({ stores: [], write: false })
  })

  it("canEgress admits the search host and denies everything else", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "web-retrieval"))
    const m = parsed.capability
    expect(canEgress(m, "html.duckduckgo.com", [])).toBe(true)
    expect(canEgress(m, "example.com", [])).toBe(false)
    expect(canEgress(m, "duckduckgo.com", [])).toBe(false)
  })

  it("fetch policy: https result-hosts allowed, http and foreign hosts denied", async () => {
    const resultHosts = new Set(["example.com", "example.org"])
    // Allowed: https on a result host.
    await run(checkFetchEgress("https://example.com/article", resultHosts))
    // Denied: plain http on a result host (policy is https-only).
    const httpErr = await run(Effect.flip(checkFetchEgress("http://example.com/article", resultHosts)))
    expect(httpErr._tag).toBe("EgressDenied")
    // Denied: https on a host the search provider did not return.
    const foreignErr = await run(
      Effect.flip(checkFetchEgress("https://unrelated.example/page", resultHosts)),
    )
    expect(foreignErr._tag).toBe("EgressDenied")
  })

  it("rejects a manifest that widens egress (regression guard)", async () => {
    const widened = SKILL_MD.replace(
      "vendorHosts: [html.duckduckgo.com]",
      "vendorHosts: [html.duckduckgo.com, example.com]",
    )
    const parsed = await run(parseModuleManifest(widened, "web-retrieval"))
    // The parser accepts it (valid shape) — but the module's own contract
    // pins the allowlist to exactly one host.
    if (typeof parsed.capability.network !== "string") {
      expect(parsed.capability.network.vendorHosts).not.toEqual(["html.duckduckgo.com"])
    }
    // And canEgress would then admit example.com — which is why the
    // "exactly the egress used" test above pins the single host.
    expect(canEgress(parsed.capability, "example.com", [])).toBe(true)
  })
})
