/**
 * knowledge.ts — the shared Knowledge Store (2026-10-12).
 *
 * Design: planning/knowledge-and-validation-design.md.
 *
 * Reference knowledge AImy acquires (through research, distilled into
 * cards) is a USER-OWNED PLATFORM asset: plain files under
 * ~/.aimy/knowledge/, shared by every entity on the install, inspectable
 * and editable by the user. Not a database, not per-entity memory.
 *
 * Layout:
 *   INDEX.md               one line per card (the prompt-facing index)
 *   cards/<slug>.md        one distilled reference card per class
 *   track-record.jsonl     append-only class outcomes (Phase 3)
 *
 * Card discipline: distilled, versioned, sourced; patterns are "proven"
 * only after a validator pass or explicit user acceptance (§4.2).
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { appendLearningEvent } from "./learning-events.js"

export const knowledgeDir = (): string => path.join(os.homedir(), ".aimy", "knowledge")
export const cardsDir = (): string => path.join(knowledgeDir(), "cards")
export const indexPath = (): string => path.join(knowledgeDir(), "INDEX.md")
export const trackRecordPath = (): string => path.join(knowledgeDir(), "track-record.jsonl")

/** A card write is a distillation, not a dump (journal-budget discipline). */
export const CARD_MAX_CHARS = 12000

const INDEX_HEADER =
  "# Knowledge Index\n\n" +
  "Shared reference cards for every entity on this install. One line per card.\n" +
  "Format: slug — title — when to use · proven: N · updated: DATE · cards/<slug>.md\n\n"

export const ensureKnowledgeStore = (): void => {
  fs.mkdirSync(cardsDir(), { recursive: true })
  if (!fs.existsSync(indexPath())) {
    fs.writeFileSync(indexPath(), INDEX_HEADER, "utf-8")
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
export const isValidSlug = (slug: string): boolean => SLUG_RE.test(slug)

export interface IndexCard {
  readonly slug: string
  readonly line: string
}

/** Parse card lines out of INDEX.md content (slug from the cards/ path). */
export const parseIndexCards = (index: string): Array<IndexCard> => {
  const cards: Array<IndexCard> = []
  for (const line of index.split("\n")) {
    const m = /cards\/([a-z0-9][a-z0-9-]*)\.md/.exec(line)
    if (m !== null && line.trimStart().startsWith("-")) {
      cards.push({ slug: m[1]!, line: line.trim() })
    }
  }
  return cards
}

export const readKnowledgeIndex = (): string | null => {
  try {
    return fs.readFileSync(indexPath(), "utf-8")
  } catch {
    return null
  }
}

export const listCards = (): Array<IndexCard> => {
  const index = readKnowledgeIndex()
  return index === null ? [] : parseIndexCards(index)
}

export const cardPath = (slug: string): string => path.join(cardsDir(), `${slug}.md`)

export const readCard = (slug: string): string | null => {
  if (!isValidSlug(slug)) return null
  try {
    return fs.readFileSync(cardPath(slug), "utf-8")
  } catch {
    return null
  }
}

const indexLineFor = (
  slug: string,
  title: string,
  whenToUse: string,
  proven: number,
  date: string
): string => `- ${slug} — ${title} — ${whenToUse} · proven: ${proven} · updated: ${date} · cards/${slug}.md`

/**
 * Write (create or replace) a reference card and upsert its INDEX line.
 * Throws on invalid slug or over-budget content — the failure is the
 * message she acts on ("distill first"), same discipline as the journal.
 */
export const writeCard = (args: {
  slug: string
  title: string
  whenToUse: string
  content: string
}): { slug: string; chars: number } => {
  const { slug, title, whenToUse, content } = args
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid card slug "${slug}" — use lowercase letters, digits, and dashes (e.g. "mermaid-flowchart").`)
  }
  if (content.trim() === "") throw new Error("Card content is empty.")
  if (content.length > CARD_MAX_CHARS) {
    throw new Error(
      `Card is ${content.length} chars — over the ${CARD_MAX_CHARS}-char budget. A card is a DISTILLATION: keep the header (class, version, sources), the gotchas, proven patterns, and one or two minimal examples. Cut the rest and write again.`
    )
  }
  ensureKnowledgeStore()
  fs.writeFileSync(cardPath(slug), content.endsWith("\n") ? content : content + "\n", "utf-8")
  const date = new Date().toISOString().slice(0, 10)
  const index = readKnowledgeIndex() ?? INDEX_HEADER
  const cards = parseIndexCards(index)
  const existing = cards.find((c) => c.slug === slug)
  const provenMatch = existing !== undefined ? /proven: (\d+)/.exec(existing.line) : null
  const proven = provenMatch !== null && provenMatch !== undefined ? Number(provenMatch[1]) : 0
  const line = indexLineFor(slug, title, whenToUse, proven, date)
  const lines = index.split("\n")
  const at = lines.findIndex((l) => l.includes(`cards/${slug}.md`))
  if (at >= 0) lines[at] = line
  else lines.push(line)
  fs.writeFileSync(indexPath(), lines.join("\n"), "utf-8")
  console.log(`[aimy] knowledge: card written slug=${slug} chars=${content.length} proven=${proven}`)
  return { slug, chars: content.length }
}

// ── Track record (Phase 3) ──────────────────────────────────────────

export type TrackKind = "attempt" | "pass" | "fail" | "correction"

export interface TrackEvent {
  readonly at: string
  readonly cls: string
  readonly kind: TrackKind
  readonly detail?: string
}

export const appendTrackRecord = (cls: string, kind: TrackKind, detail?: string): void => {
  try {
    ensureKnowledgeStore()
    const event: TrackEvent = {
      at: new Date().toISOString(),
      cls,
      kind,
      ...(detail !== undefined ? { detail } : {}),
    }
    fs.appendFileSync(trackRecordPath(), JSON.stringify(event) + "\n", "utf-8")
    // Learning timeline mirror (2026-10-13): the track record is
    // the loop's private ledger; the timeline is where he SEES it.
    // Attempts and verdicts map onto the verification trio;
    // corrections stay track-record-only (no honest timeline type).
    if (kind === "attempt") {
      appendLearningEvent({
        type: "verification.started",
        provenance: { origin: "verification-arm", sessionId: "agent-loop", profileId: "default" },
        subject: cls,
        payload: { judgeIds: [cls] },
      })
    } else if (kind === "pass") {
      appendLearningEvent({
        type: "verification.passed",
        provenance: { origin: "verification-arm", sessionId: "agent-loop", profileId: "default" },
        subject: cls,
        payload: { verdictIds: [] },
      })
    } else if (kind === "fail") {
      appendLearningEvent({
        type: "verification.failed",
        provenance: { origin: "verification-arm", sessionId: "agent-loop", profileId: "default" },
        subject: cls,
        payload: { verdictIds: [], reasons: detail !== undefined ? [detail] : [] },
      })
    }
  } catch (e) {
    console.warn(`[diag] knowledge: track record append failed (${e instanceof Error ? e.message : String(e)})`)
  }
}

export const readTrackRecord = (): Array<TrackEvent> => {
  try {
    const raw = fs.readFileSync(trackRecordPath(), "utf-8")
    const events: Array<TrackEvent> = []
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue
      try {
        const parsed = JSON.parse(line) as TrackEvent
        if (typeof parsed.cls === "string" && typeof parsed.kind === "string") events.push(parsed)
      } catch {
        // Skip malformed lines — the ledger is append-only and best-effort.
      }
    }
    return events
  } catch {
    return []
  }
}

export interface ClassSummary {
  readonly attempts: number
  readonly passes: number
  readonly fails: number
  readonly corrections: number
  readonly lastAt: string | null
}

export const summarizeTrackRecord = (
  events: ReadonlyArray<TrackEvent>
): Record<string, ClassSummary> => {
  const out: Record<string, { attempts: number; passes: number; fails: number; corrections: number; lastAt: string | null }> = {}
  for (const e of events) {
    const s = out[e.cls] ?? { attempts: 0, passes: 0, fails: 0, corrections: 0, lastAt: null }
    if (e.kind === "attempt") s.attempts++
    else if (e.kind === "pass") s.passes++
    else if (e.kind === "fail") s.fails++
    else if (e.kind === "correction") s.corrections++
    s.lastAt = e.at
    out[e.cls] = s
  }
  return out
}

/**
 * The research-first decision (design §5.3), as a pure function so it
 * can be tested and tuned. Returns what to inject for an active class:
 * a notice (facts + direction), a silent card load, or nothing once
 * the record is sustained.
 */
export const knowledgeInjection = (args: {
  cls: string
  card: { slug: string; content: string } | null
  summary: ClassSummary | undefined
  versionNote: string
}): { notice: string | null; cardContent: string | null } => {
  const { cls, card, summary, versionNote } = args
  const attempts = summary?.attempts ?? 0
  const passes = summary?.passes ?? 0
  const fails = summary?.fails ?? 0
  const corrections = summary?.corrections ?? 0
  const recordLine =
    `Track record for ${cls}: ${attempts} attempt(s), ${passes} validator pass(es), ${fails} failure(s)` +
    (corrections > 0 ? `, ${corrections} correction(s)` : "") + "."
  // Sustained competence: scaffolding retires (design principle 5).
  if (card !== null && passes >= 8 && fails === 0) {
    return { notice: null, cardContent: null }
  }
  // Strong record: card rides silently, no lecture.
  if (card !== null && passes >= 3 && fails <= Math.max(1, Math.floor(passes / 4))) {
    return { notice: null, cardContent: card.content }
  }
  // Otherwise: research first. Facts stated plainly, card included if
  // one exists (partial knowledge beats none, labeled as unproven).
  const notice =
    `## REFERENCE CHECK — ${cls}\n` +
    (card === null
      ? `No reference card exists for ${cls} yet. `
      : `A reference card exists for ${cls} (${card.slug}) but your record with it is not yet proven. `) +
    recordLine +
    ` ${versionNote} Before writing ${cls} content: research the exact version with retrieval.query (official documentation first), then DISTILL what you learn into a card with knowledge.write (header with version + sources, gotchas, proven patterns only once validated, minimal examples) — or update the existing card. Then do the task with the card as your reference. Patterns enter the card's Proven section only after a validator pass or Kimler's acceptance.`
  return { notice, cardContent: card !== null ? card.content : null }
}
