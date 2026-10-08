# Messaging gateway — spec (v0.1 draft, 2026-10-07)

*Status: spec for review. Build order per Kimler 2026-10-07: gateway → TTS → ASC channels/FACS → UI refinement.*

## 1. Goal

Talk to your AImy instance from your phone, and let it reach you. Two directions:

- **Inbound:** a Telegram message becomes a turn in the agent loop; the reply
  comes back from your instance, running on your hardware.
- **Outbound:** comms banners (job done, cron status, research paper ready)
  forward to paired chats — the in-app banner channel (Must #15) grows an
  external leg.

**Scope of this spec: Telegram only.** Best free bot API, HTTP long-polling
(no open ports, no webhook, works behind NAT). Signal/Discord/WhatsApp are
later channels on the same seam — not this build.

## 2. Architecture

Two new modules:

| Module | Role |
|---|---|
| `core/messaging/` | Gateway core: channel abstraction, pairing registry, inbound dispatch to the agent loop, outbound fan-out from comms banners. No platform code. |
| `core/messaging-telegram/` | Telegram Bot API implementation: long-polling `getUpdates`, `sendMessage`. Token from the secret locker, never config files. |

```ts
/** core/messaging — the channel seam. */
interface Channel {
  readonly name: string // "telegram"
  /** Long-poll / listen loop; yields inbound messages. Never throws — errors become channel events. */
  readonly listen: (handlers: ChannelHandlers) => Effect.Effect<void, MessagingError>
  readonly send: (to: PairedChat, text: string) => Effect.Effect<void, MessagingError>
}
interface InboundMessage {
  readonly channel: string
  readonly chatId: string
  readonly fromDisplayName?: string
  readonly text: string
  readonly receivedAt: string
}
interface PairedChat {
  readonly channel: string
  readonly chatId: string
  readonly displayName?: string
  readonly pairedAt: string
}
```

The gateway core owns:

- **Pairing registry** — which chat IDs may talk to this instance. Stored
  on disk (0600), keyed by `(channel, chatId)`. Structure mirrors the
  identity pairing grants (peer id, paired-at, display name) but for
  human→instance pairs, not instance→instance.
- **Inbound dispatch** — a message from a paired chat becomes an agent-loop
  turn with provenance `{ channel, chatId }`; the turn's reply routes back
  to that chat. Unpaired chats get the pairing prompt, never the agent.
- **Outbound forwarding** — subscribes to comms banners; forwards per the
  user's per-severity toggles (default: `success` and `critical` only —
  nobody wants every info banner buzzing their phone).

## 3. Pairing flow (human → instance)

1. User creates a bot via @BotFather, pastes the token into AImy (onboarding
   or settings). Token goes to the **secret locker**, scope
   `{ profile: "instance", purpose: "messaging-telegram" }`.
2. User sends `/start` (or any message) to the bot. Gateway sees an unknown
   chat ID → replies with pairing instructions (no agent access).
3. The desktop UI (or CLI) shows a one-time 6-digit code, expiring in 5 min.
4. User sends the code to the bot → chat ID registered as paired.
5. Paired chats talk to the agent. Unpair from the UI/CLI anytime.

**Security rules:**

- Pairing codes: single-use, 5-minute expiry, 5 attempts max per chat
  (then 1-hour cooldown). Codes are random, not sequential.
- Unpaired messages never reach the agent loop, the honesty ledger, or
  memory. They get the pairing prompt (rate-limited: 1/min per chat).
- The bot token never appears in logs, errors, or exports.
- Inbound text from paired chats runs through the **normal agent loop** —
  permission tiers apply. A Telegram message cannot bypass what a desktop
  message cannot do.
- Outbound forwarding is opt-in per severity, default minimal.

## 4. Inbound → turn mapping

- One Telegram message = one agent-loop turn, with session continuity per
  `(channel, chatId)` — your Telegram thread is its own session, separate
  from desktop.
- Long messages: Telegram's 4096-char limit — split replies on send,
  reassemble on receive (no truncation).
- Non-text messages (photos, voice, files): Phase 1 replies "I can't read
  that yet" honestly. (Image input is a separate Should item.)
- The turn carries provenance so the agent *knows* it's on Telegram:
  shorter replies are better there; the system prompt notes the channel.

## 5. Outbound → banner forwarding

```ts
interface ForwardingPrefs {
  /** severities forwarded to each paired chat; default ["success", "critical"] */
  readonly severities: ReadonlyArray<"info" | "success" | "warning" | "critical">
  readonly enabled: boolean
}
```

- Banner published → gateway checks prefs → `sendMessage` to paired chats.
- Research papers (Phase 2 of deep research): the MD file attaches via
  `sendDocument`. This is the "paper lands in your Telegram at 3am" flow.
- Forwarding failures are logged, never retried silently — a missed
  critical banner surfaces in-app.

## 6. Failure modes

| Failure | Behavior |
|---|---|
| Bot token missing/invalid | gateway stays dormant; UI shows "Telegram not configured", never crashes the app |
| `getUpdates` network failure | exponential backoff (1s → 60s cap), logged; resumes automatically |
| Agent loop error mid-turn | user gets "something went wrong on my end" — never a stack trace |
| Pairing code expired/wrong | "that code didn't work" + new code on request; attempts rate-limited |
| Telegram API down | outbound queue holds (bounded, 50 messages); overflow drops oldest with an in-app banner |

## 7. Testing strategy

- **No network in tests.** Telegram Bot API mocked at the HTTP layer
  (it's plain JSON over HTTPS — `getUpdates`/`sendMessage` fixtures).
- Pairing: code generation/validation/expiry/rate-limit — pure unit tests.
- Registry: pair/unpair/persistence round-trip.
- Dispatch: inbound message from paired chat → turn created with provenance;
  from unpaired chat → pairing prompt, no turn.
- Forwarding: banner published → prefs filter → `sendMessage` called (or not).
- Live validation is manual: real bot, real phone, @BotFather token.

## 8. Build phases

1. **Gateway core**: types, pairing registry, channel seam, prefs. No Telegram yet — tested against a stub channel.
2. **Telegram channel**: long-polling, send, pairing flow, token in locker.
3. **Agent-loop wiring**: inbound → turn with provenance + session per chat; reply routing.
4. **Outbound forwarding**: comms subscription, prefs UI (CLI first, desktop in the UI refinement pass).
5. **Hardening**: rate limits, backoff, queue bounds, honest failure messages.

## 9. Open questions — resolved 2026-10-07 (Kimler)

1. **Multi-chat:** single paired chat only (for now).
2. **Proactive agent messages:** deferred to a later phase — forwarding only.
3. **Voice notes:** deferred — honest "can't read that yet"; STT not in this build.

## 10. Setup wizard (in-app)

The gateway ships with a guided setup wizard — the capability is not
complete without it. CLI gets a text wizard in the gateway build; the
desktop stepped wizard lands in the UI refinement pass.

**Wizard steps:**

1. **Explain** — what the gateway does, the security model in one screen:
   only paired chats reach your agent; the token lives in your secret locker.
2. **Create bot** — instructions for @BotFather (`/newbot`, name it, copy
   the token). External step; the wizard waits.
3. **Enter token** — paste; the wizard validates format and calls `getMe`
   to verify before storing. Invalid token → specific error, retry.
   Token goes straight to the secret locker, never touches disk plaintext.
4. **Pair** — the wizard shows a 6-digit code (5-min expiry) and tells the
   user to message the bot. It polls for the pairing confirmation and
   advances on success; expiry → "code expired, generate a new one."
5. **Preferences** — which banner severities forward to Telegram
   (default: success + critical). Toggle per severity.
6. **Done** — sends a test message through the bot ("Your AImy is connected").
   If the test message fails, the wizard says so honestly instead of
   declaring victory.

**Wizard failure contract:** every step validates before advancing; no step
can be skipped into a broken state (e.g. no pairing without a verified
token). Abandoning the wizard mid-flow leaves no partial config — the
gateway stays dormant until setup completes.
