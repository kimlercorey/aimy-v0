/**
 * desktop/smoke/stub-server.mjs — a tiny OpenAI-compatible stub model server
 * for the M10 Linux smoke test.
 *
 * Serves POST /v1/chat/completions on 127.0.0.1:18000:
 * - `stream: true` → SSE `data:` chunks shaped exactly like the real
 *   LocalHttpProvider parser expects (`choices[0].delta.content`), then
 *   `data: [DONE]`.
 * - otherwise → a single JSON completion with prompt/completion usage.
 *
 * Every request is logged to `requests` (exported) so the smoke run can
 * assert the app ONLY talked to the configured model endpoint.
 */
import * as http from "node:http"

export const STUB_PORT = 18000
export const STUB_HOST = "127.0.0.1"
export const STUB_URL = `http://${STUB_HOST}:${STUB_PORT}`

const CANNED_TEXT =
  "Hello from the smoke stub — the packaged AImy app streams end-to-end through the real engine."

/** Split into a few chunks so the renderer exercises multi-token streaming. */
const CHUNKS = [
  "Hello from the smoke stub — ",
  "the packaged AImy app streams ",
  "end-to-end through the real engine."
]

export const requests = []

const sseChunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

export const createStubServer = () =>
  http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${STUB_HOST}:${STUB_PORT}`)
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      requests.push({ method: req.method, path: url.pathname, at: new Date().toISOString() })
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      let stream = false
      try {
        stream = Boolean(JSON.parse(body || "{}").stream)
      } catch {
        stream = false
      }
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        })
        for (const content of CHUNKS) res.write(sseChunk(content))
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: CANNED_TEXT } }],
          usage: { prompt_tokens: 12, completion_tokens: 24 }
        })
      )
    })
  })

export const startStubServer = () =>
  new Promise((resolve, reject) => {
    const server = createStubServer()
    server.once("error", reject)
    server.listen(STUB_PORT, STUB_HOST, () => resolve(server))
  })

// Allow `node desktop/smoke/stub-server.mjs` for manual testing.
const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("stub-server.mjs")
if (isMain) {
  const server = await startStubServer()
  console.log(`stub model server listening on ${STUB_URL}`)
  process.on("SIGTERM", () => server.close(() => process.exit(0)))
}
