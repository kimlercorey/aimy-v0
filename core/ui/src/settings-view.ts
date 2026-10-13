// @ts-nocheck — Provider types not yet in model.ts (2026-10-11). Fix post-demo.
/**
 * ui/src/settings-view.ts — the Settings panel.
 *
 * Currently hosts the unified provider registry (LLM, Vision, TTS, STT,
 * Image). More global app settings can live here later.
 */
import type { HtmlBuilder } from "foldkit/html"
import type { HomedashSetting, Provider, ProviderCategory, SessionSlice } from "./model.js"
import { Message } from "./messages.js"

type H = HtmlBuilder<any>

const CATEGORIES: { id: ProviderCategory; label: string; hint: string }[] = [
  { id: "llm", label: "LLM", hint: "Text models — local or remote" },
  { id: "vision", label: "Vision", hint: "Image understanding" },
  { id: "tts", label: "TTS", hint: "Text to speech" },
  { id: "stt", label: "STT", hint: "Speech to text" },
  { id: "image", label: "Image", hint: "Image generation" },
]

/** Known engines per category (for the dropdown). */
const KNOWN_ENGINES: Record<string, string[]> = {
  llm: ["Ollama", "LM Studio", "vLLM", "llama.cpp", "Splash", "Custom"],
  vision: ["Ollama", "LM Studio", "vLLM", "Splash", "Custom"],
  tts: ["Chatterbox", "Piper", "Coqui", "Custom"],
  stt: ["Parakeet MLX", "Whisper", "Faster-Whisper", "Custom"],
  image: ["A1111", "ComfyUI", "Custom"],
}

/** Default ports for known remote services. */
const KNOWN_PORTS: Record<string, number> = {
  Ollama: 11434,
  "LM Studio": 1234,
  vLLM: 8000,
  Splash: 8000,
  "llama.cpp": 8080,
  A1111: 7860,
  ComfyUI: 8188,
}

/**
 * The HomeDash section (2026-10-13): settings TRANSPOSITION — each
 * widget declared its settings in its manifest; this section renders
 * them generically (slider / toggle / select / number). Priority is
 * a first-class row on every widget: it is the screen depth on the
 * dash stage, 1–1000, higher on top. Every change round-trips
 * through the store (ApplyHomedashSetting) — the control never
 * becomes the truth.
 */
const homeDashSettingsView = (h: H, session: SessionSlice) => {
  const dash = session.drawer.dash
  const change = (widgetId: string, key: string, value: string | number | boolean) =>
    Message.HomedashSettingChanged({ widgetId, key, value })
  if (dash === undefined) {
    return h.div([h.Class("settings-section")], [
      h.h2([h.Class("settings-title")], ["HomeDash"]),
      h.p([h.Class("settings-sub")], [
        "Widget settings load with the dash — open Home once and this section fills in.",
      ]),
    ])
  }
  const control = (widgetId: string, s: HomedashSetting) => {
    switch (s.type) {
      case "toggle":
        return h.button(
          [
            h.Class(`dash-toggle${s.value === true ? " on" : ""}`),
            h.OnClick(change(widgetId, s.key, s.value !== true)),
          ],
          [s.value === true ? "On" : "Off"]
        )
      case "slider":
        return h.span([h.Class("dash-slider-wrap")], [
          h.input([
            h.Class("dash-slider"),
            h.Type("range"),
            h.Min(String(s.min ?? 0)),
            h.Max(String(s.max ?? 100)),
            h.Step(String(s.step ?? 1)),
            h.Value(String(s.value)),
            h.OnInput((v: string) => {
              const n = Number(v)
              return change(widgetId, s.key, Number.isFinite(n) ? n : (s.value as number))
            }),
          ]),
          h.span([h.Class("dash-slider-value")], [String(s.value)]),
        ])
      case "select":
        return h.select(
          [
            h.Class("dash-select"),
            h.Value(String(s.value)),
            h.OnInput((v: string) => change(widgetId, s.key, v)),
          ],
          (s.options ?? []).map((o) => h.option([h.Value(o)], [o]))
        )
      default:
        return h.input([
          h.Class("dash-number"),
          h.Value(String(s.value)),
          h.OnInput((v: string) => {
            const n = Number(v)
            return change(widgetId, s.key, v.trim() !== "" && Number.isFinite(n) ? n : s.value)
          }),
        ])
    }
  }
  return h.div([h.Class("settings-section")], [
    h.h2([h.Class("settings-title")], ["HomeDash"]),
    h.p([h.Class("settings-sub")], [
      "Widgets declare their settings; the platform presents them. Priority is screen depth — higher sits on top where widgets overlap.",
    ]),
    ...[...dash.widgets]
      .sort((a, b) => b.priority - a.priority)
      .map((w) =>
        h.div([h.Class("dash-widget-card")], [
          h.div([h.Class("dash-widget-head")], [
            h.span([h.Class("dash-widget-name")], [w.name]),
            h.span([h.Class("dash-widget-version")], [`v${w.version}`]),
          ]),
          ...(w.description !== "" ? [h.p([h.Class("dash-widget-desc")], [w.description])] : []),
          h.div([h.Class("dash-setting-row")], [
            h.label([h.Class("dash-setting-label")], ["Priority (depth)"]),
            control(w.id, {
              key: "priority",
              type: "slider",
              label: "Priority (depth)",
              value: w.priority,
              min: 1,
              max: 1000,
              step: 1,
            }),
          ]),
          ...w.settings.map((s) =>
            h.div([h.Class("dash-setting-row")], [
              h.label([h.Class("dash-setting-label")], [s.label]),
              control(w.id, s),
            ])
          ),
        ])
      ),
  ])
}

export const settingsView = (h: H, session: SessionSlice) => {
  const tab = session.providerTab as ProviderCategory
  const providers = session.providers.providers.filter((p) => p.category === tab)
  const activeId = session.providers.activeId[tab]
  const editingId = (session as { editingProviderId?: string }).editingProviderId
  const draft = (session as { editingDraft?: { name: string; endpoint: string; engine: string } }).editingDraft ?? {
    name: "",
    endpoint: "",
    engine: "",
  }
  const testResults = (session as { providerTestResults?: Record<string, string> }).providerTestResults ?? {}
  const adding = (session as { addingProvider?: boolean }).addingProvider ?? false
  const addDraft = (session as { addDraft?: { name: string; kind: string; engine: string; host: string; port: string } }).addDraft ?? {
    name: "",
    kind: "local",
    engine: "",
    host: "",
    port: "",
  }
  const scanRunning = (session as { providerScanRunning?: boolean }).providerScanRunning ?? false
  const scanProgress = (session as unknown as { providerScanProgress?: { scanned: number; total: number } }).providerScanProgress
  const scanResults = ((session as unknown) as { providerScanResults?: Array<{ host: string; port: number; service: string }> }).providerScanResults ?? []
  const scanError = (session as { providerScanError?: string }).providerScanError
  const providerModels = (session as unknown as { providerModels?: Record<string, string[]> }).providerModels ?? {}

  return h.div([h.Class("settings-panel")], [
    h.h2([h.Class("settings-title")], ["Providers"]),
    h.p([h.Class("settings-sub")], [
      "Configure LLM, vision, voice, and image providers. Benchmark each on your hardware.",
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
        : providers.map((p) =>
            p.id === editingId
              ? providerEditFormView(h, p, draft)
              : providerCardView(h, p, activeId === p.id, testResults[p.id], providerModels[p.id])
          )
    ),
    h.div([h.Class("providers-add-row")], [
      ...(adding
        ? [providerAddFormView(h, tab, addDraft, scanRunning, scanProgress, scanResults, scanError)]
        : [
            h.button(
              [h.Class("providers-add-btn"), h.OnClick(Message.ProviderAddOpened({}))],
              [`+ Add ${tab.toUpperCase()} provider`]
            ),
          ]),
    ]),
    homeDashSettingsView(h, session),
  ])
}

const providerCardView = (h: H, p: Provider, isActive: boolean, testResult?: string, models?: string[]) => {
  const stats = p.stats
  const statsText =
    stats.testCount > 0 && stats.latencyMs !== undefined
      ? `${stats.latencyMs.toFixed(0)}ms${stats.throughput !== undefined ? ` • ${stats.throughput.toFixed(1)}/s` : ""}${stats.modelSizeMb !== undefined ? ` • ${stats.modelSizeMb.toFixed(0)}MB` : ""}`
      : "Not benchmarked"
  const selectedModel = p.config?.model as string | undefined

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
        ...(testResult
          ? [h.div([h.Class("provider-card-test-result")], [testResult])]
          : []),
        // Model dropdown (for remote LLM/vision providers with loaded models).
        ...(models && models.length > 0
          ? [
              h.div([h.Class("provider-card-model-row")], [
                h.label([h.Class("provider-edit-label")], ["Model"]),
                h.select(
                  [
                    h.Class("provider-edit-input provider-model-select"),
                    h.Value(selectedModel ?? ""),
                    h.OnInput((value) =>
                      Message.ProviderModelSelected({ id: p.id, model: value })
                    ),
                  ],
                  [
                    h.option([h.Value("")], ["Select model..."]),
                    ...models.map((m) => h.option([h.Value(m)], [m])),
                  ]
                ),
              ]),
            ]
          : (p.category === "llm" || p.category === "vision")
            ? [
                h.div([h.Class("provider-card-model-row")], [
                  h.label([h.Class("provider-edit-label")], ["Model (manual)"]),
                  h.input([
                    h.Class("provider-edit-input"),
                    h.Value(selectedModel ?? ""),
                    h.Placeholder("e.g. LOGOS-X1:27B"),
                    h.OnInput((value) =>
                      Message.ProviderModelSelected({ id: p.id, model: value })
                    ),
                  ]),
                ]),
              ]
            : []),
        // Streaming toggle (for LLM providers). Some servers (e.g. OMA
        // llama-server) have broken SSE implementations — disable streaming
        // to use non-streaming requests instead.
        ...(p.category === "llm"
          ? [
              h.div([h.Class("provider-card-model-row")], [
                h.label([h.Class("provider-edit-label")], ["Streaming"]),
                h.select(
                  [
                    h.Class("provider-edit-input provider-model-select"),
                    h.Value(p.config?.streaming ?? "true"),
                    h.OnInput((value) =>
                      Message.ProviderStreamingToggled({ id: p.id, streaming: value === "true" })
                    ),
                  ],
                  [
                    h.option([h.Value("true")], ["Enabled"]),
                    h.option([h.Value("false")], ["Disabled (broken SSE)"]),
                  ]
                ),
              ]),
            ]
          : []), 
      ]),
      h.div([h.Class("provider-card-actions")], [
        h.button(
          [h.Class("provider-btn"), h.OnClick(Message.ProviderConnectionTestRequested({ id: p.id }))],
          ["Test"]
        ),
        h.button(
          [h.Class("provider-btn"), h.OnClick(Message.ProviderEditOpened({ id: p.id }))],
          ["Edit"]
        ),
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

/** Edit form for a provider (name, endpoint, engine). */
const providerEditFormView = (h: H, p: Provider, draft: { name: string; endpoint: string; engine: string }) => {
  return h.div([h.Class("provider-edit-form")], [
    h.div([h.Class("provider-edit-title")], [`Edit ${p.name}`]),
    h.div([h.Class("provider-edit-field")], [
      h.label([h.Class("provider-edit-label")], ["Name"]),
      h.input([
        h.Class("provider-edit-input"),
        h.Value(draft.name),
        h.Placeholder("Provider name"),
        h.OnInput((value) => Message.ProviderEditDraftChanged({ field: "name", value })),
      ]),
    ]),
    ...(p.kind === "remote"
      ? [
          h.div([h.Class("provider-edit-field")], [
            h.label([h.Class("provider-edit-label")], ["Endpoint URL"]),
            h.input([
              h.Class("provider-edit-input"),
              h.Value(draft.endpoint),
              h.Placeholder("http://192.168.1.10:11434"),
              h.OnInput((value) => Message.ProviderEditDraftChanged({ field: "endpoint", value })),
            ]),
          ]),
        ]
      : [
          h.div([h.Class("provider-edit-field")], [
            h.label([h.Class("provider-edit-label")], ["Engine"]),
            h.input([
              h.Class("provider-edit-input"),
              h.Value(draft.engine),
              h.Placeholder("Engine identifier"),
              h.OnInput((value) => Message.ProviderEditDraftChanged({ field: "engine", value })),
            ]),
          ]),
        ]),
    h.div([h.Class("provider-edit-actions")], [
      h.button(
        [
          h.Class("provider-btn provider-btn-primary"),
          h.OnClick(
            Message.ProviderUpdated({
              id: p.id,
              name: draft.name || p.name,
              endpoint: p.kind === "remote" ? draft.endpoint : undefined,
              engine: p.kind === "local" ? draft.engine : undefined,
              config: p.config,
            })
          ),
        ],
        ["Save"]
      ),
      h.button(
        [h.Class("provider-btn"), h.OnClick(Message.ProviderEditClosed({}))],
        ["Cancel"]
      ),
    ]),
  ])
}

/** Add-provider form (name, kind, engine/host/port). */
const providerAddFormView = (
  h: H,
  category: ProviderCategory,
  draft: { name: string; kind: string; engine: string; host: string; port: string },
  scanRunning: boolean,
  scanProgress: { scanned: number; total: number } | undefined,
  scanResults: Array<{ host: string; port: number; service: string }>,
  scanError?: string
) => {
  const engines = KNOWN_ENGINES[category] ?? ["Custom"]
  const isRemote = draft.kind === "remote"
  // For local, scan localhost. For remote, scan the entered host's subnet.
  const scanHost = isRemote ? draft.host || "192.168.1.1" : "127.0.0.1"
  return h.div([h.Class("provider-edit-form")], [
    h.div([h.Class("provider-edit-header")], [
      h.div([h.Class("provider-edit-title")], [`Add ${category.toUpperCase()} provider`]),
      h.button(
        [
          h.Class("provider-btn provider-scan-btn"),
          h.OnClick(Message.ProviderScanRequested({ host: scanHost })),
          h.Disabled(scanRunning),
          h.Title(`Scan network for AI services`),
        ],
        [scanRunning ? "Scanning..." : "Auto-detect"]
      ),
    ]),
    // Scanning progress indicator.
    ...(scanRunning
      ? [
          h.div([h.Class("provider-scan-progress")], [
            h.div([h.Class("provider-scan-spinner")], []),
            h.span(
              [h.Class("provider-scan-progress-text")],
              [`Scanning network for AI services...`]
            ),
          ]),
        ]
      : []),
    h.div([h.Class("provider-edit-field")], [
      h.label([h.Class("provider-edit-label")], ["Kind"]),
      h.div([h.Class("provider-kind-toggle")], [
        h.button(
          [
            h.Class(draft.kind === "local" ? "provider-kind-btn provider-kind-active" : "provider-kind-btn"),
            h.OnClick(Message.ProviderAddDraftChanged({ field: "kind", value: "local" })),
          ],
          ["Local"]
        ),
        h.button(
          [
            h.Class(draft.kind === "remote" ? "provider-kind-btn provider-kind-active" : "provider-kind-btn"),
            h.OnClick(Message.ProviderAddDraftChanged({ field: "kind", value: "remote" })),
          ],
          ["Remote"]
        ),
      ]),
    ]),
    ...(!isRemote
      ? [
          h.div([h.Class("provider-edit-field")], [
            h.label([h.Class("provider-edit-label")], ["Engine"]),
            h.select(
              [
                h.Class("provider-edit-input"),
                h.Value(draft.engine),
                h.OnInput((value) => Message.ProviderAddDraftChanged({ field: "engine", value })),
              ],
              [
                h.option([h.Value("")], ["Select engine..."]),
                ...engines.map((e) => h.option([h.Value(e)], [e])),
              ]
            ),
          ]),
        ]
      : [
          h.div([h.Class("provider-edit-field")], [
            h.label([h.Class("provider-edit-label")], ["Host / IP address"]),
            h.input([
              h.Class("provider-edit-input"),
              h.Value(draft.host),
              h.Placeholder("192.168.1.10"),
              h.OnInput((value) => Message.ProviderAddDraftChanged({ field: "host", value })),
            ]),
          ]),
          h.div([h.Class("provider-edit-field")], [
            h.label([h.Class("provider-edit-label")], ["Port"]),
            h.input([
              h.Class("provider-edit-input"),
              h.Value(draft.port),
              h.Placeholder("11434"),
              h.OnInput((value) => Message.ProviderAddDraftChanged({ field: "port", value })),
            ]),
          ]),
          h.div([h.Class("provider-edit-hint")], [
            "Common ports: Ollama 11434, LM Studio 1234, vLLM 8000, A1111 7860, ComfyUI 8188",
          ]),
          ...(scanError
            ? [h.div([h.Class("provider-scan-error")], [`Scan failed: ${scanError}`])]
            : []),
          ...(scanResults.length > 0
            ? [
                h.div([h.Class("provider-scan-results")], [
                  h.div([h.Class("provider-scan-title")], [`Found ${scanResults.length} service(s):`]),
                  ...scanResults.map((r) =>
                    h.button(
                      [
                        h.Class("provider-scan-result"),
                        h.OnClick(
                          Message.ProviderScanResultSelected({ host: r.host, port: r.port, service: r.service })
                        ),
                        h.Title(`Use ${r.host}:${r.port}`),
                      ],
                      [`${r.service} — ${r.host}:${r.port}`]
                    )
                  ),
                ]),
              ]
            : !scanRunning
              ? [h.div([h.Class("provider-scan-empty")], ["No services found. Try a different network."])]
              : []),
        ]),
    // Name comes after Engine/Host-Port so it can auto-populate from detection.
    h.div([h.Class("provider-edit-field")], [
      h.label([h.Class("provider-edit-label")], ["Name"]),
      h.input([
        h.Class("provider-edit-input"),
        h.Value(draft.name),
        h.Placeholder(`My ${category.toUpperCase()} provider`),
        h.OnInput((value) => Message.ProviderAddDraftChanged({ field: "name", value })),
      ]),
    ]),
    h.div([h.Class("provider-edit-actions")], [
      h.button(
        [
          h.Class("provider-btn provider-btn-primary"),
          h.OnClick(Message.ProviderCreateFromDraft({ category })),
        ],
        ["Add provider"]
      ),
      h.button(
        [h.Class("provider-btn"), h.OnClick(Message.ProviderAddClosed({}))],
        ["Cancel"]
      ),
    ]),
  ])
}
