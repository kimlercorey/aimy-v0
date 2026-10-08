/**
 * desktop/src/main/messaging.ts — the desktop messaging gateway holder.
 *
 * Owns the Telegram gateway's main-process state: the pairing registry, the
 * forwarding prefs, the wizard's in-progress code, and the inbound listener.
 * The bot token lives ONLY in the SecretLocker (revealed at the point of
 * use, never held as a field).
 *
 * - Wizard steps are one IPC command each (validate → issue code → poll
 *   pairing → prefs → test); the renderer drives the sequence.
 * - `startRuntime()` boots the inbound long-poll listener + the banner
 *   forwarder when a token and a paired chat exist. Idempotent; safe to
 *   call on every boot.
 */
import { Effect, Scope, Stream } from "effect"
import { InferenceError } from "../../../substrate/errors.js"
import {
  DEFAULT_FORWARDING_PREFS,
  handleInbound,
  makeForwarder,
  makePairingRegistry,
  type Forwarder,
  type PairingRegistryShape,
  type TurnRunner,
} from "../../../messaging/src/index.js"
import {
  TELEGRAM_TOKEN_LOCKER_KEY,
  getMe,
  getUpdates,
  makeTelegramChannel,
  sendMessage,
  textMessageOf,
} from "../../../messaging-telegram/src/index.js"
import type { HttpClientShape } from "../../../web-retrieval/src/http.js"
import { HttpClient } from "../../../web-retrieval/src/http.js"
import { Redacted } from "../../../substrate/types.js"
import type { SecretLockerShape } from "../../../identity/locker.js"
import type { CommsBannerShape } from "../../../comms/index.js"
import type { AimyPaths } from "../../../substrate/config.js"
import type { DesktopEngine } from "./engine.js"
import type {
  MessagingStatusResult,
  MessagingValidateResult,
  MessagingCodeResult,
  MessagingPairingResult,
  MessagingForwardingResult,
  MessagingTestResult,
} from "../ipc/protocol.js"

export interface MessagingGatewayDeps {
  readonly engine: DesktopEngine
  readonly locker: SecretLockerShape
  readonly comms: CommsBannerShape
  readonly paths: AimyPaths
}

export interface MessagingGateway {
  readonly status: () => Promise<MessagingStatusResult>
  readonly validateToken: (token: string) => Promise<MessagingValidateResult>
  readonly issueCode: () => Promise<MessagingCodeResult>
  readonly checkPairing: () => Promise<MessagingPairingResult>
  readonly getForwarding: () => Promise<MessagingForwardingResult>
  readonly setForwarding: (kinds: ReadonlyArray<string>) => Promise<void>
  readonly testMessage: () => Promise<MessagingTestResult>
  readonly startRuntime: () => void
}

const VALID_SEVERITIES = ["info", "success", "warning", "critical"] as const

const withHttp = <A, E>(
  engine: DesktopEngine,
  fn: (http: HttpClientShape) => Effect.Effect<A, E>
): Promise<A> => engine.run(Effect.flatMap(HttpClient, fn))

const tokenOf = (locker: SecretLockerShape): Effect.Effect<Redacted<string> | undefined, never> =>
  locker.retrieve(TELEGRAM_TOKEN_LOCKER_KEY, { profile: "instance" }).pipe(
    Effect.map((r) => r as Redacted<string> | undefined),
    Effect.catch(() => Effect.succeed(undefined))
  )

export const makeMessagingGateway = (deps: MessagingGatewayDeps): MessagingGateway => {
  const { engine, locker, comms, paths } = deps
  const dir = paths.state
  const registry: PairingRegistryShape = makePairingRegistry(dir)

  let pendingCode: string | undefined
  let pendingCodeExpiresAt = 0
  let updateOffset = 0
  let runtimeStarted = false

  // The forwarder is built lazily — it needs a live channel (token).
  let forwarder: Forwarder | undefined

  const httpFor = async (): Promise<HttpClientShape> =>
    withHttp(engine, (http) => Effect.succeed(http))

  const status = async (): Promise<MessagingStatusResult> => {
    const token = await Effect.runPromise(tokenOf(locker))
    const paired = await Effect.runPromise(registry.getPaired("telegram"))
    const prefs = forwarder !== undefined
      ? await Effect.runPromise(forwarder.getPrefs())
      : DEFAULT_FORWARDING_PREFS
    let botUsername: string | undefined
    if (token !== undefined) {
      const http = await httpFor()
      const me = await Effect.runPromise(
        getMe({ http, token: token.reveal() }).pipe(
          Effect.map((u) => u.username ?? u.first_name),
          Effect.catch(() => Effect.succeed(undefined))
        )
      )
      botUsername = me
    }
    return {
      configured: token !== undefined,
      botUsername,
      paired: paired !== undefined,
      forwardingKinds: [...prefs.severities],
    }
  }

  const validateToken = async (rawToken: string): Promise<MessagingValidateResult> => {
    const token = rawToken.trim()
    if (token === "") return { ok: false, error: "Token must not be empty." }
    const http = await httpFor()
    const me = await Effect.runPromise(
      getMe({ http, token }).pipe(
        Effect.map((u) => ({ ok: true as const, username: u.username ?? u.first_name })),
        Effect.catch((e) =>
          Effect.succeed({ ok: false as const, error: `Token invalid: ${e.reason}` })
        )
      )
    )
    if (!me.ok) return me
    // Valid → store. A failed store is surfaced, never silently claimed.
    try {
      await Effect.runPromise(locker.store(TELEGRAM_TOKEN_LOCKER_KEY, Redacted.make(token), { profile: "instance" }))
    } catch (e) {
      return { ok: false, error: `Token valid but storage failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    return { ok: true, botUsername: me.username }
  }

  const issueCode = async (): Promise<MessagingCodeResult> => {
    const code = await Effect.runPromise(registry.generateCode("telegram"))
    pendingCode = code.code
    pendingCodeExpiresAt = code.expiresAt
    updateOffset = 0
    return { code: code.code, expiresAt: new Date(code.expiresAt).toISOString() }
  }

  const checkPairing = async (): Promise<MessagingPairingResult> => {
    if (pendingCode === undefined || Date.now() > pendingCodeExpiresAt) {
      const paired = await Effect.runPromise(registry.getPaired("telegram"))
      return { paired: paired !== undefined }
    }
    const token = await Effect.runPromise(tokenOf(locker))
    if (token === undefined) return { paired: false }
    const http = await httpFor()
    const code = pendingCode
    const found = await Effect.runPromise(
      getUpdates({ http, token: token.reveal() }, updateOffset).pipe(
        Effect.map((updates) => {
          let nextOffset = updateOffset
          let chatId: string | undefined
          for (const u of updates) {
            nextOffset = Math.max(nextOffset, u.update_id + 1)
            const m = textMessageOf(u)
            if (m !== undefined && m.text.trim() === code) chatId = m.chatId
          }
          updateOffset = nextOffset
          return chatId
        }),
        Effect.catch(() => Effect.succeed(undefined))
      )
    )
    if (found === undefined) {
      const paired = await Effect.runPromise(registry.getPaired("telegram"))
      return { paired: paired !== undefined }
    }
    const claimed = await Effect.runPromise(
      registry.claimCode("telegram", found, code).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false))
      )
    )
    if (claimed) {
      pendingCode = undefined
      startRuntime()
    }
    return { paired: claimed }
  }

  const getForwarding = async (): Promise<MessagingForwardingResult> => {
    const prefs = forwarder !== undefined
      ? await Effect.runPromise(forwarder.getPrefs())
      : DEFAULT_FORWARDING_PREFS
    return { kinds: [...prefs.severities] }
  }

  const setForwarding = async (kinds: ReadonlyArray<string>): Promise<void> => {
    const clean = kinds.filter((k): k is (typeof VALID_SEVERITIES)[number] =>
      (VALID_SEVERITIES as ReadonlyArray<string>).includes(k)
    )
    if (forwarder === undefined) throw new Error("messaging: gateway not started (pair first)")
    await Effect.runPromise(
      forwarder.setPrefs({ enabled: true, severities: clean }).pipe(
        Effect.catch((e) => Effect.fail(new Error(`forwarding prefs not saved: ${e.reason}`)))
      )
    )
  }

  const testMessage = async (): Promise<MessagingTestResult> => {
    const token = await Effect.runPromise(tokenOf(locker))
    const paired = await Effect.runPromise(registry.getPaired("telegram"))
    if (token === undefined) return { ok: false, error: "No bot token stored." }
    if (paired === undefined) return { ok: false, error: "No paired chat." }
    const http = await httpFor()
    const sent = await Effect.runPromise(
      sendMessage({ http, token: token.reveal() }, paired.chatId, "AImy test message — your gateway works.").pipe(
        Effect.map(() => true),
        Effect.catch((e) => Effect.succeed(e.reason as string))
      )
    )
    return sent === true ? { ok: true } : { ok: false, error: String(sent) }
  }

  const startRuntime = (): void => {
    if (runtimeStarted) return
    runtimeStarted = true
    void (async () => {
      const token = await Effect.runPromise(tokenOf(locker))
      const paired = await Effect.runPromise(registry.getPaired("telegram"))
      if (token === undefined || paired === undefined) {
        runtimeStarted = false // nothing to run yet; a later pairing restarts us
        return
      }
      const http = await httpFor()
      const rawToken = token.reveal()
      const channel = makeTelegramChannel({ http, token: rawToken })

      const runner: TurnRunner = {
        // engine.chatStream is an AsyncIterable — wrap it as a self-contained
        // Stream (R=never) so the dispatcher's TurnRunner contract holds.
        chat: (sessionId, input) =>
          Stream.fromAsyncIterable(engine.chatStream(sessionId, input), (error: unknown) =>
            error instanceof InferenceError
              ? error
              : new InferenceError({ provider: "desktop-messaging", reason: String(error) })
          ),
      }
      const dispatch = handleInbound({ registry, runner, channel })

      forwarder = makeForwarder({ registry, channel, comms, dir })

      const scope = Effect.runSync(Scope.make())
      // Inbound listener (never fails by design) + banner forwarder.
      void Effect.runPromise(
        Effect.gen(function* () {
          yield* channel.listen({ onMessage: (m) => dispatch(m), onEvent: () => Effect.void })
        }).pipe(Effect.provideService(Scope.Scope, scope), Effect.catch(() => Effect.void))
      )
      void Effect.runPromise(
        forwarder.run().pipe(Effect.provideService(Scope.Scope, scope), Effect.catch(() => Effect.void))
      )
    })()
  }

  return { status, validateToken, issueCode, checkPairing, getForwarding, setForwarding, testMessage, startRuntime }
}
