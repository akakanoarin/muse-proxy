// Replays the exact request shape captured from the real opencode CLI
// (scripts/capture-opencode-cli.ts) to the real zen upstream, once per model,
// so the only variable is the model id. Usage:
//   bun run scripts/probe-cli-shape.ts modelA modelB ...
import { readFileSync } from "fs"

const captured = JSON.parse(readFileSync("/tmp/capture-2.json", "utf8"))
const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["mimo-v2.6-flash-free", "space-bunny-free"]

for (const model of models) {
  const body = { ...captured.body, model }
  const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "*/*",
      "user-agent": captured.headers["user-agent"],
      "x-opencode-session": captured.headers["x-session-affinity"],
      "x-opencode-request": captured.headers["x-session-id"],
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      authorization: "Bearer public",
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    console.log(`[${model}] ${res.status}`, text.slice(0, 180))
    continue
  }
  let out = ""
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue
    try {
      const j = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }
      const delta = j.choices?.[0]?.delta?.content
      if (delta) out += delta
    } catch {}
  }
  console.log(`[${model}] 200 OK text="${out.slice(0, 60)}"`)
}
