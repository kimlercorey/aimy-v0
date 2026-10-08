/**
 * ui/src/messaging/seam.ts — the messaging slice's service boundary.
 *
 * The slice never touches IPC directly: its commands yield `MessagingIpc`,
 * which the desktop renderer provides (`desktop/src/renderer/resources.ts`)
 * over the `messaging.*` IPC commands. Every method mirrors one IPC command;
 * failures surface as `Error` and the slice turns them into failed messages.
 */
import { Context } from "effect"

export interface MessagingStatus {
  readonly configured: boolean
  readonly botUsername?: string | undefined
  readonly paired: boolean
  readonly forwardingKinds: ReadonlyArray<string>
}

export interface MessagingIpcShape {
  readonly status: () => Promise<MessagingStatus>
  readonly validateToken: (token: string) => Promise<{ ok: boolean; botUsername?: string; error?: string }>
  readonly issueCode: () => Promise<{ code: string; expiresAt: string }>
  readonly checkPairing: () => Promise<{ paired: boolean }>
  readonly getForwarding: () => Promise<{ kinds: ReadonlyArray<string> }>
  readonly setForwarding: (kinds: ReadonlyArray<string>) => Promise<void>
  readonly testMessage: () => Promise<{ ok: boolean; error?: string }>
}

export class MessagingIpc extends Context.Service<MessagingIpc, MessagingIpcShape>()(
  "aimy/ui/MessagingIpc"
) {}
