// Probe (not part of the test suite): two more channels a write-file agent
// uses, run DETERMINISTICALLY through the real proxy chat facade (no reliance
// on model behavior — the tool-call turns are fabricated):
//   1. TOOL RESULT payloads: agents echo the written file back as the tool
//      result (write-then-verify). Sweep result size/encoding.
//   2. REQUEST-LEVEL parameters: temperature/top_p/max_tokens/reasoning_effort/
//      tool_choice variants/stream:false — everything an agent SDK might set.
//   bun run scripts/probe-spacebunny-toolresult-params.ts
//   MODEL=mimo-v2.6-flash-free bun run ...   (control)
//   ONLY=result / ONLY=params bun run ...    (one suite)

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"

const PORT = 8971
const KEY = process.env.PROXY_API_KEY ?? "probe-key"
const MODEL = process.env.MODEL ?? "space-bunny-free"
const ONLY = process.env.ONLY

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const forwardHeaders: Record<string, string> = {}
      for (const [headerKey, value] of Object.entries(req.headers)) {
        if (typeof value === "string") forwardHeaders[headerKey] = value
      }
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: forwardHeaders,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      })
      const response = await handleChatRequest(request, { PROXY_API_KEY: KEY })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, headerKey) => {
        headers[headerKey] = value
      })
      res.writeHead(response.status, headers)
      if (response.body) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    })
    server.listen(PORT, "127.0.0.1", () => resolve())
  })
}

function htmlDoc(target: number): string {
  const head = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>鹈鹕骑自行车 SVG 动画</title>
<style>.wheel{animation:spin 1.4s linear infinite}.pelican{animation:bob .8s ease-in-out infinite alternate}@keyframes spin{to{transform:rotate(360deg)}}@keyframes bob{to{transform:translateY(-8px)}}</style></head>
<body><svg viewBox="0 0 720 480"><g class="pelican"><ellipse cx="360" cy="230" rx="52" ry="64" fill="#4a5568"/><path d="M 360 170 Q 430 178 436 196 Q 400 206 358 188 Z" fill="#f6ad55"/></g>
<g class="wheel"><circle cx="268" cy="330" r="58" fill="none" stroke="#2d3748" stroke-width="7"/></g></svg></body></html>`
  const blocks: string[] = [head]
  let total = head.length
  let i = 0
  while (total < target) {
    i++
    const block = `\n<!-- 变体 ${i}: 车轮半径 ${40 + (i % 12)}px, 背景色 #%${(i * 7) % 255},${(i * 13) % 255},${(i * 29) % 255}, 动画 ${(0.6 + (i % 9) / 10).toFixed(1)}s -->\n<div class="note">设计说明 ${i}:保持语义化结构与可访问性,尊重 prefers-reduced-motion。</div>`
    blocks.push(block)
    total += block.length
  }
  return blocks.join("")
}

const WRITE_TOOL = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write content to a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
}

interface Turn {
  status: number
  httpError: string | null
  content: string
  finish: string | null
  inStreamError: string | null
  sawDone: boolean
}

async function chatTurn(body: Record<string, unknown>): Promise<Turn> {
  const turn: Turn = { status: 0, httpError: null, content: "", finish: null, inStreamError: null, sawDone: false }
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  turn.status = res.status
  if (res.status !== 200) {
    turn.httpError = (await res.text()).replace(/\s+/g, " ").slice(0, 300)
    return turn
  }
  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    // Aggregated JSON answer.
    try {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>
        error?: { message?: string }
      }
      if (json.error) turn.inStreamError = json.error.message ?? null
      turn.content = json.choices?.[0]?.message?.content ?? ""
      turn.finish = json.choices?.[0]?.finish_reason ?? null
      turn.sawDone = true
    } catch {
      turn.inStreamError = "non-JSON non-SSE response"
    }
    return turn
  }
  const text = await res.text()
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0) continue
    if (payload === "[DONE]") {
      turn.sawDone = true
      continue
    }
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
        error?: { message?: string }
      }
      if (chunk.error) turn.inStreamError = chunk.error.message ?? JSON.stringify(chunk.error)
      for (const choice of chunk.choices ?? []) {
        if (typeof choice.delta?.content === "string") turn.content += choice.delta.content
        if (typeof choice.finish_reason === "string" && choice.finish_reason) turn.finish = choice.finish_reason
      }
    } catch {
      turn.inStreamError = `unparseable: ${line.slice(0, 80)}`
    }
  }
  return turn
}

function report(label: string, turn: Turn): boolean {
  const problems: string[] = []
  if (turn.httpError) problems.push(`HTTP ${turn.status}: ${turn.httpError}`)
  if (turn.inStreamError) problems.push(`in-stream: ${turn.inStreamError}`)
  if (!turn.sawDone) problems.push("no [DONE]")
  if (turn.content.includes("[muse-proxy upstream error]")) problems.push("upstream error notice in content")
  const ok = problems.length === 0
  console.log(`  ${label}: ${ok ? "OK" : "FAIL"} finish=${turn.finish ?? "?"} out=${turn.content.length}ch`)
  for (const p of problems) console.log(`    !! ${p}`)
  return ok
}

// Fabricated assistant write_file turn with the given content payload.
function writeCallMessages(doc: string): { messages: unknown[]; callId: string } {
  const callId = `call_${Math.random().toString(36).slice(2, 10)}`
  return {
    callId,
    messages: [
      { role: "system", content: "You are a coding agent that writes files via tools." },
      { role: "user", content: "创建 pelican-bike.html:实现一个鹈鹕骑自行车的 SVG 动画。" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: callId, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "pelican-bike.html", content: doc }) } }],
      },
    ],
  }
}

async function suiteToolResult(): Promise<void> {
  console.log(`[tool-result sweep] model=${MODEL}`)
  const doc12 = htmlDoc(12_000)
  const doc40 = htmlDoc(40_000)
  const cases: Array<{ name: string; result: (doc: string) => string; doc: string }> = [
    { name: "result=short ok", doc: doc12, result: () => "ok" },
    { name: "result=full doc 12k (echo)", doc: doc12, result: (d) => d },
    { name: "result=full doc 40k (echo)", doc: doc40, result: (d) => d },
    { name: "result=JSON-wrapped 40k", doc: doc40, result: (d) => JSON.stringify({ ok: true, path: "pelican-bike.html", content: d }) },
    { name: "result=CRLF-normalized 12k", doc: doc12, result: (d) => d.replace(/\n/g, "\r\n") },
    { name: "result=base64 12k", doc: doc12, result: (d) => Buffer.from(d, "utf8").toString("base64") },
  ]
  let failed = 0
  for (const c of cases) {
    const { messages, callId } = writeCallMessages(c.doc)
    messages.push({ role: "tool", tool_call_id: callId, content: c.result(c.doc) })
    messages.push({ role: "user", content: "文件已写入。用一句话确认,不要输出代码。" })
    const turn = await chatTurn({ model: MODEL, stream: true, messages, tools: [WRITE_TOOL], tool_choice: "auto" })
    if (!report(c.name, turn)) failed++
  }
  console.log(`tool-result sweep: ${failed === 0 ? "ALL CLEAN" : `${failed} failing`}`)
}

async function suiteRequestParams(): Promise<void> {
  console.log(`[request-param matrix] model=${MODEL}`)
  const baseMessages = [{ role: "user", content: "用 30 字介绍鹈鹕,不要输出代码。" }]
  const bodies: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: "plain stream:true", body: { model: MODEL, stream: true, messages: baseMessages } },
    { name: "stream:false", body: { model: MODEL, stream: false, messages: baseMessages } },
    { name: "temperature=2 top_p=0.01", body: { model: MODEL, stream: true, messages: baseMessages, temperature: 2, top_p: 0.01 } },
    { name: "max_tokens=1", body: { model: MODEL, stream: true, messages: baseMessages, max_tokens: 1 } },
    { name: "max_tokens=32768", body: { model: MODEL, stream: true, messages: baseMessages, max_tokens: 32_768 } },
    { name: "max_completion_tokens=500", body: { model: MODEL, stream: true, messages: baseMessages, max_completion_tokens: 500 } },
    { name: "reasoning_effort=minimal", body: { model: MODEL, stream: true, messages: baseMessages, reasoning_effort: "minimal" } },
    { name: "reasoning_effort=max", body: { model: MODEL, stream: true, messages: baseMessages, reasoning_effort: "max" } },
    { name: "reasoning_effort=none (clamps)", body: { model: MODEL, stream: true, messages: baseMessages, reasoning_effort: "none" } },
    { name: "reasoning={effort:high}", body: { model: MODEL, stream: true, messages: baseMessages, reasoning: { effort: "high" } } },
    { name: "tool_choice=required", body: { model: MODEL, stream: true, messages: baseMessages, tools: [WRITE_TOOL], tool_choice: "required" } },
    { name: "tool_choice=none", body: { model: MODEL, stream: true, messages: baseMessages, tools: [WRITE_TOOL], tool_choice: "none" } },
    { name: "tool_choice=named write_file", body: { model: MODEL, stream: true, messages: baseMessages, tools: [WRITE_TOOL], tool_choice: { type: "function", function: { name: "write_file" } } } },
    { name: "parallel_tool_calls=true", body: { model: MODEL, stream: true, messages: baseMessages, tools: [WRITE_TOOL], tool_choice: "auto", parallel_tool_calls: true } },
    { name: "response_format=json_object (ignored?)", body: { model: MODEL, stream: true, messages: baseMessages, response_format: { type: "json_object" } } },
    { name: "seed/n/penalties present", body: { model: MODEL, stream: true, messages: baseMessages, seed: 42, n: 1, presence_penalty: 0.5, frequency_penalty: 0.5 } },
    { name: "stop=[endoftext]", body: { model: MODEL, stream: true, messages: baseMessages, stop: ["<|endoftext|>"] } },
  ]
  let failed = 0
  for (const c of bodies) {
    const turn = await chatTurn(c.body)
    if (!report(c.name, turn)) failed++
  }
  console.log(`request-param matrix: ${failed === 0 ? "ALL CLEAN" : `${failed} failing`}`)
}

async function main(): Promise<void> {
  await startServer()
  console.log(`=== tool-result + request-param probes (${MODEL}) ===`)
  if (!ONLY || ONLY === "result") await suiteToolResult()
  if (!ONLY || ONLY === "params") await suiteRequestParams()
  console.log("probes finished")
  process.exit(0)
}

await main()
