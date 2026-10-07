/**
 * SKILL.md packaging + validation.
 *
 * `packageModule(dir)` reads `<dir>/SKILL.md`, parses and validates the
 * frontmatter capability manifest, runs package-level validation, and
 * produces a `ModulePackage` ready for `ModuleHost.install`.
 *
 * Fail-closed packaging: a malformed package is a typed `ModuleError` and
 * NEVER produces a partial install. `ModuleHost.install` itself is atomic —
 * the manifest is fully parsed and validated before the lifecycle record is
 * created — so a package that fails validation cannot leave residue.
 *
 * Rejected: missing SKILL.md, malformed frontmatter, unknown capability
 * keys, missing required fields, invalid module name, duplicate tool/hook
 * declarations.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { ModuleError } from "./errors.js"
import {
  type CapabilityManifest,
  type ParsedModuleManifest,
  parseModuleManifest
} from "./manifest.js"
import type { CapabilityTier } from "./kernel-seam.js"
import type { ModulePackage } from "./host.js"

export interface PackagerOpts {
  /** Capability tier for the packaged module. Defaults to "T0". */
  readonly tier?: CapabilityTier
}

/** Module names are filesystem + identifier safe. */
const MODULE_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/

const findDuplicates = (xs: ReadonlyArray<string>): Array<string> => {
  const seen = new Set<string>()
  const dupes: Array<string> = []
  for (const x of xs) {
    if (seen.has(x)) {
      if (!dupes.includes(x)) dupes.push(x)
    } else {
      seen.add(x)
    }
  }
  return dupes
}

/** Package-level validation beyond the manifest schema. */
const validatePackageShape = (
  parsed: ParsedModuleManifest,
  module: string
): Effect.Effect<void, ModuleError> =>
  Effect.gen(function* () {
    if (!MODULE_NAME_RE.test(parsed.name)) {
      return yield* Effect.fail(
        new ModuleError({
          module,
          reason:
            `invalid module name '${parsed.name}': must match ${MODULE_NAME_RE.source} ` +
            `(lowercase alphanumerics, '-', '_')`
        })
      )
    }
    if (parsed.version.trim() === "") {
      return yield* Effect.fail(new ModuleError({ module, reason: "version must be non-empty" }))
    }
    if (parsed.description.trim() === "") {
      return yield* Effect.fail(new ModuleError({ module, reason: "description must be non-empty" }))
    }
    const cap: CapabilityManifest = parsed.capability
    const dupeTools = findDuplicates(cap.tools)
    if (dupeTools.length > 0) {
      return yield* Effect.fail(
        new ModuleError({ module, reason: `duplicate tool declarations: ${dupeTools.join(", ")}` })
      )
    }
    const dupeHooks = findDuplicates(cap.hooks)
    if (dupeHooks.length > 0) {
      return yield* Effect.fail(
        new ModuleError({ module, reason: `duplicate hook declarations: ${dupeHooks.join(", ")}` })
      )
    }
  })

/**
 * Validate an already-built package (e.g. received over a module channel):
 * re-parse the SKILL.md and run package validation. The package's moduleId
 * is the install key; the manifest's `name` is the display name — they are
 * intentionally independent (a host may install the same manifest under a
 * local alias), so no equality is required between them.
 */
export const validateModulePackage = (pkg: ModulePackage): Effect.Effect<ParsedModuleManifest, ModuleError> =>
  Effect.gen(function* () {
    const parsed = yield* parseModuleManifest(pkg.skillMd, pkg.moduleId)
    yield* validatePackageShape(parsed, pkg.moduleId)
    return parsed
  })

/**
 * Package a module directory. Reads `<dir>/SKILL.md` and returns a validated
 * `ModulePackage`. Any failure is a typed `ModuleError`; nothing is installed
 * and nothing partial is returned.
 */
export const packageModule = (
  dir: string,
  opts: PackagerOpts = {}
): Effect.Effect<ModulePackage, ModuleError> =>
  Effect.gen(function* () {
    const skillMd = yield* Effect.tryPromise({
      try: () => readFile(join(dir, "SKILL.md"), "utf8"),
      catch: (e) =>
        new ModuleError({
          module: dir,
          reason: `cannot read SKILL.md: ${e instanceof Error ? e.message : String(e)}`
        })
    })
    const parsed = yield* parseModuleManifest(skillMd, dir)
    yield* validatePackageShape(parsed, dir)
    return {
      moduleId: parsed.name,
      skillMd,
      tier: opts.tier ?? "T0"
    } satisfies ModulePackage
  })
