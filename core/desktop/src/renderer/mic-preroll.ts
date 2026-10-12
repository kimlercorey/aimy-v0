/**
 * renderer/mic-preroll.ts — Pre-roll audio buffer for push-to-talk.
 *
 * Problem (2026-10-10): PTT loses 100-300ms of speech to button-press
 * latency. STT hears fragments → LLM confused → "yeah." responses.
 *
 * Solution: Continuous 2-3s circular buffer, always capturing (local only).
 * PTT press tags into the buffer: transcription = [buffer] + [live].
 *
 * Mic states (Kimler design 2026-10-10):
 * - COLD (white): Buffer not verified OR STT unreachable. Button inactive.
 * - HOT (glowy green, pulsing): Buffer verified + STT verified. The pulse
 *   IS the buffer heartbeat — shows rolling capture is alive.
 *
 * Privacy: Buffer is local-only, in-memory, never leaves the machine.
 * Never sent to STT until explicit PTT press. The pulse means "capturing
 * locally," not "uploading."
 */

export type MicHotState = "cold" | "verifying" | "hot"

export interface PrerollStatus {
  readonly state: MicHotState
  /** Buffer is capturing audio (non-silent frames detected). */
  readonly bufferOk: boolean
  /** STT service is reachable (local or OMA). */
  readonly sttOk: boolean
  /** Human-readable reason if not hot. */
  readonly reason?: string | undefined
}

const PREROLL_SECONDS = 3
const SAMPLE_RATE = 16000 // Target: 16kHz mono for STT

/**
 * Circular audio buffer. Keeps the last N seconds of mic audio in memory.
 * On PTT press, the buffer contents are prepended to the live recording.
 */
export class PrerollBuffer {
  private buffer: Float32Array
  private writePos = 0
  private filled = false
  private audioContext: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private stream: MediaStream | null = null
  private onStateChange: ((status: PrerollStatus) => void) | null = null
  private verifyTimer: number | null = null

  constructor(
    private readonly bufferSeconds: number = PREROLL_SECONDS,
  ) {
    const size = Math.floor(SAMPLE_RATE * bufferSeconds)
    this.buffer = new Float32Array(size)
    console.log(`[aimy] PrerollBuffer: allocated ${size} samples (${bufferSeconds}s @ ${SAMPLE_RATE}Hz)`)
  }

  /** Start capturing. Requests mic permission if needed. */
  async start(onStateChange: (status: PrerollStatus) => void): Promise<void> {
    this.onStateChange = onStateChange
    this.setState({ state: "verifying", bufferOk: false, sttOk: false, reason: "Requesting mic access…" })

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      console.log("[aimy] PrerollBuffer: mic access granted")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`[aimy] PrerollBuffer: mic access denied: ${msg}`)
      this.setState({ state: "cold", bufferOk: false, sttOk: false, reason: `Mic denied: ${msg}` })
      return
    }

    // Set up Web Audio capture.
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.source = this.audioContext.createMediaStreamSource(this.stream)
    // ScriptProcessor is deprecated but widely supported; AudioWorklet is
    // the future but adds complexity. Using 4096 buffer for low latency.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (e) => this.onAudio(e)
    this.source.connect(this.processor)
    // Connect to destination via zero-gain to keep the processor running
    // (required in some browsers) without audible output.
    const zeroGain = this.audioContext.createGain()
    zeroGain.gain.value = 0
    this.processor.connect(zeroGain)
    zeroGain.connect(this.audioContext.destination)

    console.log("[aimy] PrerollBuffer: capture started, verifying…")
    this.setState({ state: "verifying", bufferOk: false, sttOk: false, reason: "Verifying audio…" })

    // Verify: check for non-silent audio over 1s, then check STT.
    this.verifyTimer = window.setTimeout(() => this.verify(), 1000)
  }

  private onAudio(e: AudioProcessingEvent): void {
    const input = e.inputBuffer.getChannelData(0)
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.writePos] = input[i]!
      this.writePos = (this.writePos + 1) % this.buffer.length
      if (this.writePos === 0) this.filled = true
    }
  }

  /** Check if buffer has non-silent audio (i.e., mic is actually capturing). */
  private verify(): void {
    // Check buffer energy: look for samples above silence threshold.
    let energy = 0
    const checkLen = Math.min(this.buffer.length, SAMPLE_RATE) // 1s
    const start = (this.writePos - checkLen + this.buffer.length) % this.buffer.length
    for (let i = 0; i < checkLen; i++) {
      const idx = (start + i) % this.buffer.length
      const s = this.buffer[idx]!
      energy += s * s
    }
    const rms = Math.sqrt(energy / checkLen)
    const bufferOk = rms > 0.001 // Above digital silence
    console.log(`[aimy] PrerollBuffer: verify rms=${rms.toFixed(6)} bufferOk=${bufferOk}`)

    if (!bufferOk) {
      // Mic might be muted or no audio; retry in 2s (don't go cold yet).
      console.log("[aimy] PrerollBuffer: no audio detected, retrying verify in 2s")
      this.verifyTimer = window.setTimeout(() => this.verify(), 2000)
      return
    }

    // Buffer OK. Now check STT (via IPC to main process).
    this.checkStt().then((sttOk) => {
      if (bufferOk && sttOk) {
        console.log("[aimy] PrerollBuffer: HOT — buffer and STT verified")
        this.setState({ state: "hot", bufferOk: true, sttOk: true })
      } else {
        this.setState({
          state: "cold",
          bufferOk,
          sttOk,
          reason: !sttOk ? "STT unreachable" : "Buffer issue",
        })
      }
    })
  }

  /** Ask main process if STT is reachable (local or OMA). */
  private async checkStt(): Promise<boolean> {
    try {
      // Use the IPC bridge (exposed via preload).
      const api = (window as unknown as { aimy?: { sttHealth?: () => Promise<boolean> } }).aimy
      if (api?.sttHealth) {
        const ok = await api.sttHealth()
        console.log(`[aimy] PrerollBuffer: STT health check: ${ok}`)
        return ok
      }
      // Fallback: assume OK if we can't check (don't block hot state).
      console.log("[aimy] PrerollBuffer: no sttHealth IPC, assuming STT OK")
      return true
    } catch (e) {
      console.log(`[aimy] PrerollBuffer: STT health check failed: ${e}`)
      return false
    }
  }

  private setState(status: PrerollStatus): void {
    console.log(`[aimy] PrerollBuffer: state=${status.state} bufferOk=${status.bufferOk} sttOk=${status.sttOk}${status.reason ? ` reason=${status.reason}` : ""}`)
    this.onStateChange?.(status)
  }

  /**
   * Get the buffered audio as a Float32Array (oldest → newest).
   * Call on PTT press to prepend to the live recording.
   */
  drain(): Float32Array {
    const out = new Float32Array(this.buffer.length)
    if (!this.filled) {
      // Buffer not full yet; only return the written portion.
      out.set(this.buffer.subarray(0, this.writePos))
      console.log(`[aimy] PrerollBuffer: drained ${this.writePos} samples (partial)`)
      return out.subarray(0, this.writePos)
    }
    // Full buffer: start from writePos (oldest) and wrap.
    out.set(this.buffer.subarray(this.writePos))
    out.set(this.buffer.subarray(0, this.writePos), this.buffer.length - this.writePos)
    console.log(`[aimy] PrerollBuffer: drained ${out.length} samples (full ${this.bufferSeconds}s)`)
    return out
  }

  /** Stop capturing and release mic. */
  stop(): void {
    if (this.verifyTimer !== null) {
      window.clearTimeout(this.verifyTimer)
      this.verifyTimer = null
    }
    this.processor?.disconnect()
    this.source?.disconnect()
    this.audioContext?.close().catch(() => {})
    this.stream?.getTracks().forEach((t) => t.stop())
    this.audioContext = null
    this.source = null
    this.processor = null
    this.stream = null
    console.log("[aimy] PrerollBuffer: stopped")
    this.setState({ state: "cold", bufferOk: false, sttOk: false, reason: "Stopped" })
  }
}
