/**
 * app.test.ts — the shell wiring: init/view/subscriptions exports and the
 * no-auto-boot contract (importing app.ts must never start a runtime —
 * entry.ts owns booting, per the Foldkit README pattern).
 */
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { inertHtml } from "foldkit/html"
import type { HtmlBuilder } from "foldkit/html"
import { init, makeShellApplication, subscriptions, view } from "./app.js"
import type { Message } from "./messages.js"
import { Model } from "./model.js"
import { serializeHtml } from "./rendering.js"

// inertHtml is the framework's process-wide builder singleton retyped to
// `never`; the markup it builds is identical to the live builder's. The cast
// recovers this test's Message universe (documented use, not a backdoor).
const h = inertHtml as unknown as HtmlBuilder<Message>

describe("app wiring", () => {
  it("init produces a valid Model", () => {
    const { model } = init()
    expect(() => Schema.decodeUnknownSync(Model)(model)).not.toThrow()
  })

  it("view renders the shell: chat panel + permissions panel", () => {
    const { model } = init()
    const tree = serializeHtml(view(model, h).body)
    expect(tree).toContain("AImy")
    expect(tree).toContain("chat-panel")
    expect(tree).toContain("permissions-panel")
  })

  it("exposes the inferenceStream subscription", () => {
    expect(Object.keys(subscriptions)).toContain("inferenceStream")
  })

  it("makeShellApplication builds without booting (no side effects on import)", () => {
    // makeApplication probes `document` for hydration markers at build time,
    // so the test installs a minimal stub. Crucially, importing app.ts above
    // never booted a runtime — Runtime.run lives only in entry.ts.
    const prior = (globalThis as Record<string, unknown>)["document"]
    const stubDocument = {
      querySelectorAll: () => [],
      querySelector: () => null,
    }
    ;(globalThis as Record<string, unknown>)["document"] = stubDocument
    const stubContainer = {
      closest: () => null,
      hasAttribute: () => false,
      ownerDocument: stubDocument,
    }
    try {
      const app = makeShellApplication(stubContainer)
      expect(app).toBeDefined()
    } finally {
      if (prior === undefined) delete (globalThis as Record<string, unknown>)["document"]
      else (globalThis as Record<string, unknown>)["document"] = prior
    }
  })
})
