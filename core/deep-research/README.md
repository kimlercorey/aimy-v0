# @aimy/deep-research

Planned, multi-query research over `web-retrieval`. Spec: `planning/deep-research-spec.md`.

**Phase 1 (current):** the local model decomposes the question into sub-questions
(background / evidence / counterpoint / primary-source); each becomes a polite
DDG search (≥1200ms apart, budget-capped); deduped results are fetched with the
readability pass; every fetched source becomes one "according to …" claim with
evidence attached (→ verified), plus an honest coverage claim with no evidence
(→ unverified, labeled).

**Not yet:** judge, corroboration, gap loop, synthesis, visuals (Phases 2–4).

```
deep-research/
  src/
    types.ts      # ResearchQueryArgs, SubQuestion, ResearchPlan, DeepResearchReport, budgets
    errors.ts     # PlanError, MalformedPlan, FanOutSearchError, ReadError, InvalidResearchArgs
    planner.ts    # versioned planning prompt, JSON parse/validate, honest fallback
    fanout.ts     # polite multi-query search, URL normalize/dedupe
    research.ts   # single-round flow wiring web-retrieval fetch + HonestyService
  test/
    planner.test.ts   # parse contract, fallback behavior
    fanout.test.ts    # purity + politeness timing
    research.test.ts  # golden flow: stubbed model/provider, mocked HTTP, real honesty ledger
```

Failure contract: the planner failing never fails the run (fallback plan,
logged); per-search and per-fetch failures are recorded in the coverage claim,
never silent; empty results produce an honest "no sources found" report.
