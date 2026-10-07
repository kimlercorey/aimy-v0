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

const composerView = (h: H, draft: string, streaming: boolean) =>
  h.div([h.Class("composer")], [
    h.input([
      h.Class("composer-input"),
      h.Value(draft),
      h.Disabled(streaming),
      h.Placeholder("Message AImy…"),
      h.OnInput((value) => Message.ComposerDraftChanged({ text: value })),
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
      contextMeterView(h, session.contextMeter),
    ]),
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
