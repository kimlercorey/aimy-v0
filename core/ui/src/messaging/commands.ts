/**
 * ui/src/messaging/commands.ts — foldkit Commands for the messaging slice.
 *
 * Each command is one IPC round-trip through `MessagingIpc`; outcomes land
 * as the slice's `*Received` / `*Failed` messages. The pairing check is
 * poll-driven: the view's "check" button re-dispatches `PairingCheckRequested`
 * (the slice never busy-loops on its own).
 */
import { Effect, Schema } from "effect"
import { define as defineCommand } from "foldkit/command"

import { Message } from "./messages.js"
import { MessagingIpc } from "./seam.js"

const toError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const RefreshStatus = defineCommand("messaging/refreshStatus", {
  args: {},
  messages: [Message.StatusReceived, Message.StatusFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* MessagingIpc
      const s = yield* Effect.tryPromise({
        try: () => ipc.status(),
        catch: (e) => new Error(toError(e)),
      })
      return Message.StatusReceived({
        configured: s.configured,
        botUsername: s.botUsername,
        paired: s.paired,
        forwardingKinds: [...s.forwardingKinds],
      })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.StatusFailed({ reason: toError(e) })))),
})

export const ValidateToken = defineCommand("messaging/validateToken", {
  args: { token: Schema.String },
  messages: [Message.TokenValidated, Message.TokenFailed],
  execute: ({ token }: { token: string }) =>
    Effect.gen(function* () {
      const ipc = yield* MessagingIpc
      const r = yield* Effect.tryPromise({
        try: () => ipc.validateToken(token),
        catch: (e) => new Error(toError(e)),
      })
      if (!r.ok) return Message.TokenFailed({ reason: r.error ?? "Token invalid." })
      return Message.TokenValidated({ botUsername: r.botUsername ?? "bot" })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.TokenFailed({ reason: toError(e) })))),
})

export const IssueCode = defineCommand("messaging/issueCode", {
  args: {},
  messages: [Message.CodeIssued, Message.CodeFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* MessagingIpc
      const r = yield* Effect.tryPromise({
        try: () => ipc.issueCode(),
        catch: (e) => new Error(toError(e)),
      })
      return Message.CodeIssued({ code: r.code, expiresAt: r.expiresAt })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.CodeFailed({ reason: toError(e) })))),
})

export const CheckPairing = defineCommand("messaging/checkPairing", {
  args: {},
  messages: [Message.PairingPaired, Message.PairingWaiting, Message.PairingFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* MessagingIpc
      const r = yield* Effect.tryPromise({
        try: () => ipc.checkPairing(),
        catch: (e) => new Error(toError(e)),
      })
      return r.paired ? Message.PairingPaired({}) : Message.PairingWaiting({})
    }).pipe(Effect.catch((e) => Effect.succeed(Message.PairingFailed({ reason: toError(e) })))),
})

export const SaveForwarding = defineCommand("messaging/saveForwarding", {
  args: { kinds: Schema.Array(Schema.String) },
  messages: [Message.ForwardingSaved, Message.ForwardingFailed],
  execute: ({ kinds }: { kinds: ReadonlyArray<string> }) =>
    Effect.gen(function* () {
      const ipc = yield* MessagingIpc
      yield* Effect.tryPromise({
        try: () => ipc.setForwarding(kinds),
        catch: (e) => new Error(toError(e)),
      })
      return Message.ForwardingSaved({ kinds: [...kinds] })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.ForwardingFailed({ reason: toError(e) })))),
})

export const SendTest = defineCommand("messaging/sendTest", {
  args: {},
  messages: [Message.TestSucceeded, Message.TestFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* MessagingIpc
      const r = yield* Effect.tryPromise({
        try: () => ipc.testMessage(),
        catch: (e) => new Error(toError(e)),
      })
      if (!r.ok) return Message.TestFailed({ reason: r.error ?? "Test message failed." })
      return Message.TestSucceeded({})
    }).pipe(Effect.catch((e) => Effect.succeed(Message.TestFailed({ reason: toError(e) })))),
})
