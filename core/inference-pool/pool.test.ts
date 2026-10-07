/**
 * pool.test.ts — InferencePool guarantees, tested against StubProvider only.
 *
 * No network in this file's dependency graph: the only provider under test is
 * the in-process stub. The zero-socket test monkeypatches `globalThis.fetch`
 * to prove the pool never touches the network during a full generate cycle.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { InferenceError } from "./errors-shim.js"
import { StubProvider } from "./local-stub.js"
import { InferencePool, InferencePoolLive } from "./pool.js"
import type { GenerateRequest, Provider } from "./provider.js"

const req: GenerateRequest = {
  messages: [{ role: "user", content: "hello world" }],
  params: {},
  maxTokens: 64
}

const withPool = <A, E>(
  effect: Effect.Effect<A, E, InferencePool>
): Effect.Effect<A, E, never> => Effect.provide(effect, InferencePoolLive)

const cloudProvider: Provider = {
  name: "cloud-x",
  kind: "cloud",
  egress: "vendor",
  capabilities: { reasoningTokens: false, tools: true },
  generate: () =>
    Effect.succeed({
      text: "cloud response",
      usage: {
        inputTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0,
        reasoningTokensEstimatedBy: "cloud-x/not-disclosed"
      }
    })
}

describe("InferencePool", () => {
  it.effect("powerhouse routes to the registered best (first local) provider", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const a = new StubProvider("local-a", "answer-a")
        const b = new StubProvider("local-b", "answer-b")
        yield* pool.register(a)
        yield* pool.register(b)

        const res = yield* pool.generate(req, { mode: "powerhouse" })
        expect(res.text).toBe("answer-a")
        expect(a.calls.length).toBe(1)
        expect(b.calls.length).toBe(0)
      })
    )
  )

  it.effect("parallel merged fans out and sums usage including reasoning tokens", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const a = new StubProvider("local-a", "answer-a", "thought-a")
        const b = new StubProvider("local-b", "answer-b", "thought-b")
        yield* pool.register(a)
        yield* pool.register(b)

        const res = yield* pool.generate(req, { mode: "parallel", merge: "merged" })
        expect(a.calls.length).toBe(1)
        expect(b.calls.length).toBe(1)
        expect(res.text).toContain("[local-a]")
        expect(res.text).toContain("[local-b]")
        expect(res.text).toContain("answer-a")
        expect(res.text).toContain("answer-b")
        // Pi #9409: reasoning tokens are part of accounting, summed across the fan-out.
        expect(res.usage.reasoningTokens).toBe(
          a.calls.length > 0 ? 1 + 1 : -1 // "thought-a"/"thought-b" are each 1 token
        )
        expect(typeof res.usage.inputTokens).toBe("number")
        expect(typeof res.usage.outputTokens).toBe("number")
        expect(res.usage.reasoningTokensEstimatedBy).toBeUndefined() // stub measures, never estimates
      })
    )
  )

  it.effect("parallel first-complete returns the fastest provider", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const fast = new StubProvider("fast", "fast-answer", "t", 0)
        const slow = new StubProvider("slow", "slow-answer", "t", 5000)
        yield* pool.register(fast)
        yield* pool.register(slow)

        const res = yield* pool.generate(req, { mode: "parallel", merge: "first-complete" })
        expect(res.text).toBe("fast-answer")
        expect(fast.calls.length).toBe(1)
      })
    )
  )

  it.effect("aux lane never touches the foreground provider", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const fg = new StubProvider("foreground")
        const aux = new StubProvider("aux-model")
        yield* pool.register(fg)
        yield* pool.register(aux)
        yield* pool.setAuxProvider("aux-model")

        const res = yield* pool.generateAux(req)
        expect(res.text).toContain("aux-model")
        expect(aux.calls.length).toBe(1)
        expect(fg.calls.length).toBe(0)

        // task:"aux" on generate() takes the same lane
        yield* pool.generate(req, { mode: "powerhouse", task: "aux" })
        expect(aux.calls.length).toBe(2)
        expect(fg.calls.length).toBe(0)
      })
    )
  )

  it.effect("generateAux with no designated aux provider fails instead of falling back", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const fg = new StubProvider("foreground")
        yield* pool.register(fg)

        const err = yield* Effect.flip(pool.generateAux(req))
        expect(err).toBeInstanceOf(InferenceError)
        expect(err.provider).toBe("pool")
        expect(fg.calls.length).toBe(0)
      })
    )
  )

  it.effect("provider failure surfaces typed InferenceError with NO fallback attempt", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const a = new StubProvider("local-a")
        const b = new StubProvider("local-b")
        yield* pool.register(a)
        yield* pool.register(b)
        a.failNextWith("simulated outage")

        const err = yield* Effect.flip(pool.generate(req, { mode: "powerhouse" }))
        expect(err).toBeInstanceOf(InferenceError)
        expect(err.provider).toBe("local-a")
        expect(err.reason).toBe("simulated outage")
        // No silent retry of a different provider — b was never attempted.
        expect(a.calls.length).toBe(1)
        expect(b.calls.length).toBe(0)
      })
    )
  )

  it.effect("explicit fallback chains are honored in order (powerhouse)", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const bad = new StubProvider("bad")
        const good = new StubProvider("good", "recovered")
        yield* pool.register(bad)
        yield* pool.register(good)
        bad.failNextWith("first is down")

        const res = yield* pool.generate(req, {
          mode: "powerhouse",
          providers: ["bad", "good"]
        })
        expect(res.text).toBe("recovered")
        expect(bad.calls.length).toBe(1)
        expect(good.calls.length).toBe(1)
      })
    )
  )

  it.effect("cloud registration without optIn fails; with optIn succeeds", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool

        const err = yield* Effect.flip(pool.register(cloudProvider))
        expect(err).toBeInstanceOf(InferenceError)
        expect(err.provider).toBe("cloud-x")
        expect(err.reason).toContain("opt-in")
        expect(yield* pool.registeredProviders()).not.toContain("cloud-x")

        yield* pool.register(cloudProvider, { optIn: true })
        expect(yield* pool.registeredProviders()).toContain("cloud-x")
        expect(yield* pool.egressOf("cloud-x")).toBe("vendor")
      })
    )
  )

  it.effect("switchProvider without confirmed:true fails; with it, switches", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const a = new StubProvider("local-a", "answer-a")
        const b = new StubProvider("local-b", "answer-b")
        yield* pool.register(a)
        yield* pool.register(b)

        const err = yield* Effect.flip(pool.switchProvider("local-b"))
        expect(err).toBeInstanceOf(InferenceError)
        expect(err.reason).toContain("confirmed")

        // Still on the default: switch did not happen.
        expect((yield* pool.generate(req, { mode: "powerhouse" })).text).toBe("answer-a")

        const cost = yield* pool.describeSwitch("local-b")
        expect(cost.from).toBe("local-a")
        expect(cost.to).toBe("local-b")
        expect(cost.cacheInvalidated).toBe(true)
        expect(cost.behaviorDeltaClass).toBe("cross-provider")

        yield* pool.switchProvider("local-b", { confirmed: true })
        expect((yield* pool.generate(req, { mode: "powerhouse" })).text).toBe("answer-b")
      })
    )
  )

  it.effect("switchProvider to an unknown provider fails", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const err = yield* Effect.flip(pool.switchProvider("ghost", { confirmed: true }))
        expect(err).toBeInstanceOf(InferenceError)
        expect(err.reason).toContain("not registered")
      })
    )
  )

  it.effect("egressOf reports the declared egress class per provider", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const local = new StubProvider("local-a")
        yield* pool.register(local)
        yield* pool.register(cloudProvider, { optIn: true })
        expect(yield* pool.egressOf("local-a")).toBe("local")
        expect(yield* pool.egressOf("cloud-x")).toBe("vendor")
      })
    )
  )

  it.effect("zero-socket: a full generate cycle opens no network sockets", () =>
    withPool(
      Effect.gen(function* () {
        const fetchCalls: Array<unknown> = []
        const originalFetch = globalThis.fetch
        globalThis.fetch = ((...args: Array<unknown>) => {
          fetchCalls.push(args)
          return Promise.reject(new Error("network disabled in test"))
        }) as typeof fetch
        try {
          const pool = yield* InferencePool
          const fg = new StubProvider("foreground")
          const aux = new StubProvider("aux-model")
          yield* pool.register(fg)
          yield* pool.register(aux)
          yield* pool.setAuxProvider("aux-model")

          yield* pool.generate(req, { mode: "powerhouse" })
          yield* pool.generate(req, { mode: "parallel" })
          yield* pool.generate(req, { mode: "parallel", merge: "merged" })
          yield* pool.generateAux(req)
          yield* pool.egressOf("foreground")
        } finally {
          globalThis.fetch = originalFetch
        }
        // The pool makes zero network calls except through a provider's own
        // inference endpoint — and the only provider here is the stub, which
        // has no transport code at all.
        expect(fetchCalls.length).toBe(0)
      })
    )
  )

  it.effect("usage always includes reasoningTokens as a number", () =>
    withPool(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const a = new StubProvider("local-a")
        const b = new StubProvider("local-b")
        yield* pool.register(a)
        yield* pool.register(b)
        yield* pool.setAuxProvider("local-b")

        const single = yield* pool.generate(req, { mode: "powerhouse" })
        const merged = yield* pool.generate(req, { mode: "parallel", merge: "merged" })
        const aux = yield* pool.generateAux(req)
        for (const usage of [single.usage, merged.usage, aux.usage]) {
          expect(typeof usage.reasoningTokens).toBe("number")
        }
      })
    )
  )
})
