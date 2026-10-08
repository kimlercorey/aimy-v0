/**
 * messaging-telegram/test/client.test.ts — Bot API client contract.
 *
 * splitMessage/textMessageOf are pure. API calls run against a mocked
 * HttpClient serving canned Bot API JSON — no sockets. Asserts: getMe
 * validates tokens (401 → TelegramAuthError), getUpdates parses, sendMessage
 * splits long texts into multiple calls, and the token never appears in errors.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  getMe,
  getUpdates,
  sendMessage,
  splitMessage,
  textMessageOf,
  TELEGRAM_MAX_MESSAGE_CHARS,
  type TelegramClientDeps,
} from "../src/client.js"
import { TelegramAuthError } from "../src/errors.js"
import type { HttpClientShape, HttpResponse } from "../../../web-retrieval/src/http.js"

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

const ok = (result: unknown): HttpResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, result }),
})

const err = (description: string, error_code = 400): HttpResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: false, description, error_code }),
})

/** Mock HttpClient with a scripted response queue; records request bodies. */
const mockHttp = (responses: ReadonlyArray<HttpResponse>) => {
  const bodies: Array<string> = []
  let i = 0
  const http: HttpClientShape = {
    request: (req) => {
      bodies.push(req.body ?? "")
      const res = responses[Math.min(i, responses.length - 1)]
      i += 1
      return Effect.succeed(res as HttpResponse)
    },
  }
  return { http, bodies }
}

const deps = (http: HttpClientShape): TelegramClientDeps => ({ http, token: "SECRET_TOKEN" })

describe("splitMessage (pure)", () => {
  it("passes short texts through", () => {
    expect(splitMessage("hello")).toEqual(["hello"])
  })

  it("splits long texts into bounded chunks without dropping content", () => {
    const text = "word ".repeat(2000) // 10k chars
    const chunks = splitMessage(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS)
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim())
  })

  it("prefers paragraph boundaries", () => {
    const a = "a".repeat(3000)
    const b = "b".repeat(3000)
    const chunks = splitMessage(`${a}\n\n${b}`)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe(a)
    expect(chunks[1]).toBe(b)
  })
})

describe("textMessageOf (pure)", () => {
  it("extracts text messages", () => {
    const m = textMessageOf({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 123, type: "private", first_name: "Kim" },
        from: { first_name: "Kim" },
        date: 1,
        text: "hello",
      },
    })
    expect(m).toEqual({ chatId: "123", text: "hello", displayName: "Kim" })
  })

  it("ignores non-text updates", () => {
    expect(textMessageOf({ update_id: 1 })).toBeUndefined()
    expect(
      textMessageOf({
        update_id: 2,
        message: { message_id: 1, chat: { id: 1, type: "private" }, date: 1, text: "  " },
      })
    ).toBeUndefined()
  })
})

describe("getMe", () => {
  it("returns the bot identity for a valid token", async () => {
    const { http } = mockHttp([ok({ id: 1, is_bot: true, first_name: "Aimy", username: "aimy_bot" })])
    const me = await run(getMe(deps(http)))
    expect(me.username).toBe("aimy_bot")
  })

  it("maps 401 to TelegramAuthError without leaking the token", async () => {
    const { http } = mockHttp([err("Unauthorized", 401)])
    const e = await run(Effect.flip(getMe(deps(http))))
    expect(e).toBeInstanceOf(TelegramAuthError)
    expect(JSON.stringify(e)).not.toContain("SECRET_TOKEN")
  })
})

describe("getUpdates", () => {
  it("parses updates and passes offset", async () => {
    const { http, bodies } = mockHttp([
      ok([{ update_id: 7, message: { message_id: 1, chat: { id: 5, type: "private" }, date: 1, text: "hi" } }]),
    ])
    const updates = await run(getUpdates(deps(http), 6))
    expect(updates).toHaveLength(1)
    expect(JSON.parse(bodies[0] ?? "{}").offset).toBe(6)
  })
})

describe("sendMessage", () => {
  it("sends short texts in one call", async () => {
    const { http, bodies } = mockHttp([ok({ message_id: 1 })])
    await run(sendMessage(deps(http), "123", "hello"))
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0] ?? "{}").chat_id).toBe("123")
  })

  it("splits long texts into multiple sendMessage calls", async () => {
    const { http, bodies } = mockHttp([ok({ message_id: 1 }), ok({ message_id: 2 }), ok({ message_id: 3 })])
    await run(sendMessage(deps(http), "123", "x".repeat(9000)))
    expect(bodies.length).toBeGreaterThanOrEqual(3)
    for (const b of bodies) {
      expect((JSON.parse(b).text as string).length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS)
    }
  })
})
