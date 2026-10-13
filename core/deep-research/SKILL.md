---
name: deep-research
version: "1.0.0"
description: "Investigated multi-source research for AImy: plan, polite multi-query fan-out, per-source ledger claims. Orchestrates web-retrieval; no API key required."
aimy:
  hooks: ["beforeToolCall", "afterToolCall"]
  tools: ["research.query"]
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

# Deep Research

Investigated research for AImy (charter: planning/deep-research-spec.md, ratified with Extension v0.2/v0.3). Orchestrates web-retrieval: the same DuckDuckGo HTML provider and fetch policy, the same honesty ledger.

## Tool: `research.query`

Plans the question into sub-questions (background / evidence / counterpoint / primary-source), runs a polite multi-query fan-out, reads sources within the depth budget, and records every claim through the honesty ledger. Deeper than `retrieval.query`: use it when the question deserves investigation, not just an answer.

**Arguments:** `query` (required), `sessionId` (required), `turnId` (required), `depth` (optional: quick | standard | deep), `output` (optional: answer | paper — paper forces deep), `maxSources` (optional).

**Returns:** `DeepResearchReport` — plan, answer, ledger-backed claims with badges, source counts, termination reason.

## Search Provider

Default: **DuckDuckGo HTML** via web-retrieval — no API key, no account. Egress is exactly web-retrieval's: the declared search host plus fetched result hosts over HTTPS.
