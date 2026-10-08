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
import { segmentStreamingText } from "./segment.js"

type H = HtmlBuilder<Message>

const roleClass = (role: ChatMessage["role"]): string =>
  role === "user" ? "msg-user" : role === "assistant" ? "msg-assistant" : "msg-tool"

const roleLabel = (role: ChatMessage["role"]): string =>
  role === "user" ? "You" : role === "assistant" ? "AImy" : "tool"

const messageRow = (h: H, m: ChatMessage) =>
  h.div([h.Class(`msg ${roleClass(m.role)}`), h.Key(m.id)], [
    h.span([h.Class("msg-role")], [roleLabel(m.role)]),
    h.div([h.Class("msg-body")], [sanitizeTerminalOutput(m.text)]),
  ])

const formatTokens = (n: number | null): string =>
  n === null ? "unknown" : n.toLocaleString("en-US")

/**
 * Voice settings panel: engine install + voice clone management.
 * Rendered under the chat header when `voicePanelOpen`.
 */
const voicePanelView = (h: H, session: SessionSlice) => {
  const engine = session.ttsEngine
  const rows: Array<ReturnType<H["div"]>> = []

  const errorLine =
    session.voiceError !== undefined
      ? h.p([h.Class("voice-error")], [session.voiceError])
      : undefined

  if (engine.state === "unknown") {
    rows.push(h.div([h.Class("voice-row")], ["Checking voice engine…"]))
  } else if (engine.state === "missing") {
    rows.push(
      h.div([h.Class("voice-row")], [
        "The voice engine isn't installed yet — one download (~1–2.5 GB), then every reply can be spoken aloud.",
      ])
    )
    rows.push(
      h.div([h.Class("voice-row")], [
        h.button(
          [h.Class("voice-btn voice-btn-primary"), h.OnClick(Message.TtsInstallRequested({}))],
          ["Install voice engine"]
        ),
      ])
    )
  } else if (engine.state === "installing") {
    rows.push(
      h.div([h.Class("voice-row")], [
        `Installing… ${engine.progressMessage ?? "starting"}`,
      ])
    )
  } else if (engine.state === "failed") {
    rows.push(
      h.div([h.Class("voice-row")], [`Install failed: ${engine.detail ?? "unknown error"}`])
    )
    rows.push(
      h.div([h.Class("voice-row")], [
        h.button(
          [h.Class("voice-btn"), h.OnClick(Message.TtsInstallRequested({}))],
          ["Retry install"]
        ),
      ])
    )
  } else {
    // ready — voice list + clone management
    rows.push(h.div([h.Class("voice-row voice-ready")], ["Voice engine ready."]))
    for (const v of session.voices) {
      const active = session.activeVoiceId === v.id || (session.activeVoiceId === undefined && v.isDefault)
      rows.push(
        h.div([h.Class("voice-row")], [
          h.button(
            [
              h.Class(active ? "voice-btn voice-active" : "voice-btn"),
              h.OnClick(Message.VoiceSelectRequested({ voiceId: v.id })),
              h.Title(active ? "Active voice" : `Use ${v.name}`),
            ],
            [`${active ? "● " : "○ "}${v.name}`]
          ),
        ])
      )
    }
    if (session.voices.length === 0) {
      rows.push(h.div([h.Class("voice-row voice-dim")], ["No voices yet — add one below."]))
    }
    rows.push(
      h.div([h.Class("voice-row")], [
        h.button(
          [h.Class("voice-btn"), h.OnClick(Message.VoiceFilePickRequested({}))],
          ["Add voice…"]
        ),
        h.button(
          [h.Class("voice-btn"), h.OnClick(Message.VoicesRefreshRequested({}))],
          ["Refresh"]
        ),
      ])
    )
    rows.push(
      h.div([h.Class("voice-row voice-dim")], [
        "Add a voice from a short WAV recording — Chatterbox clones it at synthesis time, no training step.",
      ])
    )
  }

  const children: Array<ReturnType<H["div"]>> = [
    h.div([h.Class("voice-panel-head")], [
      h.span([h.Class("voice-panel-title")], ["Voice"]),
      h.button(
        [h.Class("voice-btn"), h.OnClick(Message.VoicePanelToggled({ open: false })), h.Title("Close")],
        ["×"]
      ),
    ]),
    ...rows,
  ]
  if (errorLine !== undefined) children.push(errorLine as ReturnType<H["div"]>)
  return h.section([h.Class("voice-panel")], children)
}

const contextMeterView = (h: H, meter: ContextMeter) => {
  const used = (meter.inputTokens ?? 0) + (meter.outputTokens ?? 0) + (meter.reasoningTokens ?? 0)
  const pct =
    meter.ceiling > 0 && meter.inputTokens !== null
      ? Math.min(100, Math.round((used / meter.ceiling) * 100))
      : null
  return h.div([h.Class("context-meter")], [
    h.span([h.Class("meter-label")], ["context"]),
    h.span(
      [h.Class("meter-values")],
      [
        `in ${formatTokens(meter.inputTokens)} · out ${formatTokens(meter.outputTokens)} · reasoning ${formatTokens(meter.reasoningTokens)}`,
      ],
    ),
    h.span(
      [h.Class("meter-pct")],
      [pct === null ? "ceiling unknown" : `${pct}% of ${meter.ceiling.toLocaleString("en-US")}`],
    ),
  ])
}

const streamingView = (h: H, text: string) => {
  const { stable, tail } = segmentStreamingText(text)
  return h.div([h.Class("streaming"), h.Key("streaming")], [
    ...stable.map((b) =>
      h.div([h.Class(`seg seg-${b.kind}`), h.Key(b.hash)], [b.text]),
    ),
    h.div([h.Class("seg seg-tail"), h.Key("tail")], [tail.text]),
    h.span([h.Class("stream-caret")], ["▍"]),
  ])
}

/**
 * Enter-to-submit decision for the composer. Pure: the view wires it to
 * OnKeyDownPreventDefault; tests exercise it directly. Shift+Enter, other
 * keys, streaming, and empty drafts all decline (None).
 */
export const composerKeySubmit = (
  draft: string,
  streaming: boolean,
  key: string,
  shiftKey: boolean,
): Option.Option<Message> => {
  const submittable = !streaming && draft.trim().length > 0
  if (key !== "Enter" || shiftKey || !submittable) return Option.none()
  return Option.some(
    Message.UserSentMessage({
      id: `msg-${Date.now()}`,
      text: draft,
      at: Date.now(),
    }),
  )
}

const composerView = (h: H, draft: string, streaming: boolean) =>
  h.div([h.Class("composer")], [
    h.input([
      h.Class("composer-input"),
      h.Value(draft),
      h.Disabled(streaming),
      h.Placeholder("Message AImy…"),
      h.OnInput((value) => Message.ComposerDraftChanged({ text: value })),
      h.OnKeyDownPreventDefault((key, modifiers) =>
        composerKeySubmit(draft, streaming, key, modifiers.shiftKey),
      ),
    ]),
    h.button(
      [
        h.Class("composer-send"),
        h.Disabled(streaming || draft.trim().length === 0),
        h.OnClick(
          Message.UserSentMessage({
            id: `msg-${Date.now()}`,
            text: draft,
            at: Date.now(),
          }),
        ),
      ],
      ["Send"],
    ),
  ])

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
  const children = [...rows]
  if (session.streaming.active) {
    children.push(streamingView(h, session.streaming.text))
  }
  return h.section([h.Class("chat-panel"), h.Id("chat-panel")], [
    h.header([h.Class("chat-header")], [
      h.span([h.Class("session-id")], [`session ${session.sessionId}`]),
      h.span([h.Class("branch-id")], [`branch ${session.branchId}`]),
      h.button(
        [
          h.Class(session.voiceEnabled ? "voice-toggle voice-on" : "voice-toggle voice-off"),
          h.Title(session.voiceEnabled ? "Voice off" : "Voice on — speak each reply"),
          h.OnClick(Message.VoiceToggled({ enabled: !session.voiceEnabled })),
        ],
        [session.voiceEnabled ? "🔊 voice" : "🔇 voice"]
      ),
      h.button(
        [
          h.Class("voice-settings-btn"),
          h.Title("Voice settings — engine install, voices"),
          h.OnClick(Message.VoicePanelToggled({ open: !session.voicePanelOpen })),
        ],
        ["⚙"]
      ),
      ...(session.speakingStreamId !== undefined
        ? [h.span([h.Class("speaking-indicator")], ["speaking…"])]
        : []),
      contextMeterView(h, session.contextMeter),
    ]),
    ...(session.voicePanelOpen ? [voicePanelView(h, session)] : []),
    h.div(
      [
        h.Class("message-list"),
        h.OnScroll((scrollTop) => Message.ChatListScrolled({ scrollTop })),
      ],
      children,
    ),
    composerView(h, session.composer.draft, session.streaming.active),
  ])
}

/** Document wrapper used by app.ts for the full shell view. */
export const chatDocument = (session: SessionSlice, h: H): Document => ({
  title: `AImy — ${session.sessionId}`,
  body: chatPanelView(session, h),
})
