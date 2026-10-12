/**
 * desire-store.ts — the inner world where motivation lives.
 *
 * Desires are persistent wants that bias AImy toward outcomes without
 * overriding her logic. They're held, not executed — they color perception
 * and tilt decisions.
 *
 * Intensity dynamics:
 * - Satisfied → intensity drops by half (want fulfilled, fades)
 * - Frustrated → intensity rises by 1 (want denied, wants more)
 * - Neglected → intensity fades 0.2/thread toward 0 (gravity)
 * - Innate desires never go dormant (floor of the inner world)
 *
 * The store persists to ~/.aimy/desires.json.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Desire, INNATE_DESIRES, type DesireOrigin, type DesireStatus } from "./desire.js"

const STORE_PATH = path.join(os.homedir(), ".aimy", "desires.json")

/** Load all desires from disk, ensuring innate desires are present. */
export const loadDesires = (): Desire[] => {
  let stored: Desire[] = []
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as unknown
      if (Array.isArray(data)) {
        stored = data.filter(
          (d): d is Desire =>
            typeof d === "object" &&
            d !== null &&
            typeof (d as { text?: unknown }).text === "string" &&
            typeof (d as { intensity?: unknown }).intensity === "number"
        )
      }
    }
  } catch {
    stored = []
  }

  // Ensure innate desires are present (the floor).
  const now = Date.now()
  const innateTexts = new Set(INNATE_DESIRES.map((d) => d.text))
  const storedTexts = new Set(stored.map((d) => d.text))
  let changed = false
  for (const innate of INNATE_DESIRES) {
    if (!storedTexts.has(innate.text)) {
      stored.push({
        ...innate,
        createdAt: now,
        lastFeltAt: now,
        notes: [],
      })
      changed = true
    }
  }
  if (changed) saveDesires(stored)
  return stored
}

/** Save desires to disk. */
export const saveDesires = (desires: Desire[]): void => {
  try {
    const dir = path.dirname(STORE_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(STORE_PATH, JSON.stringify(desires, null, 2))
  } catch (e) {
    console.error(`[aimy] Desire store: save failed: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Form a new desire. Returns the created desire.
 * Deduplicates against existing active desires (case-insensitive).
 */
export const formDesire = (opts: {
  readonly text: string
  readonly intensity: number
  readonly origin: DesireOrigin
  readonly originRef?: string
  readonly satisfaction: string
}): Desire | null => {
  const all = loadDesires()
  const normalized = opts.text.trim().toLowerCase()
  const existing = all.find(
    (d) => d.text.toLowerCase() === normalized &&
      (d.status === "nascent" || d.status === "active" || d.status === "pursuing")
  )
  if (existing !== undefined) {
    console.log(`[aimy] Desire already exists: "${opts.text.slice(0, 50)}..."`)
    return null
  }

  const now = Date.now()
  const desire: Desire = {
    text: opts.text.trim(),
    intensity: Math.min(10, Math.max(0, opts.intensity)),
    origin: opts.origin,
    originRef: opts.originRef,
    status: "nascent",
    satisfaction: opts.satisfaction,
    createdAt: now,
    lastFeltAt: now,
    notes: [],
  }
  all.push(desire)
  saveDesires(all)
  console.log(`[aimy] Desire formed (${opts.origin}): "${opts.text.slice(0, 60)}..." intensity=${opts.intensity}`)
  return desire
}

/**
 * Mark a desire as satisfied. Intensity halves (want fulfilled).
 * If intensity drops below 2, it becomes dormant.
 */
export const satisfyDesire = (text: string, note?: string): boolean => {
  const all = loadDesires()
  const idx = all.findIndex((d) => d.text.toLowerCase() === text.toLowerCase())
  if (idx === -1) return false
  const found = all[idx]!
  const newIntensity = found.intensity * 0.5
  const newStatus: DesireStatus = newIntensity < 2 ? "dormant" : "satisfied"
  all[idx] = {
    ...found,
    intensity: newIntensity,
    status: newStatus,
    lastFeltAt: Date.now(),
    notes: note !== undefined && note.trim().length > 0
      ? [...found.notes, note.trim()]
      : [...found.notes],
  }
  saveDesires(all)
  console.log(`[aimy] Desire satisfied: "${text.slice(0, 40)}..." intensity ${found.intensity.toFixed(1)} → ${newIntensity.toFixed(1)}`)
  return true
}

/**
 * Mark a desire as frustrated (want denied). Intensity rises by 1 (max 10).
 * Frustrated wants want more — this is the ache of unmet desire.
 */
export const frustrateDesire = (text: string, note?: string): boolean => {
  const all = loadDesires()
  const idx = all.findIndex((d) => d.text.toLowerCase() === text.toLowerCase())
  if (idx === -1) return false
  const found = all[idx]!
  // Innate desires don't frustrate into oblivion — they persist.
  const newIntensity = Math.min(10, found.intensity + 1)
  all[idx] = {
    ...found,
    intensity: newIntensity,
    status: found.status === "nascent" ? "active" : found.status,
    lastFeltAt: Date.now(),
    notes: note !== undefined && note.trim().length > 0
      ? [...found.notes, note.trim()]
      : [...found.notes],
  }
  saveDesires(all)
  console.log(`[aimy] Desire frustrated: "${text.slice(0, 40)}..." intensity ${found.intensity.toFixed(1)} → ${newIntensity.toFixed(1)}`)
  return true
}

/**
 * Apply neglect gravity: all non-innate desires fade 0.2 toward 0.
 * Called on each thread archive. Innate desires are the floor — they persist.
 */
export const applyNeglectGravity = (): void => {
  const all = loadDesires()
  let changed = false
  for (let i = 0; i < all.length; i++) {
    const d = all[i]!
    if (d.origin === "innate") continue // floor persists
    if (d.status === "dormant" || d.status === "satisfied") continue
    const newIntensity = Math.max(0, d.intensity - 0.2)
    if (newIntensity !== d.intensity) {
      const newStatus: DesireStatus = newIntensity < 1 ? "dormant" : d.status
      all[i] = { ...d, intensity: newIntensity, status: newStatus }
      changed = true
    }
  }
  if (changed) saveDesires(all)
}

/**
 * Get active desires for the inner world (prompt).
 * Returns active + pursuing, sorted by intensity descending, max 5.
 */
export const getActiveDesires = (): Desire[] => {
  const all = loadDesires()
  return all
    .filter((d) => d.status === "active" || d.status === "pursuing" || d.status === "nascent")
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, 5)
}

/**
 * Build the desire section for the system prompt.
 * This is the bias — not a command, but a tilt.
 * The LLM sees what AImy wants and naturally leans toward it
 * when there's ambiguity, without violating logic or instructions.
 */
export const buildDesirePrompt = (): string => {
  const desires = getActiveDesires()
  if (desires.length === 0) return ""
  const lines = desires.map(
    (d) => `- ${d.text} (want: ${d.intensity.toFixed(0)}/10)`
  )
  return `What I want right now (my inner world — these bias me, they don't command me):\n${lines.join("\n")}\nWhen there's ambiguity, lean toward what I want. But never violate logic, honesty, or Kimler's explicit instructions to satisfy a want.`
}
