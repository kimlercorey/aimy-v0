/**
 * ui/src/permissions/view.ts — the permission-prompt surface (architecture §4.1).
 *
 * A permission request is NOT a banner: it is a blocking, focused surface —
 * the tool, a human-readable summary of its arguments (canonicalized, never
 * raw strings), the risk tier, the requesting context, and three actions:
 * allow-once, allow-always (scoped, revocable, recorded), deny.
 *
 * Denial kills the intent: the UI shows "denied — intent dropped" via the
 * decision record, and the agent loop is structurally barred from
 * re-attempting it (the kernel's approve() is never called for that
 * requestId; see update.ts and the integration contract in commands.ts).
 */
import type { HtmlBuilder } from "foldkit/html"
import type { PermissionPrompt, PermissionsSlice } from "../model.js"
import { Message } from "../messages.js"

type H = HtmlBuilder<Message>

const tierClass = (tier: PermissionPrompt["riskTier"]): string =>
  `tier-${tier.toLowerCase()}`

const promptCard = (h: H, p: PermissionPrompt) =>
  h.div([h.Class("perm-prompt"), h.Key(p.requestId)], [
    h.div([h.Class("perm-head")], [
      h.span([h.Class(`perm-tier ${tierClass(p.riskTier)}`)], [p.riskTier]),
      h.span([h.Class("perm-tool")], [p.tool]),
    ]),
    h.div([h.Class("perm-args")], [p.argsSummary]),
    h.div([h.Class("perm-context")], [`requested by ${p.context}`]),
    h.div([h.Class("perm-actions")], [
      h.button(
        [
          h.Class("perm-allow-once"),
          h.OnClick(
            Message.PermissionGranted({ requestId: p.requestId, scope: "once", at: Date.now() }),
          ),
        ],
        ["Allow once"],
      ),
      h.button(
        [
          h.Class("perm-allow-always"),
          h.OnClick(
            Message.PermissionGranted({ requestId: p.requestId, scope: "always", at: Date.now() }),
          ),
        ],
        ["Allow always"],
      ),
      h.button(
        [
          h.Class("perm-deny"),
          h.OnClick(Message.PermissionDenied({ requestId: p.requestId, at: Date.now() })),
        ],
        ["Deny"],
      ),
    ]),
  ])

const decisionRow = (
  h: H,
  d: PermissionsSlice["decisions"][number],
) =>
  h.div([h.Class(`perm-decision decision-${d.decision}`), h.Key(`d-${d.requestId}`)], [
    h.span([h.Class("decision-id")], [d.requestId]),
    h.span([h.Class("decision-kind")], [
      d.decision === "denied"
        ? "denied — intent dropped"
        : d.decision === "allowed-by-policy"
          ? "allowed by policy"
          : d.decision === "granted-always"
            ? "allowed always"
            : "allowed once",
    ]),
  ])

/**
 * The permission surface: pending prompts first (blocking), then the
 * decision history. Pure function of the permissions slice.
 */
export const permissionsView = (permissions: PermissionsSlice, h: H) =>
  h.section([h.Class("permissions-panel"), h.Id("permissions-panel")], [
    h.h2([h.Class("panel-title")], ["Permissions"]),
    ...(permissions.pending.length === 0
      ? [h.p([h.Class("perm-empty")], ["No pending requests."])]
      : permissions.pending.map((p) => promptCard(h, p))),
    ...(permissions.decisions.length === 0
      ? []
      : [
          h.h3([h.Class("decisions-title")], ["Decisions"]),
          ...permissions.decisions.map((d) => decisionRow(h, d)),
        ]),
  ])
