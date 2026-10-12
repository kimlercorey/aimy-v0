/**
 * feelings-to-asc.ts — applies ThreadMeaning feeling deltas to ASC dials.
 *
 * When a thread is archived and its meaning extracted, the feelingDeltas
 * (how the conversation moved AImy emotionally) are applied to the ASC
 * dials via the frozen `asc.tune` interface.
 *
 * Flow:
 *   1. Read current dial values (via asc.readDials or injected getter)
 *   2. Add feeling delta to each, clamp to [0,10]
 *   3. Call asc.tune for each dial with the new target
 *
 * This is how conversations shape AImy's emotional state over time.
 * The dials then influence both speech (TTS params) and future
 * conversations (system prompt mood line).
 */

import { Effect } from "effect"
import type { ThreadMeaning } from "./thread-meaning.js"

/** Current dial values. */
export interface DialValues {
  readonly warmth: number
  readonly playfulness: number
  readonly intensity: number
  readonly vulnerability: number
}

/** Dependencies injected by the host. */
export interface FeelingsToAscDeps {
  /** Read current dial values. */
  readonly getDials: () => Promise<DialValues>
  /** Tune a dial to a target value (via asc.tune IPC or direct). */
  readonly tuneDial: (dial: keyof DialValues, target: number) => Promise<void>
}

const clampDial = (n: number): number => Math.min(10, Math.max(0, n))

/**
 * Apply a ThreadMeaning's feeling deltas to the ASC dials.
 * Logs each adjustment for visibility.
 */
export const applyFeelingsToAsc = (
  deps: FeelingsToAscDeps,
  meaning: ThreadMeaning
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = yield* Effect.tryPromise({
        try: () => deps.getDials(),
        catch: (e) => new Error(`Failed to read ASC dials: ${e instanceof Error ? e.message : e}`),
      })

      const deltas = meaning.feelingDeltas
      const updates: Array<{ dial: keyof DialValues; from: number; to: number; delta: number }> = []

      const dialNames: Array<keyof DialValues> = ["warmth", "playfulness", "intensity", "vulnerability"]
      for (const dial of dialNames) {
        const delta = deltas[dial]
        if (delta === 0) continue // no change, skip
        const from = current[dial]
        const to = clampDial(from + delta)
        updates.push({ dial, from, to, delta })
      }

      if (updates.length === 0) {
        console.log(`[aimy] Feelings→ASC: no dial changes (all deltas zero)`)
        return
      }

      console.log(`[aimy] Feelings→ASC: applying ${updates.length} dial updates from thread meaning`)
      for (const { dial, from, to, delta } of updates) {
        console.log(`[aimy] Feelings→ASC: ${dial}: ${from.toFixed(1)} → ${to.toFixed(1)} (Δ${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`)
        yield* Effect.tryPromise({
          try: () => deps.tuneDial(dial, to),
          catch: (e) => new Error(`Failed to tune ${dial}: ${e instanceof Error ? e.message : e}`),
        })
      }
      console.log(`[aimy] Feelings→ASC: done`)
    })
  )

/**
 * Convenience: apply feelings using renderer IPC (for use in desktop renderer).
 * The `invoke` is the IPC invoke function (e.g., from getAimy().invoke).
 */
export const makeRendererFeelingsApplier = (
  invoke: (cmd: { _tag: string; [k: string]: unknown }) => Promise<unknown>
): ((meaning: ThreadMeaning) => Promise<void>) => {
  const deps: FeelingsToAscDeps = {
    getDials: async () => {
      const result = (await invoke({ _tag: "asc.readDials" })) as {
        dials?: DialValues
      }
      // The IPC returns { dials: {...} } or the dials directly.
      if (result.dials !== undefined) return result.dials
      return result as unknown as DialValues
    },
    tuneDial: async (dial, target) => {
      await invoke({ _tag: "asc.tune", dial, target })
    },
  }
  return (meaning: ThreadMeaning) => applyFeelingsToAsc(deps, meaning)
}
