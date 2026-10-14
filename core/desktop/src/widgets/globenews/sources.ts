/**
 * widgets/globenews/sources.ts — the sensor registry (Threat
 * Channel design §3, frozen 2026-10-13).
 *
 * One row per source; one parser per KIND in scan.ts. Adding a
 * feed = adding a row here. Cadence is per source: the scan job
 * runs every minute-0 hour, but a source is only fetched when
 * due (its last run is kept in the events store); a manual
 * refresh forces every source. A failing source is a logged
 * outcome, never a failed scan.
 *
 * All URLs verified live 2026-10-13 unless a row says otherwise.
 */

export type SourceKind =
  | "gdacs"
  | "usgs"
  | "wfigs"
  | "nws"
  | "nhc"
  | "spc"
  | "wire"

export interface SourceDef {
  readonly id: string
  /** Source label shown in the feed (wire sources). */
  readonly label: string
  readonly url: string
  readonly kind: SourceKind
  readonly everyMinutes: number
  /** NWS only: keep advisories too (local completeness). */
  readonly includeAdvisories?: boolean | undefined
}

const GNEWS = (q: string): string =>
  `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`

// Canonical feed URLs (scan.ts re-exports these for its
// existing importers).
export const GDACS_URL = "https://www.gdacs.org/xml/rss.xml"
export const BBC_URL = "https://feeds.bbci.co.uk/news/world/rss.xml"
export const BBC_US_URL = "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml"
export const AJ_URL = "https://www.aljazeera.com/xml/rss/all.xml"
export const USGS_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson"
export const WFIGS_URL =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=IncidentTypeCategory%3D%27WF%27&outFields=IncidentName,POOState,POOCounty,DiscoveryAcres,IncidentSize,FireDiscoveryDateTime,ModifiedOnDateTime_dt,InitialLatitude,InitialLongitude,SourceOID&returnGeometry=false&f=json&resultRecordCount=500&orderByFields=ModifiedOnDateTime_dt%20DESC"
export const NWS_URL = "https://api.weather.gov/alerts/active?status=actual"

export const SOURCE_REGISTRY: ReadonlyArray<SourceDef> = [
  // ── Located world sensors (existing) ──────────────────────
  { id: "gdacs", label: "GDACS", url: GDACS_URL, kind: "gdacs", everyMinutes: 60 },
  { id: "usgs", label: "USGS", url: USGS_URL, kind: "usgs", everyMinutes: 60 },
  { id: "wfigs", label: "WFIGS", url: WFIGS_URL, kind: "wfigs", everyMinutes: 60 },
  { id: "nws", label: "NWS", url: NWS_URL, kind: "nws", everyMinutes: 60 },
  // ── Cyclones (Threat Channel): one event per storm ────────
  { id: "nhc-atlantic", label: "NHC", url: "https://www.nhc.noaa.gov/index-at.xml", kind: "nhc", everyMinutes: 30 },
  { id: "nhc-epacific", label: "NHC", url: "https://www.nhc.noaa.gov/index-ep.xml", kind: "nhc", everyMinutes: 30 },
  // ── US severe-weather products (feed-only) ────────────────
  { id: "spc", label: "SPC", url: "https://www.spc.noaa.gov/products/spcrss.xml", kind: "spc", everyMinutes: 60 },
  // ── Wires (existing) ──────────────────────────────────────
  { id: "bbc", label: "BBC", url: BBC_URL, kind: "wire", everyMinutes: 60 },
  { id: "bbc-us", label: "BBC US", url: BBC_US_URL, kind: "wire", everyMinutes: 60 },
  { id: "aljazeera", label: "Al Jazeera", url: AJ_URL, kind: "wire", everyMinutes: 60 },
  // ── Disruption wires (Threat Channel) ─────────────────────
  // Supply-chain stress; the wire classifier drops non-events.
  { id: "freightwaves", label: "FreightWaves", url: "https://www.freightwaves.com/news/feed", kind: "wire", everyMinutes: 60 },
  // Kimler's disruption query. UNVERIFIED from the build
  // sandbox (connection timed out 2026-10-13); behind the
  // registry its failure is one logged outcome.
  { id: "gdelt-us", label: "GDELT", url: "https://api.gdeltproject.org/api/v2/doc/doc?query=(shortage%20OR%20outbreak%20OR%20outage%20OR%20evacuation)%20sourcecountry:US&mode=artlist&format=rss&timespan=1h", kind: "wire", everyMinutes: 60 },
  { id: "gnews-us", label: "Google News", url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", kind: "wire", everyMinutes: 60 },
  // ── Local Watch sensors (design §2/§3) ────────────────────
  // Area alerts with advisories kept: local completeness beats
  // the national threat gate. Ids match the national parse, so
  // an alert seen by both merges into one event.
  { id: "nws-az", label: "NWS", url: "https://api.weather.gov/alerts/active?status=actual&area=AZ", kind: "nws", everyMinutes: 30, includeAdvisories: true },
  { id: "nws-md", label: "NWS", url: "https://api.weather.gov/alerts/active?status=actual&area=MD", kind: "nws", everyMinutes: 30, includeAdvisories: true },
  { id: "gnews-pima", label: "Google News", url: GNEWS("%22Pima%20County%22%20when:1d"), kind: "wire", everyMinutes: 60 },
  { id: "gnews-stmarys", label: "Google News", url: GNEWS("%22St.%20Mary%27s%20County%22%20when:1d"), kind: "wire", everyMinutes: 60 },
  { id: "gnews-tucson", label: "Google News", url: GNEWS("Tucson%20when:1d"), kind: "wire", everyMinutes: 60 },
]
