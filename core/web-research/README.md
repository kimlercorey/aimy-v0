# @aimy/web-research

M4 Track 2 — the web-research reference domain module. Exercises the full
module seam end to end: hook participation, capability-manifested network
egress, a contributed tool, and the honesty pillar (answers ship with
verification evidence feeding the `HonestyService` ledger).

## Layout

```
web-research/
  SKILL.md            # package: AImy capability manifest + egress policy doc
  README.md           # this file
  src/
    index.ts          # public surface
    errors.ts         # typed failures (no untyped throws across the boundary)
    types.ts          # SearchResult, FetchedSource, AnswerClaim, ResearchReport
    http.ts           # HttpClient Effect service + live/mock impls + egress gate
    provider.ts       # SearchProvider interface + DuckDuckGo HTML default
    fetcher.ts        # fetch (egress-checked) + honest text extractor
    research.ts       # research() flow wiring HonestyService
    tools.ts          # research.query tool + beforeToolCall/afterToolCall hooks
  test/
    fixtures.ts       # DuckDuckGo HTML + source-page fixtures (no live network)
    provider.test.ts  # parsing, unwrapping, malformed responses
    fetcher.test.ts   # extraction, egress policy, typed fetch failures
    research.test.ts  # claim/evidence recording, badge derivation
    manifest.test.ts  # SKILL.md parses; manifest declares exactly the egress used
```

## Honesty contract

`research(query)` records **every** claim it makes in `HonestyService`:

| claim | evidence | badge |
|---|---|---|
| per-source statement ("According to X …") | `kind: "source"`, `ref` = URL | `verified` |
| coverage ("Fetched K of M …") | none | `unverified` |
| synthesis across sources | none | `unverified` |

Badges are derived by the service (`failed` > `verified` > `unverified`);
this module cannot mint one. An unsourced claim can therefore never be
presented as verified — structurally, not by prompt.

## Egress design decision

Static allowlist (`network.vendorHosts`) enumerates what can be enumerated:
`html.duckduckgo.com`. Result URLs are runtime-determined, so they are
governed by the declared fetch policy — **https-only, host must be a
search-result host for the current query** — enforced by `checkFetchEgress`
before any socket opens. See SKILL.md "Egress policy".

## Running

From `~/workspace/aimy/core`:

```sh
npx tsc -b --force   # clean compile
npx vitest run web-research
```

Unit tests never touch the network: the HTTP layer is injected
(`makeMockHttpClient`) and the provider parser is pure over fixtures.

## Demo

`DEMO.md` is a real transcript of the M4 Track 3 acceptance demo: the chat
harness's `research <query>` command against the **live** DuckDuckGo endpoint
(the only place live network is used), including a true mid-run
`/research-off` — the in-flight research completes but its trailing
`afterToolCall` hook never fires (counter-proven), the runtime registry
empties, and a research while disabled fails with a clean typed
`ModuleError`.
