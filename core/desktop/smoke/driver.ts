/**
 * desktop/smoke/driver.ts — the M10 Linux smoke-test driver (Track 3).
 *
 * Runs ONLY under `electron --smoke-test` (see `src/main/main.ts`). It drives
 * the REAL packaged renderer through the DOM — the same UI a user sees —
 * against the REAL main-process engine and Track 2's REAL IPC handlers,
 * with the model endpoint pointed at the stub SSE server:
 *
 *   1. onboarding: welcome → identity → endpoint (typed stub URL) →
 *      sovereignty defaults → done; asserts `config.set` persisted the URL.
 *   2. chat: types into the composer, sends, waits for the streamed
 *      assistant reply through the real engine → asserts the stub's text.
 *   3. ASC: asserts the dial panel rendered the 4-dial vector via IPC.
 *   4. export: runs the wizard to a destination dir; asserts the verified
 *      receipt renders (the main side ran the real exportData + verifyBundle
 *      and returned the receipt over IPC).
 *   5. captures a screenshot via `win.capturePage()`.
 *
 * Results (per-check pass/fail + the screenshot path) are written to
 * `<outDir>/smoke-results.json`; the PNG to `<outDir>/smoke.png`.
 */
import type { BrowserWindow } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"

export interface SmokeCheck {
  readonly name: string
  readonly pass: boolean
  readonly detail?: string | undefined
}

export interface SmokeResults {
  readonly pass: boolean
  readonly checks: ReadonlyArray<SmokeCheck>
  readonly screenshot: string
}

export interface SmokeOptions {
  /** Directory for smoke.png + smoke-results.json. */
  readonly outDir: string
  /** The temp desktop.json the smoke engine boots from (asserted after onboarding). */
  readonly configFile: string
  /** The stub model URL typed into onboarding. */
  readonly stubUrl: string
  /** Where the export wizard writes its destination. */
  readonly exportDestDir: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Append a timestamped line to the progress log (tail -f this during the run). */
const makeLogger = (outDir: string) => (message: string): void => {
  try {
    fs.mkdirSync(outDir, { recursive: true })
    fs.appendFileSync(
      path.join(outDir, "smoke-progress.log"),
      `${new Date().toISOString()} ${message}\n`
    )
  } catch {
    /* logging never fails the smoke test */
  }
  console.log(`smoke-driver: ${message}`)
}

/** Evaluate JS in the renderer and return the JSON-serializable result. */
const makeEval = (win: BrowserWindow) => (expression: string): Promise<unknown> =>
  win.webContents.executeJavaScript(expression, true) as Promise<unknown>

type Js = (expression: string) => Promise<unknown>

const asBoolean = async (js: Js, expression: string): Promise<boolean> =>
  (await js(`Boolean(${expression})`)) === true

const waitFor = async (
  js: Js,
  expression: string,
  label: string,
  timeoutMs = 60_000
): Promise<void> => {
  const start = Date.now()
  for (;;) {
    if (await asBoolean(js, expression)) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`smoke: timed out waiting for ${label}`)
    }
    await sleep(250)
  }
}

/** Click the first button whose text contains `label` (scoped selector optional). */
const clickButton = (label: string, scope = "document"): string =>
  `(() => { const btns = [...${scope}.querySelectorAll('button')]; const b = btns.find((x) => (x.textContent || '').includes(${JSON.stringify(label)})); if (!b) return 'missing'; b.click(); return 'clicked'; })()`

/** Set a text input's value and fire the input event foldkit listens to. */
const setInput = (selector: string, value: string): string =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return 'set'; })()`

const textOf = (selector: string): string =>
  `((document.querySelector(${JSON.stringify(selector)}) || {}).textContent || '')`

export const runSmokeTest = async (
  win: BrowserWindow,
  opts: SmokeOptions
): Promise<SmokeResults> => {
  const js = makeEval(win)
  const log = makeLogger(opts.outDir)
  const checks: Array<SmokeCheck> = []
  const check = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass, ...(detail !== undefined ? { detail } : {}) })
    log(`${pass ? "ok  " : "FAIL"} - ${name}${detail !== undefined ? ` (${detail})` : ""}`)
  }

  // ── 0. the app booted and rendered ──────────────────────────────────────
  // NOTE: foldkit's Runtime replaces the #root container with the app tree,
  // so check for the shell (or a boot error), not #root itself.
  log("waiting for app render…")
  await waitFor(
    js,
    `document.querySelector('.app') !== null || document.querySelector('.boot-error') !== null`,
    "app render"
  )
  const bootFailed = await asBoolean(js, `document.querySelector('.boot-error') !== null`)
  if (bootFailed) {
    const msg = String(await js(`document.querySelector('.boot-error').textContent`))
    throw new Error(`renderer boot error: ${msg.slice(0, 500)}`)
  }
  check("window renders", true)

  // ── 1. onboarding → config.set ──────────────────────────────────────────
  log("waiting for onboarding…")
  await waitFor(js, `document.querySelector('.onboarding')`, "onboarding")
  check("onboarding shown on first run", true)

  log("onboarding: Begin →")
  await js(clickButton("Begin"))
  await waitFor(js, `document.body.textContent.includes('What should AImy call you?')`, "identity step")
  log("onboarding: identity Continue →")
  await js(clickButton("Continue"))
  await waitFor(js, `document.body.textContent.includes('Point AImy at your local model.')`, "endpoint step")
  log(`onboarding: typing endpoint ${opts.stubUrl}`)
  const setResult = await js(setInput(".onboarding input", opts.stubUrl))
  check("endpoint input settable", setResult === "set", String(setResult))
  await js(clickButton("Continue"))
  await waitFor(js, `document.body.textContent.includes('Everything stays home')`, "sovereignty step")
  log("onboarding: confirming defaults →")
  await js(clickButton("These are my defaults"))
  await waitFor(js, `document.body.textContent.includes('It was there.')`, "onboarding done")
  log("onboarding complete")

  // The completion fired ApplyInitialConfig → config.set over IPC. Give the
  // command a moment, then read the file the main process wrote.
  await sleep(1500)
  let configOk = false
  let configDetail = ""
  try {
    const raw = JSON.parse(fs.readFileSync(opts.configFile, "utf8")) as { baseUrl?: unknown }
    configOk = raw.baseUrl === opts.stubUrl
    configDetail = `baseUrl=${JSON.stringify(raw.baseUrl)}`
  } catch (error) {
    configDetail = `config unreadable: ${String(error)}`
  }
  check("onboarding persisted endpoint via config.set", configOk, configDetail)

  // ── 2. chat streams end-to-end through the real engine ──────────────────
  log("waiting for chat composer…")
  await waitFor(js, `document.querySelector('.composer-input')`, "chat composer")
  const composerSet = await js(setInput(".composer-input", "Hello smoke test — reply briefly."))
  check("composer input settable", composerSet === "set", String(composerSet))
  // The send button enables only after the draft reaches the model (async).
  // The OnClick closure captures the draft at render time, so wait a beat
  // after enable for the vdom patch — clicking too early sends empty text,
  // which UserSentMessage ignores.
  await waitFor(
    js,
    `(() => { const b = document.querySelector('.composer-send'); return b !== null && !b.disabled })()`,
    "composer send enabled"
  )
  await sleep(1000)
  log("chat: sending message…")
  await js(`document.querySelector('.composer-send').click()`)
  // Confirm the message actually dispatched (not swallowed as empty).
  await waitFor(
    js,
    `document.querySelector('.streaming') !== null || Array.from(document.querySelectorAll('.message-user')).some(m => m.textContent.includes('smoke test'))`,
    "message dispatched",
    15_000
  )
  // The first token can take a while: the engine builds the agent loop and
  // the stub model responds; tool-rounds (if the model calls tools) add more.
  await waitFor(js, `document.querySelector('.streaming')`, "streaming started", 90_000)
  check("stream started", true)
  log("chat: streaming…")
  await waitFor(
    js,
    `!document.querySelector('.streaming') && document.body.textContent.includes('smoke stub')`,
    "streamed assistant reply",
    120_000
  )
  check("chat streams end-to-end through the real engine", true)
  log("chat complete")

  // ── 3. ASC panel shows dials ────────────────────────────────────────────
  const dialCount = (await js(`document.querySelectorAll('.dial-value').length`)) as number
  check("ASC panel shows dials", dialCount === 4, `dial-value elements: ${dialCount}`)

  // ── 4. export wizard runs to a verified receipt ─────────────────────────
  log("export: opening wizard…")
  await js(clickButton("Choose destination"))
  await waitFor(js, `document.querySelector('.export-destination input')`, "export destination step")
  fs.mkdirSync(opts.exportDestDir, { recursive: true })
  const destSet = await js(setInput(".export-destination input", opts.exportDestDir))
  check("export destination settable", destSet === "set", String(destSet))
  // The Export button enables only after the model absorbs the input (async
  // through the foldkit runtime) — wait for it, or the click hits a disabled
  // button and the export never starts.
  await waitFor(
    js,
    `(() => { const b = Array.from(document.querySelectorAll('.export-destination button')).find(x => x.textContent.trim() === 'Export'); return b !== undefined && !b.disabled })()`,
    "export button enabled"
  )
  log(`export: running to ${opts.exportDestDir}…`)
  await js(clickButton("Export", `document.querySelector('.export-destination')`))
  // The receipt appears on success; a failure panel appears on failure.
  // Either one ends the wait — then assert which one it was.
  await waitFor(
    js,
    `document.querySelector('.export-receipt') !== null || document.querySelector('.export-failed') !== null || document.querySelector('.export-error') !== null`,
    "export finished (receipt or failure)",
    180_000
  )
  const failed = await asBoolean(
    js,
    `document.querySelector('.export-failed') !== null || document.querySelector('.export-error') !== null`
  )
  if (failed) {
    const reason = String(
      await js(
        `((document.querySelector('.export-failed .error-reason') || document.querySelector('.export-error'))?.textContent ?? '').slice(0, 500)`
      )
    )
    check("export wizard completes with verified receipt", false, `export failed: ${reason}`)
  } else {
    const verified = await asBoolean(js, `document.querySelector('.export-receipt .verified-badge')`)
    check("export wizard completes with verified receipt", verified)
  }
  log("export complete")

  // ── 5. screenshot ───────────────────────────────────────────────────────
  // Always capture, even if an earlier step failed — a screenshot of the
  // failure state is more useful than no screenshot.
  try {
    fs.mkdirSync(opts.outDir, { recursive: true })
    const image = await win.capturePage()
    const screenshotPath = path.join(opts.outDir, "smoke.png")
    fs.writeFileSync(screenshotPath, image.toPNG())
    check("screenshot captured", true, screenshotPath)
  } catch (error) {
    check("screenshot captured", false, String(error))
  }

  const pass = checks.every((c) => c.pass)
  return { pass, checks, screenshot: path.join(opts.outDir, "smoke.png") }
}

/**
 * runSmokeTest, but a step failure records a failed check and continues to
 * the screenshot instead of throwing past it. The orchestrator always gets
 * results + a screenshot.
 */
export const runSmokeTestSafe = async (
  win: BrowserWindow,
  opts: SmokeOptions
): Promise<SmokeResults> => {
  try {
    return await runSmokeTest(win, opts)
  } catch (error) {
    const screenshotPath = path.join(opts.outDir, "smoke.png")
    try {
      fs.mkdirSync(opts.outDir, { recursive: true })
      const image = await win.capturePage()
      fs.writeFileSync(screenshotPath, image.toPNG())
    } catch {
      /* screenshot best-effort */
    }
    return {
      pass: false,
      checks: [{ name: "smoke flow completed without throwing", pass: false, detail: String(error) }],
      screenshot: screenshotPath
    }
  }
}
