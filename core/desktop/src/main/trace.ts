/**
 * main/trace.ts — debug trace mode (2026-10-11).
 *
 * When `debugTrace: true` in ~/.aimy/desktop.json, every app launch writes a
 * JSONL session trace to ~/.aimy/traces/session-<ts>.jsonl (last 5 kept).
 *
 * Design (per Kimler's spec):
 * - Strategic events, not every function: turn lifecycle, IPC both ways,
 *   tool calls, TTS/audio timing, state snapshots, errors, console output.
 * - NEVER payload bytes: audio base64, large blobs are replaced by metadata
 *   (lengths, sequence numbers, timings). Narrate/chat text IS logged —
 *   that's the presentation layer and it's small.
 * - State snapshots on key events (queue depth, speaking flags) so
 *   unexpected patterns are visible without predicting them.
 * - Every stop/drop logs its reason.
 * - Async batched writer: never blocks a turn. Flush on quit.
 *
 * The file is the shared troubleshooting surface: Zen reads it via the
 * device file commands, Kimler reads it directly. No collector, no dashboard.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Maximum session traces retained (Kimler: mindful of space). */
const KEEP_SESSIONS = 5
/** Flush interval for the batched writer (ms). */
const FLUSH_MS = 250
/** Max buffered lines before a forced flush. */
const FLUSH_LINES = 50

/** Fields that must never hit the trace (defense in depth). */
const FORBIDDEN_KEYS = new Set(["audioBase64", "audio_base64", "wav", "bytes"])

const tracesDir = (): string => path.join(os.homedir(), ".aimy", "traces")

export interface TraceWriter {
  readonly enabled: boolean
  readonly filePath: string | undefined
  /** Log one event. No-op when disabled. Never throws. */
  readonly log: (proc: "main" | "renderer", trace: string, event: string, fields?: Record<string, unknown>) => void
  /** Flush buffered lines now. */
  readonly flush: () => Promise<void>
  /** Flush synchronously (for quit path). */
  readonly flushSync: () => void
}

const sanitize = (fields: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(k)) {
      out[`${k}_omitted`] = typeof v === "string" ? `(${v.length} chars omitted)` : "(omitted)"
      continue
    }
    // Truncate very long strings (chat text is fine, but cap it).
    out[k] = typeof v === "string" && v.length > 8000 ? v.slice(0, 8000) + `…(${v.length - 8000} more)` : v
  }
  return out
}

/** The stable path for the current run's trace (Kimler: always readable without guessing timestamps). */
const LATEST_NAME = "session-latest.jsonl"

const pruneOldSessions = (dir: string): void => {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(
      (f) => f.startsWith("session-") && f.endsWith(".jsonl") && f !== LATEST_NAME
    ).sort()
  } catch {
    return
  }
  while (files.length > KEEP_SESSIONS) {
    const oldest = files.shift()!
    try {
      fs.unlinkSync(path.join(dir, oldest))
      console.log(`[aimy] trace: pruned old session ${oldest}`)
    } catch {
      break
    }
  }
}

/** Create the session trace writer. Returns a disabled no-op when `enabled` is false. */
export const createTraceWriter = (enabled: boolean): TraceWriter => {
  if (!enabled) {
    return {
      enabled: false,
      filePath: undefined,
      log: () => undefined,
      flush: () => Promise.resolve(),
      flushSync: () => undefined,
    }
  }
  const dir = tracesDir()
  fs.mkdirSync(dir, { recursive: true })
  pruneOldSessions(dir)
  const filePath = path.join(dir, `session-${Date.now()}.jsonl`)
  // Stable path for the current run (Kimler): truncated fresh each launch,
  // every line mirrored here so there's never a question which file is live.
  const latestPath = path.join(dir, LATEST_NAME)
  try {
    fs.writeFileSync(latestPath, "")
  } catch (e) {
    console.error(`[aimy] trace: could not reset ${LATEST_NAME}: ${e instanceof Error ? e.message : e}`)
  }
  console.log(`[aimy] trace: debug mode ON → ${filePath} (mirrored to ${LATEST_NAME})`)

  let buffer: Array<string> = []
  let flushTimer: NodeJS.Timeout | undefined
  let closed = false

  /** Append to both the timestamped file and session-latest.jsonl. */
  const appendToBoth = (text: string): void => {
    fs.appendFileSync(filePath, text)
    fs.appendFileSync(latestPath, text)
  }

  const writeBatch = (lines: Array<string>): void => {
    if (lines.length === 0 || closed) return
    try {
      appendToBoth(lines.join("\n") + "\n")
    } catch (e) {
      console.error(`[aimy] trace: write failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined || closed) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      const lines = buffer
      buffer = []
      if (lines.length === 0) return
      const text = lines.join("\n") + "\n"
      // Async so we never block the event loop on I/O.
      fs.promises.appendFile(filePath, text)
        .then(() => fs.promises.appendFile(latestPath, text))
        .catch((e) =>
          console.error(`[aimy] trace: async write failed: ${e instanceof Error ? e.message : e}`)
        )
    }, FLUSH_MS)
  }

  const log: TraceWriter["log"] = (proc, trace, event, fields) => {
    if (closed) return
    try {
      const line = JSON.stringify({ ts: Date.now(), proc, trace, event, ...sanitize(fields ?? {}) })
      buffer.push(line)
      if (buffer.length >= FLUSH_LINES) {
        const lines = buffer
        buffer = []
        writeBatch(lines)
      } else {
        scheduleFlush()
      }
    } catch (e) {
      console.error(`[aimy] trace: log failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  // Session open marker.
  log("main", "session", "session.start", { file: filePath, pid: process.pid })

  // Build info (2026-10-12): log version so Zen can verify which build is running.
  // The version.js is generated by ./core/update with git hash + timestamp.
  try {
    // ES modules don't have __dirname; derive from import.meta.url.
    const thisFile = new URL(import.meta.url).pathname
    const versionPath = path.join(path.dirname(thisFile), "..", "..", "renderer", "version.js")
    const versionContent = fs.readFileSync(versionPath, "utf-8")
    const match = versionContent.match(/AIMY_VERSION\s*=\s*"([^"]+)"/)
    const version = match ? match[1] : "unknown"
    log("main", "session", "build.info", { version, versionFile: versionPath })
  } catch (e) {
    log("main", "session", "build.info", { version: "unavailable", error: String(e) })
  }

  return {
    enabled: true,
    filePath,
    log,
    flush: () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      const lines = buffer
      buffer = []
      if (lines.length === 0) return Promise.resolve()
      const text = lines.join("\n") + "\n"
      return fs.promises.appendFile(filePath, text)
        .then(() => fs.promises.appendFile(latestPath, text))
        .catch(() => undefined).then(() => undefined)
    },
    flushSync: () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      const lines = buffer
      buffer = []
      closed = true
      writeBatch(lines)
    },
  }
}

/** Shorthand for error events with stacks. */
export const traceError = (
  trace: TraceWriter,
  proc: "main" | "renderer",
  traceId: string,
  where: string,
  error: unknown
): void => {
  trace.log(proc, traceId, "error", {
    where,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split("\n").slice(0, 8).join("\n") : undefined,
  })
}
