// Probe (not part of the test suite): field-faithful long session — tool
// loop + reasoning effort max + FULL-code outputs every turn (the exact
// "超高 + 输出完整代码" pattern from the field report), running until the
// upstream fails or 8 turns complete. Designed to run in the background:
//   PROXY=0 bun run scripts/probe-spacebunny-field.ts   (direct upstream)
//   PROXY=1 bun run scripts/probe-spacebunny-field.ts   (through the proxy)
// Writes progress lines to stdout; the raw SSE tail of a failing turn is
// printed to pinpoint what the edge actually emits mid-conversation.

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"

const THROUGH_PROXY = process.env.PROXY === "1"
const PORT = 8965
const KEY = process.env.PROXY_API_KEY ?? "probe-key"
const MODEL = process.env.PROBE_MODEL ?? "space-bunny-free"
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? 32768)

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

interface Turn {
  status: number
  error: string | null
  content: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  finish: string
  sseTail: string
}

const CLIENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "memory_get",
      description: "Look up stored memory by keywords. Returns matched entries.",
      parameters: {
        type: "object",
        properties: { keywords: { type: "array", items: { type: "string" } } },
        required: ["keywords"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_put",
      description: "Store a memory entry under keywords.",
      parameters: {
        type: "object",
        properties: {
          keywords: { type: "array", items: { type: "string" } },
          content: { type: "string" },
        },
        required: ["keywords", "content"],
      },
    },
  },
]

async function chatTurn(messages: unknown[]): Promise<Turn> {
  const started = Date.now()
  let res: Response
  if (THROUGH_PROXY) {
    res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, stream: true, reasoning_effort: "max", max_tokens: MAX_TOKENS, tools: CLIENT_TOOLS, tool_choice: "auto", messages }),
      signal: AbortSignal.timeout(300_000),
    })
  } else {
    // Direct upstream with the same shapes the proxy sends.
    const time = Date.now().toString(16).slice(-12).padStart(12, "0")
    const rand = Math.random().toString(36).slice(2).padEnd(14, "0").slice(0, 14)
    const chatMessages = (messages as Array<Record<string, unknown>>).map((m) => {
      if (m.role === "user" && Array.isArray(m.content)) {
        return { role: "user", content: (m.content as Array<{ text?: string }>).map((p) => ({ type: "text", text: p.text ?? "" })) }
      }
      if (m.role === "assistant" && Array.isArray(m.content)) {
        return { role: "assistant", content: (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("") }
      }
      return m
    })
    res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer public",
        "content-type": "application/json",
        accept: "*/*",
        "user-agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
        "x-opencode-session": `ses_${time}${rand}`,
        "x-opencode-request": `msg_${time}${rand}`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
      },
      body: JSON.stringify({ model: MODEL, messages: chatMessages, stream: true, stream_options: { include_usage: true }, reasoning_effort: "max", max_tokens: MAX_TOKENS, tools: CLIENT_TOOLS, tool_choice: "auto" }),
      signal: AbortSignal.timeout(300_000),
    })
  }
  if (res.status !== 200) {
    const text = await res.text()
    return { status: res.status, error: text.replace(/\s+/g, " ").slice(0, 400), content: "", reasoning: "", toolCalls: [], finish: "", sseTail: "" }
  }
  const text = await res.text()
  const lines = text.split("\n")
  const turn: Turn = { status: 200, error: null, content: "", reasoning: "", toolCalls: [], finish: "", sseTail: lines.filter((l) => l.startsWith("data:")).slice(-3).join(" ").slice(0, 400) }
  for (const line of lines) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === "[DONE]") continue
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }
          finish_reason?: string | null
        }>
        error?: { message?: string }
      }
      if (chunk.error) turn.error = `in-stream: ${chunk.error.message ?? JSON.stringify(chunk.error).slice(0, 200)}`
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {}
        if (typeof delta.content === "string") turn.content += delta.content
        if (typeof delta.reasoning_content === "string") turn.reasoning += delta.reasoning_content
        if (typeof delta.reasoning === "string") turn.reasoning += delta.reasoning
        for (const call of delta.tool_calls ?? []) {
          if (call.id && call.function?.name) turn.toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? "" })
          else if (call.function?.arguments && turn.toolCalls.length > 0) turn.toolCalls[turn.toolCalls.length - 1]!.arguments += call.function.arguments
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) turn.finish = choice.finish_reason
      }
    } catch {
      turn.error = `unparseable data line: ${line.slice(0, 120)}`
    }
  }
  turn.error = turn.error ?? (turn.finish === "" ? "stream ended without finish_reason" : null)
  console.log(`    [${((Date.now() - started) / 1000).toFixed(1)}s] status=200 finish=${turn.finish || "?"} content=${turn.content.length}ch reasoning=${turn.reasoning.length}ch tools=${turn.toolCalls.length}`)
  return turn
}

async function main(): Promise<void> {
  if (THROUGH_PROXY) await startServer()
  console.log(`=== space-bunny FIELD probe (${THROUGH_PROXY ? "through proxy" : "direct upstream"}, model=${MODEL}, max_tokens=${MAX_TOKENS}) ===`)
  const messages: unknown[] = [
    { role: "system", content: "You are a senior front-end engineer creating single-file HTML pages. Always output the COMPLETE code when asked." },
    { role: "user", content: [{ type: "input_text", text: "先回忆我的设计偏好(memory_get),然后写一个 HTML 页面:企鹅骑自行车的 SVG 动画。" }] },
  ]
  for (let turn = 1; turn <= 8; turn++) {
    console.log(`-- turn ${turn} --`)
    const result = await chatTurn(messages)
    if (result.status !== 200 || result.error !== null) {
      console.log(`  *** FAILURE at turn ${turn}: HTTP ${result.status} ${result.error ?? ""}`)
      if (result.sseTail) console.log(`  sse tail: ${result.sseTail}`)
      break
    }
    if (result.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: [{ type: "output_text", text: result.content }],
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
        tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      })
      for (const call of result.toolCalls) {
        const output = call.name === "memory_get" ? JSON.stringify({ matches: [], note: "no entries found" }) : JSON.stringify({ stored: true })
        messages.push({ role: "tool", tool_call_id: call.id, content: output })
      }
      messages.push({ role: "user", content: [{ type: "input_text", text: "好,现在输出完整 HTML 代码(不要省略)。" }] })
    } else {
      messages.push({ role: "assistant", content: [{ type: "output_text", text: result.content }], ...(result.reasoning ? { reasoning_content: result.reasoning } : {}) })
      messages.push({ role: "user", content: [{ type: "input_text", text: `再改进一版:加上交互控制(第 ${turn} 版)。输出完整代码,不要省略。` }] })
    }
  }
  console.log("field probe finished")
  process.exit(0)
}

await main()
