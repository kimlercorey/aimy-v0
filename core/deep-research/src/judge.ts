/**
 * deep-research/judge.ts — Stage: Judge (charter §3.4; Extension E5/E7).
 *
 * Per fetched source, the model scores relevance to its sub-question
 * (0 = off-topic, 1 = background-useful, 2 = directly answers) and
 * extracts ATOMIC claims, each with a VERBATIM excerpt (<= 400 chars)
 * copied exactly from the source text. The excerpt is the evidence, so
 * the verbatim rule is enforced in code: an excerpt that does not appear
 * in the source (whitespace-insensitive) is fabricated — the claim is
 * dropped and counted, never trusted.
 *
 * Long sources are judged chunk by chunk (context-scale, E14): the model
 * never sees more than one ~6000-char chunk per call.
 *
 * Degradation (E5): a model failure or malformed output never fails the
 * run and never silently passes — the source is marked degraded and the
 * caller falls back to the Phase-1 mechanical claim for it.
 */
import { Effect } from "effect"
import type { PlanModel } from "./planner.js"
import type { JudgedClaim, SubQuestion } from "./types.js"

export const JUDGE_PROMPT_VERSION = "judge/v1"

export const JUDGE_CHUNK_CHARS = 6000
const MAX_CLAIMS_PER_SOURCE = 6
const EXCERPT_MAX = 400

const SYSTEM_PROMPT = `You are a research judge. Given a research sub-question and an excerpt of a source, score how relevant the source is and extract its atomic factual claims.

Return ONLY valid JSON in exactly this shape:
{"relevance": 0, "claims": [{"text": "...", "excerpt": "..."}]}

Rules:
- "relevance": 0 = off-topic for the sub-question; 1 = useful background; 2 = directly answers the sub-question.
- Each claim is ONE atomic fact, stated plainly in your own words as a standalone sentence.
- "excerpt" must be copied EXACTLY, word for word, from the source text below — it is the evidence for the claim. At most 400 characters. If you cannot quote it exactly, do not include the claim.
- Extract at most 6 claims. Prefer specific facts (numbers, dates, names, findings) over generalities.
- No prose outside the JSON. No markdown fences.`

export interface JudgedSource {
  readonly url: string
  readonly title: string
  readonly host: string
  readonly relevance: 0 | 1 | 2
  readonly claims: ReadonlyArray<JudgedClaim>
  /** True when the model path failed and the caller must use the mechanical fallback. */
  readonly degraded: boolean
  /** Claims dropped because their excerpt was not verbatim in the source. */
  readonly droppedNonVerbatim: number
}

const normalizeWs = (s: string): string => s.replace(/\s+/g, " ").trim()

/** Split source text into judge-sized chunks on paragraph boundaries where possible. */
export const chunkText = (text: string, maxChars: number = JUDGE_CHUNK_CHARS): string[] => {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "))
    const cut = breakAt > maxChars * 0.4 ? breakAt + 1 : maxChars
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim() !== "") chunks.push(rest)
  return chunks
}

interface RawJudgement {
  readonly relevance: 0 | 1 | 2
  readonly claims: ReadonlyArray<{ text: string; excerpt: string }>
}

const parseJudgement = (raw: string): RawJudgement | undefined => {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const o = parsed as Record<string, unknown>
  const rel = o["relevance"]
  if (rel !== 0 && rel !== 1 && rel !== 2) return undefined
  if (!Array.isArray(o["claims"])) return undefined
  const claims: Array<{ text: string; excerpt: string }> = []
  for (const c of o["claims"]) {
    if (typeof c !== "object" || c === null) return undefined
    const co = c as Record<string, unknown>
    if (typeof co["text"] !== "string" || typeof co["excerpt"] !== "string") return undefined
    claims.push({ text: co["text"], excerpt: co["excerpt"] })
  }
  return { relevance: rel, claims }
}

/**
 * Judge one fetched source against its sub-question. Never fails: model
 * or parse failure returns degraded=true with no claims.
 */
export const judgeSource = (
  model: PlanModel,
  subQuestion: SubQuestion,
  subQuestionIndex: number,
  source: { url: string; title: string; host: string; text: string }
): Effect.Effect<JudgedSource, never> =>
  Effect.gen(function* () {
    const chunks = chunkText(source.text)
    let relevance: 0 | 1 | 2 = 0
    let droppedNonVerbatim = 0
    const byText = new Map<string, JudgedClaim>()
    for (const chunk of chunks) {
      const raw = yield* model
        .generateText(
          SYSTEM_PROMPT,
          `Sub-question (${subQuestion.intent}): ${subQuestion.question}\nSource: ${source.title} (${source.url})\n\n${chunk}`
        )
        .pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)))
      if (raw === undefined) {
        return { url: source.url, title: source.title, host: source.host, relevance: 0, claims: [], degraded: true, droppedNonVerbatim }
      }
      const judged = parseJudgement(raw)
      if (judged === undefined) {
        return { url: source.url, title: source.title, host: source.host, relevance: 0, claims: [], degraded: true, droppedNonVerbatim }
      }
      if (judged.relevance > relevance) relevance = judged.relevance
      const normalizedChunk = normalizeWs(chunk)
      for (const c of judged.claims) {
        const text = c.text.trim()
        const excerpt = c.excerpt.trim().slice(0, EXCERPT_MAX)
        if (text === "" || excerpt === "") continue
        // The verbatim rule (E7): the excerpt must be in the source.
        if (!normalizedChunk.includes(normalizeWs(excerpt))) {
          droppedNonVerbatim += 1
          continue
        }
        const key = normalizeWs(text).toLowerCase()
        if (!byText.has(key)) {
          byText.set(key, {
            text,
            excerpt,
            sourceUrl: source.url,
            sourceHost: source.host,
            subQuestionIndex,
            intent: subQuestion.intent
          })
        }
        if (byText.size >= MAX_CLAIMS_PER_SOURCE) break
      }
      if (byText.size >= MAX_CLAIMS_PER_SOURCE) break
    }
    return {
      url: source.url,
      title: source.title,
      host: source.host,
      relevance,
      claims: [...byText.values()],
      degraded: false,
      droppedNonVerbatim
    }
  })
