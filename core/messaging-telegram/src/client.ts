/**
 * messaging-telegram/client.ts — minimal Telegram Bot API client.
 *
 * Only what the gateway needs: getMe (token validation), getUpdates
 * (long-poll), sendMessage (with 4096-char splitting). HTTP goes through
 * the shared HttpClient seam (mocked in tests — no sockets).
 *
 * The token NEVER appears in errors, logs, or returned data: request URLs
 * embed it (Bot API design), so error paths redact it.
 */
import { Effect } from "effect"
import type { HttpClientShape } from "../../web-retrieval/src/http.js"
import {
  TelegramApiError,
  TelegramAuthError,
  TelegramTransportError,
} from "./errors.js"
import { isApiOk, type ApiResponse, type TelegramMessage, type TelegramUpdate, type TelegramUser } from "./types.js"

export const TELEGRAM_API_BASE = "https://api.telegram.org/bot"
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096
/** Long-poll window per getUpdates call. */
export const GET_UPDATES_TIMEOUT_SECS = 30

export interface TelegramClientDeps {
  readonly http: HttpClientShape
  /** Passed by the caller (wizard reads it from the secret locker). Never logged. */
  readonly token: string
}

const apiUrl = (token: string, method: string): string => `${TELEGRAM_API_BASE}${token}/${method}`

const callApi = <T>(
  deps: TelegramClientDeps,
  method: string,
  params: Record<string, unknown>
): Effect.Effect<T, TelegramApiError | TelegramTransportError> =>
  Effect.flatMap(
    deps.http
      .request({
        url: apiUrl(deps.token, method),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        timeoutMs: (GET_UPDATES_TIMEOUT_SECS + 15) * 1000,
        maxBytes: 512 * 1024,
      })
      .pipe(
        Effect.catch((e) =>
          Effect.fail(
            new TelegramTransportError({
              method,
              reason: e instanceof Error ? e.message : String(e),
            })
          )
        )
      ),
    (res) => parseApiResponse<T>(method, res.status, res.body)
  )

const parseApiResponse = <T>(
  method: string,
  status: number,
  body: string
): Effect.Effect<T, TelegramApiError> => {
  if (status < 200 || status >= 300) {
    return Effect.fail(new TelegramApiError({ method, reason: `HTTP ${status}` }))
  }
  let parsed: ApiResponse<T>
  try {
    parsed = JSON.parse(body) as ApiResponse<T>
  } catch {
    return Effect.fail(new TelegramApiError({ method, reason: "unparseable response JSON" }))
  }
  if (!isApiOk(parsed)) {
    return Effect.fail(
      new TelegramApiError({
        method,
        reason: parsed.description ?? `error_code ${parsed.error_code ?? "?"}`,
      })
    )
  }
  return Effect.succeed(parsed.result)
}

/** Validate the token and return the bot's identity. Throws TelegramAuthError on 401. */
export const getMe = (
  deps: TelegramClientDeps
): Effect.Effect<TelegramUser, TelegramApiError | TelegramTransportError | TelegramAuthError> =>
  callApi<TelegramUser>(deps, "getMe", {}).pipe(
    Effect.catch(
      (
        e: TelegramApiError | TelegramTransportError
      ): Effect.Effect<never, TelegramApiError | TelegramTransportError | TelegramAuthError> =>
        e._tag === "TelegramApiError" && /401|unauthorized/i.test(e.reason)
          ? Effect.fail(new TelegramAuthError({ reason: "token rejected by Telegram (401)" }))
          : Effect.fail(e)
    )
  )

/** Long-poll for updates. `offset` = last seen update_id + 1 (0 for first call). */
export const getUpdates = (
  deps: TelegramClientDeps,
  offset: number
): Effect.Effect<ReadonlyArray<TelegramUpdate>, TelegramApiError | TelegramTransportError> =>
  callApi<ReadonlyArray<TelegramUpdate>>(deps, "getUpdates", {
    offset,
    timeout: GET_UPDATES_TIMEOUT_SECS,
    allowed_updates: ["message"],
  })

/**
 * Split text into Telegram-sized chunks, preferring paragraph then sentence
 * boundaries. Pure. A single over-long word is hard-split (never dropped).
 */
export const splitMessage = (text: string): ReadonlyArray<string> => {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return [text]
  const chunks: Array<string> = []
  let rest = text
  while (rest.length > TELEGRAM_MAX_MESSAGE_CHARS) {
    const window = rest.slice(0, TELEGRAM_MAX_MESSAGE_CHARS)
    let cut = window.lastIndexOf("\n\n")
    if (cut < TELEGRAM_MAX_MESSAGE_CHARS / 2) cut = window.lastIndexOf(". ")
    if (cut < TELEGRAM_MAX_MESSAGE_CHARS / 2) cut = window.lastIndexOf("\n")
    if (cut < TELEGRAM_MAX_MESSAGE_CHARS / 2) cut = window.lastIndexOf(" ")
    if (cut <= 0) cut = TELEGRAM_MAX_MESSAGE_CHARS
    else if (rest[cut] === " ") cut += 1
    else if (rest.slice(cut, cut + 2) === ". ") cut += 2
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Send a text message, splitting over-long texts. */
export const sendMessage = (
  deps: TelegramClientDeps,
  chatId: string,
  text: string
): Effect.Effect<void, TelegramApiError | TelegramTransportError> =>
  Effect.gen(function* () {
    for (const chunk of splitMessage(text)) {
      yield* callApi<unknown>(deps, "sendMessage", { chat_id: chatId, text: chunk })
    }
  })

/** Extract a text inbound message from an update, if it is one. Pure. */
export const textMessageOf = (
  update: TelegramUpdate
): { chatId: string; text: string; displayName?: string } | undefined => {
  const m: TelegramMessage | undefined = update.message
  if (m === undefined || typeof m.text !== "string" || m.text.trim() === "") return undefined
  const displayName = m.from?.first_name ?? m.chat.first_name
  return displayName === undefined
    ? { chatId: String(m.chat.id), text: m.text }
    : { chatId: String(m.chat.id), text: m.text, displayName }
}
