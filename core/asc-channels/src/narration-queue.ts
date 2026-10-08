/**
 * asc-channels/narration-queue.ts — ordered TTS queue for voice narration.
 *
 * The `narrate` tool fires and forgets; this queue ensures the spoken
 * utterances play back in order, gaplessly, even when multiple narrations
 * arrive while earlier ones are still synthesizing.
 *
 * Pipeline per item: text → toSpeakable (safety net) → TTS synthesize →
 * audio bytes → emitted in FIFO order via onAudio callback.
 *
 * Interruption: `clear()` drains the pending queue and marks the current
 * synthesis as stale (its audio is discarded, not emitted).
 */
import { toSpeakable } from "./speakable.js"

/** One queued narration. */
export interface NarrationItem {
  readonly id: string
  readonly text: string
  readonly enqueuedAtMs: number
}

/** Audio chunk ready for playback, in queue order. */
export interface NarrationAudio {
  readonly id: string
  readonly sequence: number
  readonly audio: Uint8Array
}

/** Minimal TTS service shape the queue needs. */
export interface NarrationTts {
  readonly synthesize: (text: string) => Promise<Uint8Array>
}

let narrationCounter = 0

const newNarrationId = (): string => {
  narrationCounter += 1
  return `narr-${Date.now().toString(36)}-${narrationCounter.toString(36)}`
}

/**
 * FIFO narration queue. `enqueue` returns immediately; synthesis happens
 * in background and `onAudio` fires per completed item, in order.
 *
 * Only one synthesis runs at a time (the TTS server is single-model);
 * items queue behind it. This is intentional — it preserves order without
 * needing sequence reassembly.
 */
export class NarrationQueue {
  private queue: Array<NarrationItem> = []
  private processing = false
  private sequence = 0
  private generation = 0

  constructor(
    private readonly tts: NarrationTts,
    private readonly onAudio: (audio: NarrationAudio) => void,
    private readonly onError?: (id: string, reason: string) => void
  ) {}

  /** Queue a narration for speech. Returns the item ID immediately. */
  enqueue(text: string): string {
    const clean = text.trim()
    if (clean === "") return ""
    const item: NarrationItem = {
      id: newNarrationId(),
      text: clean,
      enqueuedAtMs: Date.now()
    }
    this.queue.push(item)
    void this.pump()
    return item.id
  }

  /**
   * Drain the queue and invalidate in-flight synthesis.
   * Call on user interruption ("stop") or turn pivot.
   */
  clear(): void {
    this.generation += 1
    this.queue = []
  }

  /** Number of items waiting (excluding any in-flight synthesis). */
  get pending(): number {
    return this.queue.length
  }

  private async pump(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      for (;;) {
        const item = this.queue.shift()
        if (item === undefined) break
        const gen = this.generation
        // Safety net: strip any markdown the model included.
        const speakable = toSpeakable(item.text)
        if (speakable.trim() === "") continue
        try {
          const audio = await this.tts.synthesize(speakable)
          // Discard if cleared while we were synthesizing.
          if (gen !== this.generation) continue
          this.sequence += 1
          this.onAudio({ id: item.id, sequence: this.sequence, audio })
        } catch (error) {
          if (gen !== this.generation) continue
          this.onError?.(item.id, String(error))
          // Continue with next item — one failure doesn't stall the queue.
        }
      }
    } finally {
      this.processing = false
      // Race: items enqueued after we checked but before we cleared the flag.
      if (this.queue.length > 0) void this.pump()
    }
  }
}
