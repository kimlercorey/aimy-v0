/**
 * sovereignty/model.ts — Schema Model slice for the sovereignty toggles panel.
 *
 * Architecture §3.6: every network-call intent class the app wants, each with an
 * explicit toggle and its stated data flow. Toggles are per-instance, revocable,
 * and recorded in the opt-in ledger with timestamps. The rich dashboard
 * ("what was sent, when, to whom") is a SHOULD and deliberately out of scope —
 * the seam is the opt-in ledger plus the `inflightCancelled` record; the
 * dashboard can be built on top without changing this Model.
 */
import { Schema } from "effect"

/**
 * Vendor-network intent classes. The offline-mode switch denies these in one
 * gesture. First-party LAN keeps its own toggles — sovereignty supported,
 * not forced (§3.6).
 */
export const VENDOR_NETWORK_CLASSES = [
  "cloudEndpoint",
  "webResearch",
  "updateChecks",
  "trustedBroadcast",
  "telemetry"
] as const
export type VendorNetworkClass = (typeof VENDOR_NETWORK_CLASSES)[number]

export const isVendorNetworkClass = (classId: string): classId is VendorNetworkClass =>
  (VENDOR_NETWORK_CLASSES as ReadonlyArray<string>).includes(classId)

export const CloudEndpointToggle = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean
})
export type CloudEndpointToggle = typeof CloudEndpointToggle.Type

export const WebResearchToggle = Schema.Struct({
  moduleId: Schema.String,
  moduleLabel: Schema.String,
  enabled: Schema.Boolean
})
export type WebResearchToggle = typeof WebResearchToggle.Type

export const PairSyncScope = Schema.Struct({
  pairId: Schema.String,
  pairLabel: Schema.String,
  enabled: Schema.Boolean,
  scopes: Schema.Array(Schema.String)
})
export type PairSyncScope = typeof PairSyncScope.Type

/** One opt-in grant: what was opted into, when, with what stated data flow. */
export const OptInEntry = Schema.Struct({
  id: Schema.String,
  /** e.g. "cloudEndpoint" or "cloudEndpoint:cloud-endpoint-1" for per-item classes. */
  classId: Schema.String,
  label: Schema.String,
  statedDataFlow: Schema.String,
  /** ISO-8601 UTC. */
  grantedAt: Schema.String,
  revokedAt: Schema.optional(Schema.String)
})
export type OptInEntry = typeof OptInEntry.Type

export const Model = Schema.Struct({
  offlineMode: Schema.Boolean,
  localInference: Schema.Boolean,
  cloudEndpoints: Schema.Array(CloudEndpointToggle),
  webResearch: Schema.Array(WebResearchToggle),
  updateChecks: Schema.Boolean,
  trustedBroadcast: Schema.Boolean,
  telemetry: Schema.Boolean,
  lanDiscoverability: Schema.Boolean,
  pairSyncScopes: Schema.Array(PairSyncScope),
  optInLedger: Schema.Array(OptInEntry),
  ledgerSeq: Schema.Number,
  /** Class ids whose in-flight egress was cancelled by a mid-flight toggle-off. */
  inflightCancelled: Schema.Array(Schema.String)
})
export type Model = typeof Model.Type

/** One row of the §3.6 inventory. `absent` documents a capability that does not exist. */
export interface InventoryRow {
  readonly classId: string
  readonly label: string
  readonly statedDataFlow: string
  readonly kind: "toggle" | "perEndpoint" | "perModule" | "absent" | "perPair"
}

export const INVENTORY: ReadonlyArray<InventoryRow> = [
  {
    classId: "localInference",
    label: "Local inference",
    statedDataFlow: "sends: nothing leaves the machine; receives: tokens from the local model",
    kind: "toggle"
  },
  {
    classId: "cloudEndpoint",
    label: "Cloud inference endpoints",
    statedDataFlow: "sends: prompt text + model id; receives: tokens",
    kind: "perEndpoint"
  },
  {
    classId: "webResearch",
    label: "Web-research fetch",
    statedDataFlow: "sends: query + retrieved URLs; receives: page content",
    kind: "perModule"
  },
  {
    classId: "updateChecks",
    label: "Update checks",
    statedDataFlow: "sends: version + platform; receives: update metadata",
    kind: "toggle"
  },
  {
    classId: "trustedBroadcast",
    label: "Trusted broadcast subscription",
    statedDataFlow: "receives: signed broadcasts",
    kind: "toggle"
  },
  {
    classId: "telemetry",
    label: "Telemetry / error reporting",
    statedDataFlow: "sends: nothing — every item stays off",
    kind: "toggle"
  },
  {
    classId: "cloudTts",
    label: "Cloud TTS fallback",
    statedDataFlow: "no such fallback exists — there is nothing to collect and nothing to toggle",
    kind: "absent"
  },
  {
    classId: "lanDiscovery",
    label: "First-party LAN discoverability",
    statedDataFlow: "sends: presence announcements on the local network; receives: peer presence",
    kind: "toggle"
  },
  {
    classId: "pairSync",
    label: "Per-pair sync scopes",
    statedDataFlow: "sends: only the scopes agreed per pair, after mutual pairing; receives: peer data in scope",
    kind: "perPair"
  }
]

export const inventoryRowFor = (classId: string): InventoryRow | undefined =>
  INVENTORY.find((row) => row.classId === classId)

/** Default state: everything off except local inference (§3.6). Tested explicitly. */
export const initialModel = (): Model => ({
  offlineMode: false,
  localInference: true,
  cloudEndpoints: [
    {
      id: "cloud-endpoint-1",
      label: "Cloud endpoint (configured in the inference pool)",
      enabled: false
    }
  ],
  webResearch: [{ moduleId: "web-research", moduleLabel: "Web-research reference module", enabled: false }],
  updateChecks: false,
  trustedBroadcast: false,
  telemetry: false,
  lanDiscoverability: false,
  pairSyncScopes: [],
  optInLedger: [],
  ledgerSeq: 0,
  inflightCancelled: []
})
