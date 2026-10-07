import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { ConfigError } from "./errors.js"
import { CONFIG_FILE_NAME, loadConfig, resolvePaths } from "./config.js"

describe("resolvePaths", () => {
  it("honors XDG env vars, one per home, with an aimy subdirectory", () => {
    const paths = resolvePaths({
      env: {
        XDG_DATA_HOME: "/xdg/data",
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_STATE_HOME: "/xdg/state",
      },
      home: "/home/tester",
    })
    expect(paths).toEqual({
      data: "/xdg/data/aimy",
      config: "/xdg/config/aimy",
      state: "/xdg/state/aimy",
    })
  })

  it("falls back to ~/.aimy when no XDG vars are set", () => {
    const paths = resolvePaths({ env: {}, home: "/home/tester" })
    expect(paths).toEqual({
      data: "/home/tester/.aimy",
      config: "/home/tester/.aimy",
      state: "/home/tester/.aimy",
    })
  })

  it("treats empty XDG vars as unset", () => {
    const paths = resolvePaths({
      env: { XDG_DATA_HOME: "", XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" },
      home: "/home/tester",
    })
    expect(paths.config).toBe("/home/tester/.aimy")
  })

  it("resolves each home independently", () => {
    const paths = resolvePaths({
      env: { XDG_CONFIG_HOME: "/xdg/config" },
      home: "/home/tester",
    })
    expect(paths.config).toBe("/xdg/config/aimy")
    expect(paths.data).toBe("/home/tester/.aimy")
    expect(paths.state).toBe("/home/tester/.aimy")
  })
})

const withTempConfigDir = async (files: Record<string, string>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aimy-substrate-config-test-"))
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf-8")
  }
  return dir
}

describe("loadConfig", () => {
  it("fails typed with ConfigError — never throws — on a missing file", async () => {
    const dir = await withTempConfigDir({})
    const result = await Effect.runPromise(
      Effect.flip(loadConfig({ data: dir, config: dir, state: dir })),
    )
    expect(result).toBeInstanceOf(ConfigError)
    expect(result._tag).toBe("ConfigError")
    expect(result.reason).toContain("cannot read config file")
  })

  it("fails typed with ConfigError on invalid JSON", async () => {
    const dir = await withTempConfigDir({ [CONFIG_FILE_NAME]: "{ not json" })
    const result = await Effect.runPromise(
      Effect.flip(loadConfig({ data: dir, config: dir, state: dir })),
    )
    expect(result).toBeInstanceOf(ConfigError)
    expect(result.reason).toContain("not valid JSON")
  })

  it("fails typed with ConfigError on schema violation", async () => {
    const dir = await withTempConfigDir({
      [CONFIG_FILE_NAME]: JSON.stringify({ version: 2 }),
    })
    const result = await Effect.runPromise(
      Effect.flip(loadConfig({ data: dir, config: dir, state: dir })),
    )
    expect(result).toBeInstanceOf(ConfigError)
    expect(result.reason).toContain("failed validation")
  })

  it("loads a valid config, tolerating unknown extra keys", async () => {
    const dir = await withTempConfigDir({
      [CONFIG_FILE_NAME]: JSON.stringify({
        version: 1,
        instanceLabel: "office",
        futureField: { nested: true },
      }),
    })
    const config = await Effect.runPromise(
      loadConfig({ data: dir, config: dir, state: dir }),
    )
    expect(config).toEqual({ version: 1, instanceLabel: "office" })
  })

  it("loads a minimal valid config without the optional label", async () => {
    const dir = await withTempConfigDir({
      [CONFIG_FILE_NAME]: JSON.stringify({ version: 1 }),
    })
    const config = await Effect.runPromise(
      loadConfig({ data: dir, config: dir, state: dir }),
    )
    expect(config.version).toBe(1)
    expect(config.instanceLabel).toBeUndefined()
  })
})
