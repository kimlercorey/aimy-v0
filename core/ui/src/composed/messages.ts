/**
 * ui/src/composed/messages.ts — the composed application's message vocabulary.
 *
 * Every slice's messages ride in a `Got*` envelope (the foldkit submodel
 * pattern). There is deliberately no top-level message that any slice does
 * not already define: the shell's structural rules (no dial-setting message,
 * rejection of unknown tags) are inherited unchanged, because slice messages
 * are only ever constructed by their own slice's views and commands.
 */
import { defineMessageUnion } from "foldkit/message"

import type { AscMessage } from "../asc/index.js"
import { AscPanelMessage } from "../asc/index.js"
import type { DevtoolsMessage } from "../devtools/index.js"
import { Message as DevtoolsMsg } from "../devtools/index.js"
import type { ExportMessage } from "../export/index.js"
import { Message as ExportMsg } from "../export/index.js"
import { Message as ShellMsg } from "../messages.js"
import type { Message as ShellMessage } from "../messages.js"
import type { OnboardingMessage } from "../onboarding/index.js"
import { Message as OnboardingMsg } from "../onboarding/index.js"
import type { BannersMessageType, JobsMessageType } from "../ops/index.js"
import { BannersMessage, JobsMessage } from "../ops/index.js"
import type { SovereigntyMessage } from "../sovereignty/index.js"
import { Message as SovereigntyMsg } from "../sovereignty/index.js"
import type { TimelineMessage } from "../timeline/index.js"
import { Message as TimelineMsg } from "../timeline/index.js"

export const AppMessage = defineMessageUnion({
  GotShell: { message: ShellMsg },
  GotAsc: { message: AscPanelMessage },
  GotSovereignty: { message: SovereigntyMsg },
  GotExport: { message: ExportMsg },
  GotOnboarding: { message: OnboardingMsg },
  GotDevtools: { message: DevtoolsMsg },
  GotTimeline: { message: TimelineMsg },
  GotJobs: { message: JobsMessage },
  GotBanners: { message: BannersMessage },
})
export type AppMessage = typeof AppMessage.Type

/** The child message types, for foldChild wiring. */
export type {
  AscMessage,
  BannersMessageType,
  DevtoolsMessage,
  ExportMessage,
  JobsMessageType,
  OnboardingMessage,
  ShellMessage,
  SovereigntyMessage,
  TimelineMessage,
}
