/**
 * desktop/src/renderer/main.ts — the desktop renderer's entry point.
 *
 * Mounts the M8 composed app (`ui/src/composed` — the real shell + every
 * panel slice, imported, not forked) via foldkit's interactive browser
 * runtime, with the IPC-backed interpreter (`./resources.ts`) provided at
 * the boundary and the bridge-backed subscriptions (`./subscriptions.ts`)
 * pumping chat tokens and main→renderer events into the message flow.
 *
 * Fail-loud boot: a missing #root container or a missing preload bridge
 * renders an error into the page instead of a silent blank window.
 */
import { Runtime } from "foldkit"

import {
  AppModel,
  appUpdate,
  appView,
  initialAppModel,
  type AppMessage,
  type AppModel as AppModelType,
  type AppServices
} from "../../../ui/src/composed/index.js"

import { getAimy } from "./ipc.js"
import { ipcResources } from "./resources.js"
import { subscriptions, stopAllAudio } from "./subscriptions.js"

const escapeHtml = (raw: string): string =>
  raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const bootError = (message: string): void => {
  document.body.innerHTML =
    `<main class="boot-error"><h1>AImy failed to start</h1><p>${escapeHtml(message)}</p></main>`
}

const boot = (): void => {
  const container = document.getElementById("root")
  if (container === null) {
    bootError("missing #root container in index.html")
    return
  }
  try {
    // Fail fast when the preload bridge is absent — the subscriptions and
    // the command interpreter both need it, and a half-connected renderer
    // would lie about every panel.
    getAimy()
  } catch (error) {
    bootError(error instanceof Error ? error.message : String(error))
    return
  }

  const app = Runtime.makeApplication<AppModelType, AppMessage, AppServices>({
    Model: AppModel,
    init: () => ({ model: initialAppModel() }),
    update: appUpdate,
    view: appView,
    subscriptions,
    container,
    resources: ipcResources
  })
  Runtime.run(app)

  // Version badge (lower right) — shows git hash + build time
  // so Kimler can verify he's seeing the latest build.
  const ver = (window as any).AIMY_VERSION as string | undefined
  if (ver) {
    const badge = document.createElement("div")
    badge.className = "version-badge"
    badge.textContent = ver
    badge.title = "Build version (git hash @ time)"
    document.body.appendChild(badge)
  }



  // Pause narration when user starts typing (2026-10-11): if AImy is
  // speaking and the user wants to ask something, don't make them wait
  // or hit send on an empty message — typing interrupts the voice.
  document.addEventListener("input", (e) => {
    const target = e.target as HTMLElement
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      const input = target as HTMLInputElement
      // Only stop on first character (not every keystroke).
      if (input.value.length === 1) {
        console.log("[aimy] user started typing — pausing narration")
        stopAllAudio("user-typing")
      }
    }
  })

  // Pause narration on mic/PTT start (2026-10-11): speaking over AImy
  // should cut her off, not layer on top. Mirrors the PTT config in
  // resources.ts (localStorage) without double-dispatching the toggle.
  const getPttConfig = () => {
    try {
      const key = localStorage.getItem("aimy.pushToTalkKey") ?? "ControlRight"
      const useMouse = localStorage.getItem("aimy.pushToTalkUseMouse") === "1"
      const isKeyboardKey = /^(Control|Alt|Shift|Meta|Space)/.test(key)
      return { key: useMouse && isKeyboardKey ? "3" : key, useMouse }
    } catch {
      return { key: "ControlRight", useMouse: false }
    }
  }
  document.addEventListener("keydown", (e) => {
    const { key, useMouse } = getPttConfig()
    if (useMouse) return
    if ((e.target as HTMLElement)?.tagName === "INPUT") return
    if (e.code === key && !e.repeat) {
      console.log(`[aimy] PTT key down (${e.code}) — pausing narration`)
      stopAllAudio("ptt-key")
    }
  })
  document.addEventListener("mousedown", (e) => {
    const { key, useMouse } = getPttConfig()
    if (!useMouse) return
    if (String(e.button) === key) {
      console.log(`[aimy] PTT mouse down (button ${e.button}) — pausing narration`)
      stopAllAudio("ptt-mouse")
    }
  })
  // Mic button in the composer: clicking it to talk also interrupts.
  // Matched by aria-label (mic/microphone/voice/record), not class names.
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement
      const button = target.closest("button")
      if (!button) return
      const label = (
        button.getAttribute("aria-label") ??
        button.getAttribute("title") ??
        ""
      ).toLowerCase()
      if (/mic|microphone|voice|record|speak/.test(label)) {
        console.log("[aimy] mic button clicked — pausing narration")
        stopAllAudio("mic-button")
      }
    },
    true
  )

  // Narrate hover tooltip (2026-10-11 debugging aid): CSS percentage
  // positioning proved unreliable across layouts, so the tooltip is a
  // single fixed div positioned from measured bubble geometry. Hovering a
  // .narrate-tag shows the spoken text in the gutter right of the bubble;
  // it hides when the pointer leaves the tag/tooltip or on scroll.
  let narrateTipEl: HTMLDivElement | null = null
  const getNarrateTipEl = (): HTMLDivElement => {
    if (narrateTipEl === null) {
      narrateTipEl = document.createElement("div")
      narrateTipEl.className = "narrate-tip-fixed"
      document.body.appendChild(narrateTipEl)
    }
    return narrateTipEl
  }
  const hideNarrateTip = (): void => {
    if (narrateTipEl !== null) narrateTipEl.style.display = "none"
  }
  document.addEventListener("mouseover", (e) => {
    const target = e.target as HTMLElement
    const el = getNarrateTipEl()
    // Hovering the tooltip itself: keep it visible (lets the user read/copy).
    if (target === el || el.contains(target)) return
    if (!(target instanceof Element)) {
      hideNarrateTip()
      return
    }
    const tag = target.closest(".narrate-tag")
    if (!tag) {
      hideNarrateTip()
      return
    }
    const source = tag.querySelector(".narrate-tip")
    const bubble = tag.closest(".msg-row")?.querySelector(".msg")
    const spoken = source?.textContent?.trim()
    if (!spoken || !bubble) {
      hideNarrateTip()
      return
    }
    const rect = bubble.getBoundingClientRect()
    el.textContent = spoken
    el.style.display = "block"
    // Gutter right of the bubble; clamp to viewport.
    const width = 300
    const left = Math.min(rect.right + 8, window.innerWidth - width - 8)
    el.style.left = `${Math.max(8, left)}px`
    el.style.top = `${Math.max(8, rect.top)}px`
  })
  // Scrolling detaches the fixed tooltip from its bubble — hide it.
  document.addEventListener("scroll", hideNarrateTip, true)

  // Copy button on message bubbles (2026-10-11): one click copies the clean
  // text (voice tags stripped, code blocks kept with language tags). The
  // button is rendered by view.ts with a hidden .msg-copy-source sibling
  // carrying the clean text — same pattern as the narrate tooltip source.
  // Delegated: no foldkit message needed, it's a pure DOM/clipboard op.
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement
    const btn = target.closest(".msg-copy-btn") as HTMLElement | null
    if (btn === null) return
    const row = btn.closest(".msg-row")
    const source = row?.querySelector(".msg-copy-source")
    const text = source?.textContent ?? ""
    if (text === "") return
    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add("copied")
      setTimeout(() => btn.classList.remove("copied"), 1500)
    }).catch((err) => {
      console.error("[aimy] copy failed:", err)
    })
  })

  // Intercept markdown link clicks: open http/https in OS browser, not in-app.
  document.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement
    const anchor = target.closest(".markdown-body a") as HTMLAnchorElement | null
    if (!anchor) return
    const href = anchor.getAttribute("href")
    if (!href) return
    if (href.startsWith("aimy://")) {
      e.preventDefault()
      return
    }
    if (href.startsWith("http://") || href.startsWith("https://")) {
      e.preventDefault()
      try {
        const aimy = getAimy()
        await aimy.invoke({ _tag: "shell.openExternal", url: href })
      } catch (err) {
        console.error("[aimy] failed to open external link:", err)
      }
      return
    }
    e.preventDefault()
  })
}

try {
  boot()
} catch (error) {
  bootError(error instanceof Error ? error.message : String(error))
}
