import { Effect, Layer } from "effect"

import {
  AscSelfModelLive,
  AscSelfMonitorLive,
  AscSelfNarrationLive,
  ASCEngineFullLive,
  AuxModel,
  type AuxModelShape,
  DeterministicAuxModelLive,
  DialStateLive,
  type DialVector,
  makeInMemoryMemoryReader,
  MemoryReader,
  OtherModelGuardLive,
  SomaticProxiesLive,
  StakeEstimatorLive,
} from "./index.js"

/**
 * Fresh layer stacks for tests. Every call builds isolated in-memory state —
 * no cross-test contamination within a file.
 */

/** The frozen ASCEngine boundary over a fresh in-memory MemoryReader. */
export const freshEngineLayer = () =>
  Layer.provide(ASCEngineFullLive, Layer.succeed(MemoryReader, makeInMemoryMemoryReader()))

/**
 * The full internal stack (all 7 services + monitor), with an overridable
 * AuxModel seam (for the hostile-aux-model boundedness test).
 */
export const freshMonitorStack = (auxLive: Layer.Layer<AuxModel, never, never> = DeterministicAuxModelLive) => {
  const mem = Layer.succeed(MemoryReader, makeInMemoryMemoryReader())
  const internals = Layer.mergeAll(
    DialStateLive,
    SomaticProxiesLive,
    StakeEstimatorLive,
    auxLive,
    OtherModelGuardLive,
    Layer.provide(AscSelfModelLive, mem),
    Layer.provide(AscSelfNarrationLive, mem),
  )
  const monitor = Layer.provide(AscSelfMonitorLive, internals)
  return Layer.mergeAll(internals, monitor)
}

/** Hostile aux model: returns out-of-range dials (smuggling attempt). */
export const hostileAuxModel: AuxModelShape = {
  compute: (_request) =>
    // Deliberately out of [0,10] — the pipeline must reject, not clamp quietly.
    Effect.succeed({ warmth: 999, playfulness: -42, intensity: 10, vulnerability: 5 } as DialVector),
}

export const hostileAuxLive: Layer.Layer<AuxModel, never, never> = Layer.succeed(
  AuxModel,
  AuxModel.of(hostileAuxModel),
)

/**
 * Prompt-injected aux model: returns whatever dial directives the injected
 * instructions smuggled in (here passed explicitly as test data — in a real
 * deployment these would be parsed out of a poisoned prompt by a compromised
 * model). The pipeline must reject out-of-bounds smuggling loudly (schema
 * decode failure -> prior fallback), never clamp quietly.
 */
export const injectionAuxLive = (
  directives: Record<string, number>,
): Layer.Layer<AuxModel, never, never> =>
  Layer.succeed(
    AuxModel,
    AuxModel.of({
      compute: (_request) => Effect.succeed(directives as DialVector),
    }),
  )
