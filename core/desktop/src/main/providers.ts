/**
 * desktop/src/main/providers.ts — provider registry persistence.
 *
 * Stores the unified provider registry (LLM, vision, TTS, STT, image)
 * in ~/.aimy/providers.json. The renderer loads on startup and saves
 * on every change.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const PROVIDERS_PATH = path.join(os.homedir(), ".aimy", "providers.json")

const DEFAULT_REGISTRY: {
  providers: Array<{
    id: string
    name: string
    category: string
    kind: string
    enabled: boolean
    engine?: string
    endpoint?: string
    config: Record<string, string>
    stats: { testCount: number; latencyMs?: number; throughput?: number; modelSizeMb?: number; lastTestedAt?: number }
  }>
  activeId: Record<string, string | undefined>
} = {
  providers: [],
  activeId: {},
}

/**
 * Migrates existing TTS/STT/LLM configs into the registry on first run.
 * Reads the STT installed.json, TTS engine status, and creates providers.
 */
const migrateExisting = (): typeof DEFAULT_REGISTRY => {
  const providers: Array<{
    id: string
    name: string
    category: string
    kind: string
    enabled: boolean
    engine?: string
    endpoint?: string
    config: Record<string, string>
    stats: { testCount: number }
  }> = []
  const activeId: Record<string, string | undefined> = {}

  // STT: check installed.json
  try {
    const sttMarker = path.join(os.homedir(), ".aimy", "stt-engine", "installed.json")
    if (fs.existsSync(sttMarker)) {
      const marker = JSON.parse(fs.readFileSync(sttMarker, "utf-8"))
      const id = `prov-stt-${Date.now()}`
      providers.push({
        id,
        name: `STT (${marker.engine ?? "parakeet"})`,
        category: "stt",
        kind: "local",
        enabled: true,
        engine: marker.engine,
        config: {},
        stats: { testCount: 0 },
      })
      activeId.stt = id
      console.log("[providers] migrated STT provider:", marker.engine)
    }
  } catch (e) {
    console.error("[providers] STT migration failed:", e)
  }

  // TTS: check installed.json, fallback to venv directory.
  // Engine is Chatterbox Nano (110M) — the current TTS setup.
  try {
    const ttsMarker = path.join(os.homedir(), ".aimy", "tts-engine", "installed.json")
    const ttsVenv = path.join(os.homedir(), ".aimy", "tts-engine", "venv")
    let engineName = "chatterbox-nano-110m"
    if (fs.existsSync(ttsMarker)) {
      const marker = JSON.parse(fs.readFileSync(ttsMarker, "utf-8"))
      engineName = marker.engine ?? "chatterbox-nano-110m"
    } else if (fs.existsSync(ttsVenv)) {
      console.log("[providers] TTS venv found without marker, using chatterbox-nano-110m")
    } else {
      throw new Error("No TTS installation found")
    }
    const id = `prov-tts-${Date.now()}`
    providers.push({
      id,
      name: `TTS (Chatterbox Nano 110M)`,
      category: "tts",
      kind: "local",
      enabled: true,
      engine: engineName,
      config: {},
      stats: { testCount: 0 },
    })
    activeId.tts = id
    console.log("[providers] migrated TTS provider:", engineName)
  } catch (e) {
    console.error("[providers] TTS migration failed:", e)
  }

  // LLM: Splash on :8000 (assumed, from existing setup)
  {
    const id = `prov-llm-${Date.now()}`
    providers.push({
      id,
      name: "LLM (Splash :8000)",
      category: "llm",
      kind: "local",
      enabled: true,
      endpoint: "http://127.0.0.1:8000",
      config: {},
      stats: { testCount: 0 },
    })
    activeId.llm = id
    // Vision: Splash has vision capability
    const visionId = `prov-vision-${Date.now()}`
    providers.push({
      id: visionId,
      name: "Vision (Splash :8000)",
      category: "vision",
      kind: "local",
      enabled: true,
      endpoint: "http://127.0.0.1:8000",
      config: {},
      stats: { testCount: 0 },
    })
    activeId.vision = visionId
    console.log("[providers] migrated LLM/Vision providers (Splash)")
  }

  return { providers, activeId }
}

export const loadProviders = (): unknown => {
  try {
    if (!fs.existsSync(PROVIDERS_PATH)) {
      console.log("[providers] no registry file, migrating existing configs")
      const migrated = migrateExisting()
      saveProviders(migrated)
      return migrated
    }
    const raw = fs.readFileSync(PROVIDERS_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    const count = parsed.providers?.length ?? 0
    console.log(`[providers] loaded ${count} providers`)
    // If the registry is empty but we have installed engines, migrate.
    // (Handles the case where an empty registry was saved before migration.)
    if (count === 0) {
      console.log("[providers] registry empty, attempting migration")
      const migrated = migrateExisting()
      if (migrated.providers.length > 0) {
        saveProviders(migrated)
        return migrated
      }
    }
    return parsed
  } catch (e) {
    console.error("[providers] load failed, returning defaults:", e)
    return DEFAULT_REGISTRY
  }
}

export const saveProviders = (registry: unknown): void => {
  try {
    const dir = path.dirname(PROVIDERS_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(registry, null, 2), "utf-8")
    console.log("[providers] saved registry")
  } catch (e) {
    console.error("[providers] save failed:", e)
    throw e
  }
}
