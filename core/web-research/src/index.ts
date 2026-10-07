/**
 * @aimy/web-research — the M4 Track 2 reference domain module.
 *
 * Web research with the honesty pillar made visible: every factual claim the
 * module produces is recorded in HonestyService; claims backed by a fetched
 * source are structurally "verified", claims without a source are
 * structurally "unverified". The module cannot present an unsourced claim
 * as verified — badges are derived by the service, never minted here.
 *
 * Seams (all replaceable without touching the research flow):
 * - SearchProvider (provider.ts) — default: DuckDuckGo HTML, no API key.
 * - HttpClient (http.ts) — Effect service; mock it in tests, never sockets.
 * - Fetcher policy (http.ts checkFetchEgress) — https-only, result hosts only.
 */
export * from "./errors.js"
export * from "./types.js"
export * from "./http.js"
export * from "./html-text.js"
export * from "./provider.js"
export * from "./fetcher.js"
export * from "./readability.js"
export * from "./research.js"
export * from "./tools.js"
