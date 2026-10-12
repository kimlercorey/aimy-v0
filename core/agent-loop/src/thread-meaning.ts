/**
 * thread-meaning.ts — the distilled essence of a conversation thread.
 *
 * When a thread is archived (new chat started, or auto-compacted), the
 * meaning extractor (an LLM call) produces a ThreadMeaning. This is not
 * just a summary — it's the *meaning* the conversation had for AImy:
 *
 * - summary: factual — what was discussed, decided, learned
 * - memories: experiential — moments that mattered emotionally
 * - feelingDeltas: how this thread moved the ASC dials
 * - curiosities: questions/ideas sparked — the growth edge
 *
 * The curiosities become part of AImy's internal model and lens:
 * they shape how she interprets future conversations and can become
 * side projects she proposes. This is how the personality grows.
 *
 * Pipeline:
 *   Conversation → Distill → Meaning
 *     ├→ summary → threadHistory (Level 1 memory)
 *     ├→ memories → episodic store (Level 2, retrievable)
 *     ├→ feelingDeltas → ASC dials via asc.tune
 *     └→ curiosities → curiosity store → lens → personality + side projects
 */

import { Schema } from "effect"

/** Bounded feeling delta: -2 (much less) to +2 (much more). */
const FeelingDelta = Schema.Number.pipe(
  Schema.refine((n): n is number => Number.isFinite(n) && n >= -2 && n <= 2, {
    message: "feeling delta out of bounds [-2, 2]",
  })
)

export const ThreadMeaning = Schema.Struct({
  /** One-sentence factual summary: topics, decisions, outcomes. */
  summary: Schema.String,
  /**
   * Experiential memories: moments that had emotional weight.
   * e.g., "User lit up when describing the magical backpack —
   *        playful energy, we joked about it for a while."
   * These are episodic, not factual — how it *felt*.
   */
  memories: Schema.Array(Schema.String),
  /**
   * How this thread moved each ASC dial. The extractor judges based on
   * the emotional tone: warm conversation → warmth up; playful banter
   * → playfulness up; intense debate → intensity up; personal sharing
   * → vulnerability up.
   */
  feelingDeltas: Schema.Struct({
    warmth: FeelingDelta,
    playfulness: FeelingDelta,
    intensity: FeelingDelta,
    vulnerability: FeelingDelta,
  }),
  /**
   * Curiosities sparked by this thread: questions AImy wants to explore,
   * ideas for side projects, threads to pull on. These become part of
   * her internal model and lens — they shape how she sees the world
   * and what she proactively brings up.
   * e.g., "How would offline AI handle real-time translation?"
   * e.g., "Build a demo of the magical backpack concept"
   */
  curiosities: Schema.Array(Schema.String),
  /** Key topics for retrieval: if user asks about X, find this thread. */
  keyTopics: Schema.Array(Schema.String),
  /** When this meaning was extracted. */
  extractedAt: Schema.Number,
})

export type ThreadMeaning = Schema.Schema.Type<typeof ThreadMeaning>

/** A curiosity with its origin and status. */
export const Curiosity = Schema.Struct({
  /** The question or idea. */
  text: Schema.String,
  /** Which thread sparked it. */
  originSessionId: Schema.String,
  /** When it was born. */
  createdAt: Schema.Number,
  /**
   * Lifecycle: nascent → active (AImy is exploring it) →
   * project (became a side project) → integrated (part of the lens)
   * → dormant (lost interest).
   */
  status: Schema.Literals(["nascent", "active", "project", "integrated", "dormant"]),
  /** Notes as the curiosity develops. */
  notes: Schema.Array(Schema.String),
})

export type Curiosity = Schema.Schema.Type<typeof Curiosity>
