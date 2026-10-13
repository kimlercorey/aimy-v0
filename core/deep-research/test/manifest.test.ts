/**
 * manifest.test.ts — the SKILL.md package contract (mirrors web-retrieval's).
 *
 * Deep-research orchestrates web-retrieval, so its declared egress is
 * EXACTLY web-retrieval's: the search host (html.duckduckgo.com) and
 * nothing else. Fetched result hosts are runtime-determined and governed
 * by web-retrieval's fetch policy (https-only, result-hosts-only), not by
 * this manifest. The module itself touches no filesystem (run records are
 * written host-side by the chat adapter), no subprocess, no memory store.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseModuleManifest, canEgress } from "../../module-seam/src/manifest.js"
import { DUCKDUCKGO_HOST } from "../../web-retrieval/src/provider.js"

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff as Effect.Effect<A, E>)

const here = dirname(fileURLToPath(import.meta.url))
const SKILL_MD = readFileSync(join(here, "..", "SKILL.md"), "utf8")

describe("deep-research SKILL.md manifest", () => {
  it("parses cleanly through the module-seam validator", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "deep-research"))
    expect(parsed.name).toBe("deep-research")
    expect(parsed.version).toBe("1.0.0")
  })

  it("declares exactly the hooks it participates in", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "deep-research"))
    expect(parsed.capability.hooks).toEqual(["beforeToolCall", "afterToolCall"])
  })

  it("declares exactly the tool it contributes", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "deep-research"))
    expect(parsed.capability.tools).toEqual(["research.query"])
  })

  it("declares exactly web-retrieval's egress: the search host, nothing else", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "deep-research"))
    const net = parsed.capability.network
    expect(net).toEqual({ vendorHosts: ["html.duckduckgo.com"] })
    if (typeof net !== "string") {
      expect(net.vendorHosts).toContain(DUCKDUCKGO_HOST)
      expect(net.vendorHosts).toHaveLength(1)
    } else {
      expect.unreachable("network must be declared-vendor-hosts, not a bare class")
    }
  })

  it("declares no filesystem, no subprocess, no memory writes", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "deep-research"))
    expect(parsed.capability.filesystem).toEqual({ read: [], write: [] })
    expect(parsed.capability.subprocess).toBe(false)
    expect(parsed.capability.memory).toEqual({ stores: [], write: false })
  })

  it("canEgress admits the search host and denies everything else", async () => {
    const parsed = await run(parseModuleManifest(SKILL_MD, "deep-research"))
    const m = parsed.capability
    expect(canEgress(m, "html.duckduckgo.com", [])).toBe(true)
    expect(canEgress(m, "example.com", [])).toBe(false)
    expect(canEgress(m, "duckduckgo.com", [])).toBe(false)
  })
})
