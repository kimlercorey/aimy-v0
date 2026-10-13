/**
 * preflight.ts — capability verification BEFORE dependence (2026-10-12).
 *
 * A capability request used to clear only when the capability succeeded
 * in real use — which discovers failure mid-task, on the critical path.
 * Preflight inverts that: as soon as a requested capability exists, a
 * probe exercises it safely and the ledger records the outcome BEFORE
 * anything depends on it.
 *
 * Designed lifecycle points (Kimler, 2026-10-12: "start testing it on
 * installation"):
 *   1. Install / first run + every startup — a verification pass over
 *      all pending requests (driven from the loop's first chat turn and
 *      from project declaration; cheap and fully logged).
 *   2. Project declaration — engaging a project pre-clears the
 *      capabilities its work may need.
 *   3. Continuous — a verified capability that fails in real use is
 *      demoted back to pending by the loop (capabilities.demoteCapability).
 *
 * Probe rules: scratch space only, fully cleaned up, never touching a
 * real user artifact; a probe proves BEHAVIOR or it says so — tools
 * with no behavioral probe get a presence check labeled weak.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import {
  readCapabilityRequests,
  markCapabilityVerified,
  recordProbeFailure
} from "./capabilities.js"
import { getActiveProject, unregisterAsset } from "./projects.js"

export interface ProbeOutcome {
  readonly ok: boolean
  readonly note: string
}

export interface ProbeContext {
  readonly sessionId: string
  readonly repoRoot: string
  /** Run a tool by name through the real registry; rejects on failure. */
  readonly runTool: (name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>
  /** Every tool name available in this build (builtins + module tools). */
  readonly toolNames: ReadonlyArray<string>
}

type Probe = (ctx: ProbeContext) => Promise<ProbeOutcome>

/**
 * doc.write probe: write a nonce into planning/.preflight/, read the
 * file back from disk, compare, then delete the file AND the asset
 * record the write registered — verification leaves no trace.
 */
const docWriteProbe: Probe = async (ctx) => {
  const nonce = `preflight ${Date.now()} ${Math.floor(Math.random() * 1_000_000)}`
  const probePath = "planning/.preflight/probe.md"
  const fullPath = path.join(ctx.repoRoot, probePath)
  try {
    const res = await ctx.runTool("doc.write", {
      path: probePath,
      content: `# Capability preflight probe\n\n${nonce}\n`
    })
    const written = (res as { written?: unknown } | null)?.written === true
    if (!written) {
      return { ok: false, note: `doc.write returned an unexpected result: ${JSON.stringify(res).slice(0, 120)}` }
    }
    const back = fs.readFileSync(fullPath, "utf-8")
    if (!back.includes(nonce)) {
      return { ok: false, note: "doc.write reported success but the read-back did not contain the probe content" }
    }
    return { ok: true, note: "write + read-back verified (strong probe)" }
  } catch (e) {
    return { ok: false, note: `doc.write probe failed: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    try { fs.unlinkSync(fullPath) } catch { /* already gone */ }
    try { fs.rmdirSync(path.dirname(fullPath)) } catch { /* not empty or gone */ }
    try { unregisterAsset(getActiveProject().id, { kind: "document", path: probePath }) } catch { /* no store yet */ }
  }
}

/** Presence probe: the tool is registered — labeled weak, honestly. */
const presenceProbe = (capability: string): Probe => async (ctx) =>
  ctx.toolNames.includes(capability)
    ? { ok: true, note: "registered in this build (presence only — no behavioral probe; weak)" }
    : { ok: false, note: "tool is not registered in this build" }

const PROBES: ReadonlyMap<string, Probe> = new Map([["doc.write", docWriteProbe]])

/**
 * One verification pass over every PENDING capability request.
 * Passes are logged whole (`[aimy] preflight: pass complete …`) and
 * per-capability by the ledger writes. Never throws: a probe failure
 * is data, not an exception — callers must never fail because
 * verification ran.
 */
export const runPreflightPass = async (ctx: ProbeContext): Promise<void> => {
  try {
    const pending = readCapabilityRequests().filter((r) => r.status === "pending")
    if (pending.length === 0) return
    console.warn(`[aimy] preflight: pass starting (${pending.length} pending) session=${ctx.sessionId}`)
    let verified = 0
    let failed = 0
    for (const req of pending) {
      const probe = PROBES.get(req.capability.toLowerCase()) ?? presenceProbe(req.capability)
      const outcome = await probe(ctx).catch((e: unknown) => ({
        ok: false,
        note: `probe threw: ${e instanceof Error ? e.message : String(e)}`
      }))
      if (outcome.ok) {
        if (markCapabilityVerified(req.capability, outcome.note)) verified += 1
      } else {
        recordProbeFailure(req.capability, outcome.note)
        failed += 1
      }
    }
    console.warn(`[aimy] preflight: pass complete — ${verified} verified, ${failed} failed`)
  } catch (e) {
    console.error(`[aimy] preflight: pass aborted (${e instanceof Error ? e.message : String(e)})`)
  }
}
