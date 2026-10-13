/**
 * deep-research/corroborate.ts — Stage: Corroborate (charter §3.5; E6/E7).
 *
 * Candidate pairs come from a Jaccard pre-filter over claim tokens — the
 * model adjudicates ONLY plausible pairs (context-scale: pair batches of
 * 8, never the whole corpus). Adjudication relations:
 * - "same": the claims assert the same fact → one cluster.
 * - "contradicts": the claims cannot both be true → the clusters link as
 *   contested. Contradictions attach and are presented both-sides; they
 *   never veto (E6: silence is not consensus, and neither is dispute).
 * - "different": unrelated or merely adjacent → no link.
 *
 * A cluster is corroborated with >= 2 distinct hosts (E6/E7: syndicated
 * copies on one host count once). Adjudication failure degrades
 * conservatively: unadjudicated pairs count as "different" — claims
 * never merge on a guess.
 */
import { Effect } from "effect"
import type { PlanModel } from "./planner.js"
import type { ClaimCluster, JudgedClaim } from "./types.js"

export const CORROBORATE_PROMPT_VERSION = "corroborate/v1"

export type PairRelation = "same" | "contradicts" | "different"

export interface ClaimPair {
  readonly a: number
  readonly b: number
  readonly similarity: number
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "were",
  "it", "its", "that", "this", "with", "by", "at", "as", "be", "has", "have", "from"
])

/** Token set for similarity: lowercase alphanumeric words, stopwords removed. */
export const tokenize = (text: string): Set<string> => {
  const out = new Set<string>()
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length > 2 && !STOPWORDS.has(tok)) out.add(tok)
  }
  return out
}

/** Jaccard similarity of two token sets (0 when either is empty). */
export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

export const PAIR_THRESHOLD = 0.3

/**
 * All claim-index pairs worth adjudicating. Two gates:
 * 1. Jaccard similarity clears the threshold (same-fact candidates).
 * 2. The numeric-dispute gate: both claims carry a number (a year, a
 *    figure) and share >= 2 topic tokens. Contradictions live exactly
 *    there — same topic, different number — and their raw Jaccard is
 *    often low because the decisive tokens differ. Missing one means a
 *    dispute never surfaces, which the charter forbids (E6).
 */
export const candidatePairs = (
  claims: ReadonlyArray<JudgedClaim>,
  threshold: number = PAIR_THRESHOLD
): ClaimPair[] => {
  const sets = claims.map((c) => tokenize(c.text))
  const pairs: ClaimPair[] = []
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const sim = jaccard(sets[i]!, sets[j]!)
      if (sim >= threshold) {
        pairs.push({ a: i, b: j, similarity: sim })
        continue
      }
      const a = sets[i]!
      const b = sets[j]!
      const aNumeric = [...a].some((t) => /^\d+$/.test(t))
      const bNumeric = [...b].some((t) => /^\d+$/.test(t))
      if (aNumeric && bNumeric) {
        let sharedTopic = 0
        for (const t of a) if (!/^\d+$/.test(t) && b.has(t)) sharedTopic += 1
        if (sharedTopic >= 2) pairs.push({ a: i, b: j, similarity: sim })
      }
    }
  }
  return pairs
}

const SYSTEM_PROMPT = `You compare pairs of factual claims from a research run. For each pair, decide the relation:
- "same": both claims assert the same fact (wording may differ).
- "contradicts": the claims cannot both be true (they disagree on a number, date, direction, or conclusion).
- "different": anything else — adjacent topics, one claim broader than the other, different facts.

Return ONLY valid JSON: {"pairs": [{"a": 0, "b": 1, "relation": "same"}]}
Use the exact a/b indexes given. No prose outside the JSON. No markdown fences.`

/**
 * Adjudicate candidate pairs with the model, batched. Returns a relation
 * map keyed "a:b"; pairs the model didn't answer (or on model failure)
 * are absent — the caller treats absence as "different" (no merge on a
 * guess). `degraded` counts batches that failed.
 */
export const adjudicatePairs = (
  model: PlanModel,
  query: string,
  claims: ReadonlyArray<JudgedClaim>,
  pairs: ReadonlyArray<ClaimPair>
): Effect.Effect<{ relations: Map<string, PairRelation>; degraded: number }, never> =>
  Effect.gen(function* () {
    const relations = new Map<string, PairRelation>()
    let degraded = 0
    const BATCH = 8
    for (let i = 0; i < pairs.length; i += BATCH) {
      const batch = pairs.slice(i, i + BATCH)
      const listing = batch
        .map((p) => `Pair a=${p.a} b=${p.b}:\n  A: ${claims[p.a]!.text}\n  B: ${claims[p.b]!.text}`)
        .join("\n")
      const raw = yield* model
        .generateText(SYSTEM_PROMPT, `Research question: ${query}\n\n${listing}`)
        .pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)))
      if (raw === undefined) {
        degraded += 1
        continue
      }
      try {
        const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
        const parsed = JSON.parse(cleaned) as { pairs?: unknown }
        if (!Array.isArray(parsed.pairs)) {
          degraded += 1
          continue
        }
        for (const entry of parsed.pairs) {
          if (typeof entry !== "object" || entry === null) continue
          const e = entry as Record<string, unknown>
          const a = e["a"]
          const b = e["b"]
          const rel = e["relation"]
          if (typeof a !== "number" || typeof b !== "number") continue
          if (rel !== "same" && rel !== "contradicts" && rel !== "different") continue
          // Only accept relations for pairs actually in this batch.
          if (!batch.some((p) => p.a === a && p.b === b)) continue
          relations.set(`${a}:${b}`, rel)
        }
      } catch {
        degraded += 1
      }
    }
    return { relations, degraded }
  })

/**
 * Build clusters: union-find over "same" relations; "contradicts"
 * relations link clusters as contested (both directions recorded).
 * Pure — no model, no I/O.
 */
export const buildClusters = (
  claims: ReadonlyArray<JudgedClaim>,
  relations: Map<string, PairRelation>
): ClaimCluster[] => {
  const parent = claims.map((_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]!
    let cur = x
    while (parent[cur] !== root) {
      const next = parent[cur]!
      parent[cur] = root
      cur = next
    }
    return root
  }
  // Identical claim texts are the same claim — the honesty ledger is
  // idempotent by claim fingerprint (over the claim text), so two
  // judged entries with the same normalized text are one claim with
  // several evidence records. Merge them deterministically, before
  // (and regardless of) model adjudication: without this, a failed
  // adjudicator leaves duplicate clusters for a single claim.
  const firstByText = new Map<string, number>()
  claims.forEach((c, i) => {
    const key = c.text.trim().toLowerCase().replace(/\s+/g, " ")
    const first = firstByText.get(key)
    if (first === undefined) {
      firstByText.set(key, i)
    } else {
      const ra = find(first)
      const rb = find(i)
      if (ra !== rb) parent[ra] = rb
    }
  })
  const contradictions: Array<[number, number]> = []
  for (const [key, rel] of relations) {
    const [a, b] = key.split(":").map(Number) as [number, number]
    if (rel === "same") {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent[ra] = rb
    } else if (rel === "contradicts") {
      contradictions.push([a, b])
    }
  }
  const groups = new Map<number, number[]>()
  claims.forEach((_, i) => {
    const root = find(i)
    const group = groups.get(root) ?? []
    group.push(i)
    groups.set(root, group)
  })
  const clusterIdOf = new Map<number, string>()
  const clusters: ClaimCluster[] = []
  let n = 0
  for (const [, idxs] of groups) {
    n += 1
    const id = `cluster-${n}`
    for (const i of idxs) clusterIdOf.set(i, id)
    const members = idxs.map((i) => claims[i]!)
    const hosts = [...new Set(members.map((m) => m.sourceHost))]
    clusters.push({
      id,
      text: members[0]!.text,
      claimCount: members.length,
      hosts,
      evidence: members.map((m) => ({ url: m.sourceUrl, excerpt: m.excerpt })),
      corroborated: hosts.length >= 2,
      contested: false,
      contradictedBy: [],
      subQuestionIndexes: [...new Set(members.map((m) => m.subQuestionIndex))]
    })
  }
  const links = new Map<string, Set<string>>()
  for (const [a, b] of contradictions) {
    const ca = clusterIdOf.get(a)
    const cb = clusterIdOf.get(b)
    if (ca === undefined || cb === undefined || ca === cb) continue
    for (const [from, to] of [[ca, cb], [cb, ca]] as const) {
      const set = links.get(from) ?? new Set<string>()
      set.add(to)
      links.set(from, set)
    }
  }
  return clusters.map((c) => {
    const contra = links.get(c.id)
    if (contra === undefined || contra.size === 0) return c
    return { ...c, contested: true, contradictedBy: [...contra] }
  })
}
