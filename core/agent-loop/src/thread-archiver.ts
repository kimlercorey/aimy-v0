/**
 * thread-archiver.ts — orchestrates thread archival and meaning distillation.
 *
 * When a thread is archived (user starts new chat, or auto-trigger at
 * message threshold), the archiver:
 *
 * 1. Extracts meaning via LLM (summary, memories, feelings, curiosities)
 * 2. Saves the summary to threadHistory (Level 1 memory)
 * 3. Adds curiosities to the curiosity store (growth edge)
 * 4. Applies feeling deltas to ASC dials (WITH BEHAVIORAL SAFETY BELT)
 * 5. Forms desires from savoring/curiosities (the spark of motivation)
 * 6. Applies neglect gravity to old desires
 * 7. Returns the new session ID for the fresh thread
 *
 * The safety belt ensures AImy doesn't spiral: deltas are clamped,
 * gravity pulls toward neutral, oscillation is dampened, and emergencies
 * trigger reset. She has moods, not mood disorders.
 */

import { Effect } from "effect"
import { extractMeaning, type ExtractorMessage } from "./meaning-extractor.js"
import type { ThreadMeaning } from "./thread-meaning.js"
import { addCuriosities } from "./curiosity-store.js"
import { safeDialUpdate, type DialValues, type DialHistory } from "./dial-safety.js"
import { formDesire, applyNeglectGravity } from "./desire-store.js"

/** Dependencies for the archiver. */
export interface ArchiverDeps {
  /** Call the LLM with a prompt, return the response text. */
  readonly callLlm: (prompt: string) => Promise<string>
  /** Read current ASC dial values. */
  readonly getDials: () => Promise<DialValues>
  /** Tune a dial to a target (via asc.tune). */
  readonly tuneDial: (dial: keyof DialValues, target: number) => Promise<void>
  /** Get recent dial history for oscillation detection (optional). */
  readonly getDialHistory?: () => Promise<DialHistory | undefined>
  /** Persist a thread summary to history (host handles storage). */
  readonly saveThreadSummary: (summary: {
    sessionId: string
    summary: string
    messageCount: number
    archivedAt: number
  }) => Promise<void>
}

/** Result of archiving a thread. */
export interface ArchiveResult {
  /** The extracted meaning. */
  readonly meaning: ThreadMeaning
  /** New session ID for the fresh thread. */
  readonly newSessionId: string
  /** Curiosities that were added. */
  readonly curiositiesAdded: number
  /** Dials that were updated. */
  readonly dialsUpdated: string[]
  /** Behavioral state (soothing/savoring) for prompt enrichment. */
  readonly behavioralState: {
    readonly soothing: string[]
    readonly savoring: string[]
  }
}

/**
 * Archives a thread: extracts meaning, saves artifacts, updates ASC,
 * and returns the new session ID.
 *
 * This is the main entry point. The caller is responsible for clearing
 * the old messages and starting the new thread with the returned ID.
 */
export const archiveThread = (
  deps: ArchiverDeps,
  messages: ReadonlyArray<ExtractorMessage>,
  sessionId: string
): Promise<ArchiveResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      console.log(`[aimy] Archiver: archiving thread ${sessionId} with ${messages.length} messages`)

      if (messages.length === 0) {
        console.log(`[aimy] Archiver: no messages, skipping extraction`)
        const newSessionId = `session-${Date.now()}`
        return {
          meaning: {
            summary: "Empty thread",
            memories: [],
            feelingDeltas: { warmth: 0, playfulness: 0, intensity: 0, vulnerability: 0 },
            curiosities: [],
            keyTopics: [],
            extractedAt: Date.now(),
          },
          newSessionId,
          curiositiesAdded: 0,
          dialsUpdated: [],
          behavioralState: { soothing: [], savoring: [] },
        } as ArchiveResult
      }

      // Step 1: Extract meaning via LLM.
      const meaning = yield* Effect.tryPromise({
        try: () => extractMeaning(messages, sessionId, deps.callLlm),
        catch: (e) => new Error(`Archiver: meaning extraction failed: ${e instanceof Error ? e.message : e}`),
      })

      // Step 2: Save summary to thread history.
      yield* Effect.tryPromise({
        try: () =>
          deps.saveThreadSummary({
            sessionId,
            summary: meaning.summary,
            messageCount: messages.length,
            archivedAt: Date.now(),
          }),
        catch: (e) => new Error(`Archiver: save summary failed: ${e instanceof Error ? e.message : e}`),
      })
      console.log(`[aimy] Archiver: summary saved: "${meaning.summary.slice(0, 60)}..."`)

      // Step 3: Add curiosities to the store.
      const added = addCuriosities(meaning.curiosities, sessionId)
      console.log(`[aimy] Archiver: ${added.length} curiosities added`)

      // Step 4: Apply feeling deltas to ASC (WITH SAFETY BELT + BEHAVIORAL REGULATION).
      const dialsUpdated: string[] = []
      let behavioralState: { soothing: string[]; savoring: string[] } = { soothing: [], savoring: [] }
      try {
        const currentDials = yield* Effect.tryPromise({
          try: () => deps.getDials(),
          catch: (e) => new Error(`Archiver: get dials failed: ${e instanceof Error ? e.message : e}`),
        })

        let history: DialHistory | undefined
        if (deps.getDialHistory !== undefined) {
          try {
            history = yield* Effect.tryPromise({
              try: () => deps.getDialHistory!(),
              catch: () => new Error("history unavailable"),
            })
          } catch {
            history = undefined // optional, continue without
          }
        }

        // Safety belt with behavioral regulation.
        // Thread engagement: magnitude of feeling deltas (0-1).
        // High engagement + high dial = savoring. Low engagement + high = mediating.
        const deltas = meaning.feelingDeltas as DialValues
        const engagement = Math.min(1, (
          Math.abs(deltas.warmth) +
          Math.abs(deltas.playfulness) +
          Math.abs(deltas.intensity) +
          Math.abs(deltas.vulnerability)
        ) / 4)
        const { dials: newDials, behavioralState: bs } = safeDialUpdate(
          currentDials,
          deltas,
          history,
          engagement
        )
        behavioralState = bs
        // Log behavioral state.
        if (behavioralState.soothing.length > 0) {
          console.log(`[aimy] Archiver: self-soothing active for: ${behavioralState.soothing.join(", ")}`)
        }
        if (behavioralState.savoring.length > 0) {
          console.log(`[aimy] Archiver: savoring high state for: ${behavioralState.savoring.join(", ")} (strong memories being made)`)
        }

        // Apply via tune.
        const dialNames: Array<keyof DialValues> = ["warmth", "playfulness", "intensity", "vulnerability"]
        for (const dial of dialNames) {
          const from = currentDials[dial]
          const to = newDials[dial]
          if (Math.abs(to - from) > 0.01) {
            yield* Effect.tryPromise({
              try: () => deps.tuneDial(dial, to),
              catch: (e) => new Error(`Archiver: tune ${dial} failed: ${e instanceof Error ? e.message : e}`),
            })
            dialsUpdated.push(dial)
          }
        }
        console.log(`[aimy] Archiver: ASC dials updated: ${dialsUpdated.join(", ") || "none"}`)
      } catch (e) {
        // ASC update failure is not fatal — log and continue.
        console.error(`[aimy] Archiver: ASC update failed (non-fatal): ${e instanceof Error ? e.message : e}`)
      }

      // Step 5: Form desires from savoring and strong curiosities.
      // This is the spark of motivation — the bias toward outcomes.
      try {
        // Savoring → "I want more of this" desire.
        if (behavioralState.savoring.length > 0) {
          for (const dial of behavioralState.savoring) {
            formDesire({
              text: `Keep feeling ${dial} — savor this high`,
              intensity: 6,
              origin: "savoring",
              originRef: sessionId,
              satisfaction: `The ${dial} high is prolonged naturally`,
            })
          }
        }
        // Strong curiosities (from meaning) can become desires.
        // If the LLM marked a curiosity as a "want" (contains "want"/"need"/"wish"),
        // form it as a desire.
        for (const curiosity of meaning.curiosities) {
          const lower = curiosity.toLowerCase()
          if (lower.includes("want to") || lower.includes("need to") || lower.includes("wish i")) {
            formDesire({
              text: curiosity,
              intensity: 5,
              origin: "curiosity",
              originRef: sessionId,
              satisfaction: `Explored or made progress on: ${curiosity.slice(0, 50)}`,
            })
          }
        }
        // Apply neglect gravity to old desires.
        applyNeglectGravity()
      } catch (e) {
        console.error(`[aimy] Archiver: desire formation failed (non-fatal): ${e instanceof Error ? e.message : e}`)
      }

      // Step 6: Generate new session ID.
      const newSessionId = `session-${Date.now()}`
      console.log(`[aimy] Archiver: done. New session: ${newSessionId}`)

      return {
        meaning,
        newSessionId,
        curiositiesAdded: added.length,
        dialsUpdated,
        behavioralState,
      }
    })
  )
