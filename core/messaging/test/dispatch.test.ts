/**
 * messaging/test/dispatch.test.ts — the inbound router contract.
 *
 * Stubbed TurnRunner (scripted stream) and Channel (recorded sends), real
 * PairingRegistry. Asserts: paired chats get turns with channel sessions;
 * unpaired chats never reach the runner; 6-digit messages attempt pairing;
 * turn failures become honest replies, never stack traces.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { Effect, Stream } from "effect"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CHANNEL_PREAMBLE,
  handleInbound,
  replyTextOf,
  sessionIdFor,
  type TurnRunner,
} from "../src/dispatch.js"
import { makePairingRegistry } from "../src/pairing.js"
import type { Channel, ChannelName, InboundMessage, PairedChat } from "../src/types.js"

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "aimy-dispatch-test-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const msg = (text: string, chatId = "chat-1"): InboundMessage => ({
  channel: "telegram",
  chatId,
  fromDisplayName: "Kimler",
  text,
  receivedAt: new Date().toISOString(),
})

/** Scripted runner: records (sessionId, input), replays a reply or fails. */
const stubRunner = (reply: string | Error) => {
  const calls: Array<{ sessionId: string; input: string }> = []
  const runner: TurnRunner = {
    chat: (sessionId, input) => {
      calls.push({ sessionId, input })
      if (reply instanceof Error) return Stream.fail(reply as never)
      return Stream.fromIterable([
        { _tag: "Token", delta: reply.slice(0, 5) },
        { _tag: "Token", delta: reply.slice(5) },
        {
          _tag: "Done",
          report: {
            turnId: "t1",
            text: reply,
            executed: [],
            blocked: [],
            terminated: false,
            toolRounds: 0,
            parseFailures: [],
            steeringMessages: [],
            followUpMessages: [],
          },
        },
      ] as const)
    },
  }
  return { runner, calls }
}

const stubChannel = () => {
  const sent: Array<{ to: PairedChat; text: string }> = []
  const channel: Channel = {
    name: "telegram" as ChannelName,
    listen: () => Effect.void as never,
    send: (to, text) => Effect.sync(() => { sent.push({ to, text }) }),
  }
  return { channel, sent }
}

const pairChat = async (registry: ReturnType<typeof makePairingRegistry>, chatId: string) => {
  const code = await run(registry.generateCode("telegram"))
  await run(registry.claimCode("telegram", chatId, code.code, "Kimler"))
}

describe("sessionIdFor", () => {
  it("is deterministic per channel+chat", () => {
    expect(sessionIdFor("telegram", "123")).toBe("msg:telegram:123")
  })
})

describe("replyTextOf (pure)", () => {
  it("takes text from the Done chunk", () => {
    expect(
      replyTextOf([
        { _tag: "Token", delta: "hi" },
        {
          _tag: "Done",
          report: { turnId: "t", text: "full reply", executed: [], blocked: [], terminated: false, toolRounds: 0, parseFailures: [], steeringMessages: [], followUpMessages: [] },
        },
      ])
    ).toBe("full reply")
  })

  it("returns undefined without a Done chunk", () => {
    expect(replyTextOf([{ _tag: "Token", delta: "hi" }])).toBeUndefined()
  })
})

describe("handleInbound", () => {
  it("paired chat → turn with channel session + preamble, reply routed back", async () => {
    const registry = makePairingRegistry(dir)
    await pairChat(registry, "chat-1")
    const { runner, calls } = stubRunner("hello back")
    const { channel, sent } = stubChannel()
    await run(handleInbound({ registry, runner, channel })(msg("hello")))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe("msg:telegram:chat-1")
    expect(calls[0]?.input).toBe(`${CHANNEL_PREAMBLE}hello`)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to.chatId).toBe("chat-1")
    expect(sent[0]?.text).toBe("hello back")
  })

  it("unpaired chat → pairing prompt, runner never called", async () => {
    const registry = makePairingRegistry(dir)
    const { runner, calls } = stubRunner("hello back")
    const { channel, sent } = stubChannel()
    await run(handleInbound({ registry, runner, channel })(msg("hello")))
    expect(calls).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("isn't paired")
  })

  it("unpaired 6-digit message → pairing claim, then chats work", async () => {
    const registry = makePairingRegistry(dir)
    const code = await run(registry.generateCode("telegram"))
    const { runner, calls } = stubRunner("hi")
    const { channel, sent } = stubChannel()
    const handle = handleInbound({ registry, runner, channel })
    await run(handle(msg(code.code, "chat-7")))
    expect(calls).toHaveLength(0) // claim is not a turn
    expect(sent[0]?.text).toContain("Paired")
    await run(handle(msg("now a real message", "chat-7")))
    expect(calls).toHaveLength(1)
    expect(sent[1]?.text).toBe("hi")
  })

  it("wrong pairing code → failure message, still unpaired", async () => {
    const registry = makePairingRegistry(dir)
    await run(registry.generateCode("telegram"))
    const { runner, calls } = stubRunner("hi")
    const { channel, sent } = stubChannel()
    await run(handleInbound({ registry, runner, channel })(msg("000000", "chat-7")))
    expect(calls).toHaveLength(0)
    expect(sent[0]?.text).toContain("Pairing failed")
  })

  it("turn failure → honest reply, never a stack trace", async () => {
    const registry = makePairingRegistry(dir)
    await pairChat(registry, "chat-1")
    const { runner } = stubRunner(new Error("boom"))
    const { channel, sent } = stubChannel()
    await run(handleInbound({ registry, runner, channel })(msg("hello")))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("Something went wrong")
    expect(sent[0]?.text).not.toContain("boom")
  })

  it("unpaired spam → one pairing prompt per minute (rate-limited)", async () => {
    const registry = makePairingRegistry(dir)
    const { runner, calls } = stubRunner("hi")
    const { channel, sent } = stubChannel()
    const handle = handleInbound({ registry, runner, channel })
    await run(handle(msg("spam one", "chat-9")))
    await run(handle(msg("spam two", "chat-9")))
    await run(handle(msg("spam three", "chat-9")))
    expect(calls).toHaveLength(0)
    expect(sent).toHaveLength(1) // only the first prompt went out
  })
})
