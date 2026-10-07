/**
 * paths-shim.ts — INTEGRATION SHIM
 *
 * The parallel substrate build owns `../substrate/config.ts`, which does not
 * exist yet. The paths contract is defined here with IDENTICAL names so the
 * memory library compiles and tests standalone.
 *
 * INTEGRATION STEP (when ../substrate/config.ts lands):
 *   1. Delete `AimyPaths` / `resolvePaths` below.
 *   2. Re-export from the substrate file:
 *        export { AimyPaths, resolvePaths } from "../substrate/config.js"
 *   3. Re-run `npx vitest run` from ~/workspace/aimy/core.
 *
 * Contract:
 *   interface AimyPaths { stateDir, memoryDir, sessionsDir, storesDir }
 *   function resolvePaths(): AimyPaths
 *
 * XDG: $XDG_STATE_HOME/aimy, falling back to ~/.local/state/aimy.
 */
import * as os from "node:os"
import * as path from "node:path"

/** Resolved on-disk locations for AImy's state. Shared contract. */
export interface AimyPaths {
  readonly stateDir: string
  readonly memoryDir: string
  readonly sessionsDir: string
  readonly storesDir: string
}

/** Resolve AImy state paths from XDG_STATE_HOME (fallback ~/.local/state). */
export const resolvePaths = (): AimyPaths => {
  const base = process.env["XDG_STATE_HOME"] ?? path.join(os.homedir(), ".local", "state")
  const stateDir = path.join(base, "aimy")
  const memoryDir = path.join(stateDir, "memory")
  return {
    stateDir,
    memoryDir,
    sessionsDir: path.join(memoryDir, "sessions"),
    storesDir: path.join(memoryDir, "stores"),
  }
}
