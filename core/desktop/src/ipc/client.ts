/**
 * desktop/src/ipc/client.ts — the renderer-side typed IPC client (M10 Track 2).
 *
 * Consumed by Track 3's renderer. It talks ONLY through the `window.aimy`
 * bridge the preload exposes (`AimyBridgeApi` in `protocol.ts`) — it never
 * touches `ipcRenderer` or Electron directly, so it is unit-testable with a
 * fake bridge and safe to bundle into the sandboxed renderer.
 *
 * `chatStream(sessionId, input)` opens a `chat.send` stream and yields the
 * `chat.token` deltas as an `AsyncIterable<string>`; it resolves when
 * `chat.done` arrives, throws the clean message on `chat.error`, and
 * `cancel()` interrupts the main-side stream and ends iteration.
 */
import type { IpcCommand, IpcCommandResult, IpcEvent, WindowAimy } from "./protocol.js"

export interface IpcClient {
  readonly invoke: <C extends IpcCommand>(cmd: C) => Promise<IpcCommandResult<C>>
  readonly subscribe: (handler: (evt: IpcEvent) => void) => () => void
  readonly chatStream: (sessionId: string, input: string) => ChatStreamHandle
}

/** A live chat stream: token deltas as an AsyncIterable, plus `cancel()`. */
export interface ChatStreamHandle extends AsyncIterable<string> {
  /** Interrupt the main-side stream and end iteration (idempotent). */
  readonly cancel: () => void
}

type ChatOutcome =
  | { readonly _tag: "token"; readonly delta: string }
  | { readonly _tag: "done" }
  | { readonly _tag: "error"; readonly error: string }

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const createIpcClient = (aimy: WindowAimy): IpcClient => {
  const bridge = aimy.aimy
  const invoke = <C extends IpcCommand>(cmd: C): Promise<IpcCommandResult<C>> => bridge.invoke(cmd)
  const subscribe = (handler: (evt: IpcEvent) => void): (() => void) => bridge.subscribe(handler)

  type ChatIpcEvent = Extract<IpcEvent, { _tag: "chat.token" | "chat.done" | "chat.error" }>

  const chatStream = (sessionId: string, input: string): ChatStreamHandle => {
    const queue: Array<ChatOutcome> = []
    /**
     * Chat events that arrived before the `chat.send` response told us our
     * streamId. We can't attribute them yet (they could be another stream's),
     * so they wait here and are replayed — in order — once the id is known.
     * Without this, a fast first token could beat the invoke response and be
     * dropped, breaking delta order.
     */
    const prestart: Array<ChatIpcEvent> = []
    let waiter: ((outcome: ChatOutcome) => void) | undefined
    let streamId: string | undefined
    let cancelRequested = false
    let cancelSent = false
    let finished = false

    const push = (outcome: ChatOutcome): void => {
      if (finished) return
      const w = waiter
      waiter = undefined
      if (w !== undefined) w(outcome)
      else queue.push(outcome)
    }

    const onChatEvent = (evt: ChatIpcEvent): void => {
      if (streamId === undefined || evt.streamId !== streamId) return
      if (evt._tag === "chat.token") push({ _tag: "token", delta: evt.delta })
      else if (evt._tag === "chat.done") push({ _tag: "done" })
      else push({ _tag: "error", error: evt.error })
    }

    let unsubscribe: (() => void) | undefined = bridge.subscribe((evt) => {
      // Narrow to the chat events first: banner.published / asc.dialsUpdated
      // carry no streamId and are ignored here.
      if (evt._tag !== "chat.token" && evt._tag !== "chat.done" && evt._tag !== "chat.error") {
        return
      }
      if (streamId === undefined) {
        prestart.push(evt)
        return
      }
      onChatEvent(evt)
    })

    const finish = (): void => {
      if (finished) return
      finished = true
      unsubscribe?.()
      unsubscribe = undefined
      waiter = undefined
    }

    const sendCancel = (): void => {
      if (streamId === undefined || cancelSent) return
      cancelSent = true
      void invoke({ _tag: "chat.cancel", streamId }).catch(() => undefined)
    }

    // Kick off the stream. A rejected chat.send surfaces as a stream error
    // rather than a hang.
    void invoke({ _tag: "chat.send", sessionId, input }).then(
      (res) => {
        streamId = res.streamId
        // Replay pre-response events in arrival order. Synchronous, so no
        // later event can interleave and break the order.
        for (const evt of prestart.splice(0)) onChatEvent(evt)
        if (cancelRequested) sendCancel()
      },
      (error) => push({ _tag: "error", error: toMessage(error) })
    )

    const handle: ChatStreamHandle = {
      cancel: () => {
        cancelRequested = true
        sendCancel()
        push({ _tag: "done" })
        finish()
      },
      [Symbol.asyncIterator]: () => {
        let iterDone = false
        const take = (): Promise<ChatOutcome> => {
          const head = queue.shift()
          if (head !== undefined) return Promise.resolve(head)
          return new Promise<ChatOutcome>((resolve) => {
            waiter = resolve
          })
        }
        return {
          next: async (): Promise<IteratorResult<string>> => {
            if (iterDone || finished) return { done: true, value: undefined }
            const outcome = await take()
            if (outcome._tag === "token") return { done: false, value: outcome.delta }
            iterDone = true
            finish()
            if (outcome._tag === "error") throw new Error(outcome.error)
            return { done: true, value: undefined }
          },
          return: async (): Promise<IteratorResult<string>> => {
            iterDone = true
            handle.cancel()
            return { done: true, value: undefined }
          }
        }
      }
    }
    return handle
  }

  return { invoke, subscribe, chatStream }
}
