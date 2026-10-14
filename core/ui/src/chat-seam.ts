/**
 * ui/src/chat-seam.ts — the chat session service boundary.
 *
 * The shell never touches IPC directly: its chat commands yield
 * `ChatIpc`, which the desktop renderer provides
 * (`desktop/src/renderer/resources.ts`) over the `chat.branch`
 * IPC command. Failures surface as `Error` and the shell turns
 * them into failed messages — a branch that didn't happen is
 * never reported as branched.
 */
import { Context } from "effect"

export interface ChatIpcShape {
  /**
   * Fork the session at his Nth prompt (1-based, wake turns
   * excluded): the new session keeps everything before that
   * prompt. Resolves with the new session's id.
   */
  readonly branchSession: (
    sessionId: string,
    userOrdinal: number
  ) => Promise<{ readonly newSessionId: string }>
}

export class ChatIpc extends Context.Service<ChatIpc, ChatIpcShape>()(
  "aimy/ui/ChatIpc"
) {}
