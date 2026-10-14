/**
 * widgets/globenews/scan.ts — the world-news scanner (2026-10-13).
 *
 * Sources, chosen for geolocation quality and zero key/secret
 * requirements (checked live 2026-10-13):
 * - GDACS (UN/EU disaster alerts, public domain): the RSS carries
 *   per-event coordinates — disasters arrive geo-exact, and its
 *   event type drives the category.
 * - USGS earthquake GeoJSON: global quakes M4.5+, geo-exact.
 * - WFIGS (US interagency wildfire incidents): geo-exact, with
 *   acreage — the US fire picture GDACS barely carries.
 * - NWS active alerts (api.weather.gov): US weather threats,
 *   filtered to Severe/Extreme threat events; dotted from the
 *   alert's geometry when it carries any, else gazetteer-
 *   geocoded from the alert text (zone-based advisories carry
 *   no geometry), feed-only when neither resolves.
 * - BBC World, BBC US & Canada + Al Jazeera RSS: wire headlines
 *   for conflict and unrest, geocoded by the gazetteer
 *   (reported-place precision).
 * (GDELT's GEO API was the obvious third source; it now answers
 * 404 — retired without notice — so it is deliberately absent.)
 *
 * The core is pure (fetch is injected) so the harness can pin
 * parsing, classification, geocoding and merging against
 * fixtures. A source that fails is logged per-source and never
 * silently treated as "no news".
 */
import { geocodeHeadline } from "./gazetteer.js"
import {
  AJ_URL,
  BBC_URL,
  BBC_US_URL,
  GDACS_URL,
  NWS_URL,
  SOURCE_REGISTRY,
  USGS_URL,
  WFIGS_URL,
  type SourceDef,
} from "./sources.js"
import { nearestWatchedKm } from "./ledger.js"
import { NEWS_MAX_AGE_MS, type NewsCategory, type NewsEvent } from "./types.js"

export {
  AJ_URL,
  BBC_URL,
  BBC_US_URL,
  GDACS_URL,
  NWS_URL,
  USGS_URL,
  WFIGS_URL,
}


/** Stable content id (FNV-1a) — stability is all an id needs here. */
export const newsIdFor = (key: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `n${(h >>> 0).toString(16).padStart(8, "0")}`
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")

/** Text of the first <tag>…</tag> in a block (CDATA unwrapped). */
const tagText = (block: string, tag: string): string | undefined => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!m || m[1] === undefined) return undefined
  const inner = m[1].trim()
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  return decodeEntities((cdata && cdata[1] !== undefined ? cdata[1] : inner).trim())
}

/** RSS prose → plain text (tags stripped, whitespace collapsed). */
const plainText = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()

const itemBlocks = (xml: string): Array<string> => {
  const out: Array<string> = []
  const re = /<item[\s>][\s\S]*?<\/item>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[0])
  return out
}

/** GDACS event type (in each item's link) → widget category. */
const GDACS_TYPE_CATEGORY: Record<string, NewsCategory> = {
  EQ: "earthquake",
  WF: "fire",
  TC: "weather",
  FL: "disaster",
  VO: "disaster",
  DR: "disaster",
}

/**
 * GDACS titles, made readable (Kimler, 2026-10-13): drop the
 * alert-level prefix and the appended " 13/10/2026 12:23 UTC,
 * [unknown]." tail, and render the robotic fire phrasing as
 * "Wildfire in …". Same facts, human shape.
 */
export const cleanGdacsTitle = (raw: string, type: string): string => {
  let t = raw.replace(/^(Green|Orange|Red)\s+/i, "")
  t = t.replace(/\s+\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*UTC.*$/i, "")
  t = t.replace(/,?\s*\[unknown\]\.?$/i, "").trim()
  if (type === "WF") t = t.replace(/^forest fire notification in\s+/i, "Wildfire in ")
  return t === "" ? t : t.charAt(0).toUpperCase() + t.slice(1)
}

/** Parse the GDACS RSS (geo-exact disasters). */
export const parseGdacs = (xml: string): Array<NewsEvent> => {
  const out: Array<NewsEvent> = []
  for (const item of itemBlocks(xml)) {
    const rawTitle = tagText(item, "title")
    const link = tagText(item, "link")
    const pub = tagText(item, "pubDate")
    if (rawTitle === undefined || link === undefined || pub === undefined) continue
    const atMs = Date.parse(pub)
    if (!Number.isFinite(atMs)) continue
    const lat = Number(tagText(item, "geo:lat"))
    const lon = Number(tagText(item, "geo:long"))
    const country = tagText(item, "gdacs:country")
    // GDACS summaries lead with the alert prose ("Overall Green …").
    const summary = plainText(tagText(item, "description") ?? "")
      .replace(/^Overall\s+(Green|Orange|Red)\s+/i, "")
      .slice(0, 600)
    const type = link.match(/[?&]eventtype=([A-Za-z]+)/)?.[1]?.toUpperCase() ?? ""
    out.push({
      id: newsIdFor(`gdacs:${link}`),
      title: cleanGdacsTitle(rawTitle, type).slice(0, 160),
      category: GDACS_TYPE_CATEGORY[type] ?? "disaster",
      source: "GDACS",
      url: link,
      atMs,
      ...(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}),
      ...(country !== undefined && country !== "" ? { place: country } : {}),
      ...(summary !== "" ? { summary } : {}),
      read: false,
    })
  }
  return out
}

const CONFLICT_RE =
  /\b(missile|airstrike|air strike|bombing|bombed|shelling|artillery|drone strike|invasion|invaded|offensive|rocket attack|air raid|warplane|fighter jet|ballistic|shooting|gunman|gunmen|gunfire)\b/i
const UNREST_RE =
  /\b(riot|riots|rioting|protest|protests|protesters|demonstrators|unrest|uprising|clashes|coup|general strike)\b/i
const EARTHQUAKE_RE = /\b(earthquake|quake|tremor|aftershock|seismic)\b/i
const FIRE_RE = /\b(wildfire|wildfires|forest fire|bushfire|bushfires)\b/i
const WEATHER_RE = /\b(hurricane|cyclone|typhoon|tornado|blizzard|heatwave|heat wave)\b/i
const DISASTER_RE =
  /\b(flood|flooding|volcano|eruption|tsunami|landslide|mudslide|drought|avalanche|storm surge)\b/i

/** Headline → event class, or null when it is not an event at all. */
export const classifyHeadline = (title: string): NewsCategory | null => {
  if (EARTHQUAKE_RE.test(title)) return "earthquake"
  if (FIRE_RE.test(title)) return "fire"
  if (WEATHER_RE.test(title)) return "weather"
  if (DISASTER_RE.test(title)) return "disaster"
  if (CONFLICT_RE.test(title)) return "conflict"
  if (UNREST_RE.test(title)) return "unrest"
  return null
}

/** Parse a wire RSS (BBC / Al Jazeera): events only, gazetteer-geocoded. */
export const parseWire = (xml: string, source: string): Array<NewsEvent> => {
  const out: Array<NewsEvent> = []
  for (const item of itemBlocks(xml)) {
    const title = tagText(item, "title")
    const link = tagText(item, "link")
    const pub = tagText(item, "pubDate")
    if (title === undefined || link === undefined || pub === undefined) continue
    const category = classifyHeadline(title)
    if (category === null) continue
    const atMs = Date.parse(pub)
    if (!Number.isFinite(atMs)) continue
    const description = tagText(item, "description") ?? ""
    const summary = plainText(description).slice(0, 600)
    const geo = geocodeHeadline(`${title} ${description}`)
    out.push({
      id: newsIdFor(`wire:${link}`),
      title: title.slice(0, 160),
      category,
      source,
      url: link,
      atMs,
      ...(geo !== undefined ? { lat: geo.lat, lon: geo.lon, place: geo.place } : {}),
      ...(summary !== "" ? { summary } : {}),
      read: false,
    })
  }
  return out
}

/** Parse the USGS earthquake GeoJSON (M4.5+, past day, geo-exact). */
export const parseUsgs = (json: string): Array<NewsEvent> => {
  const out: Array<NewsEvent> = []
  let data: { features?: unknown }
  try {
    data = JSON.parse(json) as { features?: unknown }
  } catch {
    return out
  }
  const features = Array.isArray(data.features) ? data.features : []
  for (const f of features) {
    const feat = f as {
      properties?: Record<string, unknown>
      geometry?: { coordinates?: unknown }
    }
    const p = feat.properties ?? {}
    const coords = feat.geometry?.coordinates
    if (typeof p["url"] !== "string" || typeof p["time"] !== "number" || !Array.isArray(coords)) continue
    const lon = Number(coords[0])
    const lat = Number(coords[1])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const mag = typeof p["mag"] === "number" ? p["mag"] : null
    const place = typeof p["place"] === "string" ? p["place"] : ""
    out.push({
      id: newsIdFor(`usgs:${p["url"]}`),
      title: `Earthquake${mag !== null ? ` M${mag.toFixed(1)}` : ""} — ${place}`.slice(0, 160),
      category: "earthquake",
      source: "USGS",
      url: p["url"],
      atMs: p["time"],
      lat,
      lon,
      ...(place !== "" ? { place } : {}),
      read: false,
    })
  }
  return out
}

/**
 * Parse WFIGS current US wildfire incidents (ArcGIS JSON). A
 * fire's timestamp is its last update (falling back to discovery):
 * an actively-burning, actively-updated fire stays inside the
 * 5-day horizon even when it was discovered earlier.
 */
export const parseWfigs = (json: string, nowMs: number = Date.now()): Array<NewsEvent> => {
  const out: Array<NewsEvent> = []
  let data: { features?: unknown }
  try {
    data = JSON.parse(json) as { features?: unknown }
  } catch {
    return out
  }
  const features = Array.isArray(data.features) ? data.features : []
  for (const f of features) {
    const a = (f as { attributes?: Record<string, unknown> }).attributes ?? {}
    const lat = Number(a["InitialLatitude"])
    const lon = Number(a["InitialLongitude"])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const discovered = typeof a["FireDiscoveryDateTime"] === "number" ? a["FireDiscoveryDateTime"] : 0
    const modified = typeof a["ModifiedOnDateTime_dt"] === "number" ? a["ModifiedOnDateTime_dt"] : 0
    const atMs = modified > 0 ? modified : discovered
    if (atMs <= 0) continue
    const rawName =
      typeof a["IncidentName"] === "string" && a["IncidentName"] !== "" ? a["IncidentName"] : "Unnamed fire"
    const name = rawName.replace(/^LOC\s*-\s*/i, "")
    const state = typeof a["POOState"] === "string" ? a["POOState"].replace(/^US-/, "") : ""
    const county = typeof a["POOCounty"] === "string" ? a["POOCounty"] : ""
    const place = [county !== "" ? `${county} County` : "", state].filter((x) => x !== "").join(", ")
    const acres = Math.round(
      typeof a["DiscoveryAcres"] === "number"
        ? a["DiscoveryAcres"]
        : typeof a["IncidentSize"] === "number"
          ? a["IncidentSize"]
          : 0
    )
    // Inclusion: size (>= 10 acres) or a discovery inside the
    // horizon. WFIGS keeps sub-acre records "current" on
    // bookkeeping touches alone — a 0-acre July record surfaced
    // in October before this rule (Kimler's screenshot).
    const recentDiscovery = discovered > 0 && discovered >= nowMs - NEWS_MAX_AGE_MS
    if (acres < 10 && !recentDiscovery) continue
    const summary =
      acres > 0
        ? `${acres.toLocaleString("en-US")} acres${discovered > 0 ? ` · discovered ${new Date(discovered).toISOString().slice(0, 10)}` : ""}`
        : ""
    out.push({
      id: newsIdFor(
        `wfigs:${typeof a["SourceOID"] === "string" && a["SourceOID"] !== "" ? a["SourceOID"] : `${name}:${lat},${lon}`}`
      ),
      title: `Wildfire — ${name}`,
      category: "fire",
      source: "WFIGS",
      url: "https://inciweb.wildfire.gov/",
      atMs,
      lat,
      lon,
      ...(place !== "" ? { place } : {}),
      ...(summary !== "" ? { summary } : {}),
      read: false,
    })
    if (out.length >= 30) break // The feed is a queue, not a fire census.
  }
  return out
}

const NWS_THREAT_RE =
  /(tornado|hurricane|tropical storm|flash flood|flood|fire weather|red flag|winter storm|blizzard|ice storm|snow squall|extreme wind|tsunami|storm surge|dust storm)/i

/** Centroid of a GeoJSON geometry's first ring (or the point itself). */
const geometryCentroid = (geometry: unknown): { lat: number; lon: number } | null => {
  const g = geometry as { type?: string; coordinates?: unknown } | null
  if (g === null || typeof g !== "object" || !Array.isArray(g.coordinates)) return null
  let ring: unknown = null
  if (g.type === "Point") return { lon: Number((g.coordinates as Array<number>)[0]), lat: Number((g.coordinates as Array<number>)[1]) }
  if (g.type === "Polygon") ring = (g.coordinates as Array<unknown>)[0]
  if (g.type === "MultiPolygon") ring = ((g.coordinates as Array<unknown>)[0] as Array<unknown>)[0]
  if (!Array.isArray(ring) || ring.length === 0) return null
  let lat = 0
  let lon = 0
  for (const pt of ring) {
    const pair = pt as Array<number>
    lon += Number(pair[0])
    lat += Number(pair[1])
  }
  const out = { lat: lat / ring.length, lon: lon / ring.length }
  return Number.isFinite(out.lat) && Number.isFinite(out.lon) ? out : null
}

/**
 * Parse NWS active alerts: only threat Warnings (or Extreme
 * events) — the raw feed is mostly marine advisories and
 * watches, which are outlooks rather than threats. Geometry is often
 * absent — those alerts stay feed-only, never guessed onto the
 * globe.
 */
export const parseNws = (
  json: string,
  opts?: { includeAdvisories?: boolean | undefined }
): Array<NewsEvent> => {
  const out: Array<NewsEvent> = []
  let data: { features?: unknown }
  try {
    data = JSON.parse(json) as { features?: unknown }
  } catch {
    return out
  }
  const features = Array.isArray(data.features) ? data.features : []
  for (const f of features) {
    const feat = f as { id?: unknown; geometry?: unknown; properties?: Record<string, unknown> }
    const p = feat.properties ?? {}
    const event = typeof p["event"] === "string" ? p["event"] : ""
    const severity = typeof p["severity"] === "string" ? p["severity"] : ""
    // Threats, not outlooks: Extreme anything, or a Warning.
    // (A Severe Flood Watch is still just a watch.) Local Watch
    // sources (area queries) opt out of the gate: for the user's
    // own places, advisories are signal, not noise.
    if (
      opts?.includeAdvisories !== true &&
      (!NWS_THREAT_RE.test(event) || (severity !== "Extreme" && !/warning/i.test(event)))
    )
      continue
    const onset = typeof p["onset"] === "string" ? p["onset"] : typeof p["sent"] === "string" ? p["sent"] : ""
    const atMs = Date.parse(onset)
    if (!Number.isFinite(atMs)) continue
    const area = typeof p["areaDesc"] === "string" ? p["areaDesc"].split(";")[0]?.trim() ?? "" : ""
    const sender = typeof p["senderName"] === "string" ? p["senderName"].replace(/^NWS\s+/i, "") : ""
    const centroid = geometryCentroid(feat.geometry)
    const description = plainText(typeof p["description"] === "string" ? p["description"] : "")
    const instruction = plainText(typeof p["instruction"] === "string" ? p["instruction"] : "")
    const summary = description.slice(0, 600)
    // The alert IS the article: keep its full text (description +
    // instruction) so opening the item shows the warning itself,
    // not the API's JSON payload.
    const detail = [description, instruction].filter((x) => x !== "").join("\n\n").slice(0, 8000)
    // Geometry first (geo-exact). Zone-based alerts (Wind
    // Advisory, Red Flag Warning, ...) carry no geometry — they
    // reference forecast zones, not polygons — so fall back to
    // the gazetteer over the alert's own text, the reported-
    // place rule the wire sources live by (Kimler, 2026-10-13:
    // a Tucson advisory has to be able to be Local). The event
    // name and area lead the text, so the earliest mention is
    // the alert's own area, ahead of places named in the body.
    const fallback = centroid === null ? geocodeHeadline(`${event} ${area} ${description}`) : undefined
    const latLon = centroid ?? (fallback !== undefined ? { lat: fallback.lat, lon: fallback.lon } : null)
    out.push({
      id: newsIdFor(`nws:${typeof p["id"] === "string" ? p["id"] : `${event}:${onset}:${area}`}`),
      title: `${event}${area !== "" ? ` — ${area}` : ""}`.slice(0, 160),
      category: "weather",
      source: "NWS",
      url: typeof feat.id === "string" ? feat.id : NWS_URL,
      atMs,
      ...(latLon !== null ? { lat: latLon.lat, lon: latLon.lon } : {}),
      ...(sender !== "" ? { place: sender } : area !== "" ? { place: area } : {}),
      ...(summary !== "" ? { summary } : {}),
      ...(detail !== "" ? { detail } : {}),
      read: false,
    })
    if (out.length >= (opts?.includeAdvisories === true ? 30 : 20)) break
  }
  return out
}

/**
 * Parse an NHC basin feed (Atlantic / Eastern Pacific). Only
 * items carrying an <nhc:Cyclone> block become events — in
 * practice the per-storm Summary item — so each storm is ONE
 * event, located at the storm center, id-stable by its ATCF
 * designator across advisories (its positions over time are
 * the pattern layer's track input). Category: weather.
 */
export const parseNhc = (xml: string): Array<NewsEvent> => {
  const out: Array<NewsEvent> = []
  const seen = new Set<string>()
  for (const item of itemBlocks(xml)) {
    const cyclone = item.match(/<nhc:Cyclone>([\s\S]*?)<\/nhc:Cyclone>/)?.[1]
    if (cyclone === undefined) continue
    const center = tagText(cyclone, "nhc:center")
    const atcf = tagText(cyclone, "nhc:atcf")
    const type = tagText(cyclone, "nhc:type") ?? ""
    const name = tagText(cyclone, "nhc:name") ?? ""
    const link = tagText(item, "link")
    if (center === undefined || link === undefined) continue
    const [latRaw, lonRaw] = center.split(",").map((x) => Number(x.trim()))
    if (latRaw === undefined || lonRaw === undefined || !Number.isFinite(latRaw) || !Number.isFinite(lonRaw)) continue
    const id = newsIdFor(`nhc:${atcf ?? link}`)
    if (seen.has(id)) continue
    seen.add(id)
    const pub = tagText(item, "pubDate")
    const atMs = pub !== undefined ? Date.parse(pub) : NaN
    if (!Number.isFinite(atMs)) continue
    const description = tagText(item, "description") ?? ""
    const summary = plainText(description).slice(0, 600)
    const detail = plainText(description).slice(0, 8000)
    const geo = geocodeHeadline(`${type} ${name} ${description}`)
    out.push({
      id,
      title: `${type} ${name}`.trim().slice(0, 160),
      category: "weather",
      source: "NHC",
      url: link,
      atMs,
      lat: latRaw,
      lon: lonRaw,
      ...(geo !== undefined ? { place: geo.place } : {}),
      ...(summary !== "" ? { summary } : {}),
      ...(detail !== "" ? { detail } : {}),
      read: false,
    })
  }
  return out
}

/**
 * Parse the SPC products feed: convective / fire-weather
 * outlooks and watches. Status items ("No watches are valid…")
 * are skipped — they are the absence of a threat. Feed-only by
 * design: an outlook covers a multi-state region, and pinning
 * it to one state's centroid would invent a location.
 */
export const parseSpc = (xml: string): Array<NewsEvent> => {
  const out: Array<NewsEvent> = []
  for (const item of itemBlocks(xml)) {
    const title = tagText(item, "title")
    const link = tagText(item, "link")
    const pub = tagText(item, "pubDate")
    if (title === undefined || link === undefined || pub === undefined) continue
    if (/^SPC - No /i.test(title)) continue
    if (!/outlook|watch|mesoscale/i.test(title)) continue
    const atMs = Date.parse(pub)
    if (!Number.isFinite(atMs)) continue
    const summary = plainText(tagText(item, "description") ?? "").slice(0, 600)
    out.push({
      id: newsIdFor(`spc:${link}`),
      title: title.replace(/^SPC\s+/, "").slice(0, 160),
      category: /fire weather/i.test(title) ? "fire" : "weather",
      source: "SPC",
      url: link,
      atMs,
      ...(summary !== "" ? { summary } : {}),
      read: false,
    })
  }
  return out
}

/**
 * Merge a fresh scan into the stored events. Known ids REFRESH
 * their content fields from the new scan — cleaner titles and
 * corrected categories reach events already in the store —
 * while the user's state survives: the read flag, and the
 * timestamp (which only ever moves forward, so an actively-
 * updated incident is not pruned while it is still active).
 * Anything past the 5-day horizon is pruned, newest first, capped.
 * Cross-id duplicates collapse too: one story can arrive as
 * several source records (NWS issues the same warning under
 * multiple zone URNs), so groups sharing (source, title, atMs)
 * merge into a single event — see the dedupe pass below.
 */
export const mergeEvents = (
  existing: ReadonlyArray<NewsEvent>,
  incoming: ReadonlyArray<NewsEvent>,
  nowMs: number
): { readonly events: ReadonlyArray<NewsEvent>; readonly added: number; readonly deduped: number } => {
  const floor = nowMs - NEWS_MAX_AGE_MS
  const byId = new Map<string, NewsEvent>()
  for (const e of existing) byId.set(e.id, e)
  let added = 0
  for (const e of incoming) {
    if (e.atMs < floor) continue // Arrived already past the horizon.
    const stored = byId.get(e.id)
    if (stored === undefined) {
      byId.set(e.id, e)
      added++
    } else {
      byId.set(e.id, { ...e, read: stored.read, atMs: Math.max(stored.atMs, e.atMs) })
    }
  }
  // Dedupe pass (Kimler, 2026-10-13): collapse groups sharing
  // (source, title, atMs). The keeper is a stored id when one
  // is in the group (alert and read continuity), else the copy
  // carrying coordinates, else the fullest text; the read flag
  // ORs across the group so nothing read is lost.
  const storedIds = new Set(existing.map((e) => e.id))
  const groups = new Map<string, Array<NewsEvent>>()
  for (const e of byId.values()) {
    if (e.atMs < floor) continue
    const key = `${e.source}\n${e.title}\n${e.atMs}`
    const g = groups.get(key)
    if (g === undefined) groups.set(key, [e])
    else g.push(e)
  }
  let deduped = 0
  const collapsed: Array<NewsEvent> = []
  for (const g of groups.values()) {
    if (g.length === 1) {
      collapsed.push(g[0]!)
      continue
    }
    deduped += g.length - 1
    const score = (e: NewsEvent): number =>
      (storedIds.has(e.id) ? 4 : 0) +
      (typeof e.lat === "number" && typeof e.lon === "number" ? 2 : 0) +
      Math.min(1, (e.detail?.length ?? 0) / 8000)
    const keeper = [...g].sort((a, b) => score(b) - score(a))[0]!
    collapsed.push({ ...keeper, read: g.some((e) => e.read) })
  }
  const events = collapsed
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, 120)
  return { events, added, deduped }
}

export type FetchText = (url: string) => Promise<string>

export interface SourceOutcome {
  /** Registry id (stable in logs). */
  readonly source: string
  readonly ok: boolean
  readonly count: number
  /** True when the source was not due and was not fetched. */
  readonly skipped?: boolean | undefined
}

const parseFor = (def: SourceDef, text: string, nowMs: number): Array<NewsEvent> => {
  switch (def.kind) {
    case "gdacs":
      return parseGdacs(text)
    case "usgs":
      return parseUsgs(text)
    case "wfigs":
      return parseWfigs(text, nowMs)
    case "nws":
      return parseNws(text, { includeAdvisories: def.includeAdvisories === true })
    case "nhc":
      return parseNhc(text)
    case "spc":
      return parseSpc(text)
    case "wire":
      return parseWire(text, def.label)
  }
}

/**
 * Fetch + parse every DUE source in the registry; per-source
 * outcomes, never throws. `lastRuns` (registry id → last scan
 * ms) comes from the events store; sources not yet due are
 * reported as skipped unless `force` is set (manual refresh).
 * The returned `runs` is the updated map for the store.
 */
export const scanAll = async (
  fetchText: FetchText,
  nowMs: number = Date.now(),
  lastRuns: Readonly<Record<string, number>> = {},
  force = false
): Promise<{
  readonly incoming: ReadonlyArray<NewsEvent>
  readonly sources: ReadonlyArray<SourceOutcome>
  readonly runs: Readonly<Record<string, number>>
}> => {
  const incoming: Array<NewsEvent> = []
  const sources: Array<SourceOutcome> = []
  const runs: Record<string, number> = { ...lastRuns }
  for (const def of SOURCE_REGISTRY) {
    const last = lastRuns[def.id] ?? 0
    if (!force && nowMs - last < def.everyMinutes * 60_000) {
      sources.push({ source: def.id, ok: true, count: 0, skipped: true })
      continue
    }
    try {
      const text = await fetchText(def.url)
      const events = parseFor(def, text, nowMs)
      incoming.push(...events)
      runs[def.id] = nowMs
      sources.push({ source: def.id, ok: true, count: events.length })
    } catch (e) {
      console.error(
        `[aimy] globenews scan: ${def.id} failed (${e instanceof Error ? e.message : String(e)})`
      )
      sources.push({ source: def.id, ok: false, count: 0 })
    }
  }
  return { incoming, sources, runs }
}

/**
 * Alert tier (Threat Channel design §4): which events are serious
 * enough to interrupt — a platform banner now, the "alerts" voice
 * when it is cast. Deliberately narrow: an NWS Warning near a
 * watched place, or a major quake near one. GDACS Red joins when
 * the alert level is retained on the event. Everything else is
 * the board's business, not the user's interruption.
 */
export interface NewsAlertInfo {
  readonly severity: "warning" | "critical"
  readonly reason: string
}

export const alertFor = (e: NewsEvent): NewsAlertInfo | undefined => {
  const km = nearestWatchedKm(e)
  if (km === undefined) return undefined
  if (e.source === "NWS" && /warning/i.test(e.title) && km <= 150) {
    return { severity: "warning", reason: "weather warning near a watched place" }
  }
  if (e.category === "earthquake") {
    const m = /Earthquake M([\d.]+)/.exec(e.title)
    if (m !== null) {
      const mag = Number(m[1])
      if (mag >= 7.5 && km <= 1_500) return { severity: "critical", reason: `M${mag.toFixed(1)} earthquake` }
      if (mag >= 6.5 && km <= 500) return { severity: "warning", reason: `M${mag.toFixed(1)} earthquake` }
    }
  }
  return undefined
}

/** The real fetch: global fetch, honest UA, bounded wait. */
export const fetchTextLive: FetchText = async (url: string): Promise<string> => {
  const res = await fetch(url, {
    headers: { "user-agent": "AImy/1.0 (GlobeNews widget)" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}
