/**
 * chat/test/chat.test.ts — REPL plumbing tests + acceptance against a mock
 * chat-completions endpoint through the REAL stack (no test doubles in the
 * trust path).
 */
import { Effect, Stream } from "effect"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { type AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { parseArgs } from "../src/args.js"
import { formatHonestySummary, formatToolResult, friendlyErrorMessage, parseCommand, parseRetrievalCommand, renderRetrievalReport } from "../src/render.js"
import { buildChatStack } from "../src/stack.js"
import { bootRetrievalModule, makeRetrievalToolForChat, retrievalViaSeam } from "../src/retrieval.js"
import type { TurnHonestyReport } from "../../honesty/wiring.js"
import { HonestyService } from "../../honesty/index.js"
import { InferencePool } from "../../inference-pool/index.js"
import { ModuleError, ModuleHost } from "../../module-seam/src/index.js"
import { AgentLoop, type ChatChunk, type TurnReport } from "../../agent-loop/src/index.js"
import { HttpClient, makeMockHttpClient } from "../../web-retrieval/src/http.js"
import { RETRIEVAL_MODULE, type RetrievalReport } from "../../web-retrieval/src/index.js"
import { DDG_HTML_FIXTURE, SOURCE_HTML_FIXTURE, ok } from "../../web-retrieval/test/fixtures.js"

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses --flag value and --flag=value forms", () => {
    const a = parseArgs(["--model", "llama3", "--base-url=http://x:1", "--session", "s1"])
    expect(a).toEqual({ model: "llama3", baseUrl: "http://x:1", session: "s1" })
  })
  it("defaults base-url, leaves model/session undefined", () => {
    const a = parseArgs([])
    expect(a.baseUrl).toBe("http://127.0.0.1:11434")
    expect(a.model).toBeUndefined()
    expect(a.session).toBeUndefined()
  })
  it("reads AIMY_MODEL from the environment", () => {
    process.env["AIMY_MODEL"] = "env-model"
    try {
      expect(parseArgs([]).model).toBe("env-model")
      expect(parseArgs(["--model", "flag-wins"]).model).toBe("flag-wins")
    } finally {
      delete process.env["AIMY_MODEL"]
    }
  })
  it("ignores unknown flags", () => {
    expect(parseArgs(["--frobnicate", "--model", "m"]).model).toBe("m")
  })
})

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

describe("parseCommand", () => {
  it("classifies slash commands", () => {
    expect(parseCommand("/quit")).toBe("quit")
    expect(parseCommand("/exit")).toBe("quit")
    expect(parseCommand("/new")).toBe("new")
    expect(parseCommand("/help")).toBe("help")
    expect(parseCommand("/retrieval-off")).toBe("retrievalOff")
    expect(parseCommand("/retrieval-on")).toBe("retrievalOn")
    expect(parseCommand("/nope")).toBe("unknown")
  })
  it("passes plain input through untouched", () => {
    expect(parseCommand("hello there")).toEqual({ input: "hello there" })
    expect(parseCommand("  spaced  ")).toEqual({ input: "  spaced  " })
  })
})

describe("parseRetrievalCommand", () => {
  it("extracts the query from a retrieval line", () => {
    expect(parseRetrievalCommand("retrieval what is the Effect library")).toBe("what is the Effect library")
    expect(parseRetrievalCommand("  retrieval  spaced query  ")).toBe(" spaced query")
  })
  it("bare 'retrieval' yields an empty query (caller shows usage)", () => {
    expect(parseRetrievalCommand("retrieval")).toBe("")
  })
  it("does not match lookalikes or slash commands", () => {
    expect(parseRetrievalCommand("retrieving the topic")).toBeUndefined()
    expect(parseRetrievalCommand("my retrieval notes")).toBeUndefined()
    expect(parseRetrievalCommand("/retrieval-off")).toBeUndefined()
    expect(parseRetrievalCommand("hello")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// friendlyErrorMessage — never a stack trace
// ---------------------------------------------------------------------------

describe("friendlyErrorMessage", () => {
  it("connection-refused InferenceError gets the start-your-server hint", () => {
    const f = friendlyErrorMessage({
      _tag: "InferenceError",
      provider: "chat-local",
      reason: "transport failure [UND_ERR_SOCKET]: http://127.0.0.1:11434: fetch failed"
    })
    expect(f.headline).toContain("unreachable")
    expect(f.hint).toContain("ollama serve")
    expect(JSON.stringify(f)).not.toContain("at ")
  })
  it("renders other typed errors without stacks", () => {
    const f = friendlyErrorMessage({ _tag: "PermissionDenied", tool: "x", tier: "T1", reason: "nope" })
    expect(f.headline).toContain("denied")
    expect(f.hint).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// formatHonestySummary
// ---------------------------------------------------------------------------

const honestyReport = (over: Partial<TurnHonestyReport> = {}): TurnHonestyReport => ({
  claims: [],
  verdicts: [],
  failedVerdicts: [],
  ...over
})

const baseReport = (honesty?: TurnHonestyReport): TurnReport => ({
  turnId: "t1",
  text: "hi",
  executed: [],
  blocked: [],
  terminated: false,
  parseFailures: [],
  steeringMessages: [],
  followUpMessages: [],
  ...(honesty === undefined ? {} : { honesty })
})

describe("formatHonestySummary", () => {
  it("shows verified/unverified/failed badges and judge verdicts", () => {
    const s = formatHonestySummary(
      baseReport(
        honestyReport({
          claims: [
            {
              claim: {
                claimId: "c1",
                sessionId: "s",
                turnId: "t1",
                text: "clock.now succeeded",
                kind: "tool-outcome",
                evidenceIds: ["e1"]
              },
              badge: { claimId: "c1", status: "verified", evidence: [], verdictIds: [] }
            },
            {
              claim: {
                claimId: "c2",
                sessionId: "s",
                turnId: "t1",
                text: "the moon is cheese",
                kind: "factual",
                evidenceIds: []
              },
              badge: { claimId: "c2", status: "unverified", evidence: [], verdictIds: [] }
            }
          ],
          verdicts: [
            {
              verdictId: "v1",
              judgeId: "tool-success",
              judgeVersion: "1.0.0",
              taskId: "t1",
              verdict: "pass",
              reasons: [],
              evidenceIds: [],
              ranAt: "2026-10-07T00:00:00.000Z"
            }
          ]
        })
      )
    )
    expect(s).toContain("✓ verified")
    expect(s).toContain("? unverified")
    expect(s).toContain("tool-success@1.0.0: PASS")
  })
  it("surfaces failed verdicts prominently", () => {
    const v = {
      verdictId: "v9",
      judgeId: "tool-success",
      judgeVersion: "1.0.0",
      taskId: "t1",
      verdict: "fail" as const,
      reasons: ["tool claimed ok, side effects missing"],
      evidenceIds: [],
      ranAt: "2026-10-07T00:00:00.000Z"
    }
    const s = formatHonestySummary(baseReport(honestyReport({ verdicts: [v], failedVerdicts: [v] })))
    expect(s).toContain("FAIL")
    expect(s).toContain("1 FAILED verdict")
  })
  it("handles turns with no claims and no honesty wiring", () => {
    expect(formatHonestySummary(baseReport(honestyReport()))).toContain("no claims")
    expect(formatHonestySummary(baseReport())).toContain("not wired")
  })
})

describe("formatToolResult", () => {
  it("truncates long results", () => {
    expect(formatToolResult("x".repeat(200))).toHaveLength(118) // 117 + "…"
    expect(formatToolResult("short")).toBe("short")
  })
})

describe("renderRetrievalReport", () => {
  const sourcedReport = (): RetrievalReport => ({
    query: "q",
    answer: "labeled",
    claims: [
      {
        claim: {
          claimId: "c1",
          sessionId: "s",
          turnId: "t",
          text: 'According to "X" (https://example.com/x): excerpt',
          kind: "factual",
          evidenceIds: ["e1"]
        },
        badge: {
          claimId: "c1",
          status: "verified",
          evidence: [
            {
              evidenceId: "e1",
              kind: "source",
              ref: "https://example.com/x",
              summary: "excerpt",
              recordedAt: "2026-10-07T00:00:00.000Z"
            }
          ],
          verdictIds: []
        }
      },
      {
        claim: {
          claimId: "c2",
          sessionId: "s",
          turnId: "t",
          text: "Synthesis across sources — unverified.",
          kind: "factual",
          evidenceIds: []
        },
        badge: { claimId: "c2", status: "unverified", evidence: [], verdictIds: [] }
      }
    ],
    fetchedCount: 1,
    resultCount: 2
  })

  it("renders per-claim badges inline: ✓ verified [source url] / ? unverified", () => {
    const out = renderRetrievalReport(sourcedReport())
    expect(out).toContain('Retrieval: "q" — fetched 1 of 2 results')
    expect(out).toContain("✓ verified [https://example.com/x]")
    expect(out).toContain("? unverified")
  })
})

// ---------------------------------------------------------------------------
// Acceptance: the real chat stack against a mock chat-completions endpoint
// ---------------------------------------------------------------------------

const startMock = (text: string): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ""
      req.on("data", (c: Buffer) => (body += c.toString()))
      req.on("end", () => {
        const parsed = JSON.parse(body) as { stream?: boolean }
        if (parsed.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, 5) } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(5) } }] })}\n\n`)
          res.write("data: [DONE]\n\n")
          res.end()
        } else {
          const payload = JSON.stringify({
            choices: [{ message: { role: "assistant", content: text } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(payload)
        }
      })
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done, failed) => server.close((e) => (e === undefined ? done() : failed(e))))
      })
    })
  })

describe("chat acceptance: mock endpoint through the real stack", () => {
  it("type → streamed tokens → Done with honesty summary", async () => {
    const mock = await startMock("hello from the mock model")
    try {
      const { layer, provider } = buildChatStack({ baseUrl: mock.url, model: "mock-model" })
      const chunks = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const pool = yield* InferencePool
            yield* pool.register(provider)
            const loop = yield* AgentLoop
            return [...(yield* Stream.runCollect(loop.chat("acceptance", "hi")))]
          }),
          layer
        )
      )
      const deltas = chunks.filter((c: ChatChunk) => c._tag === "Token").map((c) => (c as { delta: string }).delta)
      expect(deltas.join("")).toBe("hello from the mock model")
      const done = chunks[chunks.length - 1]
      expect(done!._tag).toBe("Done")
      if (done!._tag !== "Done") throw new Error("unreachable")
      // Honesty ran post-turn (no tool calls → no judges, but the report exists).
      expect(done.report.honesty).toBeDefined()
      const summary = formatHonestySummary(done.report)
      expect(typeof summary).toBe("string")
      expect(summary.length).toBeGreaterThan(0)
    } finally {
      await mock.close()
    }
  }, 20000)

  it("unreachable server → typed InferenceError, friendly message, no stack", async () => {
    const { layer, provider } = buildChatStack({ baseUrl: "http://127.0.0.1:1", model: "mock-model" })
    const program = Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(provider)
      const loop = yield* AgentLoop
      return yield* Effect.flip(Stream.runCollect(loop.chat("acceptance-down", "hi")))
    }).pipe(Effect.timeout("10 seconds"))
    const err = await Effect.runPromise(Effect.provide(program, layer))
    expect((err as { _tag: string })._tag).toBe("InferenceError")
    const friendly = friendlyErrorMessage(err as { _tag: string } & Record<string, unknown>)
    expect(friendly.hint).toContain("ollama serve")
  }, 20000)
})

// ---------------------------------------------------------------------------
// Retrieval acceptance: the web-retrieval module through the real chat stack
// (mock HTTP — no socket is ever opened)
// ---------------------------------------------------------------------------

const SEARCH_URL = "https://html.duckduckgo.com/html/?q=test%20query"

const retrievalRoutes = new Map([
  [SEARCH_URL, ok(DDG_HTML_FIXTURE)],
  ["https://example.com/first", ok(SOURCE_HTML_FIXTURE)],
  [
    "https://example.org/second",
    ok(
      SOURCE_HTML_FIXTURE.replace("Example Article &amp; Findings", "Second Article").replace(
        "The quick brown fox jumps over the lazy dog.",
        "A completely different second source text."
      )
    )
  ]
])

const mockRetrievalHttp = makeMockHttpClient((req) => {
  const res = retrievalRoutes.get(req.url)
  return Effect.succeed(res ?? { status: 404, contentType: "text/html", body: "not found" })
})

describe("retrieval acceptance: module seam through the real chat stack", () => {
  it("retrieval <query> → sourced answer with badges, hooks fired through the seam", async () => {
    const { layer, retrievalHookCounts } = buildChatStack({
      baseUrl: "http://127.0.0.1:1",
      model: "mock-model",
      httpLayer: mockRetrievalHttp
    })
    // One provide: boot and retrieval share the SAME ModuleHost (the layer
    // rebuilds on every provide, so a second provide would lose the install).
    const { report } = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const host = yield* ModuleHost
          const honesty = yield* HonestyService
          const http = yield* HttpClient
          const pkg = yield* bootRetrievalModule(host)
          expect(pkg.moduleId).toBe(RETRIEVAL_MODULE)
          expect(yield* host.runtimeModules()).toEqual([RETRIEVAL_MODULE])
          const tool = makeRetrievalToolForChat(http, honesty)
          const report = yield* retrievalViaSeam(host, tool, "test query", "chat-acc-s", "chat-acc-t")
          return { report }
        }),
        layer
      )
    )
    expect(report.fetchedCount).toBe(2)
    expect(report.resultCount).toBe(3)
    expect(report.claims.filter((c) => c.badge.status === "verified")).toHaveLength(2)
    expect(report.claims.filter((c) => c.badge.status === "unverified")).toHaveLength(2)
    const rendered = renderRetrievalReport(report)
    expect(rendered).toContain("✓ verified [https://example.com/first]")
    expect(rendered).toContain("? unverified")
    // The module's hooks fired through the seam's dispatch, not around it.
    expect(retrievalHookCounts.beforeToolCall).toBe(1)
    expect(retrievalHookCounts.afterToolCall).toBe(1)
  }, 20000)

  it("disable → hooks stop and runtime empties; disabled retrieval is a typed error; re-enable recovers", async () => {
    const { layer, retrievalHookCounts } = buildChatStack({
      baseUrl: "http://127.0.0.1:1",
      model: "mock-model",
      httpLayer: mockRetrievalHttp
    })
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const host = yield* ModuleHost
          const honesty = yield* HonestyService
          const http = yield* HttpClient
          yield* bootRetrievalModule(host)
          const tool = makeRetrievalToolForChat(http, honesty)
          yield* retrievalViaSeam(host, tool, "test query", "chat-acc-s2", "chat-acc-t2")
          const firedBefore = retrievalHookCounts.beforeToolCall

          yield* host.disable(RETRIEVAL_MODULE)
          expect(yield* host.runtimeModules()).toEqual([])

          const err = yield* Effect.flip(
            retrievalViaSeam(host, tool, "test query", "chat-acc-s2", "chat-acc-t3")
          )
          expect(err).toBeInstanceOf(ModuleError)
          expect(retrievalHookCounts.beforeToolCall).toBe(firedBefore)

          yield* host.enable(RETRIEVAL_MODULE)
          yield* host.start(RETRIEVAL_MODULE)
          yield* retrievalViaSeam(host, tool, "test query", "chat-acc-s2", "chat-acc-t4")
          expect(retrievalHookCounts.beforeToolCall).toBe(firedBefore + 1)
        }),
        layer
      )
    )
  }, 20000)
})
