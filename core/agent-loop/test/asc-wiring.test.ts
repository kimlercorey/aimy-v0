/**
 * asc-wiring.test.ts — Track 4: the ASC pipeline wired into the agent loop.
 *
 * Additive wiring (`layerAgentLoopWithAsc`, mirroring M3's
 * `layerAgentLoopWithHonesty`): preTurn at the prepareRequest point,
 * the post-turn audit at the finishTurn point, `report.asc` on `Done`.
 *
 * Invariants under test:
 * - the loop never writes dials directly (live vector == pipeline's write);
 * - the post-turn audit is never skipped on abort (marked partial);
 * - `Done` is never emitted before the audit settles (settled = post-turn
 *   audit complete + DialComputation archived).
 */
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"

import {
  AgentLoop,
  analyzeContent,
  type ChatChunk,
} from "../src/index.js"
import {
  AscSelfMonitor,
  AscSelfNarration,
  DIAL_NAMES,
  DialState,
} from "../../asc-engine/index.js"
import {
  InferencePool,
  StubProvider,
  type GenerateRequest,
  type GenerateResponse,
  type InferenceError,
  type Provider,
} from "../../inference-pool/index.js"
import { buildStack, doneReport, tmpRoot } from "./fixtures.js"

const inBounds = (v: Record<string, number>): boolean =>
  DIAL_NAMES.every((d) => v[d]! >= 0 && v[d]! <= 10)

describe("ASC agent-loop wiring (Track 4)", () => {
  it.effect("wired turn: preTurn before generation, audit before Done, report carries asc", () =>
    Effect.gen(function* () {
      const stack = buildStack(tmpRoot(), { asc: true })
      const program = Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(new StubProvider("asc-stub", "Here is the answer."))
        const loop = yield* AgentLoop
        const chunks = yield* Stream.runCollect(loop.chat("asc-1", "hello, what can you do?"))
        const list = [...chunks] as Array<ChatChunk>
        const report = doneReport(list)

        // The report carries the pipeline's pre-turn + post-turn.
        expect(report.asc).toBeDefined()
        const asc = report.asc!
        expect(asc.pre.computation.turn).toBe(1)
        expect(inBounds(asc.pre.dials)).toBe(true)
        expect(inBounds(asc.pre.computation.rawDials)).toBe(true)
        // Fresh "general" domain -> the capability gate names the gap.
        expect(asc.pre.gated).toBe(true)
        expect(asc.pre.computation.gated.reason).toContain("general")
        expect(asc.post.partial).toBe(false)

        const monitor = yield* AscSelfMonitor
        // Settled before Done: the audit ran AND the computation is archived.
        const history = yield* monitor.history()
        expect(history.length).toBe(1)
        expect(history[0]!.id).toBe(asc.pre.computation.id)
        expect(history[0]!.turn).toBe(1)

        // The loop never wrote dials directly: the live vector is exactly
        // the pipeline's single write (seam S7).
        const dialState = yield* DialState
        const live = yield* dialState.current
        expect(live).toEqual(asc.pre.dials)

        // L3 narrated the turn.
        const narration = yield* AscSelfNarration
        const entries = yield* narration.stream()
        expect(entries.length).toBe(1)
        expect(entries[0]!.turn).toBe(1)
      })
      yield* Effect.provide(program, stack)
    }))

  it.effect("interrupted turn: the audit still runs, marked partial", () =>
    Effect.gen(function* () {
      const stack = buildStack(tmpRoot(), { asc: true })
      // A provider whose generate never completes — the turn hangs in the
      // token phase until we interrupt the fiber.
      const neverProvider: Provider = {
        name: "never",
        kind: "local",
        egress: "local",
        capabilities: { reasoningTokens: false, tools: false },
        generate: (_request: GenerateRequest): Effect.Effect<GenerateResponse, InferenceError> =>
          Effect.never,
      }
      const program = Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(neverProvider)
        const loop = yield* AgentLoop
        const monitor = yield* AscSelfMonitor

        const fiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Effect.scope
            const f = yield* Effect.forkIn(scope)(
              Stream.runCollect(loop.chat("asc-2", "hello?")),
            )
            // Wait until the turn's preTurn ran (computation archived) —
            // i.e. the fiber is now stuck in generation, pre-audit.
            let archived = 0
            for (let i = 0; i < 1000 && archived === 0; i++) {
              archived = (yield* monitor.history()).length
              if (archived === 0) yield* Effect.yieldNow
            }
            expect(archived).toBe(1)
            // Abort mid-generation. `Fiber.interrupt` waits for teardown,
            // including the uninterruptible abort finalizer.
            yield* Fiber.interrupt(f)
          }),
        )
        void fiber

        // The audit ran despite the abort — marked partial, archived.
        const history = yield* monitor.history()
        expect(history.length).toBe(1)
        const narration = yield* AscSelfNarration
        const entries = yield* narration.stream()
        expect(entries.length).toBe(1)
        expect(entries[0]!.text).toContain("partial")
      })
      yield* Effect.provide(program, stack)
    }))

  it.effect("unwired loop: no asc on the report, pipeline untouched", () =>
    Effect.gen(function* () {
      const stack = buildStack(tmpRoot())
      const program = Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(new StubProvider("plain-stub", "Plain answer."))
        const loop = yield* AgentLoop
        const chunks = yield* Stream.runCollect(loop.chat("asc-3", "hello"))
        const report = doneReport([...chunks] as Array<ChatChunk>)
        expect(report.asc).toBeUndefined()

        // The pipeline never ran: no computations archived.
        const monitor = yield* AscSelfMonitor
        expect((yield* monitor.history()).length).toBe(0)
      })
      yield* Effect.provide(program, stack)
    }))
})

describe("analyzeContent (heuristic)", () => {
  it("routes debugging / regex / meta questions", () => {
    expect(analyzeContent("My script throws KeyError on the third item").domain).toBe("debugging")
    expect(analyzeContent("Can you help me write a regular expression?").domain).toBe("regex")
    expect(analyzeContent("Can you tell me how you feel?").isMetaQuestion).toBe(true)
    expect(analyzeContent("hello").domain).toBe("general")
  })

  it("grades urgency and cost of error", () => {
    const urgent = analyzeContent("The build crashed, production is down, blocking the release")
    expect(urgent.urgency).toBeGreaterThan(0.5)
    expect(urgent.costOfError).toBeGreaterThan(0.5)
    const casual = analyzeContent("just wondering about a routine question")
    expect(casual.urgency).toBeLessThan(0.5)
  })
})
