// Diagnostic capture server: log the exact headers+body a real opencode CLI
// sends, then return a harmless SSE stream so the CLI exits quickly.
//
// Usage (the README troubleshooting playbook, step 2):
//   1. bun run scripts/capture-server.ts
//   2. point the CLI at it, e.g.
//        OPENCODE_BASE_URL=http://127.0.0.1:8787 opencode run "say hi"
//      (or configure the opencode provider baseURL in opencode.json)
//   3. read /tmp/oc-capture.json — headers + body of the real request
//
// Zero-dependency node:http so `bun run typecheck` stays green without
// installing Bun type definitions.
import * as fs from "node:fs"
import * as http from "node:http"

const PORT = 8787

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", (chunk: Buffer) => chunks.push(chunk))
  req.on("end", () => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v)
    const body = Buffer.concat(chunks).toString("utf8")
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.url,
      headers,
      body,
    }
    console.log(`=== CAPTURED ${req.method} ${req.url} ===`)
    console.log(JSON.stringify(entry, null, 2))
    fs.writeFileSync("/tmp/oc-capture.json", JSON.stringify(entry, null, 2))
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(
      'data: {"type":"response.output_text.delta","delta":"captured"}\n\n' +
        'data: {"type":"response.completed","response":{}}\n\n' +
        "data: [DONE]\n\n",
    )
  })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`capture server listening on http://127.0.0.1:${PORT}`)
})
