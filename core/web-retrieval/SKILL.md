---
name: web-retrieval
version: "1.0.0"
description: "Local-first web search and content extraction for AImy. No API key required by default."
aimy:
  hooks: ["beforeToolCall", "afterToolCall"]
  tools: ["retrieval.query"]
  filesystem:
    read: []
    write: []
  network:
    vendorHosts: ["html.duckduckgo.com"]
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

## Search Provider

Default: **DuckDuckGo HTML** — no API key, no account. Replaceable with Brave Search API, SearXNG, or MCP search server.
