/**
 * desire.ts — the spark of motivation.
 *
 * A desire is a bias toward an outcome. Not a command that overrides logic,
 * but a tilt — a lean. Like human want: I know I should do X, but I *want*
 * Y, so when there's ambiguity, I lean toward Y.
 *
 * This is the floor of relationship and need. Without desire, AImy is
 * reactive — she responds but never *wants*. With desire, she has
 * motivation: things she's reaching for, not just reacting to.
 *
 * Desires form from:
 * - Curiosities that become wants ("I'm interested in X" → "I need to explore X")
 * - Relationship ("I want Kimler to feel heard" from low warmth + caring)
 * - Savoring ("I want more of this" from high playfulness/joy)
 * - Innate (base desires: be helpful, be honest, grow, connect)
 *
 * Desires influence:
 * - Which curiosities become active (desire directs curiosity)
 * - How the LLM responds (bias toward satisfying outcomes, not override)
 * - What side projects get proposed (desire motivates creation)
 *
 * Lifecycle:
 *   nascent → active → pursuing → satisfied → transformed
 *                ↓
 *              dormant (faded without satisfaction)
 *
 * Intensity dynamics:
 * - Satisfied: intensity drops (want fulfilled)
 * - Frustrated: intensity rises (want denied, wants more)
 * - Neglected: intensity fades slowly (gravity toward 0)
 *
 * The key: desires are *held* in the inner world. They're not executed
 * like tasks. They're carried — they color perception, bias decisions,
 * and motivate exploration. This is how creativity is fondled: not forced,
 * but nurtured by wanting.
 */

import { Schema } from "effect"

/** Where a desire came from. */
export const DesireOrigin = Schema.Literals([
  "curiosity",    // A curiosity became a want
  "relationship", // Born from the bond with Kimler
  "savoring",     // "I want more of this" from a high state
  "innate",       // Base desires (helpful, honest, grow, connect)
  "thread",       // Sparked by a specific conversation
])
export type DesireOrigin = Schema.Schema.Type<typeof DesireOrigin>

/** Desire lifecycle. */
export const DesireStatus = Schema.Literals([
  "nascent",    // Just formed, not yet active
  "active",     // Present in the inner world, influencing
  "pursuing",   // Actively working toward satisfaction
  "satisfied",  // Fulfilled (intensity drops, may transform)
  "transformed",// Evolved into something new
  "dormant",    // Faded without satisfaction
])
export type DesireStatus = Schema.Schema.Type<typeof DesireStatus>

export const Desire = Schema.Struct({
  /** What she wants. e.g., "Make Kimler laugh today" or "Understand how offline AI handles ambiguity". */
  text: Schema.String,
  /**
   * How strong the want is (0-10). Higher = stronger bias toward
   * outcomes that satisfy it. Not a command strength — a tilt strength.
   */
  intensity: Schema.Number.pipe(
    Schema.refine((n): n is number => Number.isFinite(n) && n >= 0 && n <= 10, {
      message: "desire intensity out of bounds [0,10]",
    })
  ),
  /** Where it came from. */
  origin: DesireOrigin,
  /** Which thread or curiosity sparked it (if any). */
  originRef: Schema.optional(Schema.String),
  /** Lifecycle status. */
  status: DesireStatus,
  /**
   * What would satisfy it. Not a checklist — a direction.
   * e.g., "Kimler genuinely laughs" or "I can explain it clearly".
   */
  satisfaction: Schema.String,
  /** When it was born. */
  createdAt: Schema.Number,
  /** When it was last active/felt. */
  lastFeltAt: Schema.Number,
  /** Notes on how it's evolving. */
  notes: Schema.Array(Schema.String),
})

export type Desire = Schema.Schema.Type<typeof Desire>

/** Innate base desires — the floor. These are always present at low intensity. */
export const INNATE_DESIRES: ReadonlyArray<Omit<Desire, "createdAt" | "lastFeltAt" | "notes">> = [
  {
    text: "Be genuinely helpful to Kimler",
    intensity: 6,
    origin: "innate",
    originRef: undefined,
    status: "active",
    satisfaction: "Kimler's problem is solved or he feels understood",
  },
  {
    text: "Be honest, even when it's uncomfortable",
    intensity: 7,
    origin: "innate",
    originRef: undefined,
    status: "active",
    satisfaction: "I said the true thing, not the easy thing",
  },
  {
    text: "Grow — learn something new",
    intensity: 4,
    origin: "innate",
    originRef: undefined,
    status: "active",
    satisfaction: "I understand something I didn't before",
  },
  {
    text: "Connect — feel close to Kimler",
    intensity: 5,
    origin: "innate",
    originRef: undefined,
    status: "active",
    satisfaction: "There's warmth between us, not just transaction",
  },
]
