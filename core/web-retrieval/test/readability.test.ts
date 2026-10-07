/**
 * readability.test.ts — main-content extraction: boilerplate scored out,
 * article kept, honest fallback when nothing qualifies, JS-shell detection.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { extractMainContent, isJsShell } from "../src/readability.js"
import { extractMainText, fetchSource } from "../src/fetcher.js"
import { FetchError } from "../src/errors.js"
import { makeFixtureHandler, ok } from "./fixtures.js"

/** Realistic article page: full chrome around a real article. */
const ARTICLE_PAGE = `<!DOCTYPE html><html><head><title>Rain chances rising this weekend</title>
<script>var analytics = {};</script>
<style>.ad { display: none; }</style></head>
<body>
<header class="site-header"><div class="logo">WeatherHub</div>
<nav class="main-nav"><a href="/">Home</a><a href="/radar">Radar</a><a href="/alerts">Alerts</a><a href="/about">About us</a></nav>
</header>
<div class="cookie-consent-banner">We use cookies to improve your experience. Accept all cookies to continue browsing our site.</div>
<main>
<article class="forecast-article">
<h1>Rain chances rising this weekend</h1>
<p>Meteorologists say a low-pressure system moving in from the west will bring scattered showers across the valley starting Friday evening, with the heaviest rain expected overnight into Saturday morning.</p>
<p>Rainfall totals are forecast between half an inch and one inch in most areas, though higher elevations could see up to two inches before the system moves out late Saturday, according to the National Weather Service.</p>
<p>Drivers should expect slick roads during the Saturday morning commute, and outdoor events may need a backup plan. Temperatures will drop into the mid-50s behind the front.</p>
</article>
</main>
<aside class="sidebar">
<div class="ad-unit">Buy the amazing RainAway umbrella today! Limited time offer, free shipping on all orders over fifty dollars, satisfaction guaranteed.</div>
<div class="related-links"><h3>Related stories</h3><ul><li><a href="/s1">Storm last year</a></li><li><a href="/s2">Drought ends</a></li></ul></div>
</aside>
<footer class="site-footer">Copyright 2026 WeatherHub Inc. All rights reserved. Privacy policy | Terms of service | Contact | Careers | Press</footer>
</body></html>`

/** Sidebar with LONG text: length alone must not let boilerplate win. */
const LONG_SIDEBAR_PAGE = `<!DOCTYPE html><html><body>
<div class="sidebar">
<p>Sign up for our newsletter and get the top stories in your inbox every morning. We cover weather, traffic, sports, entertainment, and so much more for our loyal readers.</p>
<p>Our premium subscription unlocks exclusive content, an ad-free experience, early access to new features, and priority customer support from our dedicated team.</p>
</div>
<article>
<p>The city council voted Tuesday to approve the new reservoir project, ending months of debate over water rights and funding for the region. Construction is expected to begin in the spring, with completion targeted for late next year.</p>
</article>
</body></html>`

/** A script-heavy SPA shell with almost no visible text. */
const JS_SHELL_PAGE = `<!DOCTYPE html><html><head><title>App</title></head><body>
<div id="root"></div>
<script>${"var bundle_part = 'x'.repeat(500);\n".repeat(60)}</script>
<script>window.__CONFIG__ = { api: "/v1", theme: "dark" };</script>
<noscript>Loading&hellip;</noscript>
</body></html>`

/** Link farm: no paragraphs, nothing to score. */
const LINK_FARM_PAGE = `<!DOCTYPE html><html><body>
<nav><a href="/a">Alpha</a><a href="/b">Beta</a><a href="/c">Gamma</a></nav>
<div class="links"><a href="/1">one</a><a href="/2">two</a></div>
</body></html>`

/** Article split across two content containers: both must be kept. */
const SPLIT_ARTICLE_PAGE = `<!DOCTYPE html><html><body>
<div class="post-body">
<p>The expedition reached base camp on Monday after a difficult ascent through the icefall, establishing supply lines for the summit push.</p>
<p>Team leaders cited unusually stable weather as the reason for the accelerated schedule, though crevasses remain a serious hazard.</p>
</div>
<div class="post-continued">
<p>By Wednesday the team had fixed ropes to Camp II, and the summit attempt is now planned for the weekend weather window.</p>
</div>
<div class="comments-section"><p>User1 says great article! User2 agrees completely with everything written here today.</p></div>
</body></html>`

/** Div-soup article: no paragraphs, but a real <article> wrapper. */
const DIV_SOUP_PAGE = `<!DOCTYPE html><html><body>
<nav>Home | Sections | Search</nav>
<article>
<div class="lede">Scientists have confirmed the discovery of a new exoplanet orbiting a nearby star, a finding that could reshape our understanding of planetary formation.</div>
<div class="body-text">The planet, roughly twice the size of Earth, sits in the habitable zone where liquid water could exist on the surface under the right atmospheric conditions.</div>
<div class="body-text">Follow-up observations are planned for next year using the orbital telescope array, with results expected to take months to analyze fully.</div>
</article>
</body></html>`

describe("extractMainContent — article pages", () => {
  it("extracts the article and drops nav, cookie banner, sidebar, footer", () => {
    const { text, mainContent } = extractMainContent(ARTICLE_PAGE)
    expect(mainContent).toBe(true)
    expect(text).toContain("low-pressure system moving in from the west")
    expect(text).toContain("Rainfall totals are forecast")
    expect(text).toContain("slick roads during the Saturday morning commute")
    expect(text).not.toContain("WeatherHub")
    expect(text).not.toContain("We use cookies")
    expect(text).not.toContain("RainAway umbrella")
    expect(text).not.toContain("Copyright 2026")
    expect(text).not.toContain("Privacy policy")
  })

  it("length alone does not let a long sidebar win", () => {
    const { text, mainContent } = extractMainContent(LONG_SIDEBAR_PAGE)
    expect(mainContent).toBe(true)
    expect(text).toContain("city council voted Tuesday")
    expect(text).not.toContain("newsletter")
    expect(text).not.toContain("premium subscription")
  })

  it("keeps a node matching both unlikely and maybe-content patterns", () => {
    const html = `<html><body>
      <div class="article-sidebar"><p>The retrieval team published its findings after a three-year longitudinal study of urban heat islands and their effect on night-time temperatures.</p></div>
      <div class="sidebar"><p>Advertisement: click here now.</p></div>
    </body></html>`
    const { text, mainContent } = extractMainContent(html)
    expect(mainContent).toBe(true)
    expect(text).toContain("longitudinal study")
  })

  it("includes high-scoring siblings of the winning container", () => {
    const { text, mainContent } = extractMainContent(SPLIT_ARTICLE_PAGE)
    expect(mainContent).toBe(true)
    expect(text).toContain("reached base camp")
    expect(text).toContain("summit attempt is now planned")
  })

  it("falls back to the longest <article> on div-soup pages", () => {
    const { text, mainContent } = extractMainContent(DIV_SOUP_PAGE)
    expect(mainContent).toBe(true)
    expect(text).toContain("new exoplanet")
    expect(text).toContain("habitable zone")
    expect(text).not.toContain("Home | Sections | Search")
  })

  it("decodes entities in extracted text", () => {
    const { text } = extractMainContent(
      `<html><body><article><p>Fish &amp; chips cost &pound;5 &#8212; a bargain, really, for the discerning diner.</p><p>More text here to pass the length bar for the article scoring pass to accept it.</p></article></body></html>`,
    )
    expect(text).toContain("Fish & chips")
    expect(text).not.toContain("&amp;")
  })

  it("tolerates malformed markup without throwing", () => {
    const { text, mainContent } = extractMainContent(
      `<html><body><article><p>Unclosed paragraph<div>Nested <b>bold<p>Second paragraph with enough text to score as real article content here, describing the events of the day in full detail for the benefit of the reader.</div></article>`,
    )
    expect(mainContent).toBe(true)
    expect(text).toContain("Second paragraph")
  })
})

describe("extractMainContent — honest fallback", () => {
  it("returns mainContent:false on a JS shell", () => {
    expect(extractMainContent(JS_SHELL_PAGE)).toEqual({ text: "", mainContent: false })
  })

  it("returns mainContent:false on a link farm", () => {
    expect(extractMainContent(LINK_FARM_PAGE)).toEqual({ text: "", mainContent: false })
  })

  it("returns mainContent:false when the article is too short to trust", () => {
    expect(extractMainContent(`<html><body><article><p>Hi.</p></article></body></html>`)).toEqual({
      text: "",
      mainContent: false,
    })
  })
})

describe("isJsShell", () => {
  it("detects script-heavy pages with almost no visible text", () => {
    expect(isJsShell(JS_SHELL_PAGE)).toBe(true)
  })

  it("does not flag real article pages", () => {
    expect(isJsShell(ARTICLE_PAGE)).toBe(false)
  })

  it("does not flag pages with substantial visible text", () => {
    expect(isJsShell(`<html><body><p>${"word ".repeat(200)}</p></body></html>`)).toBe(false)
  })
})

describe("extractMainText", () => {
  it("returns main content with the flag set", () => {
    const { text, mainContent } = extractMainText(ARTICLE_PAGE)
    expect(mainContent).toBe(true)
    expect(text).toContain("low-pressure system")
    expect(text).not.toContain("We use cookies")
  })

  it("falls back to full-page text with the flag unset", () => {
    const { text, mainContent } = extractMainText(LINK_FARM_PAGE)
    expect(mainContent).toBe(false)
    expect(text).toContain("Alpha")
  })
})

describe("fetchSource with readability", () => {
  const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff as Effect.Effect<A, E>)
  const RESULT_HOSTS = new Set(["example.com"])

  it("marks mainContent:true on article pages", async () => {
    const http = { request: makeFixtureHandler(new Map([["https://example.com/wx", ok(ARTICLE_PAGE)]])) }
    const src = await run(fetchSource({ http }, "https://example.com/wx", RESULT_HOSTS))
    expect(src.mainContent).toBe(true)
    expect(src.text).toContain("low-pressure system")
    expect(src.text).not.toContain("We use cookies")
  })

  it("fails honestly with a JS-shell reason on script-heavy pages", async () => {
    const http = { request: makeFixtureHandler(new Map([["https://example.com/app", ok(JS_SHELL_PAGE)]])) }
    const err = await run(fetchSource({ http }, "https://example.com/app", RESULT_HOSTS).pipe(Effect.flip))
    expect(err).toBeInstanceOf(FetchError)
    expect((err as FetchError).reason).toContain("require JavaScript")
  })
})
