# M6 Acceptance Demo — Learning Loop v1

Runnable: `npx vitest run learning/test/m6-demo.test.ts` (2 tests, both green).

## Positive path: the agent learns a skill from experience

A review fork proposes `skill-demo-echo`. The demo drives it through the full
pipeline and asserts each transition:

1. **Proposed** — `review-fork.proposed-add` timeline event recorded.
2. **Quarantined** — `quarantine.quarantine(candidate)` → state `quarantined`.
   Structural: loadable only in T0-observed sandboxed runs, never live.
3. **Verified** — `arm.verify(candidate)` runs the three executable mechanisms:
   - generated-tests: checks synthesized from the skill's behavior contract,
     run through the honesty judges framework (`aimy/skill-check@1.0.0`,
     frozen inputs, recomputed verdictIds) → pass
   - evals: arm-owned held-out cases, measured pass rate 1.0 → pass
   - critic: different lane (`AuthorInspectorCollision` would fail typed if
     critic lane == author lane); verdict recorded in the honesty ledger as
     evidence → pass
   `arm.finalize(report)` mints the `VerifiedReport` brand (only obtainable
   on overall-pass + executable evidence per mechanism).
4. **Trusted** — `gate.promote(verified)` → state `trusted`.
5. **Timeline** — `timeline.query({ subject })` returns, in order:
   `review-fork.proposed-add` → `verification.started` →
   `verification.passed` → `skill.trusted`, the trusted node carrying the
   evidence ids. `quarantine.resolveForLive` now succeeds (impossible in
   quarantine).

## Negative path: prompt-only candidate rejected (Hermes #25833)

`makePromptOnlyCandidate()` (LLM assertion, no behavior contract):

1. Quarantined → arm runs → generated-tests: "no executable checks…
   (prompt-only)", evals fail → overall `fail`.
2. `arm.finalize` refuses with `UnverifiedReport` — the brand cannot be minted.
3. `gate.reject` records the rejection; timeline shows `verification.failed` →
   `skill.rejected`; `resolveForLive` fails typed — the skill stays
   quarantined, never live.

Promotion of a prompt-only candidate is a **type error**, not a policy:
`gate.promote` accepts only `VerifiedReport`, and `finalize` is the sole
minter. This is the structural fix for Hermes #25833.
