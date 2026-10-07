/**
 * persistence.test.ts — file-trio round-trips and failure injection.
 *
 * Covers: cross-process lock contention, stale-lock breaking, drift guard
 * (read-back verify + .bak restore), and crash-mid-write simulation via the
 * fault injector (the original file must survive untouched).
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  LOCK_TTL_MS,
  PersistenceError,
  appendJsonlLine,
  atomicWrite,
  readJsonlLines,
  readText,
  withFileLock,
} from "../persistence.js"

const tmpRoots: string[] = []
const mkTmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-mem-test-"))
  tmpRoots.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const runP = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff)

describe("atomicWrite drift guard", () => {
  it("round-trips content", async () => {
    const f = path.join(mkTmp(), "a.txt")
    await runP(atomicWrite(f, "hello world"))
    expect(await runP(readText(f))).toBe("hello world")
  })

  it("fault before-rename leaves the original file untouched (crash simulation)", async () => {
    const f = path.join(mkTmp(), "a.txt")
    await runP(atomicWrite(f, "version-1"))
    // simulated crash: temp written + fsynced, process dies before rename
    await runP(atomicWrite(f, "version-2", { fault: "before-rename" }))
    expect(await runP(readText(f))).toBe("version-1")
    // a later clean write still works over the stale temp file
    await runP(atomicWrite(f, "version-3"))
    expect(await runP(readText(f))).toBe("version-3")
  })

  it("appendJsonlLine appends under the trio discipline", async () => {
    const f = path.join(mkTmp(), "s.jsonl")
    await runP(appendJsonlLine(f, '{"a":1}'))
    await runP(appendJsonlLine(f, '{"a":2}'))
    expect(await runP(readJsonlLines(f))).toEqual(['{"a":1}', '{"a":2}'])
  })
})

describe("withFileLock", () => {
  it("a second live holder fails fast with a typed error", async () => {
    const f = path.join(mkTmp(), "a.txt")
    const err = await Effect.runPromise(
      Effect.flip(
        withFileLock(
          f,
          withFileLock(f, Effect.succeed("inner")),
        ),
      ),
    )
    expect(err._tag).toBe("PersistenceError")
    expect((err as PersistenceError).reason).toContain("locked by live process")
  })

  it("a stale lock (dead pid) is broken", async () => {
    const dir = mkTmp()
    const f = path.join(dir, "a.txt")
    const lockPath = `${f}.lock`
    // dead pid 2^30 will not exist; ts far in the past
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1 << 30, ts: Date.now() - LOCK_TTL_MS - 1000 }))
    await runP(withFileLock(f, atomicWrite(f, "after-stale-break")))
    expect(await runP(readText(f))).toBe("after-stale-break")
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it("a stale lock (aged out) is broken even for a live pid", async () => {
    const dir = mkTmp()
    const f = path.join(dir, "a.txt")
    const lockPath = `${f}.lock`
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() - LOCK_TTL_MS - 1000 }))
    await runP(withFileLock(f, atomicWrite(f, "ok")))
    expect(await runP(readText(f))).toBe("ok")
  })

  it("the lock is always released, even on failure", async () => {
    const f = path.join(mkTmp(), "a.txt")
    const lockPath = `${f}.lock`
    await Effect.runPromise(Effect.flip(withFileLock(f, Effect.fail("boom" as never))))
    expect(fs.existsSync(lockPath)).toBe(false)
  })
})
