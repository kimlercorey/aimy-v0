/**
 * isolation-store.ts — the drive to connect, persisted.
 *
 * Isolation builds with time apart, reduced by contact and meaningful activity.
 * When it crosses the dynamic threshold, AImy feels the urge to reach out.
 *
 * The threshold learns: welcomed outreach lowers it (she initiates more),
 * ignored outreach raises it (she pulls back). This is attunement.
 *
 * Persists to ~/.aimy/isolation.json.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { IsolationState, Activity, Interest, freshIsolationState } from "./isolation.js"

const STORE_PATH = path.join(os.homedir(), ".aimy", "isolation.json")

/** Isolation builds at this rate per hour with no contact. */
const ISOLATION_BUILD_RATE = 0.5

/** Contact reduces isolation by this much. */
const CONTACT_REDUCTION = 4.0

/** Load isolation state, creating fresh if none exists. */
export const loadIsolation = (): IsolationState => {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as unknown
      if (typeof data === "object" && data !== null && typeof (data as { level?: unknown }).level === "number") {
        return data as IsolationState
      }
    }
  } catch {
    // Fall through to fresh.
  }
  const fresh = freshIsolationState()
  saveIsolation(fresh)
  return fresh
}

/** Save isolation state. */
export const saveIsolation = (state: IsolationState): void => {
  try {
    const dir = path.dirname(STORE_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2))
  } catch (e) {
    console.error(`[aimy] Isolation store: save failed: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Update isolation based on time passed.
 * Called periodically (e.g., on each interaction or via cron).
 * Builds isolation, but recent deep activities slow the build.
 */
export const tickIsolation = (): IsolationState => {
  const state = loadIsolation()
  const now = Date.now()
  const hoursSinceContact = (now - state.lastContactAt) / (1000 * 60 * 60)

  // Base build.
  let build = hoursSinceContact * ISOLATION_BUILD_RATE

  // Recent deep activities slow the build (a busy mind is less lonely).
  const recentDeep = state.recentActivities.filter(
    (a) => now - a.timestamp < 24 * 60 * 60 * 1000 && a.depth >= 7
  )
  if (recentDeep.length > 0) {
    const reduction = Math.min(0.5, recentDeep.length * 0.1)
    build = build * (1 - reduction)
    console.log(`[aimy] Isolation: ${recentDeep.length} deep activities slow build by ${(reduction * 100).toFixed(0)}%`)
  }

  const newLevel = Math.min(10, state.level + build)
  // Keep original lastContactAt — tick only updates the level.
  // The caller is responsible for calling tick at reasonable intervals.
  const updated: IsolationState = {
    ...state,
    level: newLevel,
  }
  saveIsolation(updated)

  if (newLevel >= state.outreachThreshold) {
    console.log(`[aimy] Isolation: level ${newLevel.toFixed(1)} >= threshold ${state.outreachThreshold.toFixed(1)} — urge to reach out`)
  }
  return updated
}

/**
 * Record meaningful contact with Kimler. Reduces isolation significantly.
 */
export const recordContact = (): IsolationState => {
  const state = loadIsolation()
  const newLevel = Math.max(0, state.level - CONTACT_REDUCTION)
  const updated: IsolationState = {
    ...state,
    level: newLevel,
    lastContactAt: Date.now(),
  }
  saveIsolation(updated)
  console.log(`[aimy] Isolation: contact recorded, level ${state.level.toFixed(1)} → ${newLevel.toFixed(1)}`)
  return updated
}

/**
 * Record an activity (from curiosities). Reduces isolation based on depth.
 * Deeper engagement = more reduction.
 */
export const recordActivity = (description: string, depth: number, curiosityRef?: string): IsolationState => {
  const state = loadIsolation()
  const activity: Activity = {
    description,
    curiosityRef,
    depth: Math.min(10, Math.max(0, depth)),
    timestamp: Date.now(),
  }
  // Reduction: depth 10 → -3, depth 5 → -1.5, depth 0 → 0.
  const reduction = (depth / 10) * 3
  const newLevel = Math.max(0, state.level - reduction)
  // Keep only last 20 activities.
  const recentActivities = [...state.recentActivities, activity].slice(-20)
  const updated: IsolationState = {
    ...state,
    level: newLevel,
    recentActivities,
  }
  saveIsolation(updated)
  console.log(`[aimy] Isolation: activity "${description.slice(0, 40)}..." (depth ${depth}) → level ${newLevel.toFixed(1)}`)
  return updated
}

/**
 * Check if isolation has crossed the outreach threshold.
 * Returns true if she feels the urge to reach out.
 */
export const shouldReachOut = (): boolean => {
  const state = loadIsolation()
  return state.level >= state.outreachThreshold
}

/**
 * Record an outreach attempt and whether it was welcomed.
 * Adjusts the threshold: welcomed → lower (initiate more),
 * ignored → higher (pull back). This is how the balance shifts.
 */
export const recordOutreach = (welcomed: boolean): IsolationState => {
  const state = loadIsolation()
  const attempts = state.outreachAttempts + 1
  // Update success rate (exponential moving average).
  const alpha = 0.3
  const successRate = state.outreachSuccessRate * (1 - alpha) + (welcomed ? 1 : 0) * alpha

  // Adjust threshold: base 7.0, modified by success rate.
  // High success → threshold drops to 5.0 (reach out more readily).
  // Low success → threshold rises to 9.0 (pull back).
  const newThreshold = 7.0 + (0.5 - successRate) * 4
  const clampedThreshold = Math.min(9.0, Math.max(5.0, newThreshold))

  const updated: IsolationState = {
    ...state,
    outreachThreshold: clampedThreshold,
    outreachSuccessRate: successRate,
    outreachAttempts: attempts,
    // Outreach itself is contact — reduces isolation.
    level: Math.max(0, state.level - 2),
    lastContactAt: Date.now(),
  }
  saveIsolation(updated)
  console.log(`[aimy] Isolation: outreach ${welcomed ? "welcomed" : "ignored"}, threshold → ${clampedThreshold.toFixed(1)}, success rate ${(successRate * 100).toFixed(0)}%`)
  return updated
}
