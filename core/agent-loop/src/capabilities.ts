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
