/**
 * web-retrieval/types.ts — the module's public data shapes.
 *
 * The honesty contract lives in these types: a `RetrievalReport` never
 * carries a claim except as a `ReportedClaim` whose `badge` was derived by
 * HonestyService from the evidence actually attached. The UI (or any
 * consumer) renders `badge.status` — it cannot be minted by hand.
 */
import type { ClaimWithBadge } from "../../honesty/src/types.js"

export interface SearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export interface FetchedSource {
  readonly url: string
  readonly title: string
  /** Readable text extracted from the page (see fetcher.extractText limits). */
  readonly text: string
  /**
   * True when `text` is the page's main content (nav/boilerplate removed by
   * the readability pass). False when extraction fell back to full-page
   * text — boilerplate included — because nothing scored as an article.
   * Consumers must not present a `false` source as clean article text.
   */
  readonly mainContent: boolean
}

/** One excerpt backing a claim. `ref` is the source URL; this is what the HonestyService ledger stores as evidence. */
export interface SourceEvidence {
  readonly url: string
  readonly excerpt: string
}

/**
 * A single factual statement the module produced. Claims are explicit
 * records — the module constructs them, never parses them out of prose
 * (honesty M3 scope). A claim with an empty `sources` list is recorded with
 * NO evidence and therefore badges "unverified" structurally.
 */
export interface AnswerClaim {
  readonly text: string
  readonly kind: "factual" | "tool-outcome" | "task-result"
  readonly sources: ReadonlyArray<SourceEvidence>
}

/** What `retrieval()` returns and what the `retrieval.query` tool yields. */
export interface RetrievalReport {
  readonly query: string
  /** Human-readable rendering; each claim is labeled with its badge status. */
  readonly answer: string
  /** Every claim the module made, each paired with its HonestyService-derived badge. */
  readonly claims: ReadonlyArray<ClaimWithBadge>
  /** How many search results were fetched vs. returned by the provider. */
  readonly fetchedCount: number
  readonly resultCount: number
}

export type { ClaimWithBadge }
