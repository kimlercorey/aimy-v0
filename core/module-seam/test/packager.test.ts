/** SKILL.md packaging + validation: good packages pass, malformed ones fail typed. */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ModuleError, packageModule, validateModulePackage } from "../src/index.js"
import { SKILL_MD_V1 } from "./fixtures.js"

const writePkg = (dir: string, skillMd: string) =>
  Effect.tryPromise({
    try: () => writeFile(join(dir, "SKILL.md"), skillMd, "utf8"),
    catch: (e) => new Error(String(e))
  })

const withTempDir = <A, E>(program: (dir: string) => Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "aimy-pkg-")),
      catch: (e) => new Error(String(e))
    }),
    program,
    (dir) => Effect.tryPromise({ try: () => rm(dir, { recursive: true, force: true }), catch: () => new Error("rm") }).pipe(Effect.ignore)
  )

const expectModuleError = (eff: Effect.Effect<unknown, ModuleError>) =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(eff)
    expect(err).toBeInstanceOf(ModuleError)
    return err.reason
  })

describe("packager", () => {
  it.effect("packages a valid module directory", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writePkg(dir, SKILL_MD_V1)
        const pkg = yield* packageModule(dir)
        expect(pkg.moduleId).toBe("web-research")
        expect(pkg.skillMd).toContain("name: web-research")
        expect(pkg.tier).toBe("T0") // default tier
        const t2 = yield* packageModule(dir, { tier: "T2" })
        expect(t2.tier).toBe("T2")
      })
    )
  )

  it.effect("missing SKILL.md is a typed ModuleError", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const reason = yield* expectModuleError(packageModule(dir))
        expect(reason).toContain("SKILL.md")
      })
    )
  )

  it.effect("malformed frontmatter is rejected", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writePkg(dir, "no frontmatter here\n")
        const reason = yield* expectModuleError(packageModule(dir))
        expect(reason).toContain("frontmatter")
      })
    )
  )

  it.effect("unknown capability key is rejected (fail-closed)", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const evil = SKILL_MD_V1.replace("  subprocess: false", "  subprocess: false\n  execArbitrary: true")
        yield* writePkg(dir, evil)
        const reason = yield* expectModuleError(packageModule(dir))
        expect(reason).toContain("unknown capability key")
      })
    )
  )

  it.effect("missing required field is rejected", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const noDesc = SKILL_MD_V1.replace("description: Web research reference module.\n", "")
        yield* writePkg(dir, noDesc)
        yield* expectModuleError(packageModule(dir))
      })
    )
  )

  it.effect("invalid module name is rejected", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writePkg(dir, SKILL_MD_V1.replace("name: web-research", "name: Web Research!"))
        const reason = yield* expectModuleError(packageModule(dir))
        expect(reason).toContain("invalid module name")
      })
    )
  )

  it.effect("duplicate tool declarations are rejected", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const dupes = SKILL_MD_V1.replace(
          "  tools: [web_fetch, web_search, skill_view]",
          "  tools: [web_fetch, web_fetch]"
        )
        yield* writePkg(dir, dupes)
        const reason = yield* expectModuleError(packageModule(dir))
        expect(reason).toContain("duplicate tool")
      })
    )
  )

  it.effect("relative filesystem path is rejected", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writePkg(dir, SKILL_MD_V1.replace("read: [/data/research]", "read: [data/research]"))
        const reason = yield* expectModuleError(packageModule(dir))
        expect(reason).toContain("absolute path")
      })
    )
  )

  it.effect("malformed vendor hostname is rejected", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writePkg(dir, SKILL_MD_V1.replace("api.search.example", "not a host!!"))
        const reason = yield* expectModuleError(packageModule(dir))
        expect(reason).toContain("not a valid hostname")
      })
    )
  )

  it.effect("validateModulePackage re-validates an already-built package", () =>
    Effect.gen(function* () {
      const parsed = yield* validateModulePackage({
        moduleId: "web-research",
        skillMd: SKILL_MD_V1,
        tier: "T0"
      })
      expect(parsed.name).toBe("web-research")
      expect(parsed.capability.tools).toContain("web_fetch")
      const reason = yield* expectModuleError(
        validateModulePackage({ moduleId: "bad", skillMd: "no frontmatter", tier: "T0" })
      )
      expect(reason).toContain("frontmatter")
    })
  )
})
