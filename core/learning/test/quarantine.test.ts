/**
 * Track 2 — quarantine tests.
 *
 * Quarantine is a structural state: the record is inert data, only the
 * store transitions states, and `trusted` is reachable only through
 * `applyPromotion` with a `VerifiedReport` (minted by the arm, never
 * forged in tests — see fixtures.verifyPassing).
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  QuarantineError,
  QuarantineStore,
  QuarantineViolation,
  type QuarantineStoreShape,
} from "../src/quarantine.js"
import { makeCandidate, testLayers, verifyPassing } from "./fixtures.js"

const withStore = <A, E, R>(
  use: (store: QuarantineStoreShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const store = yield* QuarantineStore
    return yield* use(store)
  }).pipe(Effect.provide(testLayers()))

describe("QuarantineStore", () => {
  it.effect("a new skill lands in quarantine", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const record = yield* store.quarantine(makeCandidate())
        expect(record.state).toBe("quarantined")
        expect(record.skillId).toBe("skill-echo")
        expect(record.history.length).toBe(1)
        expect(record.evidenceRefs).toEqual([])
        expect(record.reportId).toBeUndefined()
      }),
    ),
  )

  it.effect("re-quarantining the same skill fails typed", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.quarantine(makeCandidate())
        const err = yield* Effect.flip(store.quarantine(makeCandidate()))
        expect(err).toBeInstanceOf(QuarantineError)
        expect(err.reason).toContain("already quarantined")
      }),
    ),
  )

  it.effect("quarantined skills never resolve for live tasks", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.quarantine(makeCandidate())
        const err = yield* Effect.flip(store.resolveForLive("skill-echo"))
        expect(err).toBeInstanceOf(QuarantineViolation)
        expect(err.reason).toContain("not trusted")
      }),
    ),
  )

  it.effect("sandboxed runs require T0 + observer witness", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.quarantine(makeCandidate())
        const run = Effect.succeed("ran")
        // Happy path: T0, observed.
        expect(yield* store.runSandboxed("skill-echo", "T0", true, run)).toBe("ran")
        // Wrong tier.
        const tierErr = yield* Effect.flip(store.runSandboxed("skill-echo", "T2", true, run))
        expect(tierErr).toBeInstanceOf(QuarantineViolation)
        expect(tierErr.reason).toContain("T0")
        // Unobserved.
        const obsErr = yield* Effect.flip(store.runSandboxed("skill-echo", "T0", false, run))
        expect(obsErr).toBeInstanceOf(QuarantineViolation)
        expect(obsErr.reason).toContain("observer")
        // Unknown skill.
        const unknownErr = yield* Effect.flip(store.runSandboxed("nope", "T0", true, run))
        expect(unknownErr).toBeInstanceOf(QuarantineViolation)
      }),
    ),
  )

  it.effect("markVerifying moves quarantined -> verifying; sandboxed runs still allowed", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.quarantine(makeCandidate())
        const next = yield* store.markVerifying("skill-echo")
        expect(next.state).toBe("verifying")
        expect(next.history.length).toBe(2)
        expect(yield* store.runSandboxed("skill-echo", "T0", true, Effect.succeed(1))).toBe(1)
        // Double markVerifying fails: only quarantined -> verifying is legal.
        const err = yield* Effect.flip(store.markVerifying("skill-echo"))
        expect(err).toBeInstanceOf(QuarantineError)
      }),
    ),
  )

  it.effect("promotion requires the arm's VerifiedReport; state becomes trusted", () =>
    Effect.gen(function* () {
      const verified = yield* verifyPassing(makeCandidate({ skillId: "skill-promo" }))
      const store = yield* QuarantineStore
      yield* store.quarantine(makeCandidate({ skillId: "skill-promo" }))
      yield* store.markVerifying("skill-promo")
      const record = yield* store.applyPromotion(verified)
      expect(record.state).toBe("trusted")
      expect(record.reportId).toBe(verified.reportId)
      expect(record.evidenceRefs.length).toBeGreaterThan(0)
      // And now it resolves for live tasks.
      expect((yield* store.resolveForLive("skill-promo")).state).toBe("trusted")
    }).pipe(Effect.provide(testLayers())),
  )

  it.effect("promotion from a non-quarantined state fails", () =>
    Effect.gen(function* () {
      const verified = yield* verifyPassing(makeCandidate({ skillId: "skill-twice" }))
      const store = yield* QuarantineStore
      yield* store.quarantine(makeCandidate({ skillId: "skill-twice" }))
      yield* store.applyPromotion(verified)
      // Second promotion: already trusted -> typed failure, state untouched.
      const err = yield* Effect.flip(store.applyPromotion(verified))
      expect(err).toBeInstanceOf(QuarantineError)
      expect((yield* store.get("skill-twice")).state).toBe("trusted")
    }).pipe(Effect.provide(testLayers())),
  )

  it.effect("rejected skills can neither run sandboxed nor resolve live", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.quarantine(makeCandidate())
        const rejected = yield* store.applyRejection("skill-echo", "verification failed", ["ev-1"])
        expect(rejected.state).toBe("rejected")
        expect(rejected.evidenceRefs).toContain("ev-1")
        expect(rejected.history.length).toBe(2)
        const runErr = yield* Effect.flip(store.runSandboxed("skill-echo", "T0", true, Effect.succeed(1)))
        expect(runErr).toBeInstanceOf(QuarantineViolation)
        const liveErr = yield* Effect.flip(store.resolveForLive("skill-echo"))
        expect(liveErr).toBeInstanceOf(QuarantineViolation)
      }),
    ),
  )
})
