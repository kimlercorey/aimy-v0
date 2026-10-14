# GlobeNews → The Threat Channel — design (frozen 2026-10-13)

Kimler's direction, converged 2026-10-13 across the usefulness
evaluation, the demo framing, and the pattern discussion. This
doc supersedes the Phase 1+2 expansion scope for the GlobeNews
widget. GlobeNews remains the widget's name in code; the
channel is what it presents.

## 1. Thesis

Aggregate weak signals from many feeds, detect patterns, and
create awareness for niche interests — prepping is the exemplar
lens. A lens = sources + vocabulary + watched places +
thresholds. Lenses are configuration, not code, and may become
shareable artifacts later (open question).

The pipeline is: sensors → memory → detectors → patterns with
evidence. The globe and feed are the presentation, not the
product.

Geography: Arizona / Tucson is the anchor. The global layer is
inbound early warning — things with a trajectory toward the US
(pandemic/disease is the named example) earn prominence; the
rest is context.

The demo story and the usefulness story are the same story:
"It watches the world's weak signals, notices when they start
pointing at your home, and shows its evidence."

## 2. Scopes

The feed switch is three scopes — Global / National / Local —
defaulting to Local. (Replaces the World/USA toggle shipped
2026-10-13 and the Your Places wording.)

- Local: events within 150 km of a watched place. Watched
  places v1: Tucson, AZ (32.2, −110.9) and Tall Timbers /
  Mechanicsville, MD (38.3, −76.7). Tucson ranks first.
- National: US events (the existing isUsEvent rule).
- Global: everything.

Corridors, not just radii, are the longer-term local model:
what comes through Nogales (I-19) is Tucson's supply line;
Eastern Pacific storm remnants are Tucson's flood line.

## 3. Sensors (the registry) and memory (the ledger)

The scanner becomes a declarative source registry in the
widget folder: one row per source (id, label, url, kind,
cadence minutes, parser options) and one parser per KIND
(gdacs / geojson / arcgis / nws-api / nhc-rss / products-rss /
wire-rss). Adding a feed = adding a row. A failing source is a
logged outcome, never a failed scan.

Sources at freeze (all verified live 2026-10-13 unless noted):
GDACS, USGS earthquakes (4.5_day), WFIGS fires, NWS national,
BBC, BBC US, Al Jazeera (existing); NHC Atlantic + Eastern
Pacific cyclone feeds (nhc:Cyclone blocks carry center/name/
atcf — one event per storm, category weather, 30-min cadence);
SPC products (feed-only, status items skipped); FreightWaves
(wire rules — the classifier already drops non-event
headlines); GDELT DOC RSS with Kimler's disruption query
(shortage OR outbreak OR outage OR evacuation, sourcecountry
US — UNVERIFIED from the build sandbox, include behind the
registry); Google News wires incl. county watches (Pima
County, St. Mary's County, Tucson); NWS area=AZ and area=MD
with the advisory gate relaxed (local completeness, 30-min
cadence). CISA advisories and the NHC/SPC outlooks belong to
the signals/pattern layer, not the event board. Reddit .rss
403s from datacenter IPs — deferred until proven from the
home network.

The ledger: the events store keeps a 5-day display window,
but patterns need baselines. Each scan also appends daily
rollups (counts by category × region, storm positions, fire
sizes) to a ledger kept for a year. Rollups are the pattern
layer's memory.

## 4. Patterns

Deterministic detectors propose; AImy evaluates and words
them as claims with evidence attached; the platform's track
record scores whether watches preceded anything real.
Detectors v1: storm tracks (same atcf across scans), fire
growth (acreage deltas), disease-cluster drift (new countries
over days, approaching US hubs), category spikes vs the
ledger baseline, cross-source convergence (independent source
kinds agreeing on a theme/place within a window).

Rules: a pattern card lists its contributing signals (events,
sources, window, strength) or it does not ship. Restraint is
a feature: "quiet week, nothing converging" is a valid and
trust-building output. Correlation is never worded as
causation.

Severity: GDACS alert levels (Green/Orange/Red) are data —
retained on the event, badged in the feed, and used by the
director and the alerts voice. Alerting (from the evaluation):
a banner for NWS Warnings in watched areas, GDACS Red, and
major quakes near watched places.

## 5. The broadcast (director)

Idle, the widget is a channel — "the Weather Channel, but for
threats." A director picks the most significant fresh threat
in the current scope, flies the camera to it, shows a
lower-third (headline + severity band), dwells ~10 s, moves
on. A crawl along the stage bottom carries top-tier
headlines. Any interaction (grab, click, typing) suspends the
director instantly; it resumes after ~30 s idle. Settings
(transposed, per the widget settings pattern): cinematic
on/off, dwell seconds, announce on/off.

Severity grammar: red band = warning tier, amber = watch,
quiet = advisory. Color is reserved for category + severity
everywhere; the world stays phosphor/cyan monochrome.

## 6. Camera and the tactical layer

True zoom requires vector coastlines (Natural Earth, public
domain) replacing the fixed dot raster: the land becomes math,
so the camera descends continuously (earth → continent →
region) while the point-cloud re-resolves — sparse at
altitude, dense on approach. Zoom is user-driven (scroll /
pinch on the globe) and director-driven (fly-to on features).

Tactical elements: graticule fading in with zoom; range rings
around watched places (100 / 500 / 1,000 km); great-circle
inbound arcs from a featured threat to the nearest watched
place; target lock-on brackets + floating data tag (name,
distance, age) on the featured dot; an expanding shockwave
ring when a new threat lands; live mono readouts (camera
lat/lon, bearing, clock) along the frame edges — all real
data. The ember reflection belongs to the wide shot and fades
as the camera descends.

Frame rate at depth is a verify-on-hardware requirement (dot
counts grow while descending); no smoothness claim until it is
measured on Kimler's machine.

## 7. Intel desk

A third component of the widget (after globe + feed),
placeable independently. For the featured/selected threat:
a visual hero (source image when available — NHC cone,
USGS shake map, article lead image — else a map view of the
location); a facts strip (distance + bearing from the nearest
watched place, age, source, severity); the alert's own text
(NWS detail is stored); pattern context when one exists;
related signals below. Images are publisher-served: fine for
the local app and demo, flagged for the shipped product.

## 8. The "alerts" voice

New significant arrivals are spoken — in a DIFFERENT voice
from AImy's conversational voice: a dedicated voice profile
named "alerts" (the channel's announcer). Rules: speaks only
warning-tier arrivals in the current scope (Local warnings
always; National/Global only when severe), a cooldown between
announcements, never over the user mid-conversation, and a
transposed widget setting to silence it. Exact voice casting
is Kimler's call when the TTS slice is built.

## 9. Honesty rules (unchanged, restated)

No invented coordinates — a headline naming no known place is
feed-only. Per-source failures are logged, never silent.
Patterns show their signals. Styling never outruns data: a
readout displays only what the system actually knows.

## 10. Build order

1. Scopes: Global / National / Local, default Local.
2. Sensors: registry + NHC/SPC/wires/local NWS + cadence +
   ledger rollups.
3. Camera + tactical layer (vector coastlines, descent,
   director, grammar).
4. Intel desk + crawl + alerts voice + alert banners.
5. Demo hardening pass (click everything; kill-or-confirm
   the white slab) before any audience.

Open questions for Kimler: alerts voice casting; whether
lenses become shareable artifacts; sound design beyond the
voice (none assumed); pattern publication (private display
vs claim ledger) — default private with track record.

## Build status (2026-10-13)

Steps 1–3 built and harness-verified. Step 4 built except
the voice: the intel desk (third component — facts strip with
distance + bearing from the nearest watched place, the
event's own text, related signals), the crawl, the
lower-third, feed-row feature glow, and alert banners
(CommsBanner via a sink the scan job calls; the alert
predicate is `alertFor` in scan.ts: NWS Warnings within
150 km of a watched place, M6.5+ quakes within 500 km,
M7.5+ critical within 1,500 km; new-arrival diff only, max
2 banners per scan). Still open in §4: pattern detectors,
and GDACS level retention (which also admits GDACS Red to
the alert predicate).

The §8 voice is BUILT (2026-10-13, manifest v1.4.0). Casting:
Kimler recorded a voice named "alert" (the announcer resolves
"alerts" first, then "alert", from the local TTS server).
Rules as built: an alert speaks when it is warning-tier AND
inside the risk circle — within 150 km of a watched place
(the Local radius; banners keep the wider alertFor radii).
Pattern-driven alerts (§4) enter through the same sink with
voice set. It speaks on arrival, then repeats every
repeatMinutes (widget setting, default 3, 1–15) until
silenced; an announce toggle (default on) gates it. Silence
lives in the interface: a severity-banded strip at the top
of the desk and the feed with a Silence button per alert;
dismissals persist in the events store (7-day prune), and
on boot the announcer replays every still-alert-tier,
un-dismissed event from the store, so a restart never drops
an active threat. Speech rides a second NarrationQueue whose
synthesis always uses the alerts voice on the local server,
broadcast as chat.audioChunk on streamId "alerts" — the
renderer's single playback channel serialises it against
AImy's conversational voice, and a user message interrupts
it (the repeater re-speaks at the next due tick). Spoken
form: "Alert. <title>. <N> kilometers from <place>."
("Critical alert." when critical). The tactical range rings
adopted the same grammar: 100 km red, 500/1,000 km yellow,
slightly stronger alphas.
