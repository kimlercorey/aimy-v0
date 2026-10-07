/**
 * streaming.ts — the loop's streaming adapter.
 *
 * `InferencePool.generate` has no streaming surface, and pool.ts is not
 * ours to change. So the loop resolves live token streaming itself: the
 * wiring step passes the same provider objects it registered with the pool,
 * and this adapter streams from the first one that offers `Provider.stream`.
 *
 * When no provider offers streaming, the adapter returns `undefined` and
 * the loop falls back to `pool.generate` (one `Token` chunk with the full
 * text). In M1 the powerhouse is a single local provider, so "first
 * stream-capable provider" is exact; matching the stream to the pool's
 * active powerhouse provider across multi-provider chains is an extension
 * point.
 */
import { Stream } from "effect"
import type { InferenceError } from "../../inference-pool/index.js"
import type { GenerateRequest, Provider } from "../../inference-pool/index.js"

/**
 * Resolve a live delta stream for `request`, or `undefined` when no
 * handed-in provider offers `stream`.
 */
export const makeStreamSource =
  (providers: ReadonlyArray<Provider>) =>
  (request: GenerateRequest): Stream.Stream<string, InferenceError> | undefined => {
    const streaming = providers.find((p) => p.stream !== undefined)
    if (streaming?.stream === undefined) return undefined
    return streaming.stream(request).pipe(Stream.map((token) => token.delta))
  }
