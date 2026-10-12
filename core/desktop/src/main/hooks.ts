/**
 * hooks.ts — user-defined startup/shutdown hooks.
 *
 * The app provides the hook paradigm; the user provides the scripts.
 * This is the sovereignty-aligned extension point: AImy doesn't know
 * about SSH tunnels, VPNs, or any specific setup — it just runs whatever
 * executables the user places in the hook directories.
 *
 * Directories (under ~/.aimy/hooks/):
 * - `startup.d/` — executables run on app boot, before the engine starts.
 *   Run in alphabetical order. A non-zero exit is logged but doesn't
 *   block boot (fail-open for hooks, fail-closed for the engine).
 * - `shutdown.d/` — executables run on app quit, after the engine stops.
 *   Run in alphabetical order. Best-effort; the app quits regardless.
 *
 * Hook scripts receive no arguments and inherit the app's environment.
 * They must be executable (`chmod +x`). Output goes to the main process
 * log with a `[hooks]` prefix.
 *
 * Example: `~/.aimy/hooks/startup.d/10-oma-tunnel.sh`
 * ```sh
 * #!/bin/sh
 * # Ensure OMA SSH tunnel is up before AImy starts.
 * if ! curl -sf http://127.0.0.1:8080/v1/models >/dev/null 2>&1; then
 *   ssh -L 8080:localhost:8080 -N -f -o BatchMode=yes kc@192.168.1.54
 * fi
 * ```
 */
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const hooksDir = (): string => path.join(os.homedir(), ".aimy", "hooks")
const startupDir = (): string => path.join(hooksDir(), "startup.d")
const shutdownDir = (): string => path.join(hooksDir(), "shutdown.d")

/** Ensure the hook directories exist (created on first boot). */
const ensureHookDirs = (): void => {
  for (const dir of [startupDir(), shutdownDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      console.log(`[hooks] created ${dir}`)
      // Drop a README explaining the paradigm.
      const readme = path.join(dir, "README.md")
      if (!fs.existsSync(readme)) {
        const kind = dir.endsWith("startup.d") ? "startup" : "shutdown"
        fs.writeFileSync(readme,
          `# ${kind} hooks\n\n` +
          `Place executable scripts here. They run on app ${kind}, in alphabetical order.\n\n` +
          `Scripts must be executable (\`chmod +x\`). A non-zero exit is logged but doesn't block.\n\n` +
          `Example (\`10-oma-tunnel.sh\`):\n` +
          `\`\`\`sh\n#!/bin/sh\n` +
          `# Ensure SSH tunnel to OMA is up.\n` +
          `if ! curl -sf http://127.0.0.1:8080/v1/models >/dev/null 2>&1; then\n` +
          `  ssh -L 8080:localhost:8080 -N -f -o BatchMode=yes user@192.168.1.54\n` +
          `fi\n\`\`\`\n`,
          { mode: 0o644 }
        )
      }
    }
  }
}

/** List executable files in a hook directory, sorted alphabetically. */
const listHooks = (dir: string): string[] => {
  try {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter((name) => {
        if (name === "README.md") return false
        // Skip editor backups and temp files.
        if (name.endsWith("~") || name.endsWith(".bak") || name.endsWith(".orig") || name.endsWith(".swp")) return false
        const full = path.join(dir, name)
        try {
          const stat = fs.statSync(full)
          if (!stat.isFile()) return false
          // Check executable bit (owner).
          fs.accessSync(full, fs.constants.X_OK)
          return true
        } catch {
          return false
        }
      })
      .sort()
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** Run a single hook script, capturing output. Resolves on completion. */
const runHook = (scriptPath: string, timeoutMs: number = 30000): Promise<{ code: number; output: string }> => {
  return new Promise((resolve) => {
    const name = path.basename(scriptPath)
    console.log(`[hooks] running ${name}...`)

    const child = spawn(scriptPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs
    })

    let output = ""
    child.stdout?.on("data", (data) => { output += data.toString() })
    child.stderr?.on("data", (data) => { output += data.toString() })

    child.on("error", (error) => {
      console.error(`[hooks] ${name} failed to spawn: ${error.message}`)
      resolve({ code: -1, output: error.message })
    })

    child.on("close", (code) => {
      const exitCode = code ?? -1
      if (exitCode === 0) {
        console.log(`[hooks] ${name} completed`)
        // Show hook output so users see what was checked (e.g. tunnel status).
        if (output.trim()) {
          for (const line of output.trim().split("\n").slice(0, 10)) {
            console.log(`[hooks] ${name}: ${line}`)
          }
        }
      } else {
        console.error(`[hooks] ${name} exited with code ${exitCode}`)
        if (output.trim()) console.error(`[hooks] ${name} output: ${output.trim().slice(0, 500)}`)
      }
      resolve({ code: exitCode, output })
    })
  })
}

/**
 * Run all startup hooks. Called during app boot, before the engine starts.
 * Failures are logged but don't block boot — hooks are user-controlled
 * and must not prevent the app from launching.
 */
export const runStartupHooks = async (): Promise<void> => {
  ensureHookDirs()
  const hooks = listHooks(startupDir())
  if (hooks.length === 0) {
    console.log("[hooks] no startup hooks found")
    return
  }
  console.log(`[hooks] running ${hooks.length} startup hook(s)`)
  for (const hook of hooks) {
    await runHook(hook)
  }
}

/**
 * Run all shutdown hooks. Called during app quit, after the engine stops.
 * Best-effort — the app quits regardless of hook outcomes.
 */
export const runShutdownHooks = async (): Promise<void> => {
  const hooks = listHooks(shutdownDir())
  if (hooks.length === 0) return
  console.log(`[hooks] running ${hooks.length} shutdown hook(s)`)
  for (const hook of hooks) {
    await runHook(hook, 10000) // Shorter timeout on shutdown
  }
}
