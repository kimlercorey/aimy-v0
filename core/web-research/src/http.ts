/**
 * web-research/http.ts — the injectable HTTP seam.
 *
 * Everything in this module that touches the network goes through
 * `HttpClient`, an Effect service. Production wires `HttpClientLive`
 * (global fetch + AbortController timeout + response-size cap); unit tests
 * wire `makeMockHttpClient`, so no test ever opens a socket.
 *
 * No telemetry, no calls to AImy infrastructure: requests go only to the
 * hosts the capability manifest declares (search host) or that the fetch
 * policy admits (https result hosts returned by the declared provider).
 */
import { Context, Effect, Layer } from "effect"
import { EgressDenied, FetchError, FetchTimeout } from "./errors.js"

export interface HttpRequest {
  readonly url: string
  readonly method: "GET" | "POST"
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  /** Deadline for the whole request. */
  readonly timeoutMs: number
  /** Hard cap on response body bytes; exceeding it is a typed FetchError. */
  readonly maxBytes: number
}

export interface HttpResponse {
  readonly status: number
  readonly contentType: string | undefined
  readonly body: string
}

export interface HttpClientShape {
  readonly request: (req: HttpRequest) => Effect.Effect<HttpResponse, FetchError | FetchTimeout>
}

export class HttpClient extends Context.Service<HttpClient, HttpClientShape>()("aimy/web-research/HttpClient") {}

const readCapped = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
  url: string,
): Promise<string> => {
  if (body === null) return ""
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) throw new Error("aborted")
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new FetchError({ url, reason: `response exceeded ${maxBytes} byte cap` })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged)
}

/** Production implementation: global fetch, hard timeout, hard size cap. */
export const HttpClientLive: Layer.Layer<HttpClient> = Layer.succeed(
  HttpClient,
  HttpClient.of({
    request: (req) =>
      Effect.tryPromise({
        try: async () => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), req.timeoutMs)
          try {
            const init: RequestInit = {
              method: req.method,
              signal: controller.signal,
              redirect: "follow",
              ...(req.headers === undefined ? {} : { headers: req.headers }),
              ...(req.body === undefined ? {} : { body: req.body }),
            }
            const res = await fetch(req.url, init)
            const body = await readCapped(res.body, req.maxBytes, controller.signal, req.url)
            return {
              status: res.status,
              contentType: res.headers.get("content-type") ?? undefined,
              body,
            } satisfies HttpResponse
          } finally {
            clearTimeout(timer)
          }
        },
        catch: (e) => {
          if (e instanceof FetchError) return e
          const msg = e instanceof Error ? e.message : String(e)
          return /abort/i.test(msg)
            ? new FetchTimeout({ url: req.url, timeoutMs: req.timeoutMs })
            : new FetchError({ url: req.url, reason: msg })
        },
      }),
  }),
)

/**
 * Test seam: every request is answered by `handler`. The handler may return
 * a response or fail with FetchError/FetchTimeout — the same typed failures
 * the live client produces.
 */
export const makeMockHttpClient = (
  handler: (req: HttpRequest) => Effect.Effect<HttpResponse, FetchError | FetchTimeout>,
): Layer.Layer<HttpClient> => Layer.succeed(HttpClient, HttpClient.of({ request: handler }))

/**
 * Fail-closed URL gate shared by the fetcher: allow only https URLs whose
 * host was returned by the declared search provider for the current query.
 * Called BEFORE any request is issued — a denial never opens a socket.
 */
export const checkFetchEgress = (
  url: string,
  resultHosts: ReadonlySet<string>,
): Effect.Effect<void, EgressDenied> =>
  Effect.gen(function* () {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return yield* Effect.fail(new EgressDenied({ url, reason: "not a parseable absolute URL" }))
    }
    if (parsed.protocol !== "https:") {
      return yield* Effect.fail(
        new EgressDenied({ url, reason: `scheme '${parsed.protocol}' denied: fetch policy is https-only` }),
      )
    }
    if (!resultHosts.has(parsed.hostname.toLowerCase())) {
      return yield* Effect.fail(
        new EgressDenied({
          url,
          reason: `host '${parsed.hostname}' was not returned by the declared search provider for this query`,
        }),
      )
    }
  })
