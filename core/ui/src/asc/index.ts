/**
 * Track 2 of M8 (Foldkit desktop shell): the ASC panel + FACS expression engine.
 *
 * A self-contained foldkit sub-app slice (`ui/src/asc/`):
 * - `model.ts` — the Schema Model slice + `loadAscSlice` (reads ONLY through
 *   the frozen ASCEngine boundary)
 * - `messages.ts` — the Schema message union (no dial-setting variant exists)
 * - `update.ts` — the pure update + the `RecordTuningChange` command (the ONLY
 *   write path: `recordEvidence({ kind: "tuningChange" })` → the internal
 *   `AscSelfModel.recordTuningChange` seam)
 * - `views.ts` — the panel (pure functions of slice state)
 * - `facs.ts` — the FACS expression engine (dials → Action Units, pure)
 * - `preview.ts` — the abstract renderer + preview surface (read-only on ASC
 *   state)
 *
 * Integration: the shell composes this slice via `Update.foldChild`
 * (`ascUpdate` + `read`/`write`/`toParentMessage`) and renders `ascSection`
 * through `h.submodel`.
 */
export {
  AscSlice,
  ArchivedComputation,
  CapabilityEntry,
  DIAL_HISTORY_CAP,
  DIAL_NAMES,
  DiagnosticSummary,
  DialSummary,
  ERROR_FIRING_CAP,
  ErrorTermEntry,
  GUARD_FEED_CAP,
  GuardFlagEntry,
  initialAscSlice,
  L3_EXCERPT_COUNT,
  loadAscSlice,
  NarrativeExcerptEntry,
  RendererSelection,
  TUNING_LOG_CAP,
  TUNING_TARGETS,
  TuningChangeRecord,
  TuningError,
  TuningTarget,
  type DialName,
} from "./model.js"
export { Message as AscPanelMessage, type AscMessage } from "./messages.js"
export { RecordTuningChange, update as ascUpdate } from "./update.js"
export { ascPanelView, ascSection } from "./views.js"
export {
  AU_NAMES,
  dialsToAUFrame,
  frameActivation,
  type AUFrame,
  type AUName,
  type DialInput,
} from "./facs.js"
export {
  abstractFieldView,
  computeFieldGeometry,
  renderAbstractField,
  type FieldGeometry,
} from "./preview.js"
