/**
 * widgets/globenews/gazetteer.ts — headline geocoding, honestly
 * scoped (2026-10-13).
 *
 * Wire headlines carry no coordinates, so the scanner matches
 * headline + summary text against this table of world capitals,
 * major cities, countries (centroids) and current hotspots. The
 * EARLIEST-mentioned place wins (wire copy leads with the place
 * the news is from: "Kyiv, Ukraine" means Kyiv), ties broken by
 * the longer name ("South Korea" before "Korea"). Matching is
 * word-bounded and case-insensitive, and a headline with no match
 * gets NO location — the event appears in the feed without a dot
 * rather than on a guessed one. Precision is "reported place",
 * never street level, and the feed shows the place name so the
 * basis is visible.
 */

export interface GazetteerHit {
  readonly place: string
  readonly lat: number
  readonly lon: number
}

/** [name, lat, lon] — capitals, major cities, country centroids, hotspots. */
const PLACES: ReadonlyArray<readonly [string, number, number]> = [
  // Hotspots & conflict geography first (longest-match ordering is
  // applied at lookup, so table order does not matter).
  ["Gaza", 31.50, 34.47], ["Kyiv", 50.45, 30.52], ["Kharkiv", 49.99, 36.23],
  ["Tel Aviv", 32.08, 34.78], ["Jerusalem", 31.77, 35.21], ["Beirut", 33.89, 35.50],
  ["Damascus", 33.51, 36.29], ["Tehran", 35.69, 51.39], ["Baghdad", 33.31, 44.36],
  ["Kabul", 34.53, 69.17], ["Islamabad", 33.73, 73.09], ["Khartoum", 15.50, 32.53],
  ["Sanaa", 15.35, 44.21], ["Taipei", 25.03, 121.57], ["Beijing", 39.90, 116.40],
  ["Shanghai", 31.23, 121.47], ["Hong Kong", 22.32, 114.17], ["Seoul", 37.57, 126.98],
  ["Pyongyang", 39.03, 125.75], ["Tokyo", 35.68, 139.69], ["Manila", 14.60, 120.98],
  ["Jakarta", -6.21, 106.85], ["Bangkok", 13.76, 100.50], ["Hanoi", 21.03, 105.85],
  ["Dhaka", 23.81, 90.41], ["Kathmandu", 27.71, 85.32], ["Colombo", 6.93, 79.86],
  ["New Delhi", 28.61, 77.21], ["Mumbai", 19.08, 72.88], ["Karachi", 24.86, 67.00],
  ["Ankara", 39.93, 32.86], ["Istanbul", 41.01, 28.98], ["Athens", 37.98, 23.73],
  ["Warsaw", 52.23, 21.01], ["Berlin", 52.52, 13.40], ["Paris", 48.86, 2.35],
  ["London", 51.51, -0.13], ["Madrid", 40.42, -3.70], ["Rome", 41.90, 12.50],
  ["Stockholm", 59.33, 18.07], ["Moscow", 55.76, 37.62], ["Cairo", 30.04, 31.24],
  ["Tripoli", 32.90, 13.19], ["Addis Ababa", 8.98, 38.76], ["Mogadishu", 2.05, 45.32],
  ["Abuja", 9.06, 7.42], ["Lagos", 6.52, 3.37], ["Nairobi", -1.29, 36.82],
  ["Port-au-Prince", 18.54, -72.34], ["Caracas", 10.48, -66.90], ["Bogotá", 4.71, -74.07],
  ["Lima", -12.05, -77.04], ["Santiago", -33.45, -70.67], ["Buenos Aires", -34.60, -58.38],
  ["Mexico City", 19.43, -99.13], ["Washington", 38.90, -77.04], ["New York", 40.71, -74.01],
  ["Los Angeles", 34.05, -118.24], ["Ottawa", 45.42, -75.70], ["Havana", 23.11, -82.37],
  // US cities + states (2026-10-13, for the US sources and the
  // BBC US & Canada wire): shootings, fires and storms name the
  // city first, the state as the fallback.
  ["Chicago", 41.88, -87.63], ["Houston", 29.76, -95.37], ["Dallas", 32.78, -96.80],
  ["Austin", 30.27, -97.74], ["San Antonio", 29.42, -98.49], ["Phoenix", 33.45, -112.07],
  ["Tucson", 32.22, -110.97], ["San Francisco", 37.77, -122.42], ["San Diego", 32.72, -117.16],
  // Local Watch places (Threat Channel): the watched counties,
  // towns and the Nogales corridor.
  ["Pima County", 32.05, -111.9], ["St. Mary's County", 38.2, -76.6],
  ["Leonardtown", 38.29, -76.64], ["Mechanicsville", 38.44, -76.75],
  ["Waldorf", 38.63, -76.94], ["Nogales", 31.34, -110.93],
  ["Sacramento", 38.58, -121.49], ["Fresno", 36.74, -119.79], ["Las Vegas", 36.17, -115.14],
  ["Salt Lake City", 40.76, -111.89], ["Denver", 39.74, -104.99], ["Albuquerque", 35.08, -106.65],
  ["Boise", 43.62, -116.21], ["Portland", 45.52, -122.68], ["Seattle", 47.61, -122.33],
  ["Oklahoma City", 35.47, -97.52], ["Kansas City", 39.10, -94.58], ["St. Louis", 38.63, -90.20],
  ["Minneapolis", 44.98, -93.27], ["Nashville", 36.16, -86.78], ["Memphis", 35.15, -90.05],
  ["Atlanta", 33.75, -84.39], ["Charlotte", 35.23, -80.84], ["Miami", 25.76, -80.19],
  ["Orlando", 28.54, -81.38], ["Tampa", 27.95, -82.46], ["Jacksonville", 30.33, -81.66],
  ["New Orleans", 29.95, -90.07], ["Detroit", 42.33, -83.05], ["Indianapolis", 39.77, -86.16],
  ["Columbus", 39.96, -83.00], ["Cleveland", 41.50, -81.69], ["Milwaukee", 43.04, -87.91],
  ["Boston", 42.36, -71.06], ["Pittsburgh", 40.44, -79.99], ["Philadelphia", 39.95, -75.17],
  ["Baltimore", 39.29, -76.61], ["Anchorage", 61.22, -149.90], ["Honolulu", 21.31, -157.86],
  ["Arizona", 34.27, -111.66], ["California", 37.20, -119.61], ["Texas", 31.48, -99.33],
  ["Florida", 27.83, -81.72], ["Colorado", 39.00, -105.55], ["Utah", 39.31, -111.67],
  ["Nevada", 39.54, -116.63], ["Oregon", 43.94, -120.56], ["Idaho", 44.39, -114.66],
  ["Montana", 47.05, -109.63], ["Wyoming", 43.00, -107.55], ["New Mexico", 34.43, -106.11],
  ["Oklahoma", 35.59, -97.49], ["Kansas", 38.49, -98.38], ["Nebraska", 41.54, -99.80],
  ["Alaska", 64.00, -152.00], ["Hawaii", 19.90, -155.58], ["North Carolina", 35.54, -79.39],
  ["South Carolina", 33.92, -80.90], ["Tennessee", 35.86, -86.35], ["Louisiana", 31.05, -91.99],
  ["Mississippi", 32.74, -89.67], ["Alabama", 32.78, -86.83], ["Arkansas", 34.90, -92.44],
  ["Missouri", 38.36, -92.46], ["Iowa", 42.08, -93.50], ["Illinois", 40.04, -89.20],
  ["Michigan", 44.35, -85.41], ["Ohio", 40.29, -82.79], ["Pennsylvania", 40.88, -77.80],
  ["Virginia", 37.52, -78.66], ["Kentucky", 37.53, -84.90], ["Indiana", 39.90, -86.28],
  ["Wisconsin", 44.63, -89.99], ["Minnesota", 46.39, -94.31], ["Maine", 45.37, -68.97],
  ["Maryland", 39.05, -76.79], ["South Dakota", 44.44, -100.23], ["North Dakota", 47.45, -100.47],
  ["Canberra", -35.28, 149.13], ["Sydney", -33.87, 151.21], ["Wellington", -41.29, 174.78],
  // Countries (centroids) — the fallback when no city is named.
  ["Ukraine", 48.38, 31.17], ["Russia", 61.52, 105.32], ["Israel", 31.05, 34.85],
  ["Palestine", 31.95, 35.30], ["Lebanon", 33.85, 35.86], ["Syria", 34.80, 38.99],
  ["Iran", 32.43, 53.69], ["Iraq", 33.22, 43.68], ["Yemen", 15.55, 48.52],
  ["Sudan", 12.86, 30.22], ["South Sudan", 6.88, 31.31], ["Ethiopia", 9.15, 40.49],
  ["Somalia", 5.15, 46.20], ["Nigeria", 9.08, 8.68], ["Kenya", -0.02, 37.91],
  ["Libya", 26.34, 17.27], ["Egypt", 26.82, 30.80], ["Mali", 17.61, -4.00],
  ["Niger", 17.61, 8.08], ["Chad", 15.45, 18.73], ["Mozambique", -17.27, 35.53],
  ["Madagascar", -18.77, 46.87], ["Myanmar", 21.92, 95.96], ["Thailand", 15.87, 100.99],
  ["Vietnam", 14.06, 108.28], ["Philippines", 12.88, 121.77], ["Indonesia", -0.79, 113.92],
  ["Japan", 36.20, 138.25], ["Taiwan", 23.70, 120.96], ["China", 35.86, 104.20],
  ["India", 20.59, 78.96], ["Pakistan", 30.38, 69.35], ["Afghanistan", 33.94, 67.71],
  ["Bangladesh", 23.68, 90.36], ["Nepal", 28.39, 84.09], ["Sri Lanka", 7.87, 80.77],
  ["South Korea", 36.50, 127.90], ["North Korea", 40.34, 127.51], ["Turkey", 38.96, 35.24],
  ["Greece", 39.07, 21.82], ["Poland", 51.92, 19.15], ["Germany", 51.17, 10.45],
  ["France", 46.23, 2.21], ["Spain", 40.46, -3.75], ["Italy", 41.87, 12.57],
  ["United Kingdom", 55.38, -3.44], ["United States", 39.83, -98.58], ["Canada", 56.13, -106.35],
  ["Mexico", 23.63, -102.55], ["Brazil", -14.24, -51.93], ["Venezuela", 6.42, -66.59],
  ["Colombia", 4.57, -74.30], ["Peru", -9.19, -75.02], ["Chile", -31.76, -70.71],
  ["Argentina", -38.42, -63.62], ["Haiti", 18.97, -72.29], ["Cuba", 21.52, -77.78],
  ["Australia", -25.27, 133.78], ["New Zealand", -41.79, 172.83], ["Papua New Guinea", -6.31, 143.96],
  ["Tonga", -20.20, -175.20], ["Panama", 8.54, -80.78], ["Botswana", -22.33, 24.68],
  ["Tanzania", -6.37, 34.89], ["Mongolia", 46.86, 103.85],
]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const INDEX: ReadonlyArray<{ readonly name: string; readonly lat: number; readonly lon: number; readonly re: RegExp }> =
  PLACES.map(([name, lat, lon]) => ({
    name,
    lat,
    lon,
    re: new RegExp(`\\b${escapeRe(name)}\\b`, "i"),
  }))

/**
 * The earliest-mentioned place in the text (dateline order), or
 * undefined. Ties at the same offset go to the longer name.
 */
export const geocodeHeadline = (text: string): GazetteerHit | undefined => {
  let best: { hit: GazetteerHit; at: number } | undefined
  for (const p of INDEX) {
    const m = p.re.exec(text)
    if (m === null) continue
    if (
      best === undefined ||
      m.index < best.at ||
      (m.index === best.at && p.name.length > best.hit.place.length)
    ) {
      best = { hit: { place: p.name, lat: p.lat, lon: p.lon }, at: m.index }
    }
  }
  return best?.hit
}
