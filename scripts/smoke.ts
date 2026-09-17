// Real end-to-end smoke test against opencode zen (network required).
// Usage: bun run smoke
//
// Verifies the full pipeline with the opencode client fingerprint headers:
// auth -> lower -> POST https://opencode.ai/zen/v1/responses -> raise.
// Runs both the aggregated (stream:false) and SSE (stream:true) paths.

import { handleChatRequest } from "../api/chat"

const ENV = { PROXY_API_KEY: process.env.PROXY_API_KEY ?? "smoke-key" }

function post(body: unknown): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ENV.PROXY_API_KEY}` },
    body: JSON.stringify(body),
  })
}

async function nonStreaming() {
  console.log("POST /v1/chat/completions (stream:false) ...")
  const res = await handleChatRequest(
    post({ stream: false, messages: [{ role: "user", content: "Reply with the single word: pong" }] }),
    ENV,
  )
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    error?: { message?: string }
    usage?: { total_tokens?: number }
  }
  if (res.status !== 200) {
    console.error(`FAIL status=${res.status}`)
    console.error(JSON.stringify(body, null, 2))
    process.exit(1)
  }
  const content = body.choices?.[0]?.message?.content ?? ""
  console.log(`status=200 finish=${body.choices?.[0]?.finish_reason} usage=${body.usage?.total_tokens ?? "?"}t`)
  console.log(`content: ${content.slice(0, 120)}`)
  if (content.length === 0) {
    console.error("FAIL: empty content")
    process.exit(1)
  }
}

async function streaming() {
  console.log("POST /v1/chat/completions (stream:true) ...")
  const res = await handleChatRequest(
    post({ stream: true, messages: [{ role: "user", content: "Reply with the single word: pong" }] }),
    ENV,
  )
  if (res.status !== 200) {
    console.error(`FAIL status=${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  const text = await res.text()
  const deltas: string[] = []
  let sawDone = false
  let sawError = false
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6).trim()
    if (data === "[DONE]") {
      sawDone = true
      continue
    }
    try {
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>
      }
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) deltas.push(delta)
      if (chunk.choices?.[0]?.delta?.content?.includes("upstream error")) sawError = true
    } catch {
      // heartbeat comments etc.
    }
  }
  const content = deltas.join("")
  console.log(`status=200 sse_done=${sawDone} chunks=${deltas.length}`)
  console.log(`content: ${content.slice(0, 120)}`)
  if (!sawDone || sawError || content.length === 0) {
    console.error(`FAIL: done=${sawDone} error_chunk=${sawError} content_len=${content.length}`)
    process.exit(1)
  }
}

await nonStreaming()
await streaming()
console.log("SMOKE OK")
