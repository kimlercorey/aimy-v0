/**
 * web-retrieval/errors.ts — typed failures for the web-retrieval module.
 *
 * Every failure the module can produce is a tagged error: no untyped throws
 * cross the module boundary (architecture §1.4 — boundary functions return
 * typed errors, never throw). Network failures, malformed provider responses,
 * egress-policy denials, and timeouts are distinct tags so callers (and
 * executable judges) can distinguish "the network failed" from "the provider
 * answered garbage" from "the manifest forbids this fetch".
 */
import { Data } from "effect"

/** The search provider failed (transport error, non-2xx, timeout). */
export class SearchError extends Data.TaggedError("SearchError")<{
  readonly provider: string
  readonly reason: string
}> {}

/**
 * The provider answered but the body was not recognizable search output —
 * neither result markup nor a "no results" marker. Distinct from SearchError:
 * this means our parser no longer understands the provider (brittleness made
 * visible), not that the network failed.
 */
export class MalformedSearchResponse extends Data.TaggedError("MalformedSearchResponse")<{
  readonly provider: string
  readonly reason: string
}> {}

/** Fetching a result URL failed (transport error, non-2xx, wrong content type). */
export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string
  readonly reason: string
}> {}

/** A fetch exceeded its deadline. Separate tag so timeouts are measurable. */
export class FetchTimeout extends Data.TaggedError("FetchTimeout")<{
  readonly url: string
  readonly timeoutMs: number
}> {}

/**
 * The egress policy refused a URL: non-https scheme, or a host that was not
 * among the search-result hosts for this query. Fail-closed by construction —
 * the fetcher checks this BEFORE any socket is opened.
 */
export class EgressDenied extends Data.TaggedError("EgressDenied")<{
  readonly url: string
  readonly reason: string
}> {}

/** retrieval.query was invoked with invalid arguments (empty query, bad maxSources). Fail-fast: no search, no fetch, no ledger write. */
export class InvalidRetrievalArgs extends Data.TaggedError("InvalidRetrievalArgs")<{
  readonly reason: string
}> {}

export type RetrievalError =
  | SearchError
  | MalformedSearchResponse
  | FetchError
  | FetchTimeout
  | EgressDenied
  | InvalidRetrievalArgs
