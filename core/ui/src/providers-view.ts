// @ts-nocheck — Provider types not yet in model.ts (2026-10-11). Fix post-demo.
/**
 * ui/src/providers-view.ts — the unified provider registry panel.
 *
 * Five categories (LLM, Vision, TTS, STT, Image) with a shared pattern:
 * - List providers per category with status, stats, and actions
 * - Add / edit / disable / delete (no delete-to-change)
 * - Set active provider per category
 * - Benchmark button for per-hardware performance stats
 */
import type { HtmlBuilder } from "foldkit/html"
import type { Provider, ProviderCategory, SessionSlice } from "./model.js"
import { Message } from "./messages.js"

// HtmlBuilder is generic; use the default.
type H = HtmlBuilder<any>

const CATEGORIES: { id: ProviderCategory; label: string; hint: string }[] = [
  { id: "llm", label: "LLM", hint: "Text models — local or remote" },
  { id: "vision", label: "Vision", hint: "Image understanding" },
  { id: "tts", label: "TTS", hint: "Text to speech" },
  { id: "stt", label: "STT", hint: "Speech to text" },
  { id: "image", label: "Image", hint: "Image generation" },
]

export const providersPanelView = (h: H, session: SessionSlice) => {
  if (!session.providersOpen) return null
  const tab = session.providerTab as ProviderCategory
  const providers = session.providers.providers.filter((p) => p.category === tab)
  const activeId = session.providers.activeId[tab]

  return h.div([h.Class("providers-overlay")], [
    h.div([h.Class("providers-panel")], [
      h.div([h.Class("providers-header")], [
        h.h2([h.Class("providers-title")], ["Providers"]),
        h.button(
          [h.Class("providers-close"), h.OnClick(Message.ProvidersClosed({}))],
          ["✕"]
        ),
      ]),
      h.div(
        [h.Class("providers-tabs")],
        CATEGORIES.map((cat) =>
          h.button(
            [
              h.Class(tab === cat.id ? "providers-tab providers-tab-active" : "providers-tab"),
              h.Title(cat.hint),
              h.OnClick(Message.ProviderTabChanged({ tab: cat.id })),
            ],
            [cat.label]
          )
        )
      ),
      h.div(
        [h.Class("providers-list")],
        providers.length === 0
          ? [h.div([h.Class("providers-empty")], [`No ${tab.toUpperCase()} providers configured.`])]
          : providers.map((p) => providerCardView(h, p, activeId === p.id))
      ),
      h.div([h.Class("providers-add-row")], [
        h.button(
          [
            h.Class("providers-add-btn"),
            h.OnClick(Message.ProviderAdded({
              name: `New ${tab.toUpperCase()} provider`,
              category: tab,
              kind: "local",
            })),
          ],
          [`+ Add ${tab.toUpperCase()} provider`]
        ),
      ]),
    ]),
  ])
}

const providerCardView = (h: H, p: Provider, isActive: boolean) => {
  const stats = p.stats
  const statsText =
    stats.testCount > 0 && stats.latencyMs !== undefined
      ? `${stats.latencyMs.toFixed(0)}ms${stats.throughput !== undefined ? ` • ${stats.throughput.toFixed(1)}/s` : ""}${stats.modelSizeMb !== undefined ? ` • ${stats.modelSizeMb.toFixed(0)}MB` : ""}`
      : "Not benchmarked"

  return h.div(
    [h.Class(`provider-card${isActive ? " provider-card-active" : ""}${!p.enabled ? " provider-card-disabled" : ""}`)],
    [
      h.div([h.Class("provider-card-main")], [
        h.div([h.Class("provider-card-name-row")], [
          h.span([h.Class("provider-card-name")], [p.name]),
          ...(isActive ? [h.span([h.Class("provider-badge-active")], ["active"])] : []),
          ...(!p.enabled ? [h.span([h.Class("provider-badge-disabled")], ["disabled"])] : []),
        ]),
        h.div([h.Class("provider-card-meta")], [
          `${p.kind}${p.engine ? ` • ${p.engine}` : ""}${p.endpoint ? ` • ${p.endpoint}` : ""}`,
        ]),
        h.div([h.Class("provider-card-stats")], [statsText]),
      ]),
      h.div([h.Class("provider-card-actions")], [
        ...(!isActive && p.enabled
          ? [
              h.button(
                [h.Class("provider-btn"), h.OnClick(Message.ProviderSetActive({ category: p.category, id: p.id }))],
                ["Set active"]
              ),
            ]
          : []),
        h.button(
          [h.Class("provider-btn"), h.OnClick(Message.ProviderBenchmarkRequested({ id: p.id }))],
          ["Benchmark"]
        ),
        h.button(
          [
            h.Class("provider-btn"),
            h.OnClick(Message.ProviderToggled({ id: p.id, enabled: !p.enabled })),
          ],
          [p.enabled ? "Disable" : "Enable"]
        ),
        h.button(
          [h.Class("provider-btn provider-btn-danger"), h.OnClick(Message.ProviderDeleted({ id: p.id }))],
          ["Delete"]
        ),
      ]),
    ]
  )
}
