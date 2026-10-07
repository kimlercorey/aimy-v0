/**
 * local-http.test.ts — `LocalHttpProvider` against a real `node:http` mock
 * server implementing the chat-completions shape (JSON + SSE streaming).
 *
 * Covers: happy-path generate, params passthrough, streaming token
 * accumulation, connection refused, timeout, truncated stream (typed error,
 * no hang), malformed JSON, HTTP 500, and the zero-network-call boot
 * guarantee (construction + registration open no sockets).
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"
import { InferenceError } from "./errors-shim.js"
import { LocalHttpProvider, NO_REASONING_CHANNEL } from "./local-http.js"
import { InferencePool, InferencePoolLive } from "./pool.js"
import type { GenerateRequest } from "./provider.js"

const req: GenerateRequest = {
  messages: [{ role: "user", content: "say hello" }],
  params: {},
  maxTokens: 64
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

interface MockServer {
  readonly url: string
  readonly close: () => Promise<void>
}

const startMock = (handler: Handler): Promise<MockServer> =>
  new Promise((resolve, reject) => {
    const server: Server = createServer(handler)
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done, failed) => server.close((err) => (err === undefined ? done() : failed(err))))
      })
    })
  })

/** Read and JSON-parse the request body; 400s on parse failure. */
const readJsonBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })

const jsonOk = (res: ServerResponse, payload: unknown): void => {
  const body = JSON.stringify(payload)
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

const sseChunk = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

/** Acquire a port that is guaranteed closed: bind, then release. */
const closedPortUrl = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      server.close((err) => (err === undefined ? resolve(`http://127.0.0.1:${port}`) : reject(err)))
    })
  })

const runStream = (provider: LocalHttpProvider, request: GenerateRequest) =>
  Effect.runPromise(Stream.runCollect(provider.stream(request)).pipe(Effect.map((c) => Array.from(c))))

describe("LocalHttpProvider", () => {
  it("generate: happy path maps usage and names the reasoning estimate", async () => {
    const seen: Array<Record<string, unknown>> = []
    const mock = await startMock((req, res) => {
      void readJsonBody(req).then((body) => {
        seen.push(body)
        jsonOk(res, {
          choices: [{ message: { role: "assistant", content: "hello there" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      })
    })
    try {
      const provider = new LocalHttpProvider({ name: "llm", baseUrl: mock.url, model: "test-model" })
      const res = await Effect.runPromise(provider.generate(req))
      expect(res.text).toBe("hello there")
      expect(res.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        reasoningTokensEstimatedBy: NO_REASONING_CHANNEL
      })
      expect(provider.kind).toBe("local")
      expect(provider.egress).toBe("local")
      expect(provider.capabilities).toEqual({ reasoningTokens: false, tools: false })
    } finally {
      await mock.close()
    }
  })

  it("generate: merges params into the request body", async () => {
    const seen: Array<Record<string, unknown>> = []
    const mock = await startMock((req, res) => {
      void readJsonBody(req).then((body) => {
        seen.push(body)
        jsonOk(res, {
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      })
    })
    try {
      const provider = new LocalHttpProvider({ name: "llm", baseUrl: mock.url, model: "test-model" })
      await Effect.runPromise(
        provider.generate({ ...req, params: { temperature: 0.7, stop: ["</x>"] } })
      )
      expect(seen.length).toBe(1)
      const body = seen[0] as Record<string, unknown>
      expect(body["model"]).toBe("test-model")
      expect(body["max_tokens"]).toBe(64)
      expect(body["messages"]).toEqual([{ role: "user", content: "say hello" }])
      expect(body["temperature"]).toBe(0.7)
      expect(body["stop"]).toEqual(["</x>"])
    } finally {
      await mock.close()
    }
  })

  it("stream: accumulates SSE token deltas", async () => {
    const mock = await startMock((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.write(sseChunk("hello "))
      res.write(sseChunk("world"))
      res.write("data: [DONE]\n\n")
      res.end()
    })
    try {
      const provider = new LocalHttpProvider({ name: "llm", baseUrl: mock.url, model: "test-model" })
      const tokens = await runStream(provider, req)
      expect(tokens.map((t) => t.delta).join("")).toBe("hello world")
    } finally {
      await mock.close()
    }
  })

  it("generate: connection refused is a typed InferenceError", async () => {
    const url = await closedPortUrl()
    const provider = new LocalHttpProvider({ name: "llm", baseUrl: url, model: "test-model" })
    const error = await Effect.runPromise(Effect.flip(provider.generate(req)))
    expect(error).toBeInstanceOf(InferenceError)
    expect(error.provider).toBe("llm")
    expect(error.reason).toContain("connection refused")
    expect(error.reason).toContain(url)
  })

  it("generate: timeout is a typed InferenceError", async () => {
    // Server accepts the connection but never responds.
    const mock = await startMock((_req, _res) => {
      /* hang forever */
    })
    try {
      const provider = new LocalHttpProvider({ name: "llm", baseUrl: mock.url, model: "test-model", timeoutMs: 200 })
      const error = await Effect.runPromise(Effect.flip(provider.generate(req)))
      expect(error).toBeInstanceOf(InferenceError)
      expect(error.provider).toBe("llm")
      expect(error.reason).toContain("request timed out after 200ms")
    } finally {
      await mock.close()
    }
  }, 5000)

  it(
    "stream: truncated stream (socket destroyed mid-SSE) dies with a typed InferenceError — no hang",
    async () => {
      const mock = await startMock((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        res.write(sseChunk("partial "))
        // Abrupt drop mid-stream: no [DONE], socket destroyed.
        res.destroy()
      })
      try {
        const provider = new LocalHttpProvider({ name: "llm", baseUrl: mock.url, model: "test-model" })
        const error = await Effect.runPromise(Effect.flip(Stream.runCollect(provider.stream(req))))
        expect(error).toBeInstanceOf(InferenceError)
        expect(error.provider).toBe("llm")
      } finally {
        await mock.close()
      }
    },
    5000
  )

  it("generate: malformed JSON is a typed InferenceError", async () => {
    const mock = await startMock((_req, res) => {
      const body = "this is not json{"
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) })
      res.end(body)
    })
    try {
      const provider = new LocalHttpProvider({ name: "llm", baseUrl: mock.url, model: "test-model" })
      const error = await Effect.runPromise(Effect.flip(provider.generate(req)))
      expect(error).toBeInstanceOf(InferenceError)
      expect(error.reason).toContain("malformed response")
    } finally {
      await mock.close()
    }
  })

  it("generate: HTTP 500 carries status and body snippet", async () => {
    const mock = await startMock((_req, res) => {
      const body = "model failed to load: OOM"
      res.writeHead(500, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) })
      res.end(body)
    })
    try {
      const provider = new LocalHttpProvider({ name: "llm", baseUrl: mock.url, model: "test-model" })
      const error = await Effect.runPromise(Effect.flip(provider.generate(req)))
      expect(error).toBeInstanceOf(InferenceError)
      expect(error.provider).toBe("llm")
      expect(error.reason).toContain("500")
      expect(error.reason).toContain("model failed to load: OOM")
    } finally {
      await mock.close()
    }
  })

  it("boot: constructing + registering the provider performs zero network I/O", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = ((input: unknown, init?: unknown) => {
        calls.push(String(input))
        return originalFetch(input as Parameters<typeof fetch>[0], init as RequestInit)
      }) as typeof fetch
      try {
        const pool = yield* InferencePool
        const provider = new LocalHttpProvider({ name: "local-main", model: "test-model" })
        yield* pool.register(provider)
        expect(yield* pool.registeredProviders()).toContain("local-main")
        expect(yield* pool.egressOf("local-main")).toBe("local")
        // Zero sockets opened: not a single HTTP call was made during
        // construction or registration.
        expect(calls).toEqual([])
      } finally {
        globalThis.fetch = originalFetch
      }
    }).pipe(Effect.provide(InferencePoolLive))
  )
})
