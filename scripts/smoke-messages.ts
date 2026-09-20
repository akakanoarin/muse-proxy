// Real end-to-end smoke for the Anthropic Messages facade (POST /v1/messages)
// against the real opencode zen upstream (network required).
// Usage: bun run smoke:messages
//
// Starts a real local HTTP server dispatching to handleMessagesRequest
// (auth -> lower -> fingerprinted upstream call -> Anthropic SSE or
// aggregation), then exercises every feature over the wire:
//   1. API key auth (wrong x-api-key -> 401, same PROXY_API_KEY contract)
//   2. non-streaming simple chat (aggregated message object + usage)
//   3. streaming + system prompt (canonical Anthropic SSE event sequence)
//   4. large streaming generation (many text deltas, long output)
//   5. xhigh thinking (thinking_delta + correct answer)
//   6. client tool loop (tool_use -> tool_result round-trip)
//   7. multi-turn memory (content blocks replayed into messages)
//   8. coexistence regression: /v1/chat/completions and /v1/responses keep
//      working on the same server

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"
import { handleResponsesRequest } from "../api/responses"
import { handleMessagesRequest } from "../api/messages"

const PORT = 8908
const KEY = process.env.PROXY_API_KEY ?? "smoke-key"
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
const failures: string[] = []

function ok(name: string, detail = ""): void {
  passed++
  console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`)
}
function bad(name: string, detail = ""): void {
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}
function expect(condition: boolean, name: string, detail = ""): void {
  if (condition) ok(name, detail)
  else bad(name, detail)
}

interface SseEvent {
  type: string
  data: Record<string, unknown>
}

async function readSseEvents(res: Response): Promise<SseEvent[]> {
  const text = await res.text()
  const events: SseEvent[] = []
  for (const block of text.split("\n\n")) {
    let type = ""
    let data = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) type = line.slice(7).trim()
      else if (line.startsWith("data: ")) data += line.slice(6)
    }
    if (data.length === 0) continue // heartbeat comments etc.
    try {
      events.push({ type, data: JSON.parse(data) as Record<string, unknown> })
    } catch {
      // ignore malformed frames
    }
  }
  return events
}

function textFrom(events: SseEvent[]): string {
  return events
    .filter((e) => e.type === "content_block_delta" && (e.data as { delta?: { type?: string; text?: string } }).delta?.type === "text_delta")
    .map((e) => (e.data as { delta: { text: string } }).delta.text)
    .join("")
}

function thinkingFrom(events: SseEvent[]): string {
  return events
    .filter((e) => e.type === "content_block_delta" && (e.data as { delta?: { type?: string; thinking?: string } }).delta?.type === "thinking_delta")
    .map((e) => (e.data as { delta: { thinking: string } }).delta.thinking)
    .join("")
}

async function postMessages(body: unknown, key: string = KEY, timeoutMs = 180_000): Promise<Response> {
  return fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

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
      const response = req.url === "/v1/responses"
        ? await handleResponsesRequest(request, { PROXY_API_KEY: KEY })
        : req.url === "/v1/messages"
          ? await handleMessagesRequest(request, { PROXY_API_KEY: KEY })
          : await handleChatRequest(request, { PROXY_API_KEY: KEY })
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

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function task1Auth(): Promise<void> {
  console.log("\n[1/8] API key auth (same PROXY_API_KEY contract, x-api-key header)")
  try {
    const wrong = await postMessages({ max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, "totally-wrong-key", 30_000)
    const body = (await wrong.json()) as { type?: string; error?: { type?: string } }
    expect(wrong.status === 401, "wrong key rejected with 401", `status=${wrong.status}`)
    expect(body.type === "error" && body.error?.type === "authentication_error", "Anthropic error envelope", JSON.stringify(body).slice(0, 80))
  } catch (error) {
    bad("auth task crashed", String(error))
  }
}

async function task2NonStreaming(): Promise<void> {
  console.log("\n[2/8] non-streaming simple chat (aggregated message object)")
  try {
    const res = await postMessages({
      model: "claude-anything",
      max_tokens: 256,
      messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
    })
    expect(res.status === 200, "HTTP 200", `status=${res.status}`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.type === "message", 'type === "message"')
    expect(body.role === "assistant", 'role === "assistant"')
    expect(typeof body.id === "string" && String(body.id).startsWith("msg_"), "message id present", String(body.id))
    expect(body.stop_reason === "end_turn", "stop_reason end_turn", String(body.stop_reason))
    const content = body.content as Array<{ type: string; text?: string }>
    const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
    expect(text.includes("4"), "content text answers 4", text.slice(0, 60))
    const usage = body.usage as { input_tokens?: number; output_tokens?: number }
    expect((usage?.input_tokens ?? 0) > 0, "usage tokens reported", JSON.stringify(usage))
  } catch (error) {
    bad("non-streaming task crashed", String(error))
  }
}

async function task3StreamingSystem(): Promise<void> {
  console.log("\n[3/8] streaming + system prompt (canonical Anthropic SSE sequence)")
  try {
    const res = await postMessages({
      // Generous budget: reasoning tokens count against max_tokens upstream,
      // and a too-small budget turns the reply into a max_tokens truncation.
      max_tokens: 2048,
      system: "必须用英文回答,且只回答一句话,不要超过 20 个单词。",
      messages: [{ role: "user", content: "用一句话介绍你自己" }],
      stream: true,
    })
    expect(res.status === 200, "HTTP 200", `status=${res.status}`)
    expect((res.headers.get("content-type") ?? "").includes("text/event-stream"), "content-type is text/event-stream")

    const events = await readSseEvents(res)
    const types = events.map((e) => e.type)
    expect(events.length > 0, "SSE events received", `count=${events.length}`)
    expect(types[0] === "message_start", "first event is message_start", types[0])
    expect(types.at(-1) === "message_stop", "last event is message_stop", types.at(-1))
    expect(types.includes("message_delta"), "message_delta present (stop_reason + usage)")
    expect(!types.includes("ping"), "upstream ping frames filtered")

    const text = textFrom(events)
    expect(text.length > 0, "text deltas arrived", `${text.length} chars`)
    expect(!/[\u4e00-\u9fff]/.test(text), "system honored (English answer)", text.slice(0, 80))

    const messageDelta = events.find((e) => e.type === "message_delta")
    const usage = (messageDelta?.data as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage
    expect((usage?.input_tokens ?? 0) > 0, "usage in message_delta", JSON.stringify(usage))
    const stopReason = (messageDelta?.data as { delta?: { stop_reason?: string } } | undefined)?.delta?.stop_reason
    expect(stopReason === "end_turn", "stop_reason end_turn in message_delta", String(stopReason))
  } catch (error) {
    bad("streaming task crashed", String(error))
  }
}

const SNAKE_PROMPT =
  "Write a complete single-file Snake game in plain HTML+CSS+JavaScript. Output ONLY the code inside one ```html code block. The game must include: canvas rendering, keyboard controls, food spawning, score display, and game-over handling. Aim for at least 150 lines of code."

async function task4LargeStreaming(): Promise<void> {
  console.log("\n[4/8] large streaming generation (long code output over Anthropic SSE)")
  // The free tier occasionally truncates mid-generation (EOF without
  // message_stop); the proxy surfaces that as an error event. Retry until a
  // clean terminal event arrives (max 3 attempts) and judge that attempt.
  try {
    let events: SseEvent[] = []
    let text = ""
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await postMessages({ max_tokens: 8000, messages: [{ role: "user", content: SNAKE_PROMPT }], stream: true })
      expect(res.status === 200, "HTTP 200", `status=${res.status}`)
      events = await readSseEvents(res)
      text = textFrom(events)
      const last = events.at(-1)?.type ?? ""
      console.log(`    attempt ${attempt}: ${text.length} chars, last event: ${last}`)
      if (last === "message_stop") break
    }
    const deltas = events.filter(
      (e) => e.type === "content_block_delta" && (e.data as { delta?: { type?: string } }).delta?.type === "text_delta",
    )
    expect(text.length > 2000, "long output aggregated", `${text.length} chars`)
    expect(deltas.length > 15, "many streaming deltas", `${deltas.length} deltas`)
    expect(text.includes("canvas") || text.includes("Canvas"), "content looks like the snake game", "")
    expect(events.at(-1)?.type === "message_stop", "stream completed cleanly (message_stop)", events.at(-1)?.type)
    console.log(`    first 100 chars: ${text.slice(0, 100).replace(/\n/g, " ")}`)
  } catch (error) {
    bad("large streaming task crashed", String(error))
  }
}

async function task5XhighThinking(): Promise<void> {
  console.log("\n[5/8] xhigh thinking (thinking_delta + correct answer)")
  // Thinking summary streaming is best-effort upstream; retry until observed.
  try {
    let text = ""
    let thinking = ""
    let last = ""
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await postMessages({
        max_tokens: 8000,
        thinking: { type: "enabled", budget_tokens: 32768 },
        messages: [{ role: "user", content: "What is 17 * 23? Work it out step by step, then answer with just the number." }],
        stream: true,
      })
      expect(res.status === 200, "HTTP 200", `status=${res.status}`)
      const events = await readSseEvents(res)
      thinking = thinkingFrom(events)
      text = textFrom(events)
      last = events.at(-1)?.type ?? ""
      console.log(`    attempt ${attempt}: ${thinking.length} chars of thinking, answer starts: ${text.slice(0, 20).replace(/\n/g, " ")}`)
      if (thinking.length > 0) break
    }
    expect(thinking.length > 0, "thinking deltas streamed", `${thinking.length} chars`)
    console.log(`    thinking (first 120 chars): ${thinking.slice(0, 120).replace(/\n/g, " ")}`)
    expect(text.includes("391"), "final answer is 391", text.slice(0, 80))
    expect(last === "message_stop", "stream completed cleanly", last)
  } catch (error) {
    bad("xhigh thinking task crashed", String(error))
  }
}

interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

function toolUseOf(body: Record<string, unknown>): ToolUseBlock | undefined {
  const content = (body.content as Array<Record<string, unknown>> | undefined) ?? []
  return content.find((block) => block.type === "tool_use") as ToolUseBlock | undefined
}

async function task6ToolLoop(): Promise<void> {
  console.log("\n[6/8] client tool loop (tool_use -> tool_result round-trip)")
  try {
    const tools = [
      {
        name: "get_weather",
        description: "Query the current weather of a city.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string", description: "city name" } },
          required: ["city"],
        },
      },
    ]

    const turn1Body = { max_tokens: 2048, messages: [{ role: "user", content: "北京今天天气怎么样?你必须调用 get_weather 工具查询,禁止自己编造天气。" }], tools }
    let turn1: Record<string, unknown> | undefined
    for (let attempt = 1; attempt <= 3 && !turn1; attempt++) {
      const turn1Res = await postMessages(turn1Body)
      if (turn1Res.status === 200) {
        turn1 = (await turn1Res.json()) as Record<string, unknown>
        break
      }
      console.log(`    turn1 attempt ${attempt}: HTTP ${turn1Res.status} — ${(await turn1Res.text()).slice(0, 200)}`)
    }
    expect(turn1 !== undefined, "turn1 HTTP 200")
    if (!turn1) return
    const call = toolUseOf(turn1)
    expect(call !== undefined, "turn1 produced a tool_use block", JSON.stringify((turn1.content as Array<{ type: string }>)?.map((b) => b.type)))
    if (!call) return
    expect(call.name === "get_weather", "tool name is get_weather", String(call.name))
    expect(typeof call.id === "string" && call.id.length > 0, "tool_use id present", String(call.id))
    console.log(`    input: ${JSON.stringify(call.input)}`)

    const turn2Body = {
      max_tokens: 2048,
      messages: [
        { role: "user", content: "北京今天天气怎么样?你必须调用 get_weather 工具查询,禁止自己编造天气。" },
        { role: "assistant", content: [call as unknown as Record<string, unknown>] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "北京今天晴,26°C,微风" }] },
      ],
      tools,
    }
    let turn2: Record<string, unknown> | undefined
    for (let attempt = 1; attempt <= 3 && !turn2; attempt++) {
      const turn2Res = await postMessages(turn2Body)
      if (turn2Res.status === 200) {
        turn2 = (await turn2Res.json()) as Record<string, unknown>
        break
      }
      console.log(`    turn2 attempt ${attempt}: HTTP ${turn2Res.status} — ${(await turn2Res.text()).slice(0, 200)}`)
    }
    expect(turn2 !== undefined, "turn2 HTTP 200")
    if (!turn2) return
    const content = turn2.content as Array<{ type: string; text?: string }>
    const answer = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
    expect(answer.includes("26") || answer.includes("晴"), "turn2 answer uses the tool result", answer.slice(0, 100))
  } catch (error) {
    bad("tool loop task crashed", String(error))
  }
}

async function task7Memory(): Promise<void> {
  console.log("\n[7/8] multi-turn memory (content blocks replayed into messages)")
  try {
    // Generous budget: reasoning tokens count against max_tokens upstream, and
    // a tiny budget can burn the whole reply on reasoning (zero text deltas).
    // The free tier also occasionally truncates mid-generation (502 from the
    // proxy); retry until a clean 200 arrives (max 3 attempts), like the
    // other flake-tolerant tasks.
    const turn1Body = { max_tokens: 2048, messages: [{ role: "user", content: "请记住暗号:蓝鲸计划。只回复四个字:已记住暗号。" }] }
    let turn1: { content: Array<Record<string, unknown>> } | undefined
    for (let attempt = 1; attempt <= 3 && !turn1; attempt++) {
      const turn1Res = await postMessages(turn1Body)
      if (turn1Res.status === 200) {
        turn1 = (await turn1Res.json()) as { content: Array<Record<string, unknown>> }
        break
      }
      console.log(`    turn1 attempt ${attempt}: HTTP ${turn1Res.status} — ${(await turn1Res.text()).slice(0, 200)}`)
    }
    expect(turn1 !== undefined, "turn1 HTTP 200")
    if (!turn1) return
    expect(
      turn1.content.some((block) => block.type === "text"),
      "turn1 output has a text block",
      JSON.stringify(turn1.content.map((block) => block.type)),
    )

    const turn2Body = {
      max_tokens: 2048,
      messages: [
        { role: "user", content: "请记住暗号:蓝鲸计划。只回复四个字:已记住暗号。" },
        { role: "assistant", content: turn1.content },
        { role: "user", content: "暗号是什么?只回答暗号内容。" },
      ],
    }
    let turn2: { content: Array<{ type: string; text?: string }> } | undefined
    for (let attempt = 1; attempt <= 3 && !turn2; attempt++) {
      const turn2Res = await postMessages(turn2Body)
      if (turn2Res.status === 200) {
        turn2 = (await turn2Res.json()) as { content: Array<{ type: string; text?: string }> }
        break
      }
      console.log(`    turn2 attempt ${attempt}: HTTP ${turn2Res.status} — ${(await turn2Res.text()).slice(0, 200)}`)
    }
    expect(turn2 !== undefined, "turn2 HTTP 200")
    if (!turn2) return
    const answer = turn2.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
    expect(answer.includes("蓝鲸"), "turn2 remembers the passphrase", answer.slice(0, 60))
  } catch (error) {
    bad("memory task crashed", String(error))
  }
}

async function task8Coexistence(): Promise<void> {
  console.log("\n[8/8] coexistence regression (chat completions + responses on the same server)")
  try {
    const chatRes = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: "anything",
        messages: [{ role: "user", content: "What is 5+5? Reply with just the number." }],
      }),
      signal: AbortSignal.timeout(120_000),
    })
    expect(chatRes.status === 200, "chat completions HTTP 200", `status=${chatRes.status}`)
    const chat = (await chatRes.json()) as { object?: string; choices?: Array<{ message?: { content?: string } }> }
    expect(chat.object === "chat.completion", "chat object shape intact")
    expect(chat.choices?.[0]?.message?.content?.includes("10") ?? false, "chat answers 10", String(chat.choices?.[0]?.message?.content).slice(0, 40))

    const responsesRes = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ input: "What is 6+6? Reply with just the number." }),
      signal: AbortSignal.timeout(120_000),
    })
    expect(responsesRes.status === 200, "responses HTTP 200", `status=${responsesRes.status}`)
    const responsesBody = (await responsesRes.json()) as { object?: string; output_text?: string }
    expect(responsesBody.object === "response", "responses object shape intact")
    expect(responsesBody.output_text?.includes("12") ?? false, "responses answers 12", String(responsesBody.output_text).slice(0, 40))
  } catch (error) {
    bad("coexistence task crashed", String(error))
  }
}

// ---------------------------------------------------------------------------

await startServer()
console.log(`Anthropic Messages facade smoke against real opencode zen — proxy at ${BASE}/v1/messages`)
console.log(`(PROXY_API_KEY ${process.env.PROXY_API_KEY ? "loaded from env" : "not set in env; using local fallback key"})`)

await task1Auth()
await task2NonStreaming()
await task3StreamingSystem()
await task4LargeStreaming()
await task5XhighThinking()
await task6ToolLoop()
await task7Memory()
await task8Coexistence()

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log("\nFailures:")
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log("MESSAGES SMOKE OK")
