/**
 * learning-events.ts — the agent loop's door into the learning
 * timeline (2026-10-13).
 *
 * The loop's ledgers are append-only JSONL files (capability
 * requests, the knowledge track record); learning events follow
 * the same pattern. Producers append one JSON line per event to
 * ~/.aimy/learning/timeline-events.jsonl, and the durable timeline
 * store (learning/file-store) — the single writer of the nodes
 * file — imports the lines, fingerprints them into nodes, and
 * consumes the file. No service wiring crosses into the loop, and
 * a failed append never breaks the turn that produced the event:
 * the timeline is a record, never a gate.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface LearningEventDrop {
  readonly type: string
  readonly provenance: {
    readonly origin: string
    readonly sessionId: string
    readonly profileId: string
  }
  readonly subject?: string
  readonly evidenceIds?: ReadonlyArray<string>
  readonly payload: unknown
}

export const learningEventsPath = (): string =>
  path.join(os.homedir(), ".aimy", "learning", "timeline-events.jsonl")

export const appendLearningEvent = (event: LearningEventDrop): void => {
  try {
    const file = learningEventsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({
      type: event.type,
      provenance: event.provenance,
      ...(event.subject !== undefined ? { subject: event.subject } : {}),
      evidenceIds: event.evidenceIds ?? [],
      payload: event.payload,
      recordedAt: new Date().toISOString(),
    })
    fs.appendFileSync(file, line + "\n", "utf-8")
  } catch {
    // Never throw into a turn (see header).
  }
}
