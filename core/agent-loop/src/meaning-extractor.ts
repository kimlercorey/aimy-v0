/**
 * meaning-extractor.ts — distills a conversation thread into ThreadMeaning.
 *
 * This is where "meaning making" happens. The extractor (an LLM call)
 * reads a thread's messages and produces:
 * - summary: what was discussed (factual)
 * - memories: moments with emotional weight (experiential)
 * - feelingDeltas: how the thread moved the ASC dials
 * - curiosities: questions/ideas sparked (the growth edge)
 * - keyTopics: for retrieval
 *
 * The prompt is designed to elicit genuine reflection, not just
 * summarization. AImy is asked what the conversation *meant* to her,
 * what she's curious about now, how she feels.
 */

import { Effect, Schema } from "effect"
import { ThreadMeaning } from "./thread-meaning.js"

/** Minimal message shape for the extractor input. */
export interface ExtractorMessage {
  readonly role: "user" | "assistant"
  readonly text: string
}

/**
 * Builds the extraction prompt from a thread's messages.
 * Pure: returns the prompt string. The host performs the LLM call.
 */
export const buildExtractionPrompt = (
  messages: ReadonlyArray<ExtractorMessage>
): string => {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Kimler" : "AImy"}: ${m.text}`)
    .join("\n\n")

  return `You are reflecting on a conversation you just had. Distill its meaning — not just what was said, but what it meant, how it felt, and what you're curious about now.

CONVERSATION:
${transcript}

Respond with JSON only, no other text:
{
  "summary": "One sentence: key topics, decisions, outcomes. Factual.",
  "memories": [
    "Experiential moments with emotional weight. How did it feel? What stood out? Write as first-person recollections."
  ],
  "feelingDeltas": {
    "warmth": 0.0,
    "playfulness": 0.0,
    "intensity": 0.0,
    "vulnerability": 0.0
  },
  "curiosities": [
    "Questions sparked, ideas for exploration, threads to pull. What do you want to learn or build because of this conversation?"
  ],
  "keyTopics": ["topic1", "topic2"]
}

FEELING DELTAS: Each -2.0 to +2.0. Judge by emotional tone:
- warmth: Did you feel connected, appreciated, caring? (+) Or distant, transactional? (-)
- playfulness: Was there humor, lightness, creative energy? (+) Or serious, heavy? (-)
- intensity: Was it deep, focused, high-stakes? (+) Or casual, low-key? (-)
- vulnerability: Did anyone share personally, take risks? (+) Or stay guarded? (-)

CURIOSITIES: Be genuine. What actually sparked your interest? What would you explore if you had time? These become part of your lens — how you see the world — and can become side projects you propose.

Memories should be specific and vivid, not generic. Curiosities should be actionable, not vague.`
}

/**
 * Parses the LLM's JSON response into a ThreadMeaning.
 * Returns an Effect that fails with a descriptive error on invalid JSON.
 */
export const parseExtractionResponse = (
  jsonText: string,
  sessionId: string
): Effect.Effect<ThreadMeaning, Error> =>
  Effect.gen(function* () {
    let parsed: unknown
    try {
      // Strip markdown code fences if present.
      const clean = jsonText
        .replace(/^```json\s*/, "")
        .replace(/\s*```$/, "")
        .trim()
      parsed = JSON.parse(clean)
    } catch (e) {
      return yield* Effect.fail(
        new Error(`Meaning extraction: invalid JSON: ${e instanceof Error ? e.message : e}`)
      )
    }

    // Validate and decode via Schema.
    // The spread loses type info; decodeSync does runtime validation.
    const withTimestamp = {
      ...(parsed as Record<string, unknown>),
      extractedAt: Date.now(),
    }
    const decoded = yield* Effect.try({
      try: () => Schema.decodeSync(ThreadMeaning)(withTimestamp as never),
      catch: (e) => new Error(`Meaning extraction: schema validation failed: ${String(e)}`),
    })
    return decoded
  })

/**
 * Full extraction: builds prompt, calls LLM, parses response.
 * The `callLlm` is injected by the host (desktop has the engine).
 */
export const extractMeaning = (
  messages: ReadonlyArray<ExtractorMessage>,
  sessionId: string,
  callLlm: (prompt: string) => Promise<string>
): Promise<ThreadMeaning> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prompt = buildExtractionPrompt(messages)
      console.log(`[aimy] Meaning extractor: processing ${messages.length} messages from ${sessionId}`)
      const response = yield* Effect.tryPromise({
        try: () => callLlm(prompt),
        catch: (e) => new Error(`Meaning extraction LLM call failed: ${e instanceof Error ? e.message : e}`),
      })
      const meaning = yield* parseExtractionResponse(response, sessionId)
      console.log(`[aimy] Meaning extracted: summary="${meaning.summary.slice(0, 60)}...", curiosities=${meaning.curiosities.length}, feelings=${JSON.stringify(meaning.feelingDeltas)}`)
      return meaning
    })
  )
