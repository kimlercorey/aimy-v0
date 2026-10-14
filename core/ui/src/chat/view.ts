/**
 * ui/src/chat/view.ts — the chat panel: a pure function of the session slice.
 *
 * - Virtualized message list: only `visibleWindow(messages, anchor, overscan)`
 *   rows are built (Pi #7730); rows are keyed by message id so the differ
 *   never misattributes a row (Hermes #119668: content-fingerprinted ids).
 * - Streaming: the in-progress text renders through `segmentStreamingText` —
 *   stable blocks come from the memoization cache, only the tail re-renders
 *   (Pi #6665, #8584).
 * - Context meter: true usage incl. reasoning tokens when reported; "unknown"
 *   when not — never a fabricated zero (Pi #9409).
 * - No content loss on re-render: identical state renders identical trees
 *   (tested via serializeHtml in rendering.test.ts).
 */
import type { Document, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import type { ChatMessage, ContextMeter, SessionSlice } from "../model.js"
import { sanitizeTerminalOutput, visibleWindow } from "../rendering.js"
import { Message } from "../messages.js"
import { homeDashView } from "../homedash-view.js"
import { icon } from "../icons.js"
import { extractToolCalls } from "../tool-calls.js"
import { toolAlias } from "../tool-alias.js"

/** Format an STT engine ID (e.g. "parakeet-mlx-0.6b-v2") for display. */
const sttDisplayName = (engineId: string | undefined): string => {
  if (engineId === undefined) return "Not configured"
  // "parakeet-mlx-0.6b-v2" -> "Parakeet MLX (0.6b-v2)"
  // "whisper-cpp-tiny" -> "Whisper.cpp (tiny)"
  const parts = engineId.split("-")
  if (parts.length < 2) return engineId
  const size = parts[parts.length - 1]!
  const name = parts.slice(0, -1).join("-")
  const pretty = name
    .split("-")
    .map((w) => w === "mlx" ? "MLX" : w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .replace("Whisper.cpp", "Whisper.cpp")
    .replace("Faster Whisper", "Faster-Whisper")
    .replace("Parakeet MLX", "Parakeet MLX")
  return `${pretty} (${size})`
}

/** Per-size specs for STT engines — shown dynamically as the user picks a size.
 * Latency figures from third-party Apple Silicon benchmarks (M4/M5).
 * Expect somewhat slower on M3 — these are reference points, not guarantees.
 */
const STT_SIZE_INFO: Record<string, Record<string, { mb: string; note: string }>> = {
  "parakeet-mlx": {
    // M4 Mac mini: 102ms median (wyoming-parakeet-mlx); M5: 126ms P50 (mlx-asr-benchmark)
    "0.6b-v2": { mb: "~600 MB", note: "~100ms on M4, streaming" },
    "0.6b-v3": { mb: "~650 MB", note: "~100ms on M4, slightly better accuracy" },
  },
  "mlx-whisper": {
    // mac-whisper-speedtest (M4): large-v3-turbo 1.02s; tiny ~0.27x real-time
    tiny: { mb: "~75 MB", note: "~0.3s, basic accuracy" },
    base: { mb: "~140 MB", note: "~0.5s, good for commands" },
    small: { mb: "~240 MB", note: "~0.7s, better accuracy" },
    turbo: { mb: "~1.6 GB", note: "~1.0s on M4, best accuracy" },
  },
  "whistle": {
    // Vendor-reported (M4 Pro): 11.1ms to first token, 1319 tok/s decode
    "16mb": { mb: "16.9 MB", note: "~11ms first token (vendor), 7 languages" },
  },
  "whisper-cpp": {
    // mac-whisper-speedtest (M4): large-v3-turbo 1.23s; M4 mini: 518ms median
    tiny: { mb: "~75 MB", note: "~0.3s, basic accuracy" },
    base: { mb: "~140 MB", note: "~0.5s, good for commands" },
    small: { mb: "~240 MB", note: "~0.8s, better accuracy" },
  },
  "faster-whisper": {
    // M4 mini: base.en 326ms median; large 6.96s (CPU-only, no Metal on Mac)
    tiny: { mb: "~75 MB", note: "~0.3s on M4, CPU-only" },
    base: { mb: "~140 MB", note: "~0.3s on M4, CPU-only" },
    small: { mb: "~240 MB", note: "~0.6s on M4, CPU-only" },
  },
  vosk: {
    small: { mb: "~50 MB", note: "Lightest, simple commands" },
    medium: { mb: "~120 MB", note: "Better accuracy" },
  },
}

/** Resolve the spec for the currently-selected size of an engine. */
const sttSizeSpec = (
  sizes: Record<string, string>,
  engine: string,
  fallback: string
): { mb: string; note: string } => {
  const sel = sizes[engine] ?? fallback
  return STT_SIZE_INFO[engine]?.[sel] ?? { mb: "?", note: "" }
}
import { renderMarkdown, looksLikeMarkdown } from "../markdown.js" 
import { segmentStreamingText } from "./segment.js"
import { parseMessageTools } from "../tool-calls.js"

type H = HtmlBuilder<Message>

const roleClass = (role: ChatMessage["role"]): string =>
  role === "user" ? "msg-user" : role === "assistant" ? "msg-assistant" : "msg-tool"

const roleLabel = (role: ChatMessage["role"]): string =>
  role === "user" ? "You" : role === "assistant" ? "AImy" : "tool"

/**
 * Clean text for the copy button (2026-10-11): strip voice performance tags
 * (`[happy]` etc.) and their emoji conversions (😊😮🤫) — they're performance
 * markers, not content. Keep everything else, including fenced code blocks
 * with their language tags. Tool-call JSON is already stripped by
 * parseMessageTools before this runs.
 */
export const cleanCopyText = (text: string): string =>
  text
    .replace(/\[(chuckle|laugh|sigh|gasp|whispering|dramatic|sarcastic|happy|surprised)\]/g, "")
    .replace(/[😊😮🤫]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

const messageRow = (h: H, m: ChatMessage) => {
  // Parse tool calls from the raw text (2026-10-10): extract user-facing
  // text and tool metadata. The bubble shows ONLY the parsed text — never
  // raw tool JSON (2026-10-11: using m.text when toolsUsed existed leaked
  // the ```aimy-tool fence into the bubble as an ugly code block).
  const parsed = m.role === "assistant"
    ? parseMessageTools(m.text)
    : { text: m.text, toolsUsed: m.toolsUsed ?? [], narratedTexts: m.narratedTexts ?? [], toolSummaries: m.toolSummaries ?? [] }
  // Prefer stored metadata; fall back to parsed.
  const toolsUsed = m.toolsUsed && m.toolsUsed.length > 0 ? m.toolsUsed : parsed.toolsUsed
  const narratedTexts = m.narratedTexts && m.narratedTexts.length > 0 ? m.narratedTexts : parsed.narratedTexts
  // ALWAYS use parsed.text — m.text may still contain the tool-call fence.
  const displayText = parsed.text

  const body = looksLikeMarkdown(displayText)
    ? h.div([h.Class("msg-body markdown-body"), h.InnerHTML(renderMarkdown(displayText))], [])
    : h.div([h.Class("msg-body")], [sanitizeTerminalOutput(displayText)])
  // Footer nodes (2026-10-12, Kimler's spec): each tag is the tool's
  // ONE-WORD alias, tinted by outcome — green when the call succeeded,
  // red when it failed, untinted when no completion was observed (a
  // blocked or unexecuted call). The hover tooltip presents the
  // CONCLUSION — what the tool returned — never the request that
  // produced it. narrate is the exception: its tooltip is what she
  // said (narratedTexts). The .tool-tip span is a hidden text source —
  // main.ts positions a fixed div from bubble geometry.
  const footerNodes: Array<string | ReturnType<H["span"]>> = []
  {
    let narrateOrdinal = 0
    toolsUsed.forEach((tool, idx) => {
      if (idx > 0) footerNodes.push(", ")
      const outcome = m.toolOutcomes?.[idx]
      const tint =
        outcome === undefined || outcome.status === "none"
          ? ""
          : outcome.status === "ok"
            ? " tool-tag--ok"
            : " tool-tag--failed"
      let tip: string | undefined
      if (tool === "narrate") {
        // The spoken text is the tooltip only when the narrate call
        // actually ran (2026-10-12: a parsed-but-unexecuted narrate
        // presented its text as spoken while Kimler heard silence).
        // Unexecuted/failed → the conclusion or plain name instead.
        const spoken = narratedTexts[narrateOrdinal]
        narrateOrdinal += 1
        if (outcome === undefined || outcome.status === "ok") tip = spoken
        else if (outcome.conclusion !== "") tip = outcome.conclusion
      } else if (outcome !== undefined && outcome.conclusion !== "") {
        tip = outcome.conclusion
      }
      if (tip !== undefined && tip.length > 0) {
        footerNodes.push(
          h.span([h.Class(`tool-tag${tint}`)], [
            toolAlias(tool),
            h.span([h.Class("tool-tip"), h.Style({ display: "none" })], [`${tool} — ${tip}`]),
          ])
        )
      } else {
        footerNodes.push(
          h.span([h.Class(`tool-tag${tint}`), h.Title(tool)], [toolAlias(tool)])
        )
      }
    })
  }
  // Stopped marker (2026-10-13): a reply he cut short says so
  // in the footer, in the same register as the tool tags.
  if (m.stopped === true) {
    if (footerNodes.length > 0) footerNodes.push(", ")
    footerNodes.push(h.span([h.Class("tool-tag tool-tag--stopped")], ["Stopped"]))
  }
  // Copy source (2026-10-11): clean text for the copy button, hidden like
  // the narrate tooltip source. Voice tags stripped, code blocks kept.
  // Gesture (2026-10-12): click copies rich text (rendered HTML + this
  // text as the plain representation); long-click copies this markdown.
  const copyText = cleanCopyText(displayText)
  // Documents (2026-10-13): file chips at the top of the bubble,
  // beside any images — the record of what she was handed.
  const documentNodes = (m.documents ?? []).length > 0
    ? [h.div([h.Class("msg-documents")],
        (m.documents ?? []).map((d) =>
          h.span([h.Class("msg-document-chip"), h.Title(`${d.name} — ${d.text.length} characters`)], [
            icon.fileText(h),
            h.span([h.Class("msg-document-name")], [d.name]),
          ]),
        ),
      )]
    : []
  // Images (2026-10-11): thumbnails at the top of the bubble, click to expand.
  const imageNodes = (m.images ?? []).length > 0
    ? [h.div([h.Class("msg-images")],
        (m.images ?? []).map((img) =>
          h.img([
            h.Class("msg-image-thumb"),
            h.Src(img.dataUrl),
            h.Alt(img.name),
            h.Title(img.name),
          ]),
        ),
      )]
    : []
  // Wrapper: bubble + tool indicator below (outside the bubble).
  return h.div([h.Class(`msg-row msg-id-${m.id}`), h.Key(m.id)], [
    h.div([h.Class(`msg ${roleClass(m.role)}`)], [
      h.span([h.Class("msg-role")], [roleLabel(m.role)]),
      h.button([h.Class("msg-copy-btn"), h.Title("Copy — click for rich text, long-click for markdown")], [icon.copy(h)]),
      // Edit-and-resend (2026-10-13): his own messages carry a
      // pencil. Inert like the copy button — the delegated
      // click listener in main.ts dispatches aimy:edit-message.
      ...(m.role === "user"
        ? [h.button([h.Class("msg-edit-btn"), h.Title("Edit and resend — branches the chat at this message")], [icon.pencil(h)])]
        : []),
      h.span([h.Class("msg-copy-source")], [copyText]),
      ...imageNodes,
      ...documentNodes,
      body,
    ]),
    // Faint right-aligned tool indicator BELOW the bubble (Kimler spec 2026-10-10).
    ...(toolsUsed.length > 0 || m.stopped === true
      ? [h.div([h.Class("msg-tools")], footerNodes)]
      : []),
  ])
}

const formatTokens = (n: number | null): string =>
  n === null ? "unknown" : n.toLocaleString("en-US")

/**
 * Voice settings panel: providers, voices, add voice, test.
 * Clean sectioned layout with health indicators and help tooltips.
 */
const voicePanelView = (h: H, session: SessionSlice) => {
  const engine = session.ttsEngine

  const helpIcon = (text: string) =>
    h.span([h.Class("help-icon")], [
      icon.info(h),
      h.span([h.Class("help-card")], [text]),
    ])

  const healthDot = (healthy: boolean) =>
    h.span([h.Class(healthy ? "health-dot health-ok" : "health-dot health-bad")], [])

  const sectionHead = (title: string, help: string) =>
    h.div([h.Class("voice-section-head")], [
      h.h3([h.Class("voice-section-title")], [title]),
      helpIcon(help),
    ])

  const sections: Array<ReturnType<H["div"]>> = []

  // --- Providers ---
  // Read active providers from the registry (2026-10-10: was hardcoded).
  // Falls back to engine status if no provider is active.
  const activeTtsId = session.providers.activeId.tts
  const activeTts = activeTtsId !== undefined
    ? session.providers.providers.find((p) => p.id === activeTtsId)
    : undefined
  const ttsDisplayName = activeTts !== undefined
    ? activeTts.name
    : "Chatterbox Nano (110M)" // fallback: local engine
  // Health: for remote providers, assume healthy if no last error
  // (tunnel status is shown separately). For local, check engine state.
  const ttsHealthy = activeTts?.kind === "remote"
    ? session.providerLastError === undefined
    : engine.state === "ready" && session.providerLastError === undefined
  const ttsStatus = session.providerLastError !== undefined
    ? "error"
    : ttsHealthy ? "ready" : engine.state
  // STT: same pattern — read from registry, fall back to engine.
  const activeSttId = session.providers.activeId.stt
  const activeStt = activeSttId !== undefined
    ? session.providers.providers.find((p) => p.id === activeSttId)
    : undefined
  const sttDisplayName2 = activeStt !== undefined
    ? activeStt.name
    : sttDisplayName(session.sttEngine.engine)
  const sttHealthy = activeStt?.kind === "remote"
    ? true // remote: tunnel check is separate; assume reachable if selected
    : session.sttEngine.state === "ready"
  const sttStatusText = activeStt?.kind === "remote"
    ? "remote"
    : session.sttEngine.state === "ready" ? "ready" : session.sttEngine.state
  sections.push(
    h.div([h.Class("voice-section")], [
      sectionHead("Providers", "TTS converts text to speech. STT converts speech to text (for voice input)."),
      h.div([h.Class("voice-provider-row")], [
        healthDot(ttsHealthy),
        h.span([h.Class("voice-provider-label")], ["TTS"]),
        h.span([h.Class("voice-provider-name")], [ttsDisplayName]),
        h.span(
          [h.Class("voice-provider-status"), ...(session.providerLastError !== undefined ? [h.Title(session.providerLastError)] : [])],
          [ttsStatus]
        ),
      ]),
      h.div([h.Class("voice-provider-row voice-dim")], [
        healthDot(sttHealthy),
        h.span([h.Class("voice-provider-label")], ["STT"]),
        h.span(
          [h.Class("voice-provider-name")],
          [sttDisplayName2]
        ),
        h.span(
          [h.Class("voice-provider-status")],
          [sttStatusText]
        ),
        ...(session.sttEngine.state === "ready"
          ? [
              h.button(
                [
                  h.Class("voice-btn voice-test-btn"),
                  h.OnClick(Message.SttTestRequested({})),
                  h.Disabled(session.sttTestRunning),
                  h.Title("Run STT latency test"),
                ],
                [session.sttTestRunning ? "Downloading model…" : "Test"]
              ),
            ]
          : [
              h.button(
                [
                  h.Class("voice-btn voice-setup-btn"),
                  h.OnClick(Message.SttSetupOpened({})),
                  h.Title("Set up speech-to-text"),
                ],
                ["Setup"]
              ),
            ]),
      ]),
      // STT error detail (when failed) — show WHY, not just "failed".
      ...(session.sttEngine.state === "failed" && session.sttEngine.detail
        ? [
            h.div([h.Class("voice-error-detail")], [
              h.span([h.Class("voice-error-label")], ["Error: "]),
              h.span([h.Class("voice-error-message")], [session.sttEngine.detail]),
            ]),
          ]
        : []),
      // STT test results (below the STT provider row).
      ...(session.sttTestResults !== undefined
        ? [
            h.div([h.Class("voice-test-results")], [
              h.div([h.Class("voice-test-row")], [
                h.span([h.Class("voice-test-label")], ["STT Latency"]),
                h.span([h.Class("voice-test-value")], [`${session.sttTestResults.latencyMs.toFixed(0)}ms`]),
              ]),
              h.div([h.Class("voice-test-row")], [
                h.span([h.Class("voice-test-label")], ["Model size"]),
                h.span([h.Class("voice-test-value")], [`${session.sttTestResults.modelSizeMb.toFixed(0)} MB`]),
              ]),
            ]),
          ]
        : []),
      // Push-to-talk configuration (when STT is ready).
      ...(session.sttEngine.state === "ready"
        ? [
            h.div([h.Class("voice-section")], [
              sectionHead("Push-to-talk", "Hold the key (or mouse button) to dictate. Release to transcribe."),
              h.div([h.Class("ptt-row")], [
                h.label([h.Class("ptt-label")], ["Input:"]),
                h.button(
                  [
                    h.Class(!session.pushToTalkUseMouse ? "ptt-toggle ptt-active" : "ptt-toggle"),
                    h.OnClick(Message.PushToTalkKeyChanged({
                      key: session.pushToTalkUseMouse ? session.pushToTalkKey : "ControlRight",
                      useMouse: false,
                    })),
                  ],
                  ["Keyboard"]
                ),
                h.button(
                  [
                    h.Class(session.pushToTalkUseMouse ? "ptt-toggle ptt-active" : "ptt-toggle"),
                    h.OnClick(Message.PushToTalkKeyChanged({
                      key: !session.pushToTalkUseMouse ? "3" : session.pushToTalkKey,
                      useMouse: true,
                    })),
                  ],
                  ["Mouse"]
                ),
              ]),
              ...(!session.pushToTalkUseMouse
                ? [
                    h.div([h.Class("ptt-row")], [
                      h.label([h.Class("ptt-label")], ["Key:"]),
                      h.select(
                        [
                          h.Class("ptt-select"),
                          h.OnChange((value) => Message.PushToTalkKeyChanged({ key: value, useMouse: false })),
                        ],
                        [
                          h.option([h.Value("ControlRight"), h.Selected(session.pushToTalkKey === "ControlRight")], ["Right Ctrl"]),
                          h.option([h.Value("ControlLeft"), h.Selected(session.pushToTalkKey === "ControlLeft")], ["Left Ctrl"]),
                          h.option([h.Value("AltRight"), h.Selected(session.pushToTalkKey === "AltRight")], ["Right Alt"]),
                          h.option([h.Value("Space"), h.Selected(session.pushToTalkKey === "Space")], ["Space (hold)"]),
                        ]
                      ),
                    ]),
                  ]
                : [
                    h.div([h.Class("ptt-row")], [
                      h.label([h.Class("ptt-label")], ["Button:"]),
                      h.select(
                        [
                          h.Class("ptt-select"),
                          h.OnChange((value) => Message.PushToTalkKeyChanged({ key: value, useMouse: true })),
                        ],
                        [
                          h.option([h.Value("3"), h.Selected(session.pushToTalkKey === "3")], ["Side button (back)"]),
                          h.option([h.Value("4"), h.Selected(session.pushToTalkKey === "4")], ["Side button (forward)"]),
                          h.option([h.Value("1"), h.Selected(session.pushToTalkKey === "1")], ["Middle click"]),
                        ]
                      ),
                    ]),
                  ]),
              h.p([h.Class("ptt-hint")], [
                session.pushToTalkUseMouse
                  ? `Hold ${session.pushToTalkKey === "3" ? "side button (back)" : session.pushToTalkKey === "4" ? "side button (forward)" : session.pushToTalkKey === "1" ? "middle click" : "mouse button"} to talk.`
                  : `Hold ${session.pushToTalkKey === "ControlRight" ? "Right Ctrl" : session.pushToTalkKey === "ControlLeft" ? "Left Ctrl" : session.pushToTalkKey === "AltRight" ? "Right Alt" : session.pushToTalkKey === "Space" ? "Space" : session.pushToTalkKey} to talk.`,
              ]),
              h.div([h.Class("ptt-row")], [
                h.label([h.Class("ptt-label")], ["Mic:"]),
                h.select(
                  [
                    h.Class("ptt-select"),
                    h.OnChange((value) => Message.MicDeviceChanged({ deviceId: value })),
                  ],
                  [
                    h.option([h.Value(""), h.Selected(session.micDeviceId === "")], ["Default microphone"]),
                    ...session.micDevices.map((d) =>
                      h.option([h.Value(d.deviceId), h.Selected(session.micDeviceId === d.deviceId)], [d.label])
                    ),
                  ]
                ),
                h.button(
                  [h.Class("voice-btn"), h.OnClick(Message.MicDevicesRequested({})), h.Title("Refresh microphone list")],
                  ["Refresh"]
                ),
              ]),
            ]),
          ]
        : []),
      // STT setup dialog with engine options.
      ...(session.sttSetupOpen
        ? [
            h.div([h.Class("stt-setup-dialog")], [
              h.div([h.Class("stt-setup-head")], [
                h.span([h.Class("stt-setup-title")], ["Choose a speech-to-text engine"]),
                h.button(
                  [h.Class("icon-btn"), h.OnClick(Message.SttSetupClosed({})), h.Title("Close")],
                  ["×"]
                ),
              ]),
              h.p(
                [h.Class("stt-setup-desc")],
                ["Lightweight, local-first. All run on-device — no audio leaves your Mac. Latency figures are M4/M5 benchmarks; expect somewhat slower on M3."]
              ),
              // Per-size specs shown dynamically as the user picks a size.
              // (Defined inline so the dialog re-renders on selection.)
              // Option 1: Parakeet MLX (recommended on macOS) — full-duplex capable
              h.div([h.Class("stt-option stt-recommended")], [
                h.div([h.Class("stt-option-head")], [
                  h.span([h.Class("stt-option-name")], ["Parakeet MLX"]),
                  h.span([h.Class("stt-badge")], ["Recommended"]),
                  h.span([h.Class("stt-badge stt-badge-duplex")], ["⇄ Full-duplex"]),
                ]),
                h.p([h.Class("stt-option-desc")], ["0.6B streaming RNN-T. 0.5s on M4. Only option with barge-in (interrupt while speaking)."]),
                h.div([h.Class("stt-os-badges")], [
                  h.span([h.Class("stt-os")], ["macOS"]),
                ]),
                h.div([h.Class("stt-size-row")], [
                  h.span([h.Class("stt-size-label")], ["Size:"]),
                  ...["0.6b-v2", "0.6b-v3"].map((sz) =>
                    h.button(
                      [
                        h.Class((session.sttModelSizes["parakeet-mlx"] ?? "0.6b-v2") === sz ? "stt-size-btn stt-size-active" : "stt-size-btn"),
                        h.OnClick(Message.SttModelSizeChanged({ engine: "parakeet-mlx", size: sz })),
                      ],
                      [sz]
                    )
                  ),
                ]),
                h.div([h.Class("stt-option-meta")], [
                  h.span([h.Class("stt-meta-item")], [sttSizeSpec(session.sttModelSizes, "parakeet-mlx", "0.6b-v2").mb]),
                  h.span([h.Class("stt-meta-item")], ["MLX"]),
                  h.span([h.Class("stt-meta-item")], ["Streaming"]),
                  h.span([h.Class("stt-meta-item stt-meta-note")], [sttSizeSpec(session.sttModelSizes, "parakeet-mlx", "0.6b-v2").note]),
                ]),
                h.button(
                  [
                    h.Class("voice-btn voice-btn-primary"),
                    h.OnClick(Message.SttInstallRequested({ engine: `parakeet-mlx-${session.sttModelSizes["parakeet-mlx"] ?? "0.6b-v2"}` })),
                    h.Disabled(session.sttEngine.state === "installing"),
                  ],
                  [session.sttEngine.state === "installing" ? "Installing…" : "Install"]
                ),
                ...(session.sttEngine.state === "installing" && session.sttEngine.progressMessage !== undefined
                  ? [h.p([h.Class("stt-progress")], [session.sttEngine.progressMessage])]
                  : []),
              ]),
              // Option 2: Whistle — 16.9 MB, cross-platform
              h.div([h.Class("stt-option")], [
                h.div([h.Class("stt-option-head")], [
                  h.span([h.Class("stt-option-name")], ["Whistle"]),
                ]),
                h.p([h.Class("stt-option-desc")], ["16.9 MB, zero dependencies, CPU-only. From Cactus Compute (Needle repo)."]),
                h.div([h.Class("stt-os-badges")], [
                  h.span([h.Class("stt-os")], ["macOS"]),
                  h.span([h.Class("stt-os")], ["Windows"]),
                  h.span([h.Class("stt-os")], ["Linux"]),
                ]),
                h.div([h.Class("stt-option-meta")], [
                  h.span([h.Class("stt-meta-item")], ["16.9 MB"]),
                  h.span([h.Class("stt-meta-item")], ["CPU"]),
                  h.span([h.Class("stt-meta-item")], ["17 targets"]),
                ]),
                h.button(
                  [
                    h.Class("voice-btn"),
                    h.OnClick(Message.SttInstallRequested({ engine: "whistle-16mb" })),
                    h.Disabled(session.sttEngine.state === "installing"),
                  ],
                  [session.sttEngine.state === "installing" ? "Installing…" : "Install"]
                ),
              ]),
              // Option 3: MLX Whisper — Apple Silicon native
              h.div([h.Class("stt-option")], [
                h.div([h.Class("stt-option-head")], [
                  h.span([h.Class("stt-option-name")], ["MLX Whisper"]),
                ]),
                h.p([h.Class("stt-option-desc")], ["Apple MLX framework. 7.5x faster than PyTorch Whisper on M chips."]),
                h.div([h.Class("stt-os-badges")], [
                  h.span([h.Class("stt-os")], ["macOS"]),
                ]),
                h.div([h.Class("stt-size-row")], [
                  h.span([h.Class("stt-size-label")], ["Size:"]),
                  ...["tiny", "base", "small", "turbo"].map((sz) =>
                    h.button(
                      [
                        h.Class((session.sttModelSizes["mlx-whisper"] ?? "tiny") === sz ? "stt-size-btn stt-size-active" : "stt-size-btn"),
                        h.OnClick(Message.SttModelSizeChanged({ engine: "mlx-whisper", size: sz })),
                      ],
                      [sz]
                    )
                  ),
                ]),
                h.div([h.Class("stt-option-meta")], [
                  h.span([h.Class("stt-meta-item")], [sttSizeSpec(session.sttModelSizes, "mlx-whisper", "tiny").mb]),
                  h.span([h.Class("stt-meta-item")], ["MLX"]),
                  h.span([h.Class("stt-meta-item stt-meta-note")], [sttSizeSpec(session.sttModelSizes, "mlx-whisper", "tiny").note]),
                ]),
                h.button(
                  [
                    h.Class("voice-btn"),
                    h.OnClick(Message.SttInstallRequested({ engine: `mlx-whisper-${session.sttModelSizes["mlx-whisper"] ?? "tiny"}` })),
                    h.Disabled(session.sttEngine.state === "installing"),
                  ],
                  [session.sttEngine.state === "installing" ? "Installing…" : "Install"]
                ),
              ]),
              // Option 4: Whisper.cpp
              h.div([h.Class("stt-option")], [
                h.div([h.Class("stt-option-head")], [
                  h.span([h.Class("stt-option-name")], ["Whisper.cpp"]),
                ]),
                h.p([h.Class("stt-option-desc")], ["Fast on CPU, good accuracy for voice commands."]),
                h.div([h.Class("stt-os-badges")], [
                  h.span([h.Class("stt-os")], ["macOS"]),
                  h.span([h.Class("stt-os")], ["Windows"]),
                  h.span([h.Class("stt-os")], ["Linux"]),
                ]),
                h.div([h.Class("stt-size-row")], [
                  h.span([h.Class("stt-size-label")], ["Size:"]),
                  ...["tiny", "base", "small"].map((sz) =>
                    h.button(
                      [
                        h.Class((session.sttModelSizes["whisper-cpp"] ?? "tiny") === sz ? "stt-size-btn stt-size-active" : "stt-size-btn"),
                        h.OnClick(Message.SttModelSizeChanged({ engine: "whisper-cpp", size: sz })),
                      ],
                      [sz]
                    )
                  ),
                ]),
                h.div([h.Class("stt-option-meta")], [
                  h.span([h.Class("stt-meta-item")], [sttSizeSpec(session.sttModelSizes, "whisper-cpp", "tiny").mb]),
                  h.span([h.Class("stt-meta-item")], ["CPU"]),
                  h.span([h.Class("stt-meta-item stt-meta-note")], [sttSizeSpec(session.sttModelSizes, "whisper-cpp", "tiny").note]),
                ]),
                h.button(
                  [
                    h.Class("voice-btn"),
                    h.OnClick(Message.SttInstallRequested({ engine: `whisper-cpp-${session.sttModelSizes["whisper-cpp"] ?? "tiny"}` })),
                    h.Disabled(session.sttEngine.state === "installing"),
                  ],
                  [session.sttEngine.state === "installing" ? "Installing…" : "Install"]
                ),
              ]),
              // Option 3: Faster-Whisper
              h.div([h.Class("stt-option")], [
                h.div([h.Class("stt-option-head")], [
                  h.span([h.Class("stt-option-name")], ["Faster-Whisper"]),
                ]),
                h.p([h.Class("stt-option-desc")], ["Python-based, slightly better accuracy, uses more RAM."]),
                h.div([h.Class("stt-os-badges")], [
                  h.span([h.Class("stt-os")], ["macOS"]),
                  h.span([h.Class("stt-os")], ["Windows"]),
                  h.span([h.Class("stt-os")], ["Linux"]),
                ]),
                h.div([h.Class("stt-size-row")], [
                  h.span([h.Class("stt-size-label")], ["Size:"]),
                  ...["tiny", "base", "small"].map((sz) =>
                    h.button(
                      [
                        h.Class((session.sttModelSizes["faster-whisper"] ?? "tiny") === sz ? "stt-size-btn stt-size-active" : "stt-size-btn"),
                        h.OnClick(Message.SttModelSizeChanged({ engine: "faster-whisper", size: sz })),
                      ],
                      [sz]
                    )
                  ),
                ]),
                h.div([h.Class("stt-option-meta")], [
                  h.span([h.Class("stt-meta-item")], [sttSizeSpec(session.sttModelSizes, "faster-whisper", "tiny").mb]),
                  h.span([h.Class("stt-meta-item")], ["CPU"]),
                  h.span([h.Class("stt-meta-item stt-meta-note")], [sttSizeSpec(session.sttModelSizes, "faster-whisper", "tiny").note]),
                ]),
                h.button(
                  [
                    h.Class("voice-btn"),
                    h.OnClick(Message.SttInstallRequested({ engine: `faster-whisper-${session.sttModelSizes["faster-whisper"] ?? "tiny"}` })),
                    h.Disabled(session.sttEngine.state === "installing"),
                  ],
                  [session.sttEngine.state === "installing" ? "Installing…" : "Install"]
                ),
              ]),
              // Option 4: Vosk
              h.div([h.Class("stt-option")], [
                h.div([h.Class("stt-option-head")], [
                  h.span([h.Class("stt-option-name")], ["Vosk"]),
                ]),
                h.p([h.Class("stt-option-desc")], ["Lightest option, offline, good for simple commands."]),
                h.div([h.Class("stt-os-badges")], [
                  h.span([h.Class("stt-os")], ["macOS"]),
                  h.span([h.Class("stt-os")], ["Windows"]),
                  h.span([h.Class("stt-os")], ["Linux"]),
                ]),
                h.div([h.Class("stt-size-row")], [
                  h.span([h.Class("stt-size-label")], ["Size:"]),
                  ...["small", "medium"].map((sz) =>
                    h.button(
                      [
                        h.Class((session.sttModelSizes["vosk"] ?? "small") === sz ? "stt-size-btn stt-size-active" : "stt-size-btn"),
                        h.OnClick(Message.SttModelSizeChanged({ engine: "vosk", size: sz })),
                      ],
                      [sz]
                    )
                  ),
                ]),
                h.div([h.Class("stt-option-meta")], [
                  h.span([h.Class("stt-meta-item")], [sttSizeSpec(session.sttModelSizes, "vosk", "small").mb]),
                  h.span([h.Class("stt-meta-item")], ["CPU"]),
                  h.span([h.Class("stt-meta-item stt-meta-note")], [sttSizeSpec(session.sttModelSizes, "vosk", "small").note]),
                ]),
                h.button(
                  [
                    h.Class("voice-btn"),
                    h.OnClick(Message.SttInstallRequested({ engine: `vosk-${session.sttModelSizes["vosk"] ?? "small"}` })),
                    h.Disabled(session.sttEngine.state === "installing"),
                  ],
                  [session.sttEngine.state === "installing" ? "Installing…" : "Install"]
                ),
              ]),
              ...(session.sttEngine.state === "installing" && session.sttEngine.progressMessage
                ? [h.p([h.Class("stt-progress")], [session.sttEngine.progressMessage])]
                : []),
              ...(session.sttEngine.state === "failed" && session.sttEngine.detail
                ? [h.p([h.Class("voice-error")], [session.sttEngine.detail])]
                : []),
            ]),
          ]
        : []),
    ])
  )

  // --- Engine states ---
  if (engine.state === "unknown") {
    sections.push(h.div([h.Class("voice-section")], ["Checking voice engine…"]))
  } else if (engine.state === "missing") {
    sections.push(
      h.div([h.Class("voice-section")], [
        sectionHead("Install", "One-time download, then every reply can be spoken aloud."),
        h.p([h.Class("voice-dim")], ["The voice engine isn't installed yet (~1–2.5 GB download)."]),
        h.button(
          [h.Class("voice-btn voice-btn-primary"), h.OnClick(Message.TtsInstallRequested({}))],
          ["Install voice engine"]
        ),
      ])
    )
  } else if (engine.state === "installing") {
    sections.push(
      h.div([h.Class("voice-section")], [
        `Installing… ${engine.progressMessage ?? "starting"}`,
      ])
    )
  } else if (engine.state === "failed") {
    sections.push(
      h.div([h.Class("voice-section")], [
        `Install failed: ${engine.detail ?? "unknown error"}`,
        h.button(
          [h.Class("voice-btn"), h.OnClick(Message.TtsInstallRequested({}))],
          ["Retry install"]
        ),
      ])
    )
  } else {
    // --- Voices ---
    const voiceRows: Array<ReturnType<H["div"]>> = []
    const pendingDeleteId = session.pendingDeleteVoiceId
    for (const v of session.voices) {
      const active = session.activeVoiceId === v.id || (session.activeVoiceId === undefined && v.isDefault)
      // Only the built-in default voice is undeletable (by ID, not flag).
      const isBuiltIn = v.id === "default"
      voiceRows.push(
        h.div(
          [
            h.Class(active ? "voice-row voice-active" : "voice-row"),
            h.OnClick(Message.VoiceSelectRequested({ voiceId: v.id })),
            h.Title(`Use ${v.name} for spoken replies`),
          ],
          [
          h.span([h.Class("voice-select-indicator")], [active ? "● " : "○ "]),
          h.span([h.Class("voice-name")], [v.name]),
          // Action buttons only show for the active voice.
          ...(active
            ? [
                h.button(
                  [
                    h.Class(v.isDefault ? "icon-btn voice-default-btn is-default" : "icon-btn voice-default-btn"),
                    h.OnClick(Message.VoiceSetDefaultRequested({ voiceId: v.id })),
                    h.Title(v.isDefault ? `${v.name} is the default voice` : `Make ${v.name} the default voice`),
                  ],
                  [v.isDefault ? icon.starFilled(h) : icon.star(h)]
                ),
                h.button(
                  [
                    h.Class(session.playingSampleVoiceId === v.id ? "icon-btn voice-sample-btn is-playing" : "icon-btn voice-sample-btn"),
                    h.OnClick(Message.VoiceSampleRequested({ voiceId: v.id })),
                    h.Title(session.playingSampleVoiceId === v.id ? `Playing sample of ${v.name}…` : `Play sample of ${v.name}`),
                    h.Disabled(session.playingSampleVoiceId !== undefined),
                  ],
                  [icon.play(h)]
                ),
                ...(isBuiltIn
                  ? []
                  : [
                      h.button(
                        [h.Class("icon-btn voice-delete-btn"), h.OnClick(Message.VoiceDeleteRequested({ voiceId: v.id })), h.Title(`Delete ${v.name}`)],
                        [icon.trash(h)]
                      ),
                    ]),
              ]
            : []),
        ])
      )
      // Inline delete confirmation directly under the voice being deleted.
      if (pendingDeleteId === v.id) {
        voiceRows.push(
          h.div([h.Class("voice-confirm voice-confirm-inline")], [
            h.span([h.Class("voice-confirm-text")], [
              `Delete "${v.name}"? This can't be undone.`,
            ]),
            h.div([h.Class("voice-confirm-actions")], [
              h.button(
                [h.Class("voice-btn voice-btn-danger"), h.OnClick(Message.VoiceDeleteConfirmed({}))],
                ["Delete"]
              ),
              h.button(
                [h.Class("voice-btn"), h.OnClick(Message.VoiceDeleteCancelled({}))],
                ["Cancel"]
              ),
            ]),
          ])
        )
      }
    }
    sections.push(
      h.div([h.Class("voice-section")], [
        sectionHead("Voices", "Select the voice for spoken replies. Custom voices are cloned from your recordings."),
        ...voiceRows,
        ...(session.voices.length === 0
          ? [h.p([h.Class("voice-dim")], ["No voices yet — add one below."])]
          : []),
      ])
    )

    // --- Add Voice ---
    sections.push(
      h.div([h.Class("voice-section")], [
        sectionHead("Add Voice", "Clone a voice from a short recording — WAV, MP3, FLAC, OGG or M4A; other formats are converted on the way in. Chatterbox clones at synthesis time — no training needed."),
        h.div([h.Class("voice-add-row")], [
          h.input([
            h.Class("voice-name-input"),
            h.Placeholder("Voice name…"),
            h.Value(session.pendingVoiceName),
            h.OnInput((v) => Message.VoiceNameChanged({ name: v })),
          ]),
          h.button(
            [h.Class("voice-btn"), h.OnClick(Message.VoiceFilePickRequested({}))],
            ["Choose audio…"]
          ),
        ]),
        h.button(
          [h.Class("voice-btn"), h.OnClick(Message.VoicesRefreshRequested({}))],
          ["Refresh"]
        ),
      ])
    )
  }

  const errorLine =
    session.voiceError !== undefined
      ? h.div([h.Class("voice-error-banner")], [
          h.span([h.Class("voice-error-text")], [session.voiceError]),
          h.button(
            [h.Class("icon-btn voice-error-dismiss"), h.OnClick(Message.VoiceErrorDismissed({})), h.Title("Dismiss")],
            ["×"]
          ),
        ])
      : undefined

  const children: Array<ReturnType<H["div"] | H["p"] | H["section"]>> = [
    h.div([h.Class("voice-panel-head")], [
      h.span([h.Class("voice-panel-title")], ["Voice Settings"]),
      h.button(
        [h.Class("icon-btn"), h.OnClick(Message.VoicePanelToggled({ open: false })), h.Title("Close")],
        ["×"]
      ),
    ]),
    // Errors appear immediately below the header — never buried.
    ...(errorLine !== undefined ? [errorLine] : []),
    ...sections,
  ]
  return h.section([h.Class("voice-panel")], children)
}

const contextMeterView = (h: H, meter: ContextMeter) => {
  const hasData = meter.inputTokens !== null && meter.ceiling > 0
  const used = (meter.inputTokens ?? 0) + (meter.outputTokens ?? 0) + (meter.reasoningTokens ?? 0)
  const pct = hasData ? Math.min(100, Math.round((used / meter.ceiling) * 100)) : 0
  const ringColor = !hasData ? "#3a3f4a" : pct < 50 ? "#4ade80" : pct < 80 ? "#fbbf24" : "#f87171"
  const tooltip = hasData
    ? `Context: ${pct}% of ${meter.ceiling.toLocaleString("en-US")}\nIn: ${formatTokens(meter.inputTokens)}\nOut: ${formatTokens(meter.outputTokens)}\nReasoning: ${formatTokens(meter.reasoningTokens)}`
    : "Context usage will appear here once the conversation starts"
  return h.div(
    [
      h.Class("context-meter-ring"),
      h.Title(tooltip),
      h.Style({ background: `conic-gradient(${ringColor} ${pct * 3.6}deg, #1e222b ${pct * 3.6}deg)` }),
    ],
    [
      h.div([h.Class("context-meter-inner")], [
        h.span([h.Class(`meter-pct${!hasData ? " meter-empty" : ""}`)], [hasData ? `${pct}%` : "—"]),
      ]),
    ],
  )
}

/**
 * Strip tool-call fences from streaming text (2026-10-11): the ```aimy-tool
 * block streams in token-by-token, causing layout jumping and showing raw
 * JSON. Remove complete fences, incomplete trailing fences (mid-stream),
 * and bare JSON tool calls. Returns empty if only tool calls so far.
 *
 * Uses extractToolCalls (balanced-brace parser) for bare JSON — the old
 * regex \{[^}]*\} broke on nested objects (2026-10-11).
 */
const stripStreamingToolCalls = (text: string): string => {
  let cleaned = text.replace(/```aimy-tool[\s\S]*?```/g, "")
  cleaned = cleaned.replace(/```aimy-tool[\s\S]*$/, "")
  // Bare JSON: use the robust parser from tool-calls.ts instead of regex.
  const calls = extractToolCalls(cleaned)
  for (const c of calls) {
    cleaned = cleaned.replace(c.raw, "")
  }
  return cleaned.trim()
}

/**
 * Live footer tags for the streaming bubble (2026-10-12): calls parsed
 * from the streaming text render with a spinner until their completion
 * lands (chat.tool), then flip to the outcome tint. Matching is by
 * name, FIFO per name — the same rule the settle path uses.
 */
const streamingToolTags = (
  h: H,
  text: string,
  activity: ReadonlyArray<{ tool: string; ok: boolean; conclusion: string }> | undefined
): Array<ReturnType<H["div"]>> => {
  const calls = extractToolCalls(text)
  if (calls.length === 0) return []
  const queues = new Map<string, Array<{ ok: boolean; conclusion: string }>>()
  for (const a of activity ?? []) {
    const q = queues.get(a.tool) ?? []
    q.push({ ok: a.ok, conclusion: a.conclusion })
    queues.set(a.tool, q)
  }
  const nodes: Array<string | ReturnType<H["span"]>> = []
  calls.forEach((c, idx) => {
    if (idx > 0) nodes.push(", ")
    const q = queues.get(c.tool)
    const hit = q !== undefined && q.length > 0 ? q.shift()! : undefined
    if (hit !== undefined) {
      nodes.push(
        h.span([h.Class(`tool-tag ${hit.ok ? "tool-tag--ok" : "tool-tag--failed"}`)], [toolAlias(c.tool)])
      )
    } else {
      nodes.push(
        h.span([h.Class("tool-tag tool-tag--running")], [
          h.span([h.Class("tool-spin")], []),
          toolAlias(c.tool),
        ])
      )
    }
  })
  return [h.div([h.Class("msg-tools")], nodes)]
}

const streamingView = (
  h: H,
  streaming: { text: string; toolActivity?: ReadonlyArray<{ tool: string; ok: boolean; conclusion: string }> | undefined }
) => {
  const text = streaming.text
  const tags = streamingToolTags(h, text, streaming.toolActivity)
  // Never render tool-call JSON while streaming (2026-10-11: fixes the
  // ugly code-block flash and layout jumping). If only tool calls have
  // arrived, show a subtle working indicator instead.
  const cleanText = stripStreamingToolCalls(text)
  if (cleanText.length === 0) {
    return h.div([h.Class("msg-row"), h.Key("streaming")], [
      h.div([h.Class("msg msg-assistant streaming")], [
        h.span([h.Class("msg-role")], ["AIMY"]),
        h.div([h.Class("msg-body")], [
          h.span([h.Class("working-shimmer")], ["working\u2026"]),
        ]),
      ]),
      ...tags,
    ])
  }
  const { stable, tail } = segmentStreamingText(cleanText)
  // Render as a bubble from the start (2026-10-10: fixes raw text flash
  // before bubble formatting). Uses same structure as messageRow.
  return h.div([h.Class("msg-row"), h.Key("streaming")], [
    h.div([h.Class("msg msg-assistant streaming")], [
      h.span([h.Class("msg-role")], ["AIMY"]),
      h.div([h.Class("msg-body")], [
        ...stable.map((b) => {
          if (b.kind === "code") {
            return h.div([h.Class(`seg seg-${b.kind}`), h.Key(b.hash)], [
              h.div([h.Class("msg-body markdown-body"), h.InnerHTML(renderMarkdown(b.text))], [])
            ])
          }
          const body = looksLikeMarkdown(b.text)
            ? h.div([h.Class("msg-body markdown-body"), h.InnerHTML(renderMarkdown(b.text))], [])
            : h.div([h.Class(`seg seg-${b.kind}`)], [b.text])
          return h.div([h.Key(b.hash)], [body])
        }),
        h.div([h.Class("seg seg-tail"), h.Key("tail")], [tail.text]),
        h.span([h.Class("stream-caret")], ["▍"]),
      ]),
    ]),
    ...tags,
  ])
}

/**
 * Enter-to-submit decision for the composer. Pure: the view wires it to
 * OnKeyDownPreventDefault; tests exercise it directly.
 *
 * Plain Enter submits. Shift+Enter, Cmd+Enter, Ctrl+Enter insert a newline
 * (handled by the renderer's capture-phase keydown listener in main.ts,
 * which stops propagation before foldkit's handler swallows it). Other
 * keys, streaming, and empty drafts decline (None).
 */
export const composerKeySubmit = (
  draft: string,
  streaming: boolean,
  key: string,
  shiftKey: boolean,
  hasFiles = false,
): Option.Option<Message> => {
  const submittable = !streaming && (draft.trim().length > 0 || hasFiles)
  if (key !== "Enter" || shiftKey || !submittable) return Option.none()
  return Option.some(
    Message.UserSentMessage({
      id: `msg-${Date.now()}`,
      text: draft,
      at: Date.now(),
    }),
  )
}

/**
 * Prompt-history cycling (2026-10-13, Kimler): ArrowUp in an
 * untouched (empty) composer recalls the previous prompt he
 * sent; ArrowDown walks back toward the present, and stepping
 * past the newest returns the empty box and ends the cycle.
 * With text in the box the arrows keep their cursor job
 * (multi-line editing) — cycling engages only from empty, and
 * any typing ends it (ComposerDraftChanged rebuilds the
 * composer without an index). While cycling the arrows own
 * the keys even on multi-line recalls; one typed character
 * hands them back to the caret. At the oldest entry ArrowUp
 * declines, so the caret can still go home. Pure, like
 * composerKeySubmit above.
 */
export const composerHistoryStep = (
  history: ReadonlyArray<string>,
  index: number,
  draft: string,
  streaming: boolean,
  key: string,
): Option.Option<Message> => {
  if (streaming || history.length === 0) return Option.none()
  if (key === "ArrowUp") {
    if (index < 0) {
      if (draft !== "") return Option.none()
      const i = history.length - 1
      return Option.some(Message.ComposerHistoryStepped({ text: history[i]!, index: i }))
    }
    if (index === 0) return Option.none()
    const i = index - 1
    return Option.some(Message.ComposerHistoryStepped({ text: history[i]!, index: i }))
  }
  if (key === "ArrowDown") {
    if (index < 0) return Option.none()
    if (index >= history.length - 1) {
      return Option.some(Message.ComposerHistoryStepped({ text: "", index: -1 }))
    }
    const i = index + 1
    return Option.some(Message.ComposerHistoryStepped({ text: history[i]!, index: i }))
  }
  return Option.none()
}

/** His own sent prompts, oldest to newest, consecutive
 * duplicates collapsed so recall never appears stuck. */
export const promptHistoryOf = (
  messages: ReadonlyArray<{ role: string; text: string }>,
): Array<string> => {
  const out: Array<string> = []
  for (const m of messages) {
    if (m.role === "user" && m.text !== "" && out[out.length - 1] !== m.text) out.push(m.text)
  }
  return out
}

/**
 * The composer (chat input row). Exported for the composed
 * Home panel (2026-10-13): the dash is where work starts, so
 * the Home destination mounts this under the stage — one
 * composer implementation, two homes. Pure in the session.
 */
export const composerView = (h: H, session: SessionSlice) => {
  const draft = session.composer.draft
  const streaming = session.streaming.active
  const attachments = session.composer.attachments
  const documents = session.composer.documents ?? []
  const historyIndex = session.composer.historyIndex ?? -1
  // Global history (2026-10-13): the persisted cross-chat list
  // once it has loaded; until then, this session's own prompts.
  const promptHistory = session.promptHistory ?? promptHistoryOf(session.messages)
  // Attachment strip (2026-10-11 images; 2026-10-13 documents):
  // staged files above the input. Documents render as a chip
  // with the file-text icon and the filename — the document
  // equivalent of the photo thumbnail.
  const attachmentStrip = attachments.length > 0 || documents.length > 0
    ? h.div([h.Class("composer-attachments")], [
        ...attachments.map((a) =>
          h.div([h.Class("composer-attachment"), h.Key(a.id)], [
            h.img([h.Class("composer-attachment-thumb"), h.Src(a.dataUrl), h.Alt(a.name)]),
            h.button(
              [h.Class("composer-attachment-remove"), h.Title("Remove"), h.OnClick(Message.AttachmentRemoved({ id: a.id }))],
              ["\u00d7"],
            ),
          ]),
        ),
        ...documents.map((d) =>
          h.div([h.Class("composer-attachment composer-attachment-doc"), h.Key(d.id), h.Title(`${d.name} — ${d.text.length} characters`)], [
            icon.fileText(h),
            h.span([h.Class("composer-attachment-doc-name")], [d.name]),
            h.button(
              [h.Class("composer-attachment-remove"), h.Title("Remove"), h.OnClick(Message.AttachmentRemoved({ id: d.id }))],
              ["\u00d7"],
            ),
          ]),
        ),
      ])
    : null
  // Editing strip (2026-10-13): while a past prompt is loaded
  // for edit-and-resend, the composer says what sending will
  // do (branch the chat at that message) and offers a cancel.
  const editingTarget =
    session.pendingEditFromId !== undefined
      ? session.messages.find((m) => m.id === session.pendingEditFromId)
      : undefined
  const editingStrip = editingTarget !== undefined
    ? h.div([h.Class("composer-editing")], [
        h.span([h.Class("composer-editing-label")], [
          `Editing an earlier message — sending branches the chat there: “${editingTarget.text.slice(0, 60)}${editingTarget.text.length > 60 ? "…" : ""}”`,
        ]),
        h.button(
          [h.Class("composer-editing-cancel"), h.Title("Cancel edit"), h.OnClick(Message.UserMessageEditCancelled({}))],
          ["Cancel"],
        ),
      ])
    : null
  return h.div([h.Class("composer-wrap")], [
    ...(editingStrip ? [editingStrip] : []),
    ...(attachmentStrip ? [attachmentStrip] : []),
    h.div([h.Class("composer")], [
      h.div(
        [
          h.Class("composer-input-wrap"),
        ],
        [
          h.textarea([
          h.Class("composer-input"),
          h.Value(draft),
          h.Disabled(streaming),
          h.Placeholder("Message AImy…"),
          h.Rows(1),
          h.OnInput((value) => Message.ComposerDraftChanged({ text: value })),
          h.OnKeyDownPreventDefault((key, modifiers) =>
            composerKeySubmit(draft, streaming, key, modifiers.shiftKey, attachments.length > 0 || documents.length > 0).pipe(
              Option.orElse(() =>
                composerHistoryStep(promptHistory, historyIndex, draft, streaming, key),
              ),
            ),
          ),
        ]),
        // Stop (2026-10-13): while she is generating, a stop
        // button sits beside send. Inert — the delegated click
        // listener in main.ts dispatches aimy:stop-stream (the
        // same channel Esc uses).
        ...(streaming
          ? [h.button(
              [h.Class("composer-stop-inside js-stop-stream"), h.Title("Stop generating (Esc)")],
              [icon.stop(h)],
            )]
          : []),
        h.button(
          [
            h.Class("composer-send-inside"),
            h.Title("Send (Enter)"),
            h.Disabled(streaming || (draft.trim().length === 0 && attachments.length === 0 && documents.length === 0)),
            h.OnClick(
              Message.UserSentMessage({
                id: `msg-${Date.now()}`,
                text: draft,
                at: Date.now(),
                ...(attachments.length > 0 ? { images: attachments } : {}),
                ...(documents.length > 0 ? { documents } : {}),
              }),
            ),
          ],
          [icon.cornerDownLeft(h)],
        ),
      ]),
      h.div([h.Class("split-btn")], [
        h.button(
          [
            h.Class(session.voiceEnabled ? "icon-btn split-main voice-on" : "icon-btn split-main"),
            h.Title(session.voiceEnabled ? "Voice off" : "Voice on — speak each reply"),
            h.OnClick(Message.VoiceToggled({ enabled: !session.voiceEnabled })),
          ],
          [session.voiceEnabled ? icon.volumeOn(h) : icon.volumeOff(h)]
        ),
        h.button(
          [
            h.Class("icon-btn split-arrow"),
            h.Title("Voice settings"),
            h.OnClick(Message.VoicePanelToggled({ open: !session.voicePanelOpen })),
          ],
          [icon.chevronDown(h)]
        ),
      ]),
      // Mic input (STT) — color-coded by state:
      // green = recording/transcribing, white = ready/waiting,
      // grey = initializing/not configured, red = failed.
      // Pre-roll dot (2026-10-11): small status dot shows the 500ms lead-in
      // buffer state — amber pulsing = warming up, green = pre-roll active,
      // grey = mic unavailable. Separate channel from the STT engine color.
      ...(() => {
        const stt = session.sttEngine.state
        const active = session.micRecording || session.micTranscribing
        const ready = stt === "ready"
        const failed = stt === "failed"
        const loading = stt === "installing" || stt === "unknown"
        const micClass = active
          ? "icon-btn mic-btn mic-active"
          : failed
            ? "icon-btn mic-btn mic-error"
            : loading || !ready
              ? "icon-btn mic-btn mic-pending"
              : "icon-btn mic-btn mic-ready"
        const preRoll = session.micPreRoll
        const preRollDotClass = preRoll === "ready"
          ? "mic-preroll-dot preroll-ready"
          : preRoll === "unavailable"
            ? "mic-preroll-dot preroll-unavailable"
            : "mic-preroll-dot preroll-warming"
        const preRollLabel = preRoll === "ready"
          ? "Pre-roll active — lead-in captured"
          : preRoll === "unavailable"
            ? "Mic unavailable — pre-roll off"
            : "Mic warming up — pre-roll starting…"
        const title = active
          ? (session.micRecording ? "Recording… (release to transcribe)" : "Transcribing…")
          : failed
            ? "STT engine failed — check Voice Settings"
            : loading
              ? "STT initializing…"
              : !ready
                ? "STT not configured — open Voice Settings"
                : `Dictate (speech to text). ${preRollLabel}`
        return [
          h.button(
            [
              h.Class(micClass),
              h.Title(title),
              h.OnClick(Message.MicRecordToggled({})),
              h.Disabled(!ready || session.micTranscribing),
            ],
            [icon.mic(h), h.span([h.Class(preRollDotClass), h.Title(preRollLabel)], [])],
          ),
        ]
      })(),
      ...(session.speakingStreamId !== undefined
        ? [h.span([h.Class("speaking-indicator")], ["speaking…"])]
        : []),
      contextMeterView(h, session.contextMeter),
    ]),
    // Voice draft action bar: appears after transcription.
    // Click ✓ to send, ✕ (or right-click) to discard, Button 3 for more.
    // NOTE: Replaced by global click-to-send (see voiceConfirm subscription).
    // Keeping the bar hidden — Kimler prefers click-anywhere.
  ])
}

/**
 * Empty state: inviting, shows what Aimy can do. Not an empty box.
 */
const emptyStateView = (h: H, session: SessionSlice) => {
  return h.div([h.Class("empty-state")], [
    // The HomeDash (2026-10-13): a new chat's empty state IS the
    // dash — the layered widget stage (WorkOn / GlobeNews /
    // MindMap by priority). It dies with this element when a
    // conversation starts; the Home destination keeps it alive.
    // The greeting block that used to sit under the stage here
    // ("What should we work on?" + suggestion chips) is the WorkOn
    // widget's content now (Kimler, 2026-10-13) — it lives inside
    // the dash, in WorkOn's layer, and moves/resizes with it.
    homeDashView(h, session),
  ])
}

/**
 * The chat panel. Pure: identical `session` in -> identical tree out.
 */
export const chatPanelView = (session: SessionSlice, h: H) => {
  const { start, end } = visibleWindow(
    session.messages.length,
    session.listWindow.anchorIndex,
    session.listWindow.overscan,
  )
  const rows = session.messages.slice(start, end).map((m) => messageRow(h, m))
  // Column-reverse (2026-10-10): newest first in DOM, visually last via CSS.
  // The browser pins to DOM start (visual bottom) automatically — no JS scrolling.
  const children = [...rows].reverse()
  if (session.streaming.active) {
    children.unshift(streamingView(h, session.streaming))
  }
  const isEmpty = session.messages.length === 0 && !session.streaming.active
  return h.section([h.Class("chat-panel"), h.Id("chat-panel")], [
    ...(session.voicePanelOpen ? [voicePanelView(h, session)] : []),
    h.div(
      [
        h.Class("message-list"),
        h.OnScroll((scrollTop) => Message.ChatListScrolled({ scrollTop })),
      ],
      isEmpty
        ? [emptyStateView(h, session)]
        : children,
    ),
    composerView(h, session),
  ])
}

/** Document wrapper used by app.ts for the full shell view. */
export const chatDocument = (session: SessionSlice, h: H): Document => ({
  title: `AImy — ${session.sessionId}`,
  body: chatPanelView(session, h),
})
