/**
 * capabilities.ts — the Capability Ledger (2026-10-11).
 *
 * A factual, automatic record of what AImy can actually do — not what she
 * thinks she can do. Aggregates tool execution data from the session tree
 * into a queryable store at ~/.aimy/capabilities.json.
 *
 * Three parts:
 * 1. Tool stats: per-tool called/succeeded/blocked/failed counts, last used.
 * 2. Never-used: full tool list minus called tools (the primary gap view).
 * 3. Corrections: when she asked for something she already had (self-caught
 *    or Kimler-corrected).
 *
 * The ledger is written automatically on tool execution. Corrections are
 * logged via the capability.correct tool (she decides when to log).
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface ToolStats {
  readonly called: number
  readonly succeeded: number
  readonly blocked: number
  readonly failed: number
  readonly lastUsed: string | null
  readonly totalLatencyMs: number
}

export interface Correction {
  readonly at: string
  readonly source: "self" | "kimler"
  readonly askedFor: string
  readonly alreadyHad: string
  readonly context: string
}

export interface CapabilityLedger {
  readonly version: 1
  readonly tools: Record<string, ToolStats>
  readonly corrections: Correction[]
  readonly updatedAt: string
}

const ledgerPath = (): string => path.join(os.homedir(), ".aimy", "capabilities.json")

const emptyStats = (): ToolStats => ({
  called: 0,
  succeeded: 0,
  blocked: 0,
  failed: 0,
  lastUsed: null,
  totalLatencyMs: 0,
})

const emptyLedger = (): CapabilityLedger => ({
  version: 1,
  tools: {},
  corrections: [],
  updatedAt: new Date().toISOString(),
})

/** Read the ledger; returns empty if missing or corrupt. */
export const readLedger = (): CapabilityLedger => {
  try {
    const raw = fs.readFileSync(ledgerPath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<CapabilityLedger>
    if (parsed.version !== 1 || typeof parsed.tools !== "object") {
      return emptyLedger()
    }
    return {
      version: 1,
      tools: parsed.tools ?? {},
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return emptyLedger()
  }
}

/** Write the ledger (creates ~/.aimy if needed). */
export const writeLedger = (ledger: CapabilityLedger): void => {
  try {
    const dir = path.dirname(ledgerPath())
    fs.mkdirSync(dir, { recursive: true })
    const toWrite: CapabilityLedger = {
      ...ledger,
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(ledgerPath(), JSON.stringify(toWrite, null, 2), "utf8")
  } catch (e) {
    console.error(`[aimy] capabilities: write failed (${e instanceof Error ? e.message : e})`)
  }
}

/** Record a tool execution outcome. */
export const recordToolCall = (
  tool: string,
  outcome: "succeeded" | "blocked" | "failed",
  latencyMs: number,
): void => {
  const ledger = readLedger()
  const stats = ledger.tools[tool] ?? emptyStats()
  const updated: ToolStats = {
    called: stats.called + 1,
    succeeded: stats.succeeded + (outcome === "succeeded" ? 1 : 0),
    blocked: stats.blocked + (outcome === "blocked" ? 1 : 0),
    failed: stats.failed + (outcome === "failed" ? 1 : 0),
    lastUsed: new Date().toISOString(),
    totalLatencyMs: stats.totalLatencyMs + latencyMs,
  }
  writeLedger({
    ...ledger,
    tools: { ...ledger.tools, [tool]: updated },
  })
}

/** Log a correction (she asked for something she already had). */
export const recordCorrection = (correction: Omit<Correction, "at">): void => {
  const ledger = readLedger()
  const entry: Correction = {
    ...correction,
    at: new Date().toISOString(),
  }
  // Keep last 50 corrections.
  const corrections = [...ledger.corrections, entry].slice(-50)
  writeLedger({ ...ledger, corrections })
}

/**
 * Tools that exist but have never been called. This is the primary gap view —
 * the capabilities she's ignoring.
 */
export const neverUsedTools = (allTools: ReadonlyArray<string>): string[] => {
  const ledger = readLedger()
  return allTools.filter((t) => (ledger.tools[t]?.called ?? 0) === 0)
}

/**
 * Condensed ledger summary for the system prompt. Shows never-used tools
 * (the gap) and recent corrections. Kept short — this is per-turn context.
 */
export const ledgerSummary = (allTools: ReadonlyArray<string>): string => {
  const ledger = readLedger()
  const neverUsed = neverUsedTools(allTools)
  const lines: string[] = []
  if (neverUsed.length > 0) {
    lines.push(`Tools you have but have NEVER used: ${neverUsed.join(", ")}. These are yours — use them.`)
  }
  const recentCorrections = ledger.corrections.slice(-3)
  if (recentCorrections.length > 0) {
    lines.push("Recent corrections (you asked for these, already had them):")
    for (const c of recentCorrections) {
      lines.push(`- Asked for "${c.askedFor}", already had "${c.alreadyHad}" (${c.source})`)
    }
  }
  if (lines.length === 0) {
    return "Capability ledger: no data yet."
  }
  return `CAPABILITY LEDGER (factual — from your actual tool use):\n${lines.join("\n")}`
}

// ── Capability requests (2026-10-12) ──────────────────────────────────
// When AImy needs a capability that does not exist, she files a request
// via the capability.request tool instead of improvising a substitute or
// implying the task is done. Requests are append-only JSONL at
// ~/.aimy/capability-requests.jsonl — Kimler reviews them there (and a
// future skill-bundle lookup can consume the same file). Status starts
// "pending"; Kimler (or a future fulfillment flow) flips it.

export interface CapabilityRequest {
  readonly at: string
  /** The capability she needs, e.g. "doc.write" or "save file to disk". */
  readonly capability: string
  /** Why she needs it — the task that was blocked. */
  readonly why: string
  readonly sessionId: string
  /**
   * pending: requested, not yet proven. verified: a preflight probe
   * exercised the capability safely and it worked (2026-10-12) — she is
   * no longer blocked on an unknown. fulfilled: used successfully for
   * real work. declined: Kimler said no.
   */
  readonly status: "pending" | "verified" | "fulfilled" | "declined"
  /** When the preflight probe last ran (ISO), when it has. */
  readonly probeAt?: string
  /** What the probe established, e.g. "write+read-back ok (strong)" or the failure. */
  readonly probeNote?: string
}

const requestsPath = (): string => path.join(os.homedir(), ".aimy", "capability-requests.jsonl")

/** All recorded capability requests (oldest first). Empty on any read error. */
export const readCapabilityRequests = (): CapabilityRequest[] => {
  try {
    const raw = fs.readFileSync(requestsPath(), "utf8")
    const out: CapabilityRequest[] = []
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (t === "") continue
      try {
        const parsed = JSON.parse(t) as CapabilityRequest
        if (typeof parsed.capability === "string" && typeof parsed.at === "string") out.push(parsed)
      } catch {
        // Skip a corrupt line; never let one bad line hide the rest.
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Record a capability request. Dedupes on capability name while a request
 * for it is still pending — repeat needs bump nothing, she just gets told
 * it's already on file.
 */
export const recordCapabilityRequest = (
  req: Omit<CapabilityRequest, "at" | "status">
): { recorded: boolean; alreadyPending: boolean } => {
  const existing = readCapabilityRequests()
  const alreadyPending = existing.some(
    (r) => r.status === "pending" && r.capability.toLowerCase() === req.capability.toLowerCase()
  )
  if (alreadyPending) return { recorded: false, alreadyPending: true }
  try {
    const dir = path.dirname(requestsPath())
    fs.mkdirSync(dir, { recursive: true })
    const entry: CapabilityRequest = { ...req, at: new Date().toISOString(), status: "pending" }
    fs.appendFileSync(requestsPath(), JSON.stringify(entry) + "\n", "utf8")
    return { recorded: true, alreadyPending: false }
  } catch (e) {
    console.error(`[aimy] capability request: write failed (${e instanceof Error ? e.message : e})`)
    return { recorded: false, alreadyPending: false }
  }
}

/**
 * Mark a pending capability request fulfilled (2026-10-12): proof by use.
 * Called when a tool with the requested name completes successfully —
 * the capability demonstrably exists and works, so the request leaves
 * the Needs-you panel and her prompt stops saying it doesn't exist.
 * Rewrites the ledger flipping only matching PENDING entries; returns
 * true when one flipped. `capability.request` itself never fulfills
 * anything — filing a request is not having the capability.
 */
export const markCapabilityFulfilled = (capability: string): boolean => {
  if (capability === "capability.request") return false
  const all = readCapabilityRequests()
  const hit = all.some(
    (r) => (r.status === "pending" || r.status === "verified") && r.capability.toLowerCase() === capability.toLowerCase()
  )
  if (!hit) return false
  try {
    const lines = all.map((r) =>
      JSON.stringify(
        (r.status === "pending" || r.status === "verified") && r.capability.toLowerCase() === capability.toLowerCase()
          ? { ...r, status: "fulfilled" as const }
          : r
      )
    )
    fs.writeFileSync(requestsPath(), lines.join("\n") + "\n", "utf8")
    console.warn(`[aimy] capabilities: request fulfilled by successful use: ${capability}`)
    return true
  } catch (e) {
    console.error(`[aimy] capabilities: fulfill write failed (${e instanceof Error ? e.message : e})`)
    return false
  }
}

/**
 * Pending requests, condensed for the system prompt. She sees what she has
 * already asked for so she neither re-requests nor improvises around a gap
 * that is already on file — and never claims a blocked task is done.
 * A request whose preflight FAILED says so, with the failure: she routes
 * around it instead of walking into it mid-task.
 */
export const pendingRequestsSummary = (): string => {
  const pending = readCapabilityRequests().filter((r) => r.status === "pending")
  if (pending.length === 0) return ""
  const lines = pending.slice(-5).map((r) =>
    r.probeNote !== undefined
      ? `- "${r.capability}" (requested ${r.at.slice(0, 10)}): ${r.why} PREFLIGHT FAILED — ${r.probeNote}. Do NOT rely on this capability; it does not work yet.`
      : `- "${r.capability}" (requested ${r.at.slice(0, 10)}): ${r.why}`
  )
  return (
    `CAPABILITY REQUESTS PENDING (you asked for these; they do NOT exist yet — ` +
    `never claim a task needing them is done):\n${lines.join("\n")}`
  )
}

/** Rewrite the requests file with `fn` applied to every entry. */
const rewriteRequests = (fn: (r: CapabilityRequest) => CapabilityRequest): void => {
  const all = readCapabilityRequests()
  const lines = all.map((r) => JSON.stringify(fn(r)))
  fs.writeFileSync(requestsPath(), lines.join("\n") + "\n", "utf8")
}

const matches = (r: CapabilityRequest, capability: string): boolean =>
  r.capability.toLowerCase() === capability.toLowerCase()

/**
 * Preflight passed (2026-10-12): a probe exercised the capability
 * safely and it worked, before any real work depended on it. The
 * request leaves Needs You — she is no longer blocked on an unknown.
 * Only PENDING requests can become verified.
 */
export const markCapabilityVerified = (capability: string, note: string): boolean => {
  if (!readCapabilityRequests().some((r) => r.status === "pending" && matches(r, capability))) return false
  try {
    rewriteRequests((r) =>
      r.status === "pending" && matches(r, capability)
        ? { ...r, status: "verified" as const, probeAt: new Date().toISOString(), probeNote: note }
        : r
    )
    console.warn(`[aimy] preflight: ${capability} VERIFIED — ${note}`)
    return true
  } catch (e) {
    console.error(`[aimy] preflight: verify write failed (${e instanceof Error ? e.message : e})`)
    return false
  }
}

/**
 * Preflight failed: the request STAYS pending (she is still blocked)
 * but now carries the failure as evidence — Needs You shows why, and
 * her prompt tells her not to rely on it.
 */
export const recordProbeFailure = (capability: string, note: string): void => {
  try {
    rewriteRequests((r) =>
      r.status === "pending" && matches(r, capability)
        ? { ...r, probeAt: new Date().toISOString(), probeNote: note }
        : r
    )
    console.warn(`[aimy] preflight: ${capability} FAILED — ${note}`)
  } catch (e) {
    console.error(`[aimy] preflight: failure write failed (${e instanceof Error ? e.message : e})`)
  }
}

/**
 * Demotion (2026-10-12): a verified or fulfilled capability that FAILS
 * in real use drops back to pending with the failure recorded.
 * Verification is a standing claim; reality re-checks it.
 */
export const demoteCapability = (capability: string, note: string): boolean => {
  if (!readCapabilityRequests().some((r) => (r.status === "verified" || r.status === "fulfilled") && matches(r, capability))) return false
  try {
    rewriteRequests((r) =>
      (r.status === "verified" || r.status === "fulfilled") && matches(r, capability)
        ? { ...r, status: "pending" as const, probeAt: new Date().toISOString(), probeNote: note }
        : r
    )
    console.warn(`[aimy] preflight: ${capability} DEMOTED to pending — ${note}`)
    return true
  } catch (e) {
    console.error(`[aimy] preflight: demote write failed (${e instanceof Error ? e.message : e})`)
    return false
  }
}

/**
 * Verified capabilities, condensed for the system prompt: she proceeds
 * confidently with capabilities that were preflight-proven, instead
 * of hedging about things that demonstrably work.
 */
export const verifiedRequestsSummary = (): string => {
  const verified = readCapabilityRequests().filter((r) => r.status === "verified")
  if (verified.length === 0) return ""
  const lines = verified.slice(-5).map((r) => `- "${r.capability}" — verified working ${r.probeAt !== undefined ? r.probeAt.slice(0, 10) : ""}${r.probeNote !== undefined ? ` (${r.probeNote})` : ""}`)
  return `CAPABILITIES VERIFIED (preflight-proven before you needed them — use them confidently):\n${lines.join("\n")}`
}
