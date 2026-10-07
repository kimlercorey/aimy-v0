/**
 * @aimy/inference-pool — the single manager every token routes through.
 */
export { InferenceError } from "./errors-shim.js"
export type {
  DispatchMode,
  InferencePoolService,
  MergePolicy,
  Routing,
  SwitchCost,
  TaskClass
} from "./pool.js"
export { InferencePool, InferencePoolLive } from "./pool.js"
export { StubProvider } from "./local-stub.js"
export type { StubCall } from "./local-stub.js"
export { LocalHttpProvider, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, NO_REASONING_CHANNEL } from "./local-http.js"
export type { LocalHttpProviderOptions } from "./local-http.js"
export type {
  EgressClass,
  GenerateRequest,
  GenerateResponse,
  Message,
  Provider,
  ProviderCapabilities,
  ProviderKind,
  Token,
  Usage
} from "./provider.js"
