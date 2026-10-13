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
import { ipcResources, warmupMicCapture } from "./resources.js"
import { subscriptions, stopAllAudio } from "./subscriptions.js"
import { startMermaid } from "./mermaid.js"
import { startMirrorField } from "./mirror-field.js"
import { startMindMap } from "./mindmap.js"
import { startHomedashEdit } from "./homedash-edit.js"

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

  // Mermaid diagrams (2026-10-12): render .mermaid-block elements as SVG.
  startMermaid()

  // The Mirror Field (2026-10-12): ambient animated background for
  // the chat empty state — counter-rotating pyramids, as above/so below.
  startMirrorField()
  startMindMap()
  // HomeDash in-place editor (2026-10-13): Cmd+right-click the dash.
  startHomedashEdit()

  // Mic warmup (2026-10-11): prime the pre-roll ring buffer at startup so
  // the first PTT press doesn't lose its lead-in. Non-blocking; the mic
  // permission prompt appears once, and PTT retries on press if denied.
  warmupMicCapture()

  // Image drag-and-drop (2026-10-11): drop images onto the chat to attach
  // them to the next message. Downscaled client-side to max 1568px.
  const isImageFile = (f: File): boolean =>
    f.type === "image/png" || f.type === "image/jpeg" || f.type === "image/gif" || f.type === "image/webp"
  const downscaleImage = (file: File): Promise<{ dataUrl: string; mimeType: string }> =>
    new Promise((resolve, reject) => {
      // Use FileReader (data: URL) instead of blob: URL — the CSP img-src
      // directive allows data: but not blob: (2026-10-11: blob URLs were
      // blocked, causing "image load failed").
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const img = new Image()
        img.onload = () => {
          const maxEdge = 1568
          const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
          const w = Math.round(img.width * scale)
          const h = Math.round(img.height * scale)
          const canvas = document.createElement("canvas")
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext("2d")
          if (!ctx) { reject(new Error("no 2d context")); return }
          ctx.drawImage(img, 0, 0, w, h)
          // JPEG for photos (smaller), PNG for others (preserve transparency).
          const mimeType = file.type === "image/png" || file.type === "image/gif" ? file.type : "image/jpeg"
          resolve({ dataUrl: canvas.toDataURL(mimeType, 0.85), mimeType })
        }
        img.onerror = () => reject(new Error("image load failed"))
        img.src = dataUrl
      }
      reader.onerror = () => reject(new Error("file read failed"))
      reader.readAsDataURL(file)
    })
  let dropOverlay: HTMLElement | null = null
  document.addEventListener("dragover", (e) => {
    // Always preventDefault so the drop event fires (dataTransfer.types
    // is unreliable during dragover in some browsers).
    if (!e.dataTransfer) return
    e.preventDefault()
    const hasFiles = [...e.dataTransfer.types].includes("Files")
    if (!hasFiles && e.dataTransfer.files.length === 0) return
    if (!dropOverlay) {
      dropOverlay = document.createElement("div")
      dropOverlay.className = "drop-overlay"
      dropOverlay.textContent = "Drop images"
      document.body.appendChild(dropOverlay)
    }
  })
  document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null && dropOverlay) {
      dropOverlay.remove()
      dropOverlay = null
    }
  })
  document.addEventListener("drop", (e) => {
    if (dropOverlay) { dropOverlay.remove(); dropOverlay = null }
    if (!e.dataTransfer) return
    e.preventDefault()
    const files = [...e.dataTransfer.files].filter(isImageFile)
    console.log(`[aimy] drop: ${e.dataTransfer.files.length} files, ${files.length} images`)
    if (files.length === 0) return
    // Downscale, then dispatch a DOM event. The `imageDrop` subscription
    // in subscriptions.ts picks it up and yields the ImageDropped message
    // through the proper foldkit channel (no app-object internals).
    void (async () => {
      for (const file of files.slice(0, 4)) {
        try {
          const { dataUrl, mimeType } = await downscaleImage(file)
          window.dispatchEvent(new CustomEvent("aimy:image-dropped", {
            detail: {
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              dataUrl, name: file.name, mimeType,
            },
          }))
        } catch (err) {
          console.error("[aimy] image drop failed:", err)
        }
      }
    })()
  })

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
      // Auto-grow the composer textarea (2026-10-11): up to 5 lines,
      // then the scrollbar appears (CSS max-height: 100px).
      if (target.tagName === "TEXTAREA" && target.classList.contains("composer-input")) {
        const ta = target as HTMLTextAreaElement
        ta.style.height = "auto"
        ta.style.height = Math.min(ta.scrollHeight, 100) + "px"
      }
    }
  })

  // Composer newline (2026-10-11): Cmd/Ctrl/Shift+Enter inserts a newline.
  // Runs in capture phase before foldkit's OnKeyDownPreventDefault swallows
  // the event — stopPropagation lets the textarea handle it natively.
  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement
    if (target.tagName !== "TEXTAREA" || !target.classList.contains("composer-input")) return
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.stopPropagation()
      // Don't preventDefault — let the textarea insert the newline.
    }
  }, true)

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

  // Tool hover tooltip (2026-10-11): CSS percentage positioning proved
  // unreliable across layouts, so the tooltip is a single fixed div
  // positioned from measured bubble geometry. Hovering a .narrate-tag or
  // .tool-tag shows the summary in the gutter right of the bubble; it hides
  // when the pointer leaves the tag/tooltip or on scroll.
  let toolTipEl: HTMLDivElement | null = null
  const getToolTipEl = (): HTMLDivElement => {
    if (toolTipEl === null) {
      toolTipEl = document.createElement("div")
      toolTipEl.className = "tool-tip-fixed"
      document.body.appendChild(toolTipEl)
    }
    return toolTipEl
  }
  const hideToolTip = (): void => {
    if (toolTipEl !== null) toolTipEl.style.display = "none"
  }
  document.addEventListener("mouseover", (e) => {
    const target = e.target as HTMLElement
    const el = getToolTipEl()
    // Hovering the tooltip itself: keep it visible (lets the user read/copy).
    if (target === el || el.contains(target)) return
    if (!(target instanceof Element)) {
      hideToolTip()
      return
    }
    // Both .narrate-tag (legacy) and .tool-tag (generalized 2026-10-11).
    const tag = target.closest(".narrate-tag, .tool-tag")
    if (!tag) {
      hideToolTip()
      return
    }
    const source = tag.querySelector(".narrate-tip, .tool-tip")
    const bubble = tag.closest(".msg-row")?.querySelector(".msg")
    const text = source?.textContent?.trim()
    if (!text || !bubble) {
      hideToolTip()
      return
    }
    const rect = bubble.getBoundingClientRect()
    el.textContent = text
    el.style.display = "block"
    // Gutter right of the bubble; clamp to viewport.
    const width = 300
    const left = Math.min(rect.right + 8, window.innerWidth - width - 8)
    el.style.left = `${Math.max(8, left)}px`
    el.style.top = `${Math.max(8, rect.top)}px`
  })
  // Scrolling detaches the fixed tooltip from its bubble — hide it.
  document.addEventListener("scroll", hideToolTip, true)

  // Copy buttons — chat bubbles (.msg-copy-btn) and document spaces
  // (.drawer-copy-btn). Kimler's gesture spec (2026-10-12): CLICK copies
  // RICH text (the rendered HTML, with a plain-text representation as
  // the fallback for plain targets); LONG-CLICK (press-and-hold)
  // copies the MARKDOWN source. Delegated DOM ops — no foldkit message
  // (a no-message DOM command crashes this app). The markdown lives in
  // hidden source spans (.msg-copy-source / .drawer-space-source); the
  // rich HTML is the rendered body's innerHTML.
  const copyFeedback = (btn: HTMLElement): void => {
    btn.classList.add("copied")
    setTimeout(() => btn.classList.remove("copied"), 1500)
  }
  const copyMarkdownOf = (btn: HTMLElement): string => {
    if (btn.classList.contains("msg-copy-btn")) {
      return btn.closest(".msg-row")?.querySelector(".msg-copy-source")?.textContent ?? ""
    }
    return btn.closest(".drawer-space")?.querySelector(".drawer-space-source")?.textContent ?? ""
  }
  const copyRichOf = (btn: HTMLElement): { html: string; plain: string } => {
    const plain = copyMarkdownOf(btn)
    if (btn.classList.contains("msg-copy-btn")) {
      const body = btn.closest(".msg-row")?.querySelector(".msg-body")
      return { html: body?.innerHTML ?? "", plain }
    }
    const body = btn.closest(".drawer-space")?.querySelector(".drawer-space-body")
    const html = body !== null && body !== undefined && !body.classList.contains("drawer-space-raw")
      ? body.innerHTML
      : ""
    return { html, plain }
  }
  const doMarkdownCopy = (btn: HTMLElement): void => {
    const text = copyMarkdownOf(btn)
    if (text === "") return
    navigator.clipboard.writeText(text).then(() => {
      copyFeedback(btn)
      console.warn(`[copy] markdown (long-click): ${text.length} chars`)
    }).catch((err) => {
      console.error("[copy] markdown copy failed:", err)
    })
  }
  const doRichCopy = (btn: HTMLElement): void => {
    const { html, plain } = copyRichOf(btn)
    if (plain === "" && html === "") return
    const rich = async (): Promise<void> => {
      if (html !== "" && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ])
      } else {
        await navigator.clipboard.writeText(plain)
      }
    }
    rich().then(() => {
      copyFeedback(btn)
      console.warn(`[copy] rich (click): ${plain.length} chars plain, ${html.length} chars html`)
    }).catch((err) => {
      // Rich write refused (permissions/unsupported): fall back to plain.
      console.warn("[copy] rich write failed, falling back to plain:", err)
      navigator.clipboard.writeText(plain).then(() => {
        copyFeedback(btn)
        console.warn(`[copy] plain fallback: ${plain.length} chars`)
      }).catch((err2) => {
        console.error("[copy] copy failed:", err2)
      })
    })
  }
  // Long-press detection: a 500ms hold fires the markdown copy and
  // marks the button so the click that follows on release is swallowed.
  const LONG_PRESS_MS = 500
  let pressTimer: number | undefined
  let longFiredBtn: HTMLElement | null = null
  let longFiredAt = 0
  const copyBtnOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof HTMLElement ? target.closest(".msg-copy-btn, .drawer-copy-btn") : null
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    const btn = copyBtnOf(e.target)
    if (btn === null) return
    if (pressTimer !== undefined) window.clearTimeout(pressTimer)
    pressTimer = window.setTimeout(() => {
      longFiredBtn = btn
      longFiredAt = Date.now()
      doMarkdownCopy(btn)
    }, LONG_PRESS_MS)
  })
  const cancelPress = (): void => {
    if (pressTimer !== undefined) {
      window.clearTimeout(pressTimer)
      pressTimer = undefined
    }
  }
  document.addEventListener("pointerup", cancelPress)
  document.addEventListener("pointercancel", cancelPress)
  document.addEventListener("click", (e) => {
    const btn = copyBtnOf(e.target)
    if (btn === null) return
    if (longFiredBtn === btn && Date.now() - longFiredAt < 2000) {
      // This click is the release of a long-press that already copied.
      longFiredBtn = null
      return
    }
    doRichCopy(btn)
  })

  // (Drawer copy buttons are handled by the unified copy-gesture block
  // above: click = rich, long-click = markdown.)

  // Download button on drawer spaces (2026-10-12): saves the space's
  // markdown as a file. Delegated DOM op — deliberately NOT a foldkit
  // command: no-message DOM commands crash this app with "Schema
  // validation failed" (see commands.ts note). The view renders the raw
  // markdown in a hidden .drawer-space-source span inside the space.
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement
    const btn = target.closest(".drawer-download-btn") as HTMLElement | null
    if (btn === null) return
    const space = btn.closest(".drawer-space")
    const source = space?.querySelector(".drawer-space-source")
    const text = source?.textContent ?? ""
    if (text === "") return
    const title = space?.querySelector(".drawer-space-title")?.textContent ?? "document"
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "document"
    try {
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${slug}.md`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      console.warn(`[drawer] download: ${slug}.md (${text.length} chars)`)
    } catch (err) {
      console.error("[drawer] download failed:", err)
    }
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
