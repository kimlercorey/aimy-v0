/**
 * honesty/test/honesty.test.ts — HonestyService behavior.
 *
 * Covers the badge-derivation matrix, idempotent claim re-recording,
 * verdict immutability, evidence queries, and the typed-error paths.
 * Runs against the in-memory ledger only (no I/O, no network).
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  HonestyService,
  HonestyServiceInMemory,
  type HonestyServiceShape,
  type JudgeVerdict,
  type NewClaim,
  type NewEvidence,
} from "../src/index.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const claim = (text: string, turnId = "turn-1"): NewClaim => ({
  sessionId: "session-1",
  turnId,
  text,
  kind: "task-result",
})

const toolEvidence = (ref: string, summary = "tool output"): NewEvidence => ({
  kind: "tool-output",
  ref,
  summary,
})

const verdictEvidence = (verdictId: string): NewEvidence => ({
  kind: "judge-verdict",
  ref: verdictId,
  summary: `judge verdict ${verdictId}`,
})

const verdict = (verdictId: string, v: "pass" | "fail", judgeVersion = "1.2.0"): JudgeVerdict => ({
  verdictId,
  judgeId: "final-state-check",
  judgeVersion,
  taskId: "task-1",
  verdict: v,
  reasons: [`judge said ${v}`],
  evidenceIds: [],
  ranAt: new Date().toISOString(),
})

const withHonesty = <A, E>(
  use: (svc: HonestyServiceShape) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const svc = yield* HonestyService
    return yield* use(svc)
  }).pipe(Effect.provide(HonestyServiceInMemory))

const isIsoDate = (s: string): boolean => !Number.isNaN(Date.parse(s))

describe("HonestyService", () => {
  describe("badge derivation matrix", () => {
    it.effect("no evidence -> unverified", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const c = yield* svc.recordClaim(claim("the build passed"))
          const badge = yield* svc.getBadge(c.claimId)
          assert.strictEqual(badge.status, "unverified")
          assert.strictEqual(badge.claimId, c.claimId)
          assert.deepStrictEqual(badge.evidence, [])
          assert.deepStrictEqual(badge.verdictIds, [])
        }),
      ),
    )

    it.effect("evidence, no verdicts -> verified", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const c = yield* svc.recordClaim(claim("the build passed"))
          yield* svc.attachEvidence(c.claimId, toolEvidence("toolcall-1"))
          const badge = yield* svc.getBadge(c.claimId)
          assert.strictEqual(badge.status, "verified")
          assert.strictEqual(badge.evidence.length, 1)
          assert.strictEqual(badge.evidence[0]?.ref, "toolcall-1")
        }),
      ),
    )

    it.effect("passed verdict -> verified, verdict listed", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const c = yield* svc.recordClaim(claim("deploy succeeded"))
          yield* svc.recordVerdict(verdict("v-pass-1", "pass"))
          yield* svc.attachEvidence(c.claimId, verdictEvidence("v-pass-1"))
          const badge = yield* svc.getBadge(c.claimId)
          assert.strictEqual(badge.status, "verified")
          assert.deepStrictEqual(badge.verdictIds, ["v-pass-1"])
        }),
      ),
    )

    it.effect("failed verdict -> failed even with other evidence", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const c = yield* svc.recordClaim(claim("deploy succeeded"))
          yield* svc.attachEvidence(c.claimId, toolEvidence("toolcall-1", "logs look fine"))
          yield* svc.attachEvidence(c.claimId, toolEvidence("toolcall-2", "exit code 0"))
          yield* svc.recordVerdict(verdict("v-pass-1", "pass"))
          yield* svc.recordVerdict(verdict("v-fail-1", "fail"))
          yield* svc.attachEvidence(c.claimId, verdictEvidence("v-pass-1"))
          yield* svc.attachEvidence(c.claimId, verdictEvidence("v-fail-1"))
          const badge = yield* svc.getBadge(c.claimId)
          assert.strictEqual(badge.status, "failed")
          assert.deepStrictEqual(badge.verdictIds, ["v-pass-1", "v-fail-1"])
        }),
      ),
    )

    it.effect("failed verdict alone (no other evidence) -> failed", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const c = yield* svc.recordClaim(claim("deploy succeeded"))
          yield* svc.recordVerdict(verdict("v-fail-1", "fail"))
          yield* svc.attachEvidence(c.claimId, verdictEvidence("v-fail-1"))
          const badge = yield* svc.getBadge(c.claimId)
          assert.strictEqual(badge.status, "failed")
        }),
      ),
    )

    it.effect("evidence on one claim does not leak into another claim's badge", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const a = yield* svc.recordClaim(claim("claim A"))
          const b = yield* svc.recordClaim(claim("claim B"))
          yield* svc.attachEvidence(a.claimId, toolEvidence("toolcall-1"))
          assert.strictEqual((yield* svc.getBadge(a.claimId)).status, "verified")
          assert.strictEqual((yield* svc.getBadge(b.claimId)).status, "unverified")
        }),
      ),
    )
  })

  describe("idempotent claim recording", () => {
    it.effect("re-recording the same (session, turn, text) returns the same claimId", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const first = yield* svc.recordClaim(claim("deterministic me"))
          const second = yield* svc.recordClaim(claim("deterministic me"))
          assert.strictEqual(first.claimId, second.claimId)
          assert.deepStrictEqual(first, second)
        }),
      ),
    )

    it.effect("claimIds are deterministic across fresh service instances (no randomness, no clock)", () =>
      Effect.gen(function* () {
        const one = yield* withHonesty((svc) => svc.recordClaim(claim("same input")))
        const two = yield* withHonesty((svc) => svc.recordClaim(claim("same input")))
        assert.strictEqual(one.claimId, two.claimId)
        assert.match(one.claimId, /^[0-9a-f]{64}$/)
      }),
    )

    it.effect("different texts get different claimIds", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const a = yield* svc.recordClaim(claim("alpha"))
          const b = yield* svc.recordClaim(claim("beta"))
          assert.notStrictEqual(a.claimId, b.claimId)
        }),
      ),
    )

    it.effect("re-record keeps the original kind (first write wins)", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const first = yield* svc.recordClaim({ ...claim("same text"), kind: "factual" })
          const second = yield* svc.recordClaim({ ...claim("same text"), kind: "tool-outcome" })
          assert.strictEqual(first.kind, "factual")
          assert.strictEqual(second.kind, "factual")
        }),
      ),
    )
  })

  describe("verdict immutability", () => {
    it.effect("mutating the input object after recording does not change the stored verdict", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const v = verdict("v-imm-1", "pass")
          yield* svc.recordVerdict(v)
          // Attempt to alter through the caller's alias.
          ;(v as { verdict: string }).verdict = "fail"
          ;(v.reasons as Array<string>).push("tampered")
          const stored = yield* svc.getVerdict("v-imm-1")
          assert.strictEqual(stored.verdict, "pass")
          assert.deepStrictEqual(stored.reasons, ["judge said pass"])
        }),
      ),
    )

    it.effect("re-recording an existing verdictId is a no-op success; stored verdict unchanged", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          yield* svc.recordVerdict(verdict("v-imm-2", "pass"))
          // Attempt to alter by re-recording conflicting content.
          yield* svc.recordVerdict({ ...verdict("v-imm-2", "fail"), judgeId: "other-judge" })
          const stored = yield* svc.getVerdict("v-imm-2")
          assert.strictEqual(stored.verdict, "pass")
          assert.strictEqual(stored.judgeId, "final-state-check")
        }),
      ),
    )

    it.effect("non-semver judgeVersion is rejected with InvalidVerdict", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(svc.recordVerdict(verdict("v-bad-1", "pass", "not-a-version")))
          assert.strictEqual(error._tag, "InvalidVerdict")
          assert.strictEqual((error as { verdictId: string }).verdictId, "v-bad-1")
        }),
      ),
    )
  })

  describe("evidence", () => {
    it.effect("evidenceFor returns exactly the attached set, in attach order", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const c = yield* svc.recordClaim(claim("with evidence"))
          const e1 = yield* svc.attachEvidence(c.claimId, toolEvidence("toolcall-1", "first"))
          const e2 = yield* svc.attachEvidence(c.claimId, toolEvidence("toolcall-2", "second"))
          const e3 = yield* svc.attachEvidence(c.claimId, {
            kind: "source",
            ref: "https://example.com/doc",
            summary: "a source",
          })
          const all = yield* svc.evidenceFor(c.claimId)
          assert.strictEqual(all.length, 3)
          assert.deepStrictEqual(
            all.map((e) => e.evidenceId),
            [e1.evidenceId, e2.evidenceId, e3.evidenceId],
          )
          // evidenceIds are content-derived: deterministic, unique, hex.
          assert.strictEqual(new Set(all.map((e) => e.evidenceId)).size, 3)
          for (const e of all) {
            assert.match(e.evidenceId, /^[0-9a-f]{64}$/)
            assert.isTrue(isIsoDate(e.recordedAt))
          }
        }),
      ),
    )

    it.effect("records are JSON-serializable (durable-ready)", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const c = yield* svc.recordClaim(claim("serializable"))
          const e = yield* svc.attachEvidence(c.claimId, toolEvidence("toolcall-1"))
          yield* svc.recordVerdict(verdict("v-json-1", "pass"))
          const stored = yield* svc.getVerdict("v-json-1")
          for (const record of [c, e, stored]) {
            assert.deepStrictEqual(JSON.parse(JSON.stringify(record)), record)
          }
        }),
      ),
    )

    it.effect("attaching judge-verdict evidence for an unknown verdict fails with VerdictNotFound", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const c = yield* svc.recordClaim(claim("dangling verdict ref"))
          const error = yield* Effect.flip(svc.attachEvidence(c.claimId, verdictEvidence("v-missing")))
          assert.strictEqual(error._tag, "VerdictNotFound")
        }),
      ),
    )
  })

  describe("typed errors", () => {
    it.effect("getBadge on unknown claimId -> ClaimNotFound", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(svc.getBadge("no-such-claim"))
          assert.strictEqual(error._tag, "ClaimNotFound")
          assert.strictEqual((error as { claimId: string }).claimId, "no-such-claim")
        }),
      ),
    )

    it.effect("evidenceFor on unknown claimId -> ClaimNotFound", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(svc.evidenceFor("no-such-claim"))
          assert.strictEqual(error._tag, "ClaimNotFound")
        }),
      ),
    )

    it.effect("attachEvidence on unknown claimId -> ClaimNotFound", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(svc.attachEvidence("no-such-claim", toolEvidence("t")))
          assert.strictEqual(error._tag, "ClaimNotFound")
        }),
      ),
    )

    it.effect("getVerdict on unknown verdictId -> VerdictNotFound", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(svc.getVerdict("no-such-verdict"))
          assert.strictEqual(error._tag, "VerdictNotFound")
        }),
      ),
    )
  })

  describe("claimsForTurn", () => {
    it.effect("lists the turn's claims, each with its derived badge", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const a = yield* svc.recordClaim(claim("turn claim A", "turn-7"))
          const b = yield* svc.recordClaim(claim("turn claim B", "turn-7"))
          yield* svc.recordClaim(claim("other turn", "turn-8"))
          yield* svc.attachEvidence(a.claimId, toolEvidence("toolcall-1"))
          const pairs = yield* svc.claimsForTurn("session-1", "turn-7")
          assert.strictEqual(pairs.length, 2)
          const byId = new Map(pairs.map((p) => [p.claim.claimId, p.badge.status] as const))
          assert.strictEqual(byId.get(a.claimId), "verified")
          assert.strictEqual(byId.get(b.claimId), "unverified")
        }),
      ),
    )

    it.effect("empty turn -> empty list", () =>
      withHonesty((svc) =>
        Effect.gen(function* () {
          const pairs = yield* svc.claimsForTurn("session-1", "turn-empty")
          assert.deepStrictEqual(pairs, [])
        }),
      ),
    )
  })
})
