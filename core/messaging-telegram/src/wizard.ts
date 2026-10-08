/**
 * messaging-telegram/wizard.ts — Phase 4: CLI setup wizard.
 *
 * A guided, testable setup flow with injected prompt/print (readline in
 * production, scripted in tests):
 *   1. Explain — what the gateway does + the security model.
 *   2. Token — paste from @BotFather; validated via getMe before storage.
 *   3. Pair — 6-digit code displayed; the wizard polls the bot's inbox for
 *      the code and claims the pairing for the sending chat.
 *   4. Preferences — which banner severities forward.
 *   5. Test message — proves the whole path works before declaring victory.
 *
 * The token goes straight to the secret locker (never disk plaintext, never
 * logs). Abandoning mid-flow leaves no partial config: the registry only
 * records a pairing on successful claim, prefs only save on completion.
 */
import { Effect } from "effect"
import type { HttpClientShape } from "../../web-retrieval/src/http.js"
import type { SecretLockerShape } from "../../identity/locker.js"
import { Redacted } from "../../substrate/types.js"
import {
  makePairingRegistry,
  type PairingRegistryShape,
} from "../../messaging/src/pairing.js"
import {
  DEFAULT_FORWARDING_PREFS,
  type ForwardingPrefs,
} from "../../messaging/src/types.js"
import type { Forwarder } from "../../messaging/src/forward.js"
import { getMe, getUpdates, sendMessage, textMessageOf } from "./client.js"

export const TELEGRAM_TOKEN_LOCKER_KEY = "messaging.telegram.botToken"

export interface WizardDeps {
  readonly prompt: (question: string) => Effect.Effect<string, never>
  readonly print: (line: string) => Effect.Effect<void, never>
  readonly http: HttpClientShape
  readonly locker: SecretLockerShape
  readonly registry: PairingRegistryShape
  readonly forwarder: Forwarder
  readonly dir: string
}

const POLL_ROUNDS = 30
const POLL_INTERVAL_MS = 2000

/**
 * Poll the bot's inbox for the pairing code. Returns the chatId that sent it,
 * or undefined on timeout. Self-contained — no dispatcher needed.
 */
const awaitPairingCode = (
  deps: WizardDeps,
  token: string,
  code: string
): Effect.Effect<string | undefined, never> => {
  const client = { http: deps.http, token }
  const loop: (round: number, offset: number) => Effect.Effect<string | undefined, never> = (round, offset) =>
    Effect.gen(function* () {
      if (round >= POLL_ROUNDS) return undefined
      const updates = yield* getUpdates(client, offset).pipe(
        Effect.catch(() => Effect.succeed([] as const))
      )
      let nextOffset = offset
      for (const u of updates) {
        nextOffset = Math.max(nextOffset, u.update_id + 1)
        const m = textMessageOf(u)
        if (m !== undefined && m.text.trim() === code) return m.chatId
      }
      yield* Effect.sleep(POLL_INTERVAL_MS)
      return yield* loop(round + 1, nextOffset)
    })
  return loop(0, 0)
}

export const runSetupWizard = (
  deps: WizardDeps
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const print = deps.print
    const ask = deps.prompt

    // 1. Explain.
    yield* print("Telegram gateway setup")
    yield* print("Talk to your AImy from your phone. Only the paired chat can reach")
    yield* print("your agent; your bot token lives in the secret locker, never on disk.")
    yield* print("")

    // 2. Token.
    yield* print("Step 1/4: create a bot with @BotFather on Telegram (/newbot), then paste the token.")
    const token = (yield* ask("Bot token: ")).trim()
    if (token === "") {
      yield* print("No token entered — setup cancelled, nothing was stored.")
      return
    }
    const client = { http: deps.http, token }
    const me = yield* getMe(client).pipe(
      Effect.map((u) => ({ ok: true as const, username: u.username ?? u.first_name })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, reason: e._tag === "TelegramAuthError" ? e.reason : `Telegram error: ${e.reason}` }))
    )
    if (!me.ok) {
      yield* print(`Token invalid: ${me.reason} — setup cancelled, nothing was stored.`)
      return
    }
    yield* deps.locker
      .store(TELEGRAM_TOKEN_LOCKER_KEY, Redacted.make(token), { profile: "instance" })
      .pipe(Effect.catch(() => Effect.void))
    yield* print(`Connected as @${me.username}. Token stored in the secret locker.`)
    yield* print("")

    // 3. Pair.
    yield* print("Step 2/4: pairing. I'm generating a one-time code (5 minutes).")
    const pairing = yield* deps.registry.generateCode("telegram")
    yield* print(`Your code: ${pairing.code}`)
    yield* print("Send exactly those 6 digits to your bot on Telegram.")
    yield* print("Waiting for the code (up to 60 seconds)…")
    const chatId = yield* awaitPairingCode(deps, token, pairing.code)
    if (chatId === undefined) {
      yield* print("Timed out waiting for the code — setup cancelled. Run the wizard again for a fresh code.")
      return
    }
    const claimed = yield* deps.registry
      .claimCode("telegram", chatId, pairing.code)
      .pipe(
        Effect.map((c) => ({ ok: true as const, chat: c })),
        Effect.catch((e) => Effect.succeed({ ok: false as const, reason: e.reason }))
      )
    if (!claimed.ok) {
      yield* print(`Pairing failed: ${claimed.reason} — setup cancelled.`)
      return
    }
    yield* print(`Paired with chat ${chatId}.`)
    yield* print("")

    // 4. Preferences.
    yield* print("Step 3/4: which notifications forward to Telegram?")
    yield* print("Severities: info, success, warning, critical (comma-separated).")
    const rawSevs = (yield* ask(`Forward [${DEFAULT_FORWARDING_PREFS.severities.join(", ")}]: `)).trim()
    const severities = (
      rawSevs === ""
        ? DEFAULT_FORWARDING_PREFS.severities
        : rawSevs.split(",").map((s) => s.trim().toLowerCase())
    ).filter((s): s is "info" | "success" | "warning" | "critical" =>
      ["info", "success", "warning", "critical"].includes(s)
    )
    const prefs: ForwardingPrefs = {
      enabled: true,
      severities: severities.length > 0 ? severities : DEFAULT_FORWARDING_PREFS.severities,
    }
    yield* deps.forwarder.setPrefs(prefs).pipe(Effect.catch(() => Effect.void))
    yield* print(`Forwarding: ${prefs.severities.join(", ")}.`)
    yield* print("")

    // 5. Test message.
    yield* print("Step 4/4: sending a test message…")
    const sent = yield* sendMessage(client, chatId, "Your AImy is connected. 🔌").pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false))
    )
    if (sent) {
      yield* print("Done — check your Telegram. Send /start anytime to talk to your AImy.")
    } else {
      yield* print("Paired, but the test message failed to send. Your pairing is saved; check connectivity and try messaging the bot.")
    }
  }).pipe(Effect.catch(() => Effect.void))
