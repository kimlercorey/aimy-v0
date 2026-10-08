/**
 * desktop/test/tts-engine.test.ts — the TTS engine holder's pure parts.
 *
 * No installs run here: we test path resolution, python discovery (stubbed
 * probe), marker-based status, and the disk-persisted voice selection.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  findSystemPython,
  makeTtsEngine,
  systemPythonCandidates,
  ttsEngineDir,
  venvPythonFor,
} from "../src/main/tts-engine.js"

describe("tts engine paths", () => {
  it("resolves the venv python per platform", () => {
    expect(venvPythonFor("/e", "linux")).toBe(path.join("/e", "venv", "bin", "python"))
    expect(venvPythonFor("/e", "darwin")).toBe(path.join("/e", "venv", "bin", "python"))
    expect(venvPythonFor("C:\\e", "win32")).toBe(path.join("C:\\e", "venv", "Scripts", "python.exe"))
  })

  it("prefers python3 on posix, py -3 on windows", () => {
    expect(systemPythonCandidates("linux")[0]).toEqual(["python3"])
    expect(systemPythonCandidates("win32")[0]).toEqual(["py", "-3"])
  })

  it("honors AIMY_TTS_ENGINE_DIR", () => {
    process.env["AIMY_TTS_ENGINE_DIR"] = "/tmp/tts-test-dir"
    expect(ttsEngineDir()).toBe("/tmp/tts-test-dir")
    delete process.env["AIMY_TTS_ENGINE_DIR"]
  })
})

describe("findSystemPython", () => {
  it("returns the first candidate whose --version looks like Python 3", () => {
    const probe = (cmd: string, _args: ReadonlyArray<string>) =>
      cmd === "python3" ? { ok: true, out: "Python 3.12.1" } : { ok: false, out: "" }
    expect(findSystemPython("linux", probe)).toEqual(["python3"])
  })

  it("skips Python 2 and failures", () => {
    const probe = (cmd: string, _args: ReadonlyArray<string>) =>
      cmd === "python3"
        ? { ok: true, out: "Python 2.7.18" }
        : cmd === "python"
          ? { ok: true, out: "Python 3.11.0" }
          : { ok: false, out: "" }
    expect(findSystemPython("linux", probe)).toEqual(["python"])
  })

  it("returns undefined when nothing is found", () => {
    expect(findSystemPython("linux", () => ({ ok: false, out: "" }))).toBeUndefined()
  })
})

describe("engine status + voice persistence", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-engine-test-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("reports missing with no marker", () => {
    const engine = makeTtsEngine({ engineDir: dir })
    expect(engine.status().state).toBe("missing")
  })

  it("reports ready when the marker and venv python exist", () => {
    const engine = makeTtsEngine({ engineDir: dir })
    const vpy = venvPythonFor(dir)
    fs.mkdirSync(path.dirname(vpy), { recursive: true })
    fs.writeFileSync(vpy, "")
    fs.writeFileSync(path.join(dir, ".installed.json"), JSON.stringify({ v: 1 }))
    expect(engine.status().state).toBe("ready")
  })

  it("reports missing when the marker exists but the venv is gone", () => {
    const engine = makeTtsEngine({ engineDir: dir })
    fs.writeFileSync(path.join(dir, ".installed.json"), JSON.stringify({ v: 1 }))
    expect(engine.status().state).toBe("missing")
  })

  it("persists the active voice across holder instances", () => {
    const a = makeTtsEngine({ engineDir: dir })
    expect(a.activeVoiceId()).toBeUndefined()
    a.setActiveVoice("my-clone")
    expect(a.activeVoiceId()).toBe("my-clone")
    // A fresh holder (new process boot) reads the same file.
    const b = makeTtsEngine({ engineDir: dir })
    expect(b.activeVoiceId()).toBe("my-clone")
  })

  it("install is a no-op when already ready", async () => {
    const engine = makeTtsEngine({ engineDir: dir })
    const vpy = venvPythonFor(dir)
    fs.mkdirSync(path.dirname(vpy), { recursive: true })
    fs.writeFileSync(vpy, "")
    fs.writeFileSync(path.join(dir, ".installed.json"), JSON.stringify({ v: 1 }))
    const seen: Array<string> = []
    await engine.install((p) => seen.push(p.phase))
    expect(seen).toEqual(["done"])
  })
})
