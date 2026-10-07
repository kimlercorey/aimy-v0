/**
 * desktop/src/ipc/sovereignty.ts — file-backed sovereignty toggle store.
 *
 * Track 2. There is no Effect-service home for the sovereignty toggles (the
 * toggle Model lives in the Foldkit UI layer, `core/ui/src/sovereignty/`);
 * the desktop IPC needs a durable, per-instance store behind
 * `sovereignty.list` / `sovereignty.set`, so this module owns it: a small
 * JSON file at `~/.aimy/sovereignty.json` (mode 0600), keyed exactly like the
 * UI model.
 *
 * Key space:
 * - flat toggles: offlineMode, localInference, updateChecks,
 *   trustedBroadcast, telemetry, lanDiscoverability
 * - per-item toggles: `cloudEndpoint:<id>`, `webRetrieval:<moduleId>`,
 *   `pairSync:<pairId>`
 *
 * Defaults: everything off except local inference (the MoSCoW-verified
 * posture). Unknown keys are rejected — never stored.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { SovereigntyToggle } from "./protocol.js"

const FLAT_KEYS = [
  "offlineMode",
  "localInference",
  "updateChecks",
  "trustedBroadcast",
  "telemetry",
  "lanDiscoverability"
] as const

/** Verified posture: default everything off except local inference. */
const FLAT_DEFAULTS: Readonly<Record<string, boolean>> = {
  offlineMode: false,
  localInference: true,
  updateChecks: false,
  trustedBroadcast: false,
  telemetry: false,
  lanDiscoverability: false
}

const ITEM_KEY_RE = /^(cloudEndpoint|webRetrieval|pairSync):[A-Za-z0-9._-]{1,128}$/

const isKnownKey = (key: string): boolean =>
  (FLAT_KEYS as ReadonlyArray<string>).includes(key) || ITEM_KEY_RE.test(key)

export interface SovereigntyStore {
  /** All flat toggles plus any per-item keys already present in the store. */
  readonly list: () => ReadonlyArray<SovereigntyToggle>
  /** Persist a toggle. Throws on unknown keys or non-boolean values. */
  readonly set: (key: string, value: boolean) => void
}

export const defaultSovereigntyPath = (): string =>
  path.join(os.homedir(), ".aimy", "sovereignty.json")

export const loadSovereigntyStore = (file: string = defaultSovereigntyPath()): SovereigntyStore => {
  const read = (): Record<string, boolean> => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (typeof raw !== "object" || raw === null) return {}
      const out: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "boolean" && isKnownKey(k)) out[k] = v
      }
      return out
    } catch {
      // Missing or corrupt file degrades to defaults — never throws.
      return {}
    }
  }

  let state: Record<string, boolean> = read()

  const write = (): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  }

  return {
    list: () => [
      ...FLAT_KEYS.map((key): SovereigntyToggle => ({ key, enabled: state[key] ?? FLAT_DEFAULTS[key] ?? false })),
      ...Object.keys(state)
        .filter((k) => !(FLAT_KEYS as ReadonlyArray<string>).includes(k))
        .sort()
        .map((key): SovereigntyToggle => ({ key, enabled: state[key] ?? false }))
    ],
    set: (key, value) => {
      if (!isKnownKey(key)) throw new Error(`unknown sovereignty key: ${key}`)
      if (typeof value !== "boolean") throw new Error(`sovereignty value for "${key}" must be a boolean`)
      state = { ...state, [key]: value }
      write()
    }
  }
}
