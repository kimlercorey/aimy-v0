/**
 * @aimy/messaging-telegram — Telegram channel for the messaging gateway.
 *
 * Implements the `Channel` seam from @aimy/messaging: long-polling
 * getUpdates (no webhook, no open ports), sendMessage with 4096-char
 * splitting, getMe for token validation. The token is passed in by the
 * caller (setup wizard reads it from the secret locker) — never persisted
 * or logged here.
 */
export * from "./errors.js"
export * from "./types.js"
export * from "./client.js"
export * from "./channel.js"
export * from "./wizard.js"
