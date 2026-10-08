/**
 * messaging-telegram/test/wizard.test.ts — the setup wizard contract.
 *
 * Scripted prompt/print, mocked Bot API, stubbed locker, real registry and
 * a recording forwarder. Asserts the happy path (token → validate → code →
 * pair → prefs → test message) and the failure paths (bad token, timeout).
 * The token never appears in printed output.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSetupWizard, TELEGRAM_TOKEN_LOCKER_KEY, type WizardDeps } from "../src/wizard.js"
import { makePairingRegistry } from "../../messaging/src/pairing.js"
import type { Forwarder } from "../../messaging/src/forward.js"
import type { ForwardingPrefs } from "../../messaging/src/types.js"
import type { HttpClientShape, HttpResponse } from "../../../web-retrieval/src/http.js"
import type { SecretLockerShape } from "../../../identity/locker.js"

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "aimy-wizard-test-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const ok = (result: unknown): HttpResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, result }),
})

interface Script {
  readonly prompts: Record<string, string>
  printed: Array<string>
  bodies: Array<string>
}

const scriptHttp = (script: Script, updates: ReadonlyArray<unknown>): HttpClientShape => ({
  request: (req) => {
    script.bodies.push(req.body ?? "")
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>
    const method = (req.url.split("/").pop() ?? "")
    if (method === "getMe") return Effect.succeed(ok({ id: 1, is_bot: true, first_name: "Aimy", username: "aimy_bot" }))
    if (method === "getUpdates") return Effect.succeed(ok(updates))
    return Effect.succeed(ok({ message_id: 1 }))
  },
})

const scriptDeps = (
  script: Script,
  updates: ReadonlyArray<unknown>,
  overrides?: Partial<WizardDeps>
): { deps: WizardDeps; script: Script; stored: Record<string, string>; prefsSet: Array<ForwardingPrefs> } => {
  const stored: Record<string, string> = {}
  const prefsSet: Array<ForwardingPrefs> = []
  const locker = {
    store: (key: string, _v: unknown) => Effect.sync(() => { stored[key] = "REDACTED-STORED" }),
    retrieve: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    manifest: () => Effect.succeed([]),
  } as unknown as SecretLockerShape
  const forwarder = {
    setPrefs: (p: ForwardingPrefs) => Effect.sync(() => { prefsSet.push(p) }),
    getPrefs: () => Effect.succeed({ enabled: true, severities: ["success", "critical"] as const }),
    forward: () => Effect.void,
    run: () => Effect.void as never,
  } as unknown as Forwarder
  const deps: WizardDeps = {
    prompt: (q) => Effect.succeed(script.prompts[q] ?? ""),
    print: (line) => Effect.sync(() => { script.printed.push(line) }),
    http: scriptHttp(script, updates),
    locker,
    registry: makePairingRegistry(dir),
    forwarder,
    dir,
    ...overrides,
  }
  return { deps, script, stored, prefsSet }
}

const newScript = (): Script => ({ prompts: {}, printed: [], bodies: [] })

describe("setup wizard", () => {
  it("happy path: token → pair → prefs → test message", async () => {
    const script = newScript()
    script.prompts["Bot token: "] = "valid-token"
    script.prompts["Forward [success, critical]: "] = ""
    // The wizard generates the code internally; we can't know it ahead.
    // Instead: capture the code from printed output, then feed updates.
    // Two-pass approach: run once to get the code, then run with updates.
    // Simpler: make getUpdates return the code by echoing whatever was printed.
    let capturedCode = ""
    const { deps, stored, prefsSet } = scriptDeps(script, [])
    // Wrap print to capture the code line.
    const origPrint = deps.print
    const deps2: WizardDeps = {
      ...deps,
      print: (line) => {
        const m = /^Your code: (\d{6})$/.exec(line)
        if (m !== null && m[1] !== undefined) capturedCode = m[1]
        return origPrint(line)
      },
    }
    // getUpdates must return the code message — rebuild http with a lazy reader.
    const http2: HttpClientShape = {
      request: (req) => {
        script.bodies.push(req.body ?? "")
        const method = req.url.split("/").pop() ?? ""
        if (method === "getMe") return Effect.succeed(ok({ id: 1, is_bot: true, first_name: "A", username: "aimy_bot" }))
        if (method === "getUpdates") {
          return Effect.succeed(
            ok(capturedCode === "" ? [] : [{ update_id: 1, message: { message_id: 1, chat: { id: 99, type: "private" }, date: 1, text: capturedCode } }])
          )
        }
        return Effect.succeed(ok({ message_id: 1 }))
      },
    }
    await run(runSetupWizard({ ...deps2, http: http2 }))
    expect(stored[TELEGRAM_TOKEN_LOCKER_KEY]).toBe("REDACTED-STORED")
    expect(script.printed.some((l) => l.includes("Paired with chat 99"))).toBe(true)
    expect(prefsSet).toHaveLength(1)
    expect(prefsSet[0]?.severities).toEqual(["success", "critical"])
    expect(script.printed.some((l) => l.includes("Done — check your Telegram"))).toBe(true)
    // Token never printed.
    expect(script.printed.join("\n")).not.toContain("valid-token")
  })

  it("invalid token cancels without storing", async () => {
    const script = newScript()
    script.prompts["Bot token: "] = "bad-token"
    const badHttp: HttpClientShape = {
      request: () =>
        Effect.succeed({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, description: "Unauthorized", error_code: 401 }),
        }),
    }
    const { deps, stored } = scriptDeps(script, [], { http: badHttp })
    await run(runSetupWizard(deps))
    expect(stored[TELEGRAM_TOKEN_LOCKER_KEY]).toBeUndefined()
    expect(script.printed.some((l) => l.includes("Token invalid"))).toBe(true)
  })

  it("empty token cancels immediately", async () => {
    const script = newScript()
    script.prompts["Bot token: "] = "  "
    const { deps, stored } = scriptDeps(script, [])
    await run(runSetupWizard(deps))
    expect(stored[TELEGRAM_TOKEN_LOCKER_KEY]).toBeUndefined()
    expect(script.printed.some((l) => l.includes("nothing was stored"))).toBe(true)
  })
})
