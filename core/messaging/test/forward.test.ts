/**
 * messaging/test/forward.test.ts — outbound forwarding contract.
 *
 * Stubbed channel (recorded sends) and comms hub, real pairing registry.
 * Asserts: severity prefs filter correctly, disabled forwarding sends
 * nothing, unpaired state sends nothing, prefs persist, and banner
 * rendering is compact.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { Effect, Stream } from "effect"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeForwarder, renderBanner, shouldForward } from "../src/forward.js"
import { makePairingRegistry } from "../src/pairing.js"
import { DEFAULT_FORWARDING_PREFS } from "../src/types.js"
import type { Channel, ChannelName, PairedChat } from "../src/types.js"
import type { Banner, BannerEvent } from "../../../comms/types.js"
import type { CommsBannerShape } from "../../../comms/service.js"

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "aimy-forward-test-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const banner = (severity: Banner["severity"], title = "Job done"): Banner => ({
  id: "b1",
  severity,
  source: "job:test",
  title,
  body: "all good",
  createdAt: new Date().toISOString(),
  actions: [],
  count: 1,
  sequence: 1,
})

const stubChannel = () => {
  const sent: Array<{ to: PairedChat; text: string }> = []
  const channel: Channel = {
    name: "telegram" as ChannelName,
    listen: () => Effect.void as never,
    send: (to, text) => Effect.sync(() => { sent.push({ to, text }) }),
  }
  return { channel, sent }
}

const stubComms = (events: ReadonlyArray<BannerEvent>): CommsBannerShape =>
  ({ subscribe: () => Effect.succeed(Stream.fromIterable(events)) }) as unknown as CommsBannerShape

const pairChat = async (registry: ReturnType<typeof makePairingRegistry>) => {
  const code = await run(registry.generateCode("telegram"))
  await run(registry.claimCode("telegram", "chat-1", code.code))
}

describe("shouldForward (pure)", () => {
  it("forwards default severities only", () => {
    expect(shouldForward(DEFAULT_FORWARDING_PREFS, banner("success"))).toBe(true)
    expect(shouldForward(DEFAULT_FORWARDING_PREFS, banner("critical"))).toBe(true)
    expect(shouldForward(DEFAULT_FORWARDING_PREFS, banner("info"))).toBe(false)
    expect(shouldForward(DEFAULT_FORWARDING_PREFS, banner("warning"))).toBe(false)
  })

  it("disabled forwarding sends nothing", () => {
    expect(shouldForward({ enabled: false, severities: ["info", "success", "warning", "critical"] }, banner("critical"))).toBe(false)
  })
})

describe("renderBanner (pure)", () => {
  it("is compact with a severity mark", () => {
    const text = renderBanner(banner("critical", "Disk full"))
    expect(text).toContain("🔴")
    expect(text).toContain("Disk full")
  })
})

describe("forwarder", () => {
  it("forwards matching banners to the paired chat", async () => {
    const registry = makePairingRegistry(dir)
    await pairChat(registry)
    const { channel, sent } = stubChannel()
    const fw = makeForwarder({ registry, channel, comms: stubComms([]), dir })
    await run(fw.forward(banner("success")))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to.chatId).toBe("chat-1")
    expect(sent[0]?.text).toContain("Job done")
  })

  it("drops non-matching severities", async () => {
    const registry = makePairingRegistry(dir)
    await pairChat(registry)
    const { channel, sent } = stubChannel()
    const fw = makeForwarder({ registry, channel, comms: stubComms([]), dir })
    await run(fw.forward(banner("info")))
    expect(sent).toHaveLength(0)
  })

  it("sends nothing when unpaired", async () => {
    const registry = makePairingRegistry(dir)
    const { channel, sent } = stubChannel()
    const fw = makeForwarder({ registry, channel, comms: stubComms([]), dir })
    await run(fw.forward(banner("critical")))
    expect(sent).toHaveLength(0)
  })

  it("persists prefs across restarts", async () => {
    const registry = makePairingRegistry(dir)
    const { channel } = stubChannel()
    const fw1 = makeForwarder({ registry, channel, comms: stubComms([]), dir })
    await run(fw1.setPrefs({ enabled: true, severities: ["info"] }))
    const fw2 = makeForwarder({ registry, channel, comms: stubComms([]), dir })
    expect((await run(fw2.getPrefs())).severities).toEqual(["info"])
  })

  it("run() forwards published events from the hub", async () => {
    const registry = makePairingRegistry(dir)
    await pairChat(registry)
    const { channel, sent } = stubChannel()
    const events: ReadonlyArray<BannerEvent> = [
      { type: "published", banner: banner("critical", "Alert") },
      { type: "published", banner: banner("info", "Noise") },
      { type: "dismissed", banner: banner("critical", "Gone") },
    ]
    const fw = makeForwarder({ registry, channel, comms: stubComms(events), dir })
    await run(Effect.scoped(fw.run()))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("Alert")
  })

  it("queues failed sends and flushes on recovery", async () => {
    const registry = makePairingRegistry(dir)
    await pairChat(registry)
    let fail = true
    const sent: Array<string> = []
    const flaky: Channel = {
      name: "telegram" as ChannelName,
      listen: () => Effect.void as never,
      send: (_to, text) => (fail ? Effect.fail(new Error("down") as never) : Effect.sync(() => { sent.push(text) })),
    }
    const fw = makeForwarder({ registry, channel: flaky, comms: stubComms([]), dir })
    await run(fw.forward(banner("critical", "Queued")))
    expect(sent).toHaveLength(0) // failed → queued, not lost
    fail = false
    await run(fw.flush())
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("Queued")
  })
})
