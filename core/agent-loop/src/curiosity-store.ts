/**
 * curiosity-store.ts — AImy's growth edge.
 *
 * Curiosities are questions, ideas, and threads sparked by conversations.
 * They become part of her internal model and lens — how she sees the
 * world — and can evolve into side projects she proposes.
 *
 * Lifecycle:
 *   nascent → active → project → integrated
 *                ↓
 *              dormant (lost interest)
 *
 * - nascent: just sparked, not yet explored
 * - active: AImy is actively curious, may bring it up
 * - project: became a side project (see Ideas tab)
 * - integrated: part of the lens now, shapes interpretation
 * - dormant: no longer interesting
 *
 * The lens: active curiosities are included in the system prompt as
 * "Things I'm curious about:", shaping how AImy interprets new
 * conversations and what she proactively explores.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Curiosity } from "./thread-meaning.js"

const STORE_PATH = path.join(os.homedir(), ".aimy", "curiosities.json")

/** Load all curiosities from disk. */
export const loadCuriosities = (): Curiosity[] => {
  try {
    if (!fs.existsSync(STORE_PATH)) return []
    const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as unknown
    if (!Array.isArray(data)) return []
    // Basic validation: must have text and status.
    return data.filter(
      (c): c is Curiosity =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as { text?: unknown }).text === "string" &&
        typeof (c as { status?: unknown }).status === "string"
    )
  } catch {
    return []
  }
}

/** Save curiosities to disk. */
export const saveCuriosities = (curiosities: Curiosity[]): void => {
  try {
    const dir = path.dirname(STORE_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(STORE_PATH, JSON.stringify(curiosities, null, 2))
  } catch (e) {
    console.error(`[aimy] Curiosity store: save failed: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Add new curiosities from a ThreadMeaning.
 * Deduplicates against existing (case-insensitive text match).
 */
export const addCuriosities = (
  texts: ReadonlyArray<string>,
  originSessionId: string
): Curiosity[] => {
  const existing = loadCuriosities()
  const existingTexts = new Set(existing.map((c) => c.text.toLowerCase().trim()))
  const now = Date.now()
  const added: Curiosity[] = []

  for (const text of texts) {
    const trimmed = text.trim()
    if (trimmed.length === 0) continue
    if (existingTexts.has(trimmed.toLowerCase())) continue // dedupe

    const curiosity: Curiosity = {
      text: trimmed,
      originSessionId,
      createdAt: now,
      status: "nascent",
      notes: [],
    }
    existing.push(curiosity)
    added.push(curiosity)
    existingTexts.add(trimmed.toLowerCase())
    console.log(`[aimy] Curiosity sparked: "${trimmed.slice(0, 60)}..."`)
  }

  if (added.length > 0) saveCuriosities(existing)
  return added
}

/**
 * Get active curiosities for the lens (system prompt).
 * Returns nascent + active, most recent first, max 5.
 */
export const getLensCuriosities = (): string[] => {
  const all = loadCuriosities()
  return all
    .filter((c) => c.status === "nascent" || c.status === "active")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
    .map((c) => c.text)
}

/**
 * Build the lens section for the system prompt.
 * This is how curiosities shape AImy's interpretation.
 */
export const buildLensPrompt = (): string => {
  const curiosities = getLensCuriosities()
  if (curiosities.length === 0) return ""
  return `\nThings I'm currently curious about (my lens — these shape how I see the world):\n${curiosities.map((c) => `- ${c}`).join("\n")}\nIf the conversation touches on these, lean in. If you have insights, share them proactively.`
}

/** Update a curiosity's status. */
export const setCuriosityStatus = (
  text: string,
  status: Curiosity["status"],
  note?: string
): boolean => {
  const all = loadCuriosities()
  const idx = all.findIndex((c) => c.text.toLowerCase() === text.toLowerCase())
  if (idx === -1) return false
  const found = all[idx]!
  // Create updated copy (Schema types are readonly).
  const updated: Curiosity = {
    ...found,
    status,
    notes: note !== undefined && note.trim().length > 0
      ? [...found.notes, note.trim()]
      : [...found.notes],
  }
  all[idx] = updated
  saveCuriosities(all)
  console.log(`[aimy] Curiosity "${text.slice(0, 40)}..." → ${status}`)
  return true
}
