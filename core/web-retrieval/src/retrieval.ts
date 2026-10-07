/**
 * web-retrieval/retrieval.ts — the retrieval flow.
 *
 * `retrieval(query)`:
 *   1. search via the configured SearchProvider,
 *   2. fetch the top N results (fetch failures drop that source — a source
 *      that could not be fetched contributes no claim),
 *   3. compose an answer where EVERY factual claim is recorded in
 *      HonestyService via `recordClaim`, and each claim backed by a fetched
 *      source gets `attachEvidence` (kind "source", ref = source URL) —
 *      which structurally badges it "verified".
 *
 * THE HONESTY PILLAR, made visible: any claim the module produces WITHOUT a
 * fetched source (the synthesis paragraph, the coverage statement's
 * interpretation, background framing) is recorded with NO evidence — and
 * HonestyService therefore badges it "unverified". There is no code path in
 * this module that presents an unsourced claim as verified: badges are
 * derived by the service, never minted here.
 *
 * Claim model (explicit records, per the honesty M3 scope — never parsed
 * from prose):
 * - one "source statement" claim per fetched source: "According to <title>
 *   (<url>): <excerpt>" + evidence { kind: "source", ref: url } -> verified
 * - one "coverage" claim: "K of M search results were fetched for '<query>'"
 *   — the module's own bookkeeping statement, recorded with NO evidence
 *   (hence "unverified"); it is labeled, not hidden.
 * - one "synthesis" claim: the module's own synthesis across sources, NO
 *   evidence -> unverified (structurally; this is the point)
 */
import { Effect, Option } from "effect"
import type { HonestyServiceShape } from "../../honesty/src/service.js"
import type { HonestyError } from "../../honesty/src/errors.js"
import type { NewClaim } from "../../honesty/src/types.js"
import { fetchSource } from "./fetcher.js"
import type { HttpClientShape } from "./http.js"
import type { SearchProvider } from "./provider.js"
import type { AnswerClaim, FetchedSource, RetrievalReport, SourceEvidence } from "./types.js"
import type { RetrievalError } from "./errors.js"

export const DEFAULT_MAX_SOURCES = 3
export const EXCERPT_CHARS = 400

export interface RetrievalDeps {
  readonly provider: SearchProvider
  readonly http: HttpClientShape
  readonly honesty: HonestyServiceShape
  readonly maxSources?: number
}

export interface RetrievalInput {
  readonly query: string
  readonly sessionId: string
  readonly turnId: string
  /** Override for maxSources on a single call. */
  readonly maxSources?: number | undefined
}

const excerptOf = (source: FetchedSource): string => {
  const t = source.text.replace(/\s+/g, " ").trim()
  return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS)}…` : t
}

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

const claimFromSource = (source: FetchedSource): AnswerClaim => {
  const title = source.title === "" ? source.url : source.title
  return {
    text: `According to "${title}" (${source.url}): ${excerptOf(source)}`,
    kind: "factual",
    sources: [{ url: source.url, excerpt: excerptOf(source) } satisfies SourceEvidence],
  }
}

const recordOneClaim = (
  honesty: HonestyServiceShape,
  sessionId: string,
  turnId: string,
  claim: AnswerClaim,
): Effect.Effect<{ readonly claimId: string }, HonestyError> =>
  Effect.gen(function* () {
    const newClaim: NewClaim = {
      sessionId,
      turnId,
      text: claim.text,
      kind: claim.kind,
    }
    const record = yield* honesty.recordClaim(newClaim)
    for (const s of claim.sources) {
      yield* honesty.attachEvidence(record.claimId, {
        kind: "source",
        ref: s.url,
        summary: s.excerpt,
      })
    }
    return { claimId: record.claimId }
  })

const renderAnswer = (
  query: string,
  claims: ReadonlyArray<{ readonly text: string; readonly status: string }>,
): string => {
  const lines = claims.map((c) => `[${c.status}] ${c.text}`)
  return [`Retrieval: "${query}"`, "", ...lines].join("\n")
}

/**
 * Run one retrieval pass. Search failures fail the whole pass (typed
 * RetrievalError); fetch failures drop individual sources.
 */
export const retrieval = (deps: RetrievalDeps) => (input: RetrievalInput): Effect.Effect<RetrievalReport, RetrievalError | HonestyError> =>
  Effect.gen(function* () {
    const maxSources = input.maxSources ?? deps.maxSources ?? DEFAULT_MAX_SOURCES
    const results = yield* deps.provider.search(input.query)
    const top = results.slice(0, Math.max(0, maxSources))
    const resultHosts = new Set<string>()
    for (const r of top) {
      const h = hostOf(r.url)
      if (h !== undefined) resultHosts.add(h)
    }

    // Fetch concurrently; a failed fetch drops that source (it contributes no claim).
    const fetched = yield* Effect.forEach(
      top,
      (r) => fetchSource({ http: deps.http }, r.url, resultHosts).pipe(Effect.option),
      { concurrency: 3 },
    )
    const sources: Array<FetchedSource> = []
    for (const o of fetched) {
      if (Option.isSome(o)) sources.push(o.value)
    }

    const claims: Array<AnswerClaim> = []
    for (const s of sources) claims.push(claimFromSource(s))
    claims.push({
      text: `Fetched ${sources.length} of ${results.length} search results for "${input.query}".`,
      kind: "tool-outcome",
      sources: [],
    })
    // Synthesis is the module's own composition across sources — recorded
    // with NO evidence, hence structurally "unverified". This is deliberate:
    // the module never presents its synthesis as verified.
    claims.push({
      text:
        sources.length > 0
          ? `Synthesis across ${sources.length} fetched source(s) for "${input.query}" — see the sourced statements above; this synthesis itself is unverified.`
          : `No sources could be fetched for "${input.query}" — no sourced statements are available.`,
      kind: "factual",
      sources: [],
    })

    const withBadges = yield* Effect.forEach(claims, (c) =>
      Effect.gen(function* () {
        const { claimId } = yield* recordOneClaim(deps.honesty, input.sessionId, input.turnId, c)
        const badge = yield* deps.honesty.getBadge(claimId)
        return { claim: c, badge }
      }),
    )

    const answer = renderAnswer(
      input.query,
      withBadges.map(({ claim, badge }) => ({ text: claim.text, status: badge.status })),
    )

    // Read the report's claims back from the ledger — the ClaimWithBadge
    // records are the service's own, never reconstructed by hand.
    const ledgerClaims = yield* deps.honesty.claimsForTurn(input.sessionId, input.turnId)

    return {
      query: input.query,
      answer,
      claims: ledgerClaims,
      fetchedCount: sources.length,
      resultCount: results.length,
    } satisfies RetrievalReport
  })
