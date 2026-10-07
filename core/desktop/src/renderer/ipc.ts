/**
 * desktop/src/renderer/ipc.ts — typed access to the preload bridge.
 *
 * The ONLY way the renderer talks to the main process is `window.aimy`,
 * exposed by the preload script (Track 2: `desktop/src/preload.ts`) as the
 * `AimyBridgeApi` from `desktop/src/ipc/protocol.ts`. This module fails
 * loudly when the bridge is absent — a renderer without its bridge is never
 * allowed to pretend it is connected — and hands out Track 2's
 * `createIpcClient` client (invoke / subscribe / chatStream) as a singleton.
 */
import type { AimyBridgeApi, WindowAimy } from "../ipc/protocol.js"
import { createIpcClient, type IpcClient } from "../ipc/client.js"

declare global {
  interface Window {
    readonly aimy?: AimyBridgeApi | undefined
  }
}

/** The raw bridge, or a thrown error naming exactly what is missing. */
export const getAimy = (): AimyBridgeApi => {
  const bridge = window.aimy
  if (bridge === undefined) {
    throw new Error(
      "window.aimy is not available: the preload bridge did not expose the IPC surface. " +
        "This renderer must run inside the Electron shell (or the smoke harness)."
    )
  }
  return bridge
}

let client: IpcClient | undefined

/** Track 2's typed IPC client over the bridge (singleton per renderer). */
export const getClient = (): IpcClient => {
  if (client === undefined) {
    const bridge = getAimy()
    const windowAimy: WindowAimy = { aimy: bridge }
    client = createIpcClient(windowAimy)
  }
  return client
}
