/**
 * messaging-telegram/types.ts — Telegram Bot API shapes (subset we use).
 *
 * Reference: https://core.telegram.org/bots/api. We model only what the
 * gateway needs: getMe, getUpdates (messages), sendMessage. Unknown fields
 * are ignored — the API adds fields without warning.
 */
export interface TelegramUser {
  readonly id: number
  readonly is_bot: boolean
  readonly first_name: string
  readonly username?: string
}

export interface TelegramChat {
  readonly id: number
  readonly type: string
  readonly first_name?: string
}

export interface TelegramMessage {
  readonly message_id: number
  readonly chat: TelegramChat
  readonly from?: { readonly first_name?: string }
  readonly date: number
  readonly text?: string
}

export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
}

interface ApiOk<T> {
  readonly ok: true
  readonly result: T
}

interface ApiErr {
  readonly ok: false
  readonly description?: string
  readonly error_code?: number
}

export type ApiResponse<T> = ApiOk<T> | ApiErr

export const isApiOk = <T>(r: ApiResponse<T>): r is ApiOk<T> => r.ok === true
