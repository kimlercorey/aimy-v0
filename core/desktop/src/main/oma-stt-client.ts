/**
 * desktop/src/main/oma-stt-client.ts — OMA faster-whisper STT via SSH tunnel.
 *
 * POST http://127.0.0.1:8765/transcribe with multipart/form-data (file=@audio.wav).
 * Response: { text, avg_logprob, no_speech_prob, no_speech, n_segments, model, duration_s, rtf }
 *
 * 2026-10-10: Kimler's stt_5090_wrap.py on OMA (RTX 5090). Tunnel via
 * ~/.aimy/hooks/startup.d/10-oma-tunnel.sh (127.0.0.1:8765 → OMA:8765).
 */

 export interface OmaSttResponse {
  readonly text: string
  /** Whisper model size (currently "small" per live /health). */
  readonly model?: string | undefined
  readonly duration_s?: number | undefined
  readonly decode_s?: number | undefined
  readonly transcribe_s?: number | undefined
  readonly total_s?: number | undefined
  /** Real-time factor. */
  readonly rtf?: number | undefined
  readonly language?: string | undefined
  readonly n_segments?: number | undefined
  /** True if server detected no speech (normal for silence, not an error). */
  readonly no_speech?: boolean | undefined
  /** Mean logprob; null when no_speech=true. */
  readonly avg_logprob?: number | null | undefined
  /** P(no speech); null when no_speech=true. */
  readonly no_speech_prob?: number | null | undefined
}

/**
 * Transcribe audio via OMA faster-whisper.
 * @param audioBytes WAV/MP3 audio data
 * @param filename e.g. "recording.wav" (sent as multipart filename)
 * @param baseUrl OMA STT endpoint base (default: tunnel)
 */
export const omaTranscribe = async (
  audioBytes: Uint8Array,
  filename: string,
  baseUrl: string = "http://127.0.0.1:8765"
): Promise<OmaSttResponse> => {
  const started = Date.now()
  console.log(`[aimy] OMA STT: transcribing ${audioBytes.length} bytes via ${baseUrl}/transcribe`)

  // Build multipart/form-data manually (Node fetch supports FormData with Blob).
  const form = new FormData()
  const blob = new Blob([audioBytes as unknown as BlobPart], { type: "audio/wav" })
  form.append("file", blob, filename)

  const res = await fetch(`${baseUrl}/transcribe`, {
    method: "POST",
    body: form,
    // 120s timeout per Kimler's curl (-m 120)
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    console.log(`[aimy] OMA STT failed: HTTP ${res.status} ${text.slice(0, 200)}`)
    throw new Error(`OMA STT HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as OmaSttResponse
  const elapsed = Date.now() - started
  // no_speech=true is NORMAL (silence), not an error. Caller should re-listen.
  if (data.no_speech === true) {
    console.log(`[aimy] OMA STT: no speech detected (${elapsed}ms, duration_s=${data.duration_s ?? "?"}) — not an error`)
  } else {
    console.log(
      `[aimy] OMA STT success: ${elapsed}ms, text="${data.text.slice(0, 80)}${data.text.length > 80 ? "…" : ""}", ` +
      `rtf=${data.rtf ?? "?"}, model=${data.model ?? "?"}`
    )
  }
  return data
}

/**
 * Health check: is OMA STT reachable via the tunnel?
 * Any HTTP response (even 404) means the tunnel is up.
 */
export const omaSttHealth = async (
  baseUrl: string = "http://127.0.0.1:8765"
): Promise<boolean> => {
  try {
    const res = await fetch(`${baseUrl}/`, {
      signal: AbortSignal.timeout(3000),
    })
    // Any response (even 404) = server is up
    console.log(`[aimy] OMA STT health: reachable (HTTP ${res.status})`)
    return true
  } catch (e) {
    console.log(`[aimy] OMA STT health: unreachable (${e instanceof Error ? e.message : e})`)
    return false
  }
}
