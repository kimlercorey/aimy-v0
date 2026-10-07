/**
 * ui/test/helpers.ts — integration-test harness for the Track 4 slices.
 *
 * Each test mounts a slice's PURE update against LIVE services: `drain`
 * feeds a Message through `update`, runs every emitted Command's real Effect
 * (its service requirements flow through the Effect R channel), feeds the
 * resulting Messages back through `update`, and repeats until no Commands
 * remain. The final Model is what the view would render — tests then assert
 * displayed values === service state.
 *
 * IMPORTANT: the caller provides the layer ONCE around the whole test body
 * (`Effect.provide(layers)` at the top). `Effect.provide` builds the layer a
 * single time for the enclosed Effect, so seeding, commands, and assertions
 * all share the same in-memory services. Providing per-call would rebuild
 * the in-memory stores and lose state.
 */
import { Effect, Layer } from "effect"

import { AlertSink, JobRunnerLive, SilentAlertSink } from "../../jobs/src/runner.js"
import { InMemoryRunHistory } from "../../jobs/src/history.js"
import { CommsBannerEphemeral } from "../../comms/service.js"
import { InMemoryTimelineStore, LearningTimelineLive } from "../../learning/src/timeline.js"

/** A Command instance, structurally: the runtime never sees this shape here. */
export interface TestCommand {
  readonly effect: Effect.Effect<unknown, unknown, unknown>
}

/**
 * Drive `update` with live services until the Command queue is empty.
 * `update` is `(model, message) => { model, commands? }`; each command's
 * Effect runs with its requirements flowing through R (the caller provides
 * the layer once around the whole test).
 */
export const drain = (
  update: (model: any, message: any) => { model: any; commands?: ReadonlyArray<TestCommand> },
  model: any,
  message: any,
): Effect.Effect<any, unknown, any> =>
  Effect.gen(function* () {
    let current = model
    let pending: ReadonlyArray<TestCommand> = []
    const first = update(current, message)
    current = first.model
    pending = first.commands ?? []
    let guard = 0
    while (pending.length > 0) {
      guard += 1
      if (guard > 25) {
        return yield* Effect.die(new Error("drain: command loop did not settle after 25 rounds"))
      }
      const next: Array<TestCommand> = []
      for (const cmd of pending) {
        const out = (yield* cmd.effect) as any
        const r = update(current, out)
        current = r.model
        next.push(...(r.commands ?? []))
      }
      pending = next
    }
    return current
  })

/** Poll a check until it returns non-undefined (jobs run on fibers). */
export const pollFor = <A>(
  check: Effect.Effect<A | undefined, unknown, any>,
  label: string,
  maxSteps = 500,
): Effect.Effect<A, unknown, any> =>
  Effect.gen(function* () {
    for (let i = 0; i < maxSteps; i++) {
      const found = yield* check
      if (found !== undefined) return found
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error(`timed out waiting for: ${label}`))
  })

/** Fresh isolated timeline layers per test. Provide ONCE per test body. */
export const timelineLayers = (): Layer.Layer<any, never, never> =>
  LearningTimelineLive.pipe(Layer.provide(InMemoryTimelineStore)) as Layer.Layer<any, never, never>

/** Fresh isolated banner layers per test. Provide ONCE per test body. */
export const commsLayers = (): Layer.Layer<any, never, never> =>
  CommsBannerEphemeral() as unknown as Layer.Layer<any, never, never>

/**
 * Fresh isolated job-runner layers per test (silent alert sink by default).
 * Provide ONCE per test body.
 */
export const jobsLayers = (
  sink: Layer.Layer<AlertSink, never, never> = SilentAlertSink,
): Layer.Layer<any, never, never> =>
  JobRunnerLive.pipe(
    Layer.provideMerge(Layer.mergeAll(sink, InMemoryRunHistory)),
  ) as unknown as Layer.Layer<any, never, never>

export { AlertSink, SilentAlertSink }
