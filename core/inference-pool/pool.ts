/**
 * pool.ts — `InferencePool`, the single manager every token routes through.
 *
 * Guarantees (architecture §4, MoSCoW Musts):
 * - Local default, cloud strictly opt-in: registering a `cloud` provider
 *   without `{ optIn: true }` is an `InferenceError`. No silent cloud.
 * - No keyless fallbacks: if the chosen provider fails, the pool returns a
 *   typed `InferenceError`. It NEVER silently retries a different (especially
 *   cloud) provider. Fallback chains must be explicit in the request.
 * - No telemetry: this module makes zero network calls. The ONLY
 *   network-touching code in this phase lives inside provider
 *   implementations, against their own declared inference endpoint.
 * - Aux-model routing (Hermes harvest): `generateAux()` routes to the
 *   designated cheap/local model on its own named lane — it never competes
 *   with foreground for the local GPU and never falls back to it.
 * - Model switches are explicit, costed, confirmed: `switchProvider()`
 *   requires `{ confirmed: true }`; `describeSwitch()` exposes the cost
 *   (cache invalidation, behavior-delta class) as a first-class value.
 * - Token accounting always includes reasoning tokens (§4.10, Pi #9409).
 */
import { Context, Effect, Layer, Ref } from "effect"
import { InferenceError } from "./errors-shim.js"
import type {
  EgressClass,
  GenerateRequest,
  GenerateResponse,
  Provider,
  Usage
} from "./provider.js"

/** Dispatch modes (§4.4): powerhouse = one logical engine; parallel = fan-out. */
export type DispatchMode = "powerhouse" | "parallel"

/** Purpose class carried on every request (§4.1). */
export type TaskClass = "foreground" | "aux"

/** How parallel results combine. */
export type MergePolicy = "first-complete" | "merged"

export interface Routing {
  readonly mode: DispatchMode
  readonly task?: TaskClass
  /**
   * Explicit provider names. In `parallel` mode this is the fan-out set;
   * in `powerhouse` mode it is an explicit fallback chain, tried in order.
   * Nothing is ever retried implicitly — the chain must be named here.
   */
  readonly providers?: ReadonlyArray<string>
  /** Parallel merge policy; default `first-complete`. */
  readonly merge?: MergePolicy
}

/** Cost of a model switch, exposed as a first-class value (§4.6). */
export interface SwitchCost {
  readonly from: string | undefined
  readonly to: string
  /** Switching providers invalidates prefix caches (Hermes #128757). */
  readonly cacheInvalidated: boolean
  readonly behaviorDeltaClass: "same-provider" | "cross-provider"
}

export interface InferencePoolService {
  /**
   * Register a provider. `cloud`-kind providers require `{ optIn: true }` —
   * without it this fails with `InferenceError`. Registration is the only
   * place a provider enters the pool; nothing is discovered implicitly.
   */
  readonly register: (
    provider: Provider,
    opts?: { readonly optIn?: boolean }
  ) => Effect.Effect<void, InferenceError>

  /**
   * Change the powerhouse provider. Requires explicit confirmation:
   * `switchProvider(name, { confirmed: true })`. Without it, fails.
   */
  readonly switchProvider: (
    name: string,
    opts?: { readonly confirmed?: boolean }
  ) => Effect.Effect<void, InferenceError>

  /** Cost of switching to `name` — decide against it with full information. */
  readonly describeSwitch: (name: string) => Effect.Effect<SwitchCost, InferenceError>

  /** Designate the aux lane's provider (Hermes `auxiliary_client` pattern). */
  readonly setAuxProvider: (name: string) => Effect.Effect<void, InferenceError>

  /** Dispatch a request per `routing`. `task: "aux"` routes to the aux lane. */
  readonly generate: (
    request: GenerateRequest,
    routing: Routing
  ) => Effect.Effect<GenerateResponse, InferenceError>

  /**
   * Aux-model lane: routes to the designated cheap/local model only.
   * Never touches the foreground provider, never falls back to it.
   */
  readonly generateAux: (request: GenerateRequest) => Effect.Effect<GenerateResponse, InferenceError>

  /** Egress class of a registered provider — seam contract S8 input. */
  readonly egressOf: (providerName: string) => Effect.Effect<EgressClass, InferenceError>

  /** Registered provider names, in registration order. */
  readonly registeredProviders: () => Effect.Effect<ReadonlyArray<string>>
}

interface RegistryEntry {
  readonly provider: Provider
  readonly cloudOptIn: boolean
}

const notRegistered = (name: string): InferenceError =>
  new InferenceError({ provider: name, reason: `provider "${name}" is not registered` })

const mergeUsage = (usages: ReadonlyArray<Usage>): Usage => {
  const estimators = Array.from(
    new Set(
      usages.flatMap((u) =>
        u.reasoningTokensEstimatedBy === undefined ? [] : [u.reasoningTokensEstimatedBy]
      )
    )
  )
  const base: Usage = {
    inputTokens: usages.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: usages.reduce((n, u) => n + u.outputTokens, 0),
    // reasoningTokens is always present (Pi #9409); summed like the rest.
    reasoningTokens: usages.reduce((n, u) => n + u.reasoningTokens, 0)
  }
  return estimators.length === 0
    ? base
    : { ...base, reasoningTokensEstimatedBy: estimators.join("+") }
}

const mergeResponses = (
  names: ReadonlyArray<string>,
  responses: ReadonlyArray<GenerateResponse>
): GenerateResponse => ({
  // Deterministic provider order: parallel results concatenate in fan-out order.
  text: responses.map((r, i) => `[${names[i]}]\n${r.text}`).join("\n"),
  usage: mergeUsage(responses.map((r) => r.usage))
})

const makeService: Effect.Effect<InferencePoolService> = Effect.gen(function* () {
  const registry = yield* Ref.make(new Map<string, RegistryEntry>())
  const active = yield* Ref.make<string | undefined>(undefined)
  const auxLane = yield* Ref.make<string | undefined>(undefined)

  const getEntry = (name: string): Effect.Effect<RegistryEntry, InferenceError> =>
    Effect.gen(function* () {
      const entry = (yield* Ref.get(registry)).get(name)
      return entry === undefined ? yield* Effect.fail(notRegistered(name)) : entry
    })

  const localNames = (): Effect.Effect<ReadonlyArray<string>> =>
    Ref.get(registry).pipe(
      Effect.map((reg) =>
        Array.from(reg.values())
          .filter((e) => e.provider.kind === "local")
          .map((e) => e.provider.name)
      )
    )

  /** Effective powerhouse provider: confirmed switch > first registered local. */
  const currentActiveName = (): Effect.Effect<string | undefined, InferenceError> =>
    Effect.gen(function* () {
      const activeName = yield* Ref.get(active)
      if (activeName !== undefined) return activeName
      const locals = yield* localNames()
      return locals[0]
    })

  /** Powerhouse target: explicit chain > active provider > first local. */
  const resolvePowerhouse = (routing: Routing): Effect.Effect<ReadonlyArray<RegistryEntry>, InferenceError> =>
    Effect.gen(function* () {
      if (routing.providers !== undefined && routing.providers.length > 0) {
        return yield* Effect.forEach(routing.providers, getEntry)
      }
      const activeName = yield* currentActiveName()
      if (activeName === undefined) {
        return yield* Effect.fail(
          new InferenceError({ provider: "pool", reason: "no local provider registered" })
        )
      }
      // First registered local is the default "best" for this phase;
      // capability/cost/load selection is future policy work.
      return [yield* getEntry(activeName)]
    })

  const resolveParallel = (routing: Routing): Effect.Effect<ReadonlyArray<RegistryEntry>, InferenceError> =>
    Effect.gen(function* () {
      const names =
        routing.providers !== undefined
          ? routing.providers
          : yield* Ref.get(registry).pipe(Effect.map((reg) => Array.from(reg.keys())))
      if (names.length === 0) {
        return yield* Effect.fail(
          new InferenceError({ provider: "pool", reason: "no providers registered for parallel fan-out" })
        )
      }
      return yield* Effect.forEach(names, getEntry)
    })

  /** Explicit chain only: try in order, first success wins, no silent retry. */
  const attemptChain = (
    entries: ReadonlyArray<RegistryEntry>,
    request: GenerateRequest
  ): Effect.Effect<GenerateResponse, InferenceError> => {
    const [head, ...tail] = entries
    if (head === undefined) {
      return Effect.fail(
        new InferenceError({ provider: "pool", reason: "empty provider chain" })
      )
    }
    return Effect.catch(head.provider.generate(request), (error) =>
      tail.length === 0 ? Effect.fail(error) : attemptChain(tail, request)
    )
  }

  const generateParallel = (
    request: GenerateRequest,
    routing: Routing
  ): Effect.Effect<GenerateResponse, InferenceError> =>
    Effect.gen(function* () {
      const entries = yield* resolveParallel(routing)
      const effects = entries.map((e) => e.provider.generate(request))
      const merge = routing.merge ?? "first-complete"
      if (merge === "first-complete") {
        // First success wins; losers are interrupted (no GPU contention bleed).
        // All-fail surfaces the last provider's typed InferenceError.
        return yield* Effect.firstSuccessOf(effects)
      }
      const responses = yield* Effect.all(effects)
      return mergeResponses(
        entries.map((e) => e.provider.name),
        responses
      )
    })

  const generateAux: InferencePoolService["generateAux"] = (request) =>
    Effect.gen(function* () {
      const auxName = yield* Ref.get(auxLane)
      if (auxName === undefined) {
        return yield* Effect.fail(
          new InferenceError({
            provider: "pool",
            reason: "no aux provider designated — the aux lane is explicit and never falls back to the foreground provider"
          })
        )
      }
      const entry = yield* getEntry(auxName)
      return yield* entry.provider.generate(request)
    })

  const service: InferencePoolService = {
    register: (provider, opts) =>
      Effect.gen(function* () {
        if (provider.kind === "cloud" && opts?.optIn !== true) {
          return yield* Effect.fail(
            new InferenceError({
              provider: provider.name,
              reason:
                "cloud provider registration requires explicit opt-in: register(provider, { optIn: true }) — no silent cloud"
            })
          )
        }
        yield* Ref.update(registry, (reg) => {
          reg.set(provider.name, { provider, cloudOptIn: provider.kind === "cloud" })
          return reg
        })
      }),

    switchProvider: (name, opts) =>
      Effect.gen(function* () {
        if (opts?.confirmed !== true) {
          return yield* Effect.fail(
            new InferenceError({
              provider: name,
              reason: "model switch requires explicit confirmation: switchProvider(name, { confirmed: true })"
            })
          )
        }
        const entry = yield* getEntry(name)
        yield* Ref.set(active, entry.provider.name)
      }),

    describeSwitch: (name) =>
      Effect.gen(function* () {
        const entry = yield* getEntry(name)
        const from = yield* currentActiveName()
        return {
          from,
          to: entry.provider.name,
          cacheInvalidated: from !== entry.provider.name,
          behaviorDeltaClass: from === entry.provider.name ? "same-provider" : "cross-provider"
        } as SwitchCost
      }),

    setAuxProvider: (name) =>
      Effect.gen(function* () {
        const entry = yield* getEntry(name)
        yield* Ref.set(auxLane, entry.provider.name)
      }),

    generate: (request, routing) =>
      routing.task === "aux"
        ? generateAux(request)
        : routing.mode === "parallel"
          ? generateParallel(request, routing)
          : Effect.gen(function* () {
              const chain = yield* resolvePowerhouse(routing)
              return yield* attemptChain(chain, request)
            }),

    generateAux,

    egressOf: (providerName) =>
      Effect.gen(function* () {
        return (yield* getEntry(providerName)).provider.egress
      }),

    registeredProviders: () =>
      Ref.get(registry).pipe(Effect.map((reg) => Array.from(reg.keys())))
  }

  return service
})

export class InferencePool extends Context.Service<InferencePool, InferencePoolService>()(
  "aimy/InferencePool"
) {}

export const InferencePoolLive: Layer.Layer<InferencePool> = Layer.effect(InferencePool, makeService)
