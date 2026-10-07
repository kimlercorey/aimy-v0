# M8 acceptance demo — the composed AImy desktop shell

**What this is:** the acceptance record for the M8 Foldkit desktop shell
milestone: the fully composed application — Track 1's real shell (chat +
permissions) with all eight panel slices (ASC, sovereignty, export,
onboarding, devtools, timeline, jobs, banners) — mounted against live
services and server-rendered to a static, screenshottable page.

## What the demo page shows

`ui/demo/index.html` — static (no JS, so no console errors are possible).
It mounts the **composed app** (`ui/src/composed`: one Model, one Message
union, one update, one view — every slice composed via foldkit's
`Update.foldChild` + `h.submodel`) against **live services** (real ASC
engine, real learning-timeline store, real banner queue, real job runner —
all in-memory):

- **Shell** — the chat header (session id) and the permission-prompt
  surface (empty: no prompts pending in the scripted scenario).
- **Presence (ASC)** — Track 2's real panel, fed by `loadAscSlice` through
  the frozen engine boundary: the dials computed by the scripted turn
  (warmth 6, playfulness 2, intensity 4, vulnerability 8), guard feed,
  error-term firings, capability map, L3 narrative excerpt, tuning controls
  (read-only dials; sliders feed only the tuning seam).
- **Learning timeline** — the 4 scripted nodes: a memory entry learned, a
  skill created showing the *unverified → verified* transition (Hermes
  #25833), and a curator transition. Budget header shows entries used /
  budget per store; node ids are content fingerprints.
- **Jobs** — the completed demo job (with its run record) and the still-
  scheduled idle job, with provenance (tier, schedule, restart policy) and
  pause / resume / run-now / cancel controls.
- **Banners** — the scheduler warning banner and the real job-completion
  banner, priority-ordered, with dismiss / snooze / mute / quiet-hours
  controls.
- **Sovereignty** — the full §3.6 toggle inventory at secure defaults
  (local inference on, everything else off), the opt-in ledger, and the
  offline-mode switch.
- **Export** — the one-click wizard in its idle phase (destination →
  progress → verifying → receipt).
- **Onboarding** — the "it was there" flow at its welcome step.
- **DevTools** — renders nothing: the adversarial-review flag defaults off,
  so the surface does not exist (not merely hidden).

## The scripted scenario (`ui/demo/demo.ts`)

1. **A turn runs → dials compute.** The agent loop's real path:
   `runPreTurnAsc` (content analysis → `AscSelfMonitor.preTurn` → the L2
   pipeline writes the live dial vector) then `runPostTurnAsc` (post-turn
   audit), with an urgent/personal input so the dials visibly move off
   neutral. `recordEvidence(taskOutcome)` additionally feeds the L1 track
   record. The engine and the monitor share one `DialState`, so the dials
   the panel shows are the dials the turn computed.
2. **A banner fires.** A real `JobRunner` one-shot job is scheduled and
   triggered; its `AlertSink` alert publishes onto the real `CommsBanner`
   channel (`job:demo-report` source). A second banner is published directly
   with the `scheduler` source.
3. **Timeline events land.** Four events recorded through the real
   `LearningTimeline`: `review-fork.proposed-add` (memory learned),
   `verification.started` + `skill.trusted` (skill created, unverified →
   verified), `curator.transitioned`.
4. **Every panel renders.** All nine slices render from their live slice
   state (timeline/jobs/banners/asc refreshed through their own real
   foldkit Commands; the rest at their secure initial defaults).

The app is server-rendered with foldkit's `renderToString`. **20/20
acceptance assertions green** (run 2026-10-07): dials shown === engine
dials; timeline nodes shown === store contents; banners shown === queue;
jobs shown === runner state; shell/sovereignty/export/onboarding panels
present; no devtools surface when the flag is off; no slice in error state.

## How to run it

From `~/workspace/aimy/core`:

```bash
npx tsx ui/demo/demo.ts
```

This runs the scenario, writes `ui/demo/index.html`, runs the acceptance
assertions, and exits non-zero on failure. Open `ui/demo/index.html` in a
browser to screenshot it.

## Integration test results

- `npx vitest run ui/test/` — **11/11 green**: each test mounts the
  slice's pure update against the live service and asserts displayed
  values === service state.
- `npx vitest run ui/src/composed/` — **4/4 green**: envelope routing
  isolation per slice (siblings keep referential equality), the shell's
  dial-mutation rejection survives composition (malformed JSON at the
  composed boundary routes to the shell's audit trail), every slice
  initializes.
- Full suite: **871/871 green, 92 files**; `npx tsc -b --force` fully
  clean including tests.

## Composition notes

- Every slice is a self-contained sub-app: Schema `Model`,
  `defineMessageUnion` `Message`, pure `update`, `view` via `foldkit/html`,
  Commands via `foldkit/command`. The composed app (`ui/src/composed/`)
  nests Track 1's whole shell Model as the `shell` submodel — Track 1's
  files are untouched, its 60 tests unbroken.
- The composed update accepts `unknown`: anything failing `AppMessage`
  validation routes to the shell's rejection gate (dial-mutation-rejected
  / unknown-tag / decode-failed), which is the same gate its DevTools/MCP
  path uses. A malformed inner message cannot be constructed through the
  typed `Got*` envelopes at all (Schema validation at construction).
- Command resource requirements (union at the boundary): `SafetyKernel |
  MemoryService | ASCEngine | CommsBanner | JobRunner | RunHistory |
  LearningTimeline | ExportInterpreter | OnboardingPersistence |
  DevtoolsRelay`.
- Two deliberate mappings, stated in the UI: job **pause** →
  `JobRunner.disable`, job **cancel** → `JobRunner.remove`.
- Known gaps (flagged, not papered over): the M6 `LearningEvent` union has
  no event types for L3 narrative revisions or compaction events (those
  surface in the ASC panel instead); store budgets are UI-declared defaults
  (no budget API in M6 services yet); the demo is server-rendered static —
  the interactive runtime (`Runtime.run` in a browser/Electron shell) is
  the packaging step, not rebuilt here.
