/**
 * desktop/src/preload.ts — the sandbox bridge (M10 Track 2).
 *
 * The ONLY privileged code the renderer process loads. With
 * `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`
 * (locked in `src/main/main.ts`), the renderer gets EXACTLY the
 * `window.aimy` API defined below — nothing else.
 *
 * Two allowlists, both from `src/ipc/protocol.ts` (the contract):
 * - `invoke` rejects any command whose `_tag` is not in `IPC_COMMAND_TAGS`
 *   — a forged command never reaches `ipcRenderer`, let alone the main
 *   process.
 * - the `"aimy:event"` listener only forwards events whose `_tag` is in
 *   `IPC_EVENT_TAGS` — a forged event never reaches the renderer.
 *
 * PACKAGING NOTE (for Track 3): this file is compiled by the shared
 * `tsc -b` to ESM (`dist/desktop/src/preload.js`), but Electron does NOT
 * support ESM imports in *sandboxed* preload scripts
 * (https://www.electronjs.org/docs/latest/tutorial/esm#esm-support-matrix:
 * "Sandboxed preload scripts can't use ESM imports"). The `main.ts` preload
 * path is correct; the file itself must be bundled to a single CJS script
 * (e.g. esbuild/vite `--format=cjs`) before it is handed to the
 * `BrowserWindow` — raw tsc output will fail to load under `sandbox: true`.
 */
import { contextBridge, ipcRenderer } from "electron"
import {
  IPC_COMMAND_TAGS,
  IPC_EVENT_TAGS,
  type AimyBridgeApi,
  type IpcCommand,
  type IpcCommandResult,
  type IpcEvent
} from "./ipc/protocol.js"

const tagOf = (value: unknown): unknown =>
  typeof value === "object" && value !== null ? (value as { _tag?: unknown })._tag : undefined

const isCommandTag = (tag: unknown): tag is IpcCommand["_tag"] =>
  typeof tag === "string" && (IPC_COMMAND_TAGS as ReadonlyArray<string>).includes(tag)

const isEventTag = (tag: unknown): tag is IpcEvent["_tag"] =>
  typeof tag === "string" && (IPC_EVENT_TAGS as ReadonlyArray<string>).includes(tag)

const api: AimyBridgeApi = {
  invoke: <C extends IpcCommand>(cmd: C): Promise<IpcCommandResult<C>> => {
    if (!isCommandTag(tagOf(cmd))) {
      return Promise.reject(new Error("aimy: blocked invoke of unknown command tag"))
    }
    return ipcRenderer.invoke(`aimy:${cmd._tag}`, cmd) as Promise<IpcCommandResult<C>>
  },
  subscribe: (handler: (evt: IpcEvent) => void): (() => void) => {
    const listener = (_event: unknown, evt: unknown): void => {
      // Drop anything that isn't a protocol event — including forged shapes.
      if (isEventTag(tagOf(evt))) handler(evt as IpcEvent)
    }
    ipcRenderer.on("aimy:event", listener)
    return () => {
      ipcRenderer.removeListener("aimy:event", listener)
    }
  }
}

contextBridge.exposeInMainWorld("aimy", api)
