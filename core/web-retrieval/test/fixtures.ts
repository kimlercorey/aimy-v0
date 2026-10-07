/**
 * web-retrieval/test/fixtures.ts — offline fixtures. No test in this library
 * opens a socket; the provider parser is pure over these strings and the
 * HTTP layer is mocked.
 */
import type { HttpRequest, HttpResponse } from "../src/http.js"
import { FetchError } from "../src/errors.js"
import { Effect } from "effect"

/** Minimal but structurally faithful DuckDuckGo HTML results page. */
export const DDG_HTML_FIXTURE = `<!DOCTYPE html><html><head><title>test query at DuckDuckGo</title></head>
<body>
<div class="results">
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst&amp;rut=abc">First Result Title</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst">First snippet text with <b>markup</b> inside.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.org/second">Second <em>Result</em> Title</a>
    </h2>
    <a class="result__snippet" href="https://example.org/second">Second snippet &amp; more.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Finsecure.example.net%2Fplain">Insecure Result</a>
    </h2>
  </div>
</div>
</div>
</body></html>`

/** DuckDuckGo "no results" page shape. */
export const DDG_NO_RESULTS_FIXTURE = `<!DOCTYPE html><html><body>
<div class="no-results">No results for that query.</div>
</body></html>`

/** A page whose markup the parser does not recognize at all. */
export const DDG_GARBAGE_FIXTURE = `<!DOCTYPE html><html><body><div class="brand-new-layout">hello</div></body></html>`

/** A source article page with scripts, styles, and entities. */
export const SOURCE_HTML_FIXTURE = `<!DOCTYPE html><html><head>
<title>Example Article &amp; Findings</title>
<script>var x = 1; document.write("invisible");</script>
<style>body { color: red; }</style>
</head>
<body>
<nav>Home | About | Contact</nav>
<article>
<h1>Example Article &amp; Findings</h1>
<p>The quick brown fox jumps over the lazy dog. Retrievalers found that
foxes prefer &quot;lazy&quot; dogs for jumping&#46;</p>
<p>Second paragraph with a <a href="/more">link</a> and more text.</p>
</article>
<footer>Copyright 2026</footer>
</body></html>`

export const SOURCE_TEXT_EXPECTED_FRAGMENTS = [
  "Example Article & Findings",
  "The quick brown fox jumps over the lazy dog.",
  'foxes prefer "lazy" dogs for jumping.',
  "Second paragraph with a link and more text.",
]

export const ok = (body: string, contentType = "text/html"): HttpResponse => ({
  status: 200,
  contentType,
  body,
})

export const notFound: HttpResponse = { status: 404, contentType: "text/html", body: "not found" }

/** Handler answering only the URLs the test wires up; anything else 404s. */
export const makeFixtureHandler = (routes: ReadonlyMap<string, HttpResponse>) =>
  (req: HttpRequest) => {
    const res = routes.get(req.url)
    return res === undefined
      ? Effect.succeed(notFound)
      : Effect.succeed(res)
  }

export const failingHandler = (reason: string) => (_req: HttpRequest) =>
  Effect.fail(new FetchError({ url: "https://html.duckduckgo.com/html/?q=x", reason }))
