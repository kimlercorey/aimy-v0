---
name: web-retrieval
version: 1.0.0
description: Web retrieval reference module — sourced answers with per-claim verification badges from the HonestyService ledger.
author: AImy project
license: MIT
aimy:
  hooks: [beforeToolCall, afterToolCall]
  tools: [retrieval.query]
  filesystem:
    read: []
    write: []
  network:
    vendorHosts: [html.duckduckgo.com]
  memory:
    stores: []
    write: false
  subprocess: false
---

# web-retrieval

Reference domain module for M4 (Track 2). Retrievales a query on the public
web and returns an answer where **every factual claim carries a verification
badge** derived by `HonestyService`:

- a claim backed by a fetched source → evidence attached (`kind: "source"`,
  `ref` = source URL) → badge **verified**
- a claim with no fetched source (synthesis, background framing) → recorded
  with **no evidence** → badge **unverified**, structurally

The module never presents an unsourced claim as verified: badges are pure
derived data in the honesty service; this module has no badge constructor.

## Tool: `retrieval.query`

Arguments: `{ query, sessionId, turnId, maxSources? }` (`maxSources` 1–10,
default 3). Returns a `RetrievalReport`: `{ query, answer, claims, fetchedCount,
resultCount }`. `answer` renders each claim labeled `[verified]` /
`[unverified]` / `[failed]`.

## Hook participation

- `beforeToolCall` — fail-fast validation of `retrieval.query` arguments
  (empty query, out-of-range `maxSources`, missing ledger scope). Deny blocks
  the call; it never terminates the turn.
- `afterToolCall` — pass-through. Outcomes are ledger-backed by construction
  (the retrieval flow records every claim before returning); this hook is the
  documented extension point where a future verification arm attaches judge
  verdicts.

## Egress policy (design decision)

The capability manifest above allowlists exactly one static host:
`html.duckduckgo.com` — the declared search provider's host. Fetched result
URLs are **runtime-determined** (they come from search results) and cannot be
enumerated at install time, so they are governed by a declared, enforced
fetch policy rather than the static host list:

- **fetch policy: https-only, result-hosts-only** — the fetcher allows an
  `https://` URL only when its host was returned by the declared search
  provider for the current query; plain `http:` and foreign hosts are denied
  with a typed `EgressDenied` **before any socket opens**.
- Manifest schema validation stays fail-closed: `vendorHosts` keeps its
  hostname format check, and no wildcard or policy keys are smuggled into
  the frontmatter. (A future schema revision could promote `fetchPolicy` to
  a first-class manifest key; until then it lives here, documented, and is
  enforced in code by `checkFetchEgress`.)

Filesystem: none. Subprocess: denied. Memory: none — claims live in the
`HonestyService` ledger via the host, not in module-scoped stores.

## Limits (honest, by design)

- The default search provider scrapes the DuckDuckGo HTML endpoint; markup
  changes or rate-limiting surface as typed errors (`MalformedSearchResponse`,
  `SearchError`), never silent empty results. The provider is behind the
  `SearchProvider` interface — swap it without touching the retrieval flow.
- Text extraction is a simple tag-stripper, not a readability port: nav and
  boilerplate are included, JS-rendered pages yield little.
- No telemetry, no calls to AImy infrastructure.
