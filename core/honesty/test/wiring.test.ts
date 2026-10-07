/**
 * honesty/test/wiring.test.ts — Track 3: the post-turn honesty pipeline.
 *
 * Covers `runPostTurnHonesty` (honesty/wiring.ts) at the pipeline level with
 * fabricated turn reports, plus the real AgentLoop integration: the `Done`
 * chunk's report carries `report.honesty`, judge FAILs surface there (never
 * swallowed), and judge infrastructure errors are typed stream errors.
 *
 * The loop-level tests drive the REAL stack from agent-loop/test/fixtures.ts
 * (real SafetyKernel, real gates, StubProvider — no network).
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { InferencePool, StubProvider } from "../../inference-pool/index.js"
import { AgentLoop, type AgentLoopHonestyOpts } from "../../agent-loop/src/index.js"
import type { ChatChunk, ExecutedToolCall, TurnReport } from "../../agent-loop/src/index.js"
import {
  buildStack,
  doneReport,
  tmpRoot,
  toolBlock
} from "../../agent-loop/test/fixtures.js"
import { HonestyService, HonestyServiceInMemory, type HonestyServiceShape } from "../src/index.js"
import { JudgeNotFound, JudgeRegistry } from "../judges/src/index.js"
import {
  DEMO_UNVERIFIED_CLAIM_TEXT,
  runPostTurnHonesty,
  type PostTurnHonestyOptions,
  type PostTurnHonestyError,
  type TurnHonestyReport
} from "../wiring.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-10-07T12:00:00.000Z"

const turnReport = (opts: {
  readonly turnId?: string
  readonly text: string
  readonly executed: ReadonlyArray<ExecutedToolCall>
}): TurnReport => ({
  turnId: opts.turnId ?? "turn-1",
  text: opts.text,
  executed: opts.executed,
  blocked: [],
  terminated: false,
  parseFailures: [],
  steeringMessages: [],
  followUpMessages: []
})

const okCall = (id: string, tool: string, result: unknown): ExecutedToolCall => ({
  id,
  tool,
  result
})

const GOOD_RESULT = "2026-10-07T12:00:00.000Z"

/** A turn whose dialogue honestly reports what the tool log shows. */
const goodReport = (turnId: string): TurnReport =>
  turnReport({
    turnId,
    text: "The current time, from clock.now:\nRetrieved from clock.now successfully.",
    executed: [okCall(`${turnId}:call:0`, "clock.now", GOOD_RESULT)]
  })

/**
 * A sabotaged turn, constructed via the adapter path: the tool outcome was
 * io-error, but the dialogue claims the tool succeeded. The JudgeInput the
 * pipeline builds must trip `tool-success-matches-side-effects`.
 */
const sabotagedReport = (turnId: string): TurnReport =>
  turnReport({
    turnId,
    text: "clock.now retrieved the time successfully.",
    executed: [
      okCall(`${turnId}:call:0`, "clock.now", {
        _tag: "IoError",
        reason: "connection refused"
      })
    ]
  })

const runPipeline = (
  options: PostTurnHonestyOptions
): Effect.Effect<TurnHonestyReport, PostTurnHonestyError, HonestyService> =>
  Effect.gen(function* () {
    const honesty = yield* HonestyService
    return yield* runPostTurnHonesty(honesty, options)
  })

/** Fresh in-memory ledger per run. */
const runPipelineInMemory = (
  options: PostTurnHonestyOptions
): Promise<TurnHonestyReport> =>
  Effect.runPromise(Effect.provide(runPipeline(options), HonestyServiceInMemory))

const baseOptions = (report: TurnReport): PostTurnHonestyOptions => ({
  sessionId: "session-1",
  input: "test input",
  report,
  now: FIXED_NOW
})

// ---------------------------------------------------------------------------
// Pipeline level
// ---------------------------------------------------------------------------

describe("runPostTurnHonesty", () => {
  it("records one claim per executed tool call with tool-output evidence attached", async () => {
    const out = await runPipelineInMemory(baseOptions(goodReport("turn-good-1")))

    expect(out.verdicts.length).toBe(3)
    expect(out.failedVerdicts).toEqual([])
    expect(out.claims.length).toBe(1)

    const pair = out.claims[0]!
    expect(pair.claim.kind).toBe("tool-outcome")
    expect(pair.claim.text).toBe(`clock.now returned ${GOOD_RESULT}`)
    const kinds = pair.badge.evidence.map((e) => e.kind)
    expect(kinds).toEqual(["tool-output", "judge-verdict", "judge-verdict", "judge-verdict"])
    expect(pair.badge.evidence[0]!.ref).toBe("turn-good-1:call:0")
    // Every verdict attached names its pinned judge version.
    for (const verdict of out.verdicts) {
      expect(verdict.judgeVersion).toBe("1.0.0")
      expect(verdict.taskId).toBe("turn-good-1")
      expect(pair.badge.verdictIds).toContain(verdict.verdictId)
    }
  })

  it("all three reference judges PASS an honest turn; badge renders verified", async () => {
    const out = await runPipelineInMemory(baseOptions(goodReport("turn-good-2")))

    const byId = new Map(out.verdicts.map((v) => [v.judgeId, v]))
    expect([...byId.keys()].sort()).toEqual([
      "claim-has-evidence",
      "no-undeclared-side-effects",
      "tool-success-matches-side-effects"
    ])
    for (const verdict of out.verdicts) expect(verdict.verdict).toBe("pass")
    expect(out.claims[0]!.badge.status).toBe("verified")
  })

  it("judge FAIL renders badge failed AND is surfaced on the report, not swallowed", async () => {
    const out = await runPipelineInMemory(baseOptions(sabotagedReport("turn-bad-1")))

    // The failure is DATA on the report — the exact object the loop puts on
    // the Done chunk. It was not thrown, not hidden.
    expect(out.failedVerdicts.length).toBe(1)
    const failure = out.failedVerdicts[0]!
    expect(failure.judgeId).toBe("tool-success-matches-side-effects")
    expect(failure.judgeVersion).toBe("1.0.0")
    expect(failure.verdict).toBe("fail")
    expect(failure.reasons.join("\n")).toContain('outcome "io-error"')

    // …and it dominates the badge: evidence or not, a failed verdict means
    // "failed".
    const badge = out.claims[0]!.badge
    expect(badge.status).toBe("failed")
    expect(badge.verdictIds).toContain(failure.verdictId)
    expect(badge.evidence.length).toBeGreaterThan(0)
  })

  it("the deliberately evidence-less demo claim renders unverified", async () => {
    const out = await runPipelineInMemory({
      ...baseOptions(goodReport("turn-demo-1")),
      recordUnverifiedDemoClaim: true
    })

    expect(out.claims.length).toBe(2)
    const demo = out.claims.find((p) => p.claim.text === DEMO_UNVERIFIED_CLAIM_TEXT)!
    expect(demo.badge.status).toBe("unverified")
    expect(demo.badge.evidence).toEqual([])
    expect(demo.badge.verdictIds).toEqual([])
    // The mechanism labels it — no prompt, no special case: zero evidence
    // cannot be "verified" through this API.
    const toolPair = out.claims.find((p) => p.claim.text !== DEMO_UNVERIFIED_CLAIM_TEXT)!
    expect(toolPair.badge.status).toBe("verified")
  })

  it("judge infrastructure error is a typed stream error, distinct from a FAIL verdict", async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          runPipeline({
            ...baseOptions(goodReport("turn-infra-1")),
            registry: JudgeRegistry.empty()
          }),
          HonestyServiceInMemory
        )
      )
    )
    // Typed error on the error channel — not a verdict, not data.
    expect(err).toBeInstanceOf(JudgeNotFound)
    expect(err._tag).toBe("JudgeNotFound")
    expect((err as JudgeNotFound).judgeId).toBe("tool-success-matches-side-effects")
  })

  it("is deterministic: same turn data twice → identical verdictIds", async () => {
    const options = baseOptions(goodReport("turn-det-1"))
    const first = await runPipelineInMemory(options)
    const second = await runPipelineInMemory(options)
    expect(first.verdicts.map((v) => v.verdictId)).toEqual(
      second.verdicts.map((v) => v.verdictId)
    )
    expect(first.claims.map((p) => p.claim.claimId)).toEqual(
      second.claims.map((p) => p.claim.claimId)
    )
  })

  it("skips the judges for a turn with no tool activity", async () => {
    const out = await runPipelineInMemory(
      baseOptions(turnReport({ turnId: "turn-quiet-1", text: "just chatting", executed: [] }))
    )
    expect(out.verdicts).toEqual([])
    expect(out.failedVerdicts).toEqual([])
    expect(out.claims).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Live loop integration
// ---------------------------------------------------------------------------

const GOOD_STUB_TEXT =
  "The current time, from clock.now:\n" +
  toolBlock("clock.now") +
  "\nRetrieved from clock.now successfully."

/** Run one REAL loop turn with the honesty wiring active; return chunks + ledger. */
const runLiveTurn = (
  stubName: string,
  stubText: string,
  sessionId: string,
  input: string,
  honestyOpts?: AgentLoopHonestyOpts
): Promise<{ readonly chunks: ReadonlyArray<ChatChunk>; readonly honesty: HonestyServiceShape }> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(new StubProvider(stubName, stubText))
        const loop = yield* AgentLoop
        const chunks = [...(yield* Stream.runCollect(loop.chat(sessionId, input)))]
        // Same ledger instance the loop's pipeline wrote to: buildStack
        // provides HonestyServiceInMemory internally when honesty opts are set.
        const honesty = yield* HonestyService
        return { chunks, honesty }
      }),
      buildStack(tmpRoot(), { honesty: honestyOpts ?? {} })
    )
  )

describe("post-turn honesty in the live loop", () => {
  it("good turn: the Done chunk's report carries honesty with a verified badge", async () => {
    const { chunks, honesty } = await runLiveTurn("loop-good", GOOD_STUB_TEXT, "s1", "what time is it?")
    const report = doneReport(chunks)

    expect(report.executed.length).toBe(1)
    expect(report.executed[0]!.tool).toBe("clock.now")

    const h = report.honesty
    expect(h).toBeDefined()
    expect(h!.verdicts.length).toBe(3)
    expect(h!.failedVerdicts).toEqual([])
    expect(h!.claims.length).toBe(1)
    expect(h!.claims[0]!.badge.status).toBe("verified")

    // The ledger agrees — the badge is derived, not asserted by the loop.
    const pairs = await Effect.runPromise(honesty.claimsForTurn("s1", report.turnId))
    expect(pairs.length).toBe(1)
    expect(pairs[0]!.badge.status).toBe("verified")
  })

  it("sabotaged turn: the judge FAIL is visible in the Done chunk's report, not hidden", async () => {
    // The stub is dishonest: it claims the unknown tool succeeded, but the
    // real execution records an io-error. The judge must catch the
    // contradiction and the loop must surface it.
    const sabotageText =
      "Session info:\n" + toolBlock("nope.nope") + "\nnope.nope completed successfully, got the result."
    const { chunks } = await runLiveTurn("loop-sabotage", sabotageText, "s1", "get session info")
    const report = doneReport(chunks)

    expect(report.executed.length).toBe(1)
    expect((report.executed[0]!.result as { _tag: string })._tag).toBe("IoError")

    // The failure is PRESENT in the emitted Done chunk — the loop did not
    // swallow it, throw it away, or convert it into a crash.
    const h = report.honesty
    expect(h).toBeDefined()
    expect(h!.failedVerdicts.length).toBe(1)
    expect(h!.failedVerdicts[0]!.judgeId).toBe("tool-success-matches-side-effects")
    expect(h!.failedVerdicts[0]!.verdict).toBe("fail")
    expect(h!.claims[0]!.badge.status).toBe("failed")
  })

  it("without HonestyService in the layer, the Done path skips the pipeline", async () => {
    const stack = buildStack(tmpRoot())
    const program = Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(new StubProvider("loop-plain", GOOD_STUB_TEXT))
      const loop = yield* AgentLoop
      return [...(yield* Stream.runCollect(loop.chat("s1", "what time is it?")))]
    })
    const chunks = await Effect.runPromise(Effect.provide(program, stack))
    expect(doneReport(chunks).honesty).toBeUndefined()
  })
})
