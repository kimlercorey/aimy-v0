/**
 * @aimy/deep-research — the research module (spec: planning/deep-research-spec.md).
 *
 * Phase 1: planned, multi-query, single-round research over web-retrieval.
 * The planner decomposes the question into sub-questions (background,
 * evidence, counterpoint, primary-source); the fan-out searches each politely;
 * fetched sources become per-source claims in HonestyService.
 *
 * Seams (all replaceable without touching the flow):
 * - PlanModel (planner.ts) — default: local model via InferencePool; stub it in tests.
 * - SearchProvider (web-retrieval) — default: DuckDuckGo HTML, no API key.
 * - HttpClient (web-retrieval) — Effect service; mock it in tests, never sockets.
 */
export * from "./errors.js"
export * from "./types.js"
export * from "./planner.js"
export * from "./fanout.js"
export * from "./research.js"
