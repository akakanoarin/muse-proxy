// Real end-to-end smoke for the OpenAI Responses facade (POST /v1/responses)
// against the real opencode zen upstream (network required).
// Usage: bun run smoke:responses
//
// Starts a real local HTTP server dispatching to handleResponsesRequest
// (auth -> normalize -> fingerprinted upstream call -> SSE passthrough or
// aggregation), then exercises every feature over the wire:
//   1. API key auth (wrong key -> 401, same PROXY_API_KEY contract as chat)
//   2. non-streaming simple chat (aggregated response object + usage)
//   3. streaming + instructions (canonical event:/data: SSE frames)
//   4. large streaming generation (many deltas, long output_text)
//   5. xhigh reasoning (reasoning summary deltas + correct answer)
//   6. client tool loop (function_call -> function_call_output round-trip)
//   7. multi-turn memory (output items replayed into input, incl. encrypted
//      reasoning items)

import * as http from "node:http"
import { handleResponsesRequest } from "../api/responses"

const PORT = 8907
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
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => (e.data as { delta?: string }).delta ?? "")
    .join("")
}

async function post(body: unknown, key: string = KEY, timeoutMs = 180_000): Promise<Response> {
  return fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      // Forward ALL client headers (authorization included!) to the handler.
      const forwardHeaders: Record<string, string> = {}
      for (const [headerKey, value] of Object.entries(req.headers)) {
        if (typeof value === "string") forwardHeaders[headerKey] = value
      }
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: forwardHeaders,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      })
      const response = await handleResponsesRequest(request, { PROXY_API_KEY: KEY })
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
  console.log("\n[1/7] API key auth (same PROXY_API_KEY contract as chat completions)")
  try {
    const wrong = await post({ input: "hi" }, "totally-wrong-key", 30_000)
    const body = (await wrong.json()) as { error?: { type?: string } }
    expect(wrong.status === 401, "wrong key rejected with 401", `status=${wrong.status} type=${body.error?.type}`)
    expect(body.error?.type === "authentication_error", "error body is OpenAI-shaped authentication_error")
  } catch (error) {
    bad("auth task crashed", String(error))
  }
}

async function task2NonStreaming(): Promise<void> {
  console.log("\n[2/7] non-streaming simple chat (aggregated response object)")
  try {
    const res = await post({
      model: "whatever-maps-to-muse",
      input: "What is 2+2? Reply with just the number.",
      stream: false,
    })
    expect(res.status === 200, "HTTP 200", `status=${res.status}`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.object === "response", 'object === "response"')
    expect(body.id !== undefined, "response id present", String(body.id))
    expect(body.status === "completed", "status completed")
    const outputText = String(body.output_text ?? "")
    expect(outputText.includes("4"), "output_text answers 4", outputText.slice(0, 60))
    const usage = body.usage as { input_tokens?: number; output_tokens?: number } | null
    expect(usage !== null && (usage?.input_tokens ?? 0) > 0, "usage tokens reported", JSON.stringify(usage))
  } catch (error) {
    bad("non-streaming task crashed", String(error))
  }
}

async function task3StreamingInstructions(): Promise<void> {
  console.log("\n[3/7] streaming + instructions (canonical event:/data: SSE frames)")
  try {
    const res = await post({
      input: "用一句话介绍你自己",
      instructions: "必须用英文回答,且只回答一句话,不要超过 20 个单词。",
      stream: true,
    })
    expect(res.status === 200, "HTTP 200", `status=${res.status}`)
    expect((res.headers.get("content-type") ?? "").includes("text/event-stream"), "content-type is text/event-stream")

    const events = await readSseEvents(res)
    expect(events.length > 0, "SSE events received", `count=${events.length}`)
    expect(events[0]?.type === "response.created", "first event is response.created", events[0]?.type)
    expect(events.at(-1)?.type === "response.completed", "last event is response.completed", events.at(-1)?.type)
    expect(events.every((e) => e.type.length > 0), "every frame carries an event: type")

    const text = textFrom(events)
    expect(text.length > 0, "text deltas arrived", `${text.length} chars`)
    // instructions are English-only: no CJK chars should leak into the answer
    expect(!/[\u4e00-\u9fff]/.test(text), "instructions honored (English answer)", text.slice(0, 80))

    const completed = events.at(-1)!.data as { response?: { usage?: { total_tokens?: number } } }
    expect((completed.response?.usage?.total_tokens ?? 0) > 0, "usage in response.completed", JSON.stringify(completed.response?.usage))
  } catch (error) {
    bad("streaming task crashed", String(error))
  }
}

async function task4LargeStreaming(): Promise<void> {
  console.log("\n[4/7] large streaming generation (long code output over SSE)")
  // The free tier occasionally closes the connection mid-generation (observed
  // 2026-09-20: EOF after output deltas, no response.completed). The proxy
  // surfaces that as a synthetic error event; retry until a clean terminal
  // event arrives (max 3 attempts) and judge that attempt.
  try {
    let events: SseEvent[] = []
    let text = ""
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await post({
        input:
          "Write a complete single-file Snake game in plain HTML+CSS+JavaScript. Output ONLY the code inside one ```html code block. The game must include: canvas rendering, keyboard controls, food spawning, score display, and game-over handling. Aim for at least 150 lines of code.",
        stream: true,
      })
      expect(res.status === 200, "HTTP 200", `status=${res.status}`)
      events = await readSseEvents(res)
      text = textFrom(events)
      const last = events.at(-1)?.type ?? ""
      console.log(`    attempt ${attempt}: ${text.length} chars, last event: ${last}`)
      if (last === "response.completed") break
    }
    const deltas = events.filter((e) => e.type === "response.output_text.delta")
    expect(text.length > 2000, "long output aggregated", `${text.length} chars`)
    expect(deltas.length > 15, "many streaming deltas", `${deltas.length} deltas`)
    expect(text.includes("canvas") || text.includes("Canvas"), "content looks like the snake game", "")
    expect(events.at(-1)?.type === "response.completed", "stream completed cleanly", events.at(-1)?.type)
    console.log(`    first 100 chars: ${text.slice(0, 100).replace(/\n/g, " ")}`)
  } catch (error) {
    bad("large streaming task crashed", String(error))
  }
}

async function task5XhighReasoning(): Promise<void> {
  console.log("\n[5/7] xhigh reasoning (summary deltas + correct answer)")
  // Upstream streams reasoning summaries on a best-effort basis: the model
  // sometimes solves the task without emitting streamable summary text
  // (observed 2026-09-20). Retry until reasoning deltas are observed (max 3
  // attempts) and judge the final stream for answer + clean termination.
  try {
    let text = ""
    let lastEvent = ""
    let reasoningText = ""
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await post({
        input: "What is 17 * 23? Work it out step by step, then answer with just the number.",
        reasoning: { effort: "xhigh" },
        stream: true,
      })
      expect(res.status === 200, `HTTP 200`, `status=${res.status}`)
      const events = await readSseEvents(res)
      const reasoningDeltas = events.filter(
        (e) => e.type === "response.reasoning_summary_text.delta" || e.type === "response.reasoning_text.delta",
      )
      reasoningText = reasoningDeltas.map((e) => (e.data as { delta?: string }).delta ?? "").join("")
      text = textFrom(events)
      lastEvent = events.at(-1)?.type ?? ""
      console.log(
        `    attempt ${attempt}: ${reasoningDeltas.length} reasoning deltas, answer starts: ${text.slice(0, 20).replace(/\n/g, " ")}`,
      )
      if (reasoningDeltas.length > 0) break
    }
    expect(reasoningText.length > 0, "reasoning summary deltas streamed", `${reasoningText.length} chars`)
    console.log(`    reasoning (first 120 chars): ${reasoningText.slice(0, 120).replace(/\n/g, " ")}`)
    expect(text.includes("391"), "final answer is 391", text.slice(0, 80))
    expect(lastEvent === "response.completed", "stream completed cleanly", lastEvent)
  } catch (error) {
    bad("xhigh reasoning task crashed", String(error))
  }
}

function outputItemsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (body.output as Array<Record<string, unknown>> | undefined) ?? []
}

async function task6ToolLoop(): Promise<void> {
  console.log("\n[6/7] client tool loop (function_call -> function_call_output round-trip)")
  try {
    const tools = [
      {
        type: "function",
        name: "get_weather",
        description: "Query the current weather of a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string", description: "city name" } },
          required: ["city"],
        },
      },
    ]

    const turn1Res = await post({
      input: "北京今天天气怎么样?你必须调用 get_weather 工具查询,禁止自己编造天气。",
      tools,
      stream: false,
    })
    expect(turn1Res.status === 200, "turn1 HTTP 200", `status=${turn1Res.status}`)
    const turn1 = (await turn1Res.json()) as Record<string, unknown>
    const items1 = outputItemsOf(turn1)
    const call = items1.find((item) => item.type === "function_call") as
      | { call_id?: string; name?: string; arguments?: string }
      | undefined
    expect(call !== undefined, "turn1 produced a function_call", JSON.stringify(items1.map((i) => i.type)))
    if (!call) return
    expect(call.name === "get_weather", "tool name is get_weather", String(call.name))
    expect(typeof call.call_id === "string" && call.call_id.length > 0, "call_id present", String(call.call_id))
    console.log(`    arguments: ${call.arguments}`)

    const turn2Res = await post({
      input: [
        ...items1,
        { type: "function_call_output", call_id: call.call_id, output: "北京今天晴,26°C,微风" },
      ],
      tools,
      stream: false,
    })
    expect(turn2Res.status === 200, "turn2 HTTP 200", `status=${turn2Res.status}`)
    const turn2 = (await turn2Res.json()) as Record<string, unknown>
    const answer = String(turn2.output_text ?? "")
    expect(answer.includes("26") || answer.includes("晴"), "turn2 answer uses the tool result", answer.slice(0, 100))
  } catch (error) {
    bad("tool loop task crashed", String(error))
  }
}

async function task7Memory(): Promise<void> {
  console.log("\n[7/7] multi-turn memory (output items replayed into input)")
  try {
    const turn1Res = await post({
      input: "请记住暗号:蓝鲸计划。只回复四个字:已记住暗号。",
      stream: false,
    })
    expect(turn1Res.status === 200, "turn1 HTTP 200", `status=${turn1Res.status}`)
    const turn1 = (await turn1Res.json()) as Record<string, unknown>
    const items1 = outputItemsOf(turn1)
    const types = items1.map((item) => item.type)
    expect(types.includes("message"), "turn1 output has an assistant message", JSON.stringify(types))

    const turn2Res = await post({
      input: [...items1, { role: "user", content: "暗号是什么?只回答暗号内容。" }],
      stream: false,
    })
    expect(turn2Res.status === 200, "turn2 HTTP 200", `status=${turn2Res.status}`)
    const turn2 = (await turn2Res.json()) as Record<string, unknown>
    const answer = String(turn2.output_text ?? "")
    expect(answer.includes("蓝鲸"), "turn2 remembers the passphrase", answer.slice(0, 60))
  } catch (error) {
    bad("memory task crashed", String(error))
  }
}

// ---------------------------------------------------------------------------

await startServer()
console.log(`Responses facade smoke against real opencode zen — proxy at ${BASE}/v1/responses`)
console.log(`(PROXY_API_KEY ${process.env.PROXY_API_KEY ? "loaded from env" : "not set in env; using local fallback key"})`)

await task1Auth()
await task2NonStreaming()
await task3StreamingInstructions()
await task4LargeStreaming()
await task5XhighReasoning()
await task6ToolLoop()
await task7Memory()

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log("\nFailures:")
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log("RESPONSES SMOKE OK")
