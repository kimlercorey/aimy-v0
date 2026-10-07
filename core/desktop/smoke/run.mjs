/**
 * desktop/smoke/run.mjs — M10 Linux smoke-test orchestrator (Track 3).
 *
 * Usage (from ~/workspace/aimy/core):
 *   node desktop/smoke/run.mjs [--no-sandbox]
 *
 * What it does:
 *  1. Creates an isolated HOME + XDG dirs under the system temp dir, so the
 *     smoke run never touches the real ~/.aimy.
 *  2. Starts the stub OpenAI-compatible SSE server (in-process) on
 *     127.0.0.1:18000.
 *  3. Launches the BUILT app (`dist/desktop/src/main/main.js`) under
 *     `xvfb-run` with `--smoke-test`. The main process boots the real
 *     engine (pointed at the stub), registers Track 2's real IPC handlers,
 *     and the smoke driver (in main) drives the real renderer through the
 *     DOM: onboarding → chat stream → ASC dials → export wizard →
 *     screenshot.
 *  4. While the app runs, samples `ss -tnp` for the app's process tree and
 *     asserts every established TCP peer is loopback — the packaged app
 *     must make no network calls except the configured model endpoint.
 *  5. Reports per-check results + the network verdict; exits non-zero on
 *     any failure.
 *
 * Prerequisites: `npm run dist` (or at least `npm run build`,
 * `npm run desktop:preload`, and the vite renderer build) must have run so
 * `dist/` is complete.
 */
import { spawn, execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { startStubServer, requests, STUB_URL } from "./stub-server.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = path.resolve(HERE, "..", "..")
const MAIN_JS = path.join(CORE, "dist", "desktop", "src", "main", "main.js")
const ELECTRON_BIN = path.join(CORE, "node_modules", ".bin", "electron")
const SMOKE_DIR = path.join(CORE, "desktop", "smoke")

const noSandbox = process.argv.includes("--no-sandbox")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** All pids in the process tree rooted at `rootPid` (Linux /proc walk). */
const treePids = (rootPid) => {
  const pids = new Set([rootPid])
  try {
    for (const dir of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(dir)) continue
      const pid = Number(dir)
      try {
        const stat = fs.readFileSync(`/proc/${dir}/stat`, "utf8")
        const ppid = Number(stat.split(" ")[3])
        if (pids.has(ppid)) pids.add(pid)
      } catch {
        /* raced exit */
      }
    }
  } catch {
    /* /proc unavailable */
  }
  return pids
}

const ssOutput = () =>
  new Promise((resolve) => {
    execFile("ss", ["-tnp"], { timeout: 5000 }, (error, stdout) => {
      resolve(error ? "" : stdout)
    })
  })

/** Sample established TCP peers of the app tree; return non-loopback hits. */
const checkLoopbackOnly = async (pids) => {
  const out = await ssOutput()
  const hits = []
  for (const line of out.split("\n")) {
    if (!line.includes("ESTAB")) continue
    const pidMatch = line.match(/pid=(\d+)/)
    if (pidMatch === null || !pids.has(Number(pidMatch[1]))) continue
    const cols = line.trim().split(/\s+/)
    // ss -tn: State Recv-Q Send-Q Local:Port Peer:Port Process
    const peer = cols[4] ?? ""
    const host = peer.includes("[") ? peer.slice(0, peer.lastIndexOf("]") + 1) : peer.split(":")[0]
    const loopback = host === "127.0.0.1" || host === "::1" || host.startsWith("127.")
    if (!loopback) hits.push(peer)
  }
  return hits
}

const main = async () => {
  for (const f of [MAIN_JS, ELECTRON_BIN]) {
    if (!fs.existsSync(f)) {
      console.error(`smoke: missing ${f} — run \`npm run dist\` first`)
      process.exit(2)
    }
  }

  // A previous killed run can orphan a stub server on the port; free it first.
  try {
    const { execSync } = await import("node:child_process")
    const out = execSync("ss -tlnp 2>/dev/null | grep '127.0.0.1:18000' || true").toString()
    for (const m of out.matchAll(/pid=(\d+)/g)) {
      try {
        process.kill(Number(m[1]), "SIGKILL")
        console.log(`smoke: killed stale port-18000 holder pid ${m[1]}`)
      } catch {
        /* already gone */
      }
    }
    if (out.includes("127.0.0.1:18000")) await sleep(1000)
  } catch {
    /* ss unavailable — the listen will fail loudly if occupied */
  }

  // Isolated home: the smoke run must not touch the real ~/.aimy.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-smoke-home-"))
  const xdg = (name) => {
    const dir = path.join(fakeHome, name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
  const env = {
    ...process.env,
    HOME: fakeHome,
    XDG_DATA_HOME: xdg("data"),
    XDG_CONFIG_HOME: xdg("config"),
    XDG_STATE_HOME: xdg("state"),
    AIMY_SMOKE_DIR: SMOKE_DIR
  }

  const server = await startStubServer()
  console.log(`smoke: stub model server on ${STUB_URL}`)
  console.log(`smoke: isolated HOME=${fakeHome}`)

  const args = ["-a", ELECTRON_BIN, MAIN_JS, "--smoke-test"]
  if (noSandbox) args.splice(3, 0, "--no-sandbox")
  console.log(`smoke: xvfb-run ${args.join(" ")}`)
  const child = spawn("xvfb-run", args, { cwd: CORE, env, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`))
  child.stderr.on("data", (d) => process.stderr.write(`[app:err] ${d}`))

  // Network watch: every established peer of the app tree must be loopback.
  const violations = []
  const netWatch = (async () => {
    for (;;) {
      await sleep(2000)
      if (child.exitCode !== null) break
      const pids = treePids(child.pid)
      for (const peer of await checkLoopbackOnly(pids)) violations.push(peer)
    }
  })()

  const exitCode = await new Promise((resolve) => child.on("exit", resolve))
  await netWatch
  server.close()

  console.log(`smoke: app exited with code ${exitCode}`)
  console.log(`smoke: stub saw ${requests.length} request(s): ${requests.map((r) => `${r.method} ${r.path}`).join(", ")}`)

  let results = null
  try {
    results = JSON.parse(fs.readFileSync(path.join(SMOKE_DIR, "smoke-results.json"), "utf8"))
  } catch {
    console.error("smoke: no smoke-results.json — the driver never finished")
  }

  const netOk = violations.length === 0
  console.log(`smoke: network check (loopback only): ${netOk ? "ok" : `FAIL — non-loopback peers: ${[...new Set(violations)].join(", ")}`}`)

  const pass = exitCode === 0 && results !== null && results.pass === true && netOk && requests.length > 0
  console.log(`smoke: ${pass ? "PASS" : "FAIL"}`)
  // Leave the fake home for inspection; it is under the temp dir.
  process.exit(pass ? 0 : 1)
}

main().catch((error) => {
  console.error(`smoke: orchestrator failed: ${error?.stack ?? String(error)}`)
  process.exit(2)
})
