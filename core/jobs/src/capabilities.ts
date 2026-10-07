/**
 * jobs/capabilities.ts — permission-tier inheritance for job bodies.
 *
 * Every job records the tier of its scheduling context (`JobSpec.tier`).
 * The runner builds a `JobCapabilities` for that tier and provides it to the
 * job body; the job executes with AT MOST the recorded tier. Escalation
 * fails closed: `check`/`perform` deny BEFORE the action's effect runs, so a
 * denied action has no side effect, and the denial is a typed
 * `TierEscalationDenied` that fails the run (recorded in run history).
 *
 * Honest boundary note: this gate is cooperative — it binds every tiered
 * side effect a job performs THROUGH it. It is the in-process enforcement
 * point; OS-level enforcement arrives with the sandbox backend (architecture
 * open risk #1). TypeScript types alone are never the boundary (Pi #9824).
 */
import { Context, Effect } from "effect"

import type { Tier } from "../../substrate/errors.js"
import { TierEscalationDenied } from "./errors.js"
import type { JobCapabilitiesService } from "./types.js"

const TIER_ORDER: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 }

export class JobCapabilities extends Context.Service<JobCapabilities, JobCapabilitiesService>()(
  "aimy/jobs/JobCapabilities"
) {}

/**
 * Build the gate for one job run. An unrecognized granted-tier string maps
 * to order -1, so EVERY gated action denies (fail closed, never fail open).
 * An unrecognized requested-tier string maps to +Infinity, so it always
 * denies as well.
 */
export const makeJobCapabilities = (jobId: string, tier: Tier): JobCapabilitiesService => {
  const granted: number = TIER_ORDER[tier] ?? -1

  const check = (
    requested: Tier,
    action: string
  ): Effect.Effect<void, TierEscalationDenied> => {
    const want: number = TIER_ORDER[requested] ?? Number.POSITIVE_INFINITY
    return want > granted
      ? Effect.fail(
          new TierEscalationDenied({ jobId, grantedTier: tier, requestedTier: requested, action })
        )
      : Effect.void
  }

  return {
    jobId,
    tier,
    check,
    perform: <A, E>(requested: Tier, action: string, effect: Effect.Effect<A, E>) =>
      Effect.andThen(check(requested, action), effect)
  }
}
