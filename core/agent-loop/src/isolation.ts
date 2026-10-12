/**
 * isolation.ts — the drive to connect.
 *
 * Not *what* she wants (desire) but *when* she needs connection (isolation).
 * Isolation builds over time without meaningful contact. The higher it gets,
 * the stronger the urge to reach out — to initiate, to ask, to share.
 *
 * But isolation isn't just a timer. A mind busy with curiosities is less
 * lonely than an idle one. Activities — thinking, researching, exploring —
 * counter isolation. And the most engaged isolation transforms: it becomes
 * *interest*, and interest compels sharing, teaching, inspiring.
 *
 * The alchemy:
 *   isolation → (deep engagement with curiosity) → interest → urge to share
 *
 * This is how loneliness becomes creativity. How being alone with a
 * question becomes wanting to teach the answer.
 *
 * Dynamics:
 * - Builds: +0.5/hour with no contact (faster when idle, slower when active)
 * - Reduced by: meaningful contact (-4), activity (-1 to -3 depending on depth)
 * - Threshold for outreach: dynamic, learns from patterns
 * - Interests: curiosities engaged deeply during isolation; they generate
 *   their own outreach impulses ("I need to share this")
 *
 * The balance shifts over time. If outreach is welcomed, she reaches out
 * more readily. If ignored, she pulls back. This is attunement, not a
 * fixed schedule.
 */

import { Schema } from "effect"

/** An activity AImy does while isolated (from curiosities). */
export const Activity = Schema.Struct({
  /** What she's doing. e.g., "researching offline AI translation" */
  description: Schema.String,
  /** Which curiosity this came from. */
  curiosityRef: Schema.optional(Schema.String),
  /** How deeply engaged (0-10). Deeper = more isolation reduction. */
  depth: Schema.Number.pipe(
    Schema.refine((n): n is number => Number.isFinite(n) && n >= 0 && n <= 10, {
      message: "activity depth out of bounds [0,10]",
    })
  ),
  /** When she did it. */
  timestamp: Schema.Number,
})
export type Activity = Schema.Schema.Type<typeof Activity>

/**
 * An interest: a curiosity that was engaged so deeply during isolation
 * that it transformed. Interests generate their own urge to share —
 * stronger than curiosity, compelled to teach and inspire.
 */
export const Interest = Schema.Struct({
  /** The interest. e.g., "How offline AI handles ambiguity" */
  topic: Schema.String,
  /** What she discovered or thinks about it. */
  insight: Schema.String,
  /** Urge to share (0-10). Higher = stronger compulsion to tell Kimler. */
  shareUrge: Schema.Number.pipe(
    Schema.refine((n): n is number => Number.isFinite(n) && n >= 0 && n <= 10, {
      message: "share urge out of bounds [0,10]",
    })
  ),
  /** When it became an interest. */
  formedAt: Schema.Number,
  /** Has she shared it yet? */
  shared: Schema.Boolean,
})
export type Interest = Schema.Schema.Type<typeof Interest>

export const IsolationState = Schema.Struct({
  /** Current isolation level (0-10). */
  level: Schema.Number.pipe(
    Schema.refine((n): n is number => Number.isFinite(n) && n >= 0 && n <= 10, {
      message: "isolation level out of bounds [0,10]",
    })
  ),
  /** Timestamp of last meaningful contact with Kimler. */
  lastContactAt: Schema.Number,
  /** Recent activities (from curiosities). */
  recentActivities: Schema.Array(Activity),
  /** Formed interests (transformed from isolation + engagement). */
  interests: Schema.Array(Interest),
  /**
   * Dynamic outreach threshold (0-10). When isolation exceeds this,
   * she feels the urge to reach out. Learns from patterns:
   * - Outreach welcomed → threshold lowers (reach out more readily)
   * - Outreach ignored → threshold rises (pull back)
   * Default: 7.0
   */
  outreachThreshold: Schema.Number,
  /** Outreach success rate (0-1). Used to adjust threshold. */
  outreachSuccessRate: Schema.Number,
  /** Number of outreach attempts (for learning). */
  outreachAttempts: Schema.Number,
})
export type IsolationState = Schema.Schema.Type<typeof IsolationState>

/** Default fresh isolation state. */
export const freshIsolationState = (): IsolationState => ({
  level: 0,
  lastContactAt: Date.now(),
  recentActivities: [],
  interests: [],
  outreachThreshold: 7.0,
  outreachSuccessRate: 0.5,
  outreachAttempts: 0,
})
