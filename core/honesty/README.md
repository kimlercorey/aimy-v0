# @aimy/honesty — M3 Track 1: the HonestyService evidence ledger

The verification-evidence ledger for Project AImy (architecture §2.6, §12 M3;
MoSCoW MUST 11): claims the agent made, the evidence backing them, and the
executable-judge verdicts (Track 2) that checked them.

**Structural honesty, not prompt honesty.** A `VerificationBadge` is pure
derived data. The only badge constructor in this codebase is the
module-private `deriveBadge` in `src/service.ts`; the public API exposes no
way to mint a badge with an arbitrary status. Consequences, enforced by the
types:

- a claim with zero evidence is `"unverified"` — by construction, never by a prompt instruction;
- a claim with ≥1 evidence record and no failed verdicts is `"verified"`;
- **any** attached judge verdict of `"fail"` forces `"failed"`, even when the
  claim has abundant other evidence.

## Layout

```
honesty/
  index.ts            # top-level re-export (external consumers)
  src/
    index.ts          # internal re-export (tests import ../src/index.js)
    types.ts          # the shared cross-track contracts (verbatim)
    errors.ts         # HonestyError — substrate-style Data.TaggedErrors
    store.ts          # LedgerStore seam + InMemoryLedgerStore default
    service.ts        # HonestyService tag + HonestyServiceLive layer
  test/
    honesty.test.ts
```

## API

```ts
import { Effect } from "effect"
import {
  HonestyService,
  HonestyServiceInMemory, // live service over the in-memory ledger
} from "@aimy/honesty" // or ../../honesty/index.js within core/

const program = Effect.gen(function* () {
  const honesty = yield* HonestyService

  // 1. The loop records a claim (from a tool outcome / task result).
  // claimId is deterministic in (sessionId, turnId, text): re-recording is idempotent.
  const claim = yield* honesty.recordClaim({
    sessionId: "s-1",
    turnId: "t-1",
    text: "deploy succeeded",
    kind: "task-result",
  })

  // 2. Evidence is attached. A "judge-verdict" ref must name a recorded verdict.
  yield* honesty.attachEvidence(claim.claimId, {
    kind: "tool-output",
    ref: "toolcall-42",
    summary: "deploy script exited 0",
  })

  // 3. Track 2's executable judge produces a JudgeVerdict; the ledger stores it.
  // Verdicts are outcome records: never mutated, first write wins, re-recording is a no-op.
  yield* honesty.recordVerdict({
    verdictId: "v-1",
    judgeId: "deploy-final-state",
    judgeVersion: "1.2.0", // semver, pinned per task; non-semver is rejected
    taskId: "task-1",
    verdict: "pass",
    reasons: ["expected service reachable at /healthz"],
    evidenceIds: [],
    ranAt: new Date().toISOString(),
  })
  yield* honesty.attachEvidence(claim.claimId, {
    kind: "judge-verdict",
    ref: "v-1",
    summary: "deploy-final-state@1.2.0 passed",
  })

  // 4. Derive the badge. "What evidence backs claim X?" via evidenceFor.
  const badge = yield* honesty.getBadge(claim.claimId)
  const evidence = yield* honesty.evidenceFor(claim.claimId)

  // 5. Per-turn listing with badges — what the UI renders (Foldkit, M8).
  const pairs = yield* honesty.claimsForTurn("s-1", "t-1")
  return { badge, evidence, pairs }
}).pipe(Effect.provide(HonestyServiceInMemory))
```

### Badge-derivation rule

| evidence attached | verdicts attached | badge status |
|---|---|---|
| none | none | `unverified` |
| ≥1 | none / all pass | `verified` |
| any | ≥1 fail | `failed` |

A passed verdict does not upgrade a claim beyond what its evidence
establishes; a failed verdict dominates everything. `getBadge` fails with
`ClaimNotFound` for unknown claims and `VerdictNotFound` if a
`judge-verdict` reference cannot be resolved (rejected earlier at
`attachEvidence` time through the public API).

### Errors (`HonestyError`)

`ClaimNotFound { claimId }` · `VerdictNotFound { verdictId }` ·
`EvidenceNotFound { evidenceId }` (foreign-store corruption guard) ·
`InvalidVerdict { verdictId, reason }` (non-semver `judgeVersion`) ·
`LedgerError { operation, reason }` (reserved for the durable store).

Recording an existing `verdictId` is a **no-op success** (idempotent), not an
error — verdicts are write-once outcome records.

### Deterministic IDs

- `claimId` = SHA-256 hex of canonical JSON `{sessionId, turnId, text}`.
- `evidenceId` = SHA-256 hex of canonical JSON `{claimId, seq, kind, ref, summary}`
  (`seq` = per-claim attach index).
- No `Math.random`, no `Date.now()` inside ID generation. Wall-clock appears
  only in `recordedAt`/`ranAt` ISO timestamps.

## Track 3: post-turn wiring (loop integration)

`wiring.ts` — `runPostTurnHonesty(honesty, options)` — runs after the
AgentLoop completes a turn, in the loop's `Done` path
(`agent-loop/src/loop.ts`, step 6). It is the only bridge between the loop
and the honesty layer, and it is one-directional: the loop hands the turn
report over; the pipeline builds everything else.

What it does, in order:

1. **Claims.** One `ClaimRecord` per *executed* tool call
   (`kind: "tool-outcome"`, text `"<tool> returned <summary>"` — or
   `"<tool>: <summary>"` for non-ok outcomes, whose summaries already carry
   their outcome prefix), each with its `tool-output` evidence attached
   (`ref` = the tool call id).
2. **Judges.** Builds the `JudgeInput` from the turn report —
   `taskId` = turnId, `claim` = the turn's declared task claim, `finalState`
   = `{ executed: [...], blocked: [...] }`, `sideEffects` via
   `sideEffectsFromTurn(report.executed, report.blocked)`, `dialogue` =
   the user input + the assistant text — and runs the three reference
   judges pinned `@1.0.0` via `runJudge`. Each verdict is `recordVerdict`ed,
   then attached as `judge-verdict` evidence to the turn's tool-outcome
   claims. Pure-dialogue turns (no executed, no blocked calls) skip the
   judge run: there is nothing executable to verify, and the runner itself
   requires ≥1 side-effect record.
3. **Badges.** Returns a `TurnHonestyReport` — the per-claim
   `ClaimWithBadge` pairs, all verdicts, and `failedVerdicts` — which the
   loop puts on the turn's `Done` chunk as `report.honesty`.

The failure contract (architecture §2.6):

- A FAIL verdict is **data**, never an exception: it lands in
  `report.honesty.failedVerdicts`, surfaced to the user. The loop never
  swallows a judge failure.
- A judge *infrastructure* error (`JudgeNotFound`, `JudgeInputInvalid`,
  `JudgeThrew`, `JudgeVerdictInvalid`) is a **typed error** on the
  stream — `AgentLoopError` carries `HonestyError | JudgeError` — distinct
  from a FAIL verdict.

Wiring the loop (additive — no existing behavior changes):

- `TurnReport` gains the optional `honesty?: TurnHonestyReport` field.
- `layerAgentLoop` accepts `opts.honesty` (`recordUnverifiedDemoClaim`,
  `registry`, `now`) and picks up `HonestyService` ambiently via
  `Effect.serviceOption` — so `AgentLoopLive` and every existing call site
  are untouched: without the service in the environment the `Done` path
  skips the pipeline.
- `layerAgentLoopWithHonesty` takes `HonestyService` as a declared
  requirement instead — use it when the wiring must hold by construction
  (tests, the demo). Ambient pickup cannot see a sibling `Layer.mergeAll`
  branch at build time, so the explicit requirement is the reliable path.

Demo-only knob: `recordUnverifiedDemoClaim: true` records one extra claim
with deliberately no evidence, so the `unverified` badge is exhibited.
Verdicts are attached to the tool-outcome claims only — never to the demo
claim, which stays bare. Never set in production wiring.

Determinism: the wiring introduces none. Claim/evidence/verdict ids are
content hashes; `ranAt` is stamped by the runner after the verdict is
computed (`options.now` overrides it for tests). Re-running the pipeline on
the same turn data yields identical verdictIds — asserted in
`test/wiring.test.ts`.

Live demo: `demo.ts` drives the real loop and renders the transcript into
`DEMO.md` — run `npx tsc -b && node dist/honesty/demo.js` to regenerate.

## Future seams (not in M3)

- **MemoryService persistence.** The ledger is deliberately *not* coupled to
  `MemoryService` in M3. `LedgerStore` is the seam: a durable implementation
  (JSONL-per-session under MemoryService, SQLite, …) implements the same
  interface and is provided to `HonestyServiceLive` in place of
  `InMemoryLedgerStore`. All records are plain JSON-serializable data, so the
  in-memory state snapshots to disk verbatim.
- **Prose claim-extraction.** M3 claims are explicit records created by the
  loop from tool outcomes / task results. Extracting claims from free-form
  prose is a future extension; when it lands, it produces `NewClaim` records
  through the same `recordClaim` path — the ledger and badges need no changes.
- **Cross-process verdict ingestion.** `JudgeVerdict`s currently arrive
  in-process from Track 2's judges. If verdicts ever cross a process or
  trust boundary, decode them with an Effect `Schema` at the boundary before
  `recordVerdict` (field names/tags/literals in `src/types.ts` are the
  contract to decode against).
