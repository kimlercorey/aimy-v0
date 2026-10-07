/**
 * substrate/config.ts
 *
 * XDG filesystem layout resolution and typed app-config loading.
 *
 * Layout rule (architecture §1.2 — Pi #2870): XDG base directories are
 * respected from day one. Each AImy home resolves from its own env var and
 * falls back to `~/.aimy` (the single unified legacy dir) when unset:
 *
 *   data   <- $XDG_DATA_HOME/aimy   or ~/.aimy
 *   config <- $XDG_CONFIG_HOME/aimy or ~/.aimy
 *   state  <- $XDG_STATE_HOME/aimy  or ~/.aimy
 *
 * Config loading never throws: missing files, invalid JSON, and schema
 * violations all surface as typed `ConfigError` values in Effect.
 */
import * as fs from "node:fs/promises"
import * as os from "node:os"
import { Effect, Schema } from "effect"

import { ConfigError } from "./errors.js"

/** Name of the app config file inside the config home. */
export const CONFIG_FILE_NAME = "aimy.json"

/** Resolved on-disk homes for AImy state. */
export interface AimyPaths {
  readonly data: string
  readonly config: string
  readonly state: string
}

export interface ResolvePathsOptions {
  /** Defaults to `process.env`. Inject a stub in tests. */
  readonly env?: Record<string, string | undefined>
  /** Defaults to `os.homedir()`. Inject a stub in tests. */
  readonly home?: string
}

/**
 * Resolve the AImy directory layout. Honors XDG_DATA_HOME, XDG_CONFIG_HOME,
 * XDG_STATE_HOME (each gets an `aimy` subdirectory per the XDG spec); falls
 * back to `~/.aimy` for any var that is unset or empty.
 */
export const resolvePaths = (options: ResolvePathsOptions = {}): AimyPaths => {
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  const fallback = `${home}/.aimy`

  const pick = (key: string): string => {
    const value = env[key]
    return value !== undefined && value !== "" ? `${value}/aimy` : fallback
  }

  return {
    data: pick("XDG_DATA_HOME"),
    config: pick("XDG_CONFIG_HOME"),
    state: pick("XDG_STATE_HOME"),
  }
}

/** Typed app config. Strict: unknown top-level keys are ignored, wrong types fail. */
export const AppConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  instanceLabel: Schema.optional(Schema.String),
})

export type AppConfig = Schema.Schema.Type<typeof AppConfigSchema>

const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Load `<config home>/aimy.json`, parsed and Schema-validated.
 * Never throws: every failure mode (missing file, bad JSON, schema
 * violation) returns a typed `ConfigError`.
 */
export const loadConfig = (paths: AimyPaths): Effect.Effect<AppConfig, ConfigError> =>
  Effect.gen(function* () {
    const file = `${paths.config}/${CONFIG_FILE_NAME}`

    const text = yield* Effect.tryPromise({
      try: () => fs.readFile(file, "utf-8"),
      catch: (cause) =>
        new ConfigError({
          reason: `cannot read config file ${file}: ${describeFailure(cause)}`,
        }),
    })

    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        new ConfigError({
          reason: `config file ${file} is not valid JSON: ${describeFailure(cause)}`,
        }),
    })

    return yield* Schema.decodeUnknownEffect(AppConfigSchema, {
      onExcessProperty: "ignore",
    })(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            reason: `config file ${file} failed validation: ${describeFailure(cause)}`,
          }),
      ),
    )
  })
