/**
 * comms/index.ts — public surface of the comms library (M7, Track 3).
 *
 * - `types.ts`: Banner, BannerSource, NewBanner, BannerEvent, BannerLogRecord, filters.
 * - `errors.ts`: the CommsError typed-error union.
 * - `capability.ts`: TrustedBroadcastCapability (type only — NOT constructible).
 * - `store.ts`: append-only log backends (file + in-memory).
 * - `service.ts`: CommsBanner tag + shape, CommsBannerLive / CommsBannerEphemeral layers.
 */
export * from "./types.js"
export * from "./errors.js"
export * from "./capability.js"
export * from "./store.js"
export * from "./service.js"
