---
name: web-retrieval
version: "1.0.0"
description: "Local-first web search and content extraction for AImy. No API key required by default."
aimy:
  hooks: ["beforeToolCall", "afterToolCall"]
  tools: ["retrieval.query", "retrieval.news", "retrieval.images", "retrieval.videos"]
  filesystem:
    read: []
    write: []
  network:
    vendorHosts: ["html.duckduckgo.com", "api.search.brave.com"]
  memory:
    stores: []
    write: false
  subprocess: false
---

# Web Retrieval

Local-first web search and content extraction for AImy. No API key required by default.

## Tool: `retrieval.query`

Searches the web, fetches pages, extracts readable content, and records every claim through the honesty ledger.

**Arguments:** `query` (required), `sessionId` (required), `turnId` (required), `maxSources` (optional, default 5, max 10).

**Returns:** `RetrievalReport` with sources and ledger-backed claims.

**Arguments (optional):** `freshness` — recency window `day | week | month | year` (honored by the Brave provider; the DuckDuckGo provider accepts and ignores it); `resultFilter` — Brave result-type filter passthrough.

## Tools: `retrieval.news` / `retrieval.images` / `retrieval.videos`

The Brave Search verticals (2026-10-13). Each takes `query` (required) and `count` (optional, 1–20, default 10); news and videos also take `freshness`. They return compact, attributed result listings — raw results, not ledger claims.

**Key-gated:** these endpoints exist only on the Brave API, so the tools are registered ONLY when a key is configured at ~/.aimy/search.json. Without a key they are absent, never present-but-broken. Brave options outside the Search bundle (LLM Context, Local, Answers, Suggest, Spellcheck) are not part of this module; if a plan lacks an endpoint, Brave's OPTION_NOT_IN_PLAN is surfaced in plain language.

## Search Provider

Chain (2026-10-13): **Brave Search API** primary when a key is configured at ~/.aimy/search.json (`braveApiKey`), **DuckDuckGo HTML** as fallback (and sole provider when no key is configured). Fallback happens on provider failure only, never on an empty result. Also replaceable with SearXNG or an MCP search server via the same SearchProvider seam.
