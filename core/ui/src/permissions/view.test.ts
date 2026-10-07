/**
 * permissions/view.test.ts — the permission-prompt surface renders the tool,
 * args summary, risk tier, and requesting context, with the three actions.
 */
import { describe, expect, it } from "@effect/vitest"
import { inertHtml } from "foldkit/html"
import type { HtmlBuilder } from "foldkit/html"
import type { Message } from "../messages.js"
import { initialModel } from "../model.js"
import { serializeHtml } from "../rendering.js"
import { permissionsView } from "./view.js"

// inertHtml is the framework's process-wide builder singleton retyped to
// `never`; the markup it builds is identical to the live builder's. The cast
// recovers this test's Message universe (documented use, not a backdoor).
const h = inertHtml as unknown as HtmlBuilder<Message>

describe("permissionsView", () => {
  it("renders the tool, args summary, risk tier, and context", () => {
    const permissions = {
      ...initialModel().permissions,
      pending: [
        {
          requestId: "r1",
          tool: "exec",
          argsSummary: '{"cmd":"ls /tmp"}',
          riskTier: "T2" as const,
          context: "agent-loop:turn-3",
          at: 1,
        },
      ],
    }
    const tree = serializeHtml(permissionsView(permissions, h))
    expect(tree).toContain("exec")
    expect(tree).toContain("ls /tmp")
    expect(tree).toContain("T2")
    expect(tree).toContain("agent-loop:turn-3")
    expect(tree).toContain("Allow once")
    expect(tree).toContain("Allow always")
    expect(tree).toContain("Deny")
  })

  it("shows the empty state when nothing is pending", () => {
    const tree = serializeHtml(permissionsView(initialModel().permissions, h))
    expect(tree).toContain("No pending requests.")
  })

  it("shows denied intents as dropped in the decision history", () => {
    const permissions = {
      ...initialModel().permissions,
      decisions: [{ requestId: "r9", decision: "denied" as const, at: 2 }],
    }
    const tree = serializeHtml(permissionsView(permissions, h))
    expect(tree).toContain("denied — intent dropped")
  })
})
