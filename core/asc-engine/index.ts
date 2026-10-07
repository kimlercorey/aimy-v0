// @aimy/asc-engine — public surface. See INTERFACE.md (frozen v1).

export { INTERFACE_VERSION, ASCEngine, ASCEngineLive, ASCEngineFullLive } from "./engine.js"
export type { ASCEngineShape, Evidence, EvidenceKind, CapabilityMapSnapshot } from "./engine.js"

export {
  DialVector,
  DIAL_NAMES,
  NEUTRAL_DIALS,
  DEFAULT_SPILLOVER_RATIO,
  spillover,
  decodeDialVector,
  DialState,
  DialStateLive,
  makeDialState,
} from "./dial-state.js"
export type { DialName } from "./dial-state.js"

export {
  SomaticProxies,
  SomaticProxiesLive,
  measureProxies,
  readingsAreOperational,
  DEFAULT_PROXY_WEIGHTS,
} from "./somatic-proxies.js"
export type {
  ProxyReadings,
  ProxyName,
  DialShiftEvidence,
  ProxyWeights,
  SomaticProxiesShape,
} from "./somatic-proxies.js"

export {
  StakeEstimator,
  StakeEstimatorLive,
  makeStakeEstimator,
  computeStake,
  calibrateZeta,
  ZETA_ALPHA,
  DEFAULT_ZETA_PARAMS,
} from "./stake-estimator.js"
export type {
  StakeInput,
  StakeOutcome,
  ZetaParams,
  EpsilonSquaredFiring,
  StakeEstimatorShape,
} from "./stake-estimator.js"

export {
  AscSelfModel,
  AscSelfModelLive,
  makeAscSelfModel,
  ERROR_TERM_ALPHA,
  ERROR_TERM_SAMPLE_K,
  ERROR_TERM_FIRE_THRESHOLD,
  ERROR_TERM_RECENCY_HALFLIFE_DAYS,
} from "./asc-self-model.js"
export type {
  AscSelfModelShape,
  CapabilityEntry,
  TrackRecordEntry,
  SelfModelState,
  OutcomeInput,
  ErrorTermEvaluation,
  ErrorTermFiring,
} from "./asc-self-model.js"

export {
  AscSelfNarration,
  AscSelfNarrationLive,
  makeAscSelfNarration,
  narrativeId,
  NARRATIVE_CAP,
} from "./asc-self-narration.js"
export type {
  AscSelfNarrationShape,
  NarrativeEntry,
  NarrativeLinks,
  AppendNarrativeInput,
} from "./asc-self-narration.js"

export {
  OtherModelGuard,
  OtherModelGuardLive,
  makeOtherModelGuard,
  classifyShift,
  GUARD_SHIFT_THRESHOLD,
  GUARD_SUPPORT_FLOOR,
  GUARD_DAMPEN_BETA,
} from "./other-model-guard.js"
export type {
  OtherModelGuardShape,
  ContentCues,
  RegisterShift,
  GuardClassification,
} from "./other-model-guard.js"

export {
  AscSelfMonitor,
  AscSelfMonitorLive,
  makeAscSelfMonitor,
  estimateRegisterFromText,
  scanT1Violation,
  scanProxyOverreach,
  reflectiveFidelity,
  ANTICIPATION_DELTA,
  ABSTENTION_DIALS,
  GATE_MIN_SAMPLES,
  GATE_MIN_CONFIDENCE,
  T1_VOCABULARY,
  COMPUTATION_HISTORY_CAP,
} from "./asc-self-monitor.js"
export type {
  AscSelfMonitorShape,
  ContentAnalysis,
  PreTurnInput,
  PostTurnInput,
  PreTurnResult,
  PostTurnResult,
  GuardedTurnResult,
  DialComputation,
  BiasTerm,
  RegisterMatchAudit,
  DeliverableInput,
} from "./asc-self-monitor.js"

// Integration seams (declared here, provided by the host) + error shim.
export {
  MemoryReader,
  AuxModel,
  InMemoryMemoryReaderLive,
  makeInMemoryMemoryReader,
  DeterministicAuxModelLive,
  defaultDialComputation,
  L1_STORAGE_KEY,
  L3_STORAGE_KEY,
} from "./seams.js"
export type {
  MemoryReaderShape,
  AuxModelShape,
  AuxModelRequest,
  ContentSummary,
  L1Slice,
  ContextualRead,
} from "./seams.js"

export { AscError, ascError } from "./errors-shim.js"
