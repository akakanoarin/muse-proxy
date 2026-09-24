// Real-upstream OpenMinis compatibility probe for space-bunny-free.
//
// Source of truth: OpenMinis commit 4ef2900 (2026-09-02), iOS
// AIChatViewModel+ToolDefinitions.swift / AgentTools.kt and the OpenAI /
// Anthropic provider converters.  In particular, file_write has exactly these
// arguments: required tool_title/path/content plus optional append/create_dirs.
//
// This probe deliberately does not rely on the model choosing a tool.  It
// sends a real upstream turn for every facade and every valid argument shape,
// replaying a completed OpenMinis tool turn with a local file-write result.
// It also asks the model to generate one file_write call per facade, which
// exercises the real argument stream and catches clients that require
// output_item.added before output_item.done (OpenMinis Responses does).
// Generation uses an 8,192-token budget: a complete HTML file commonly needs
// more than a tiny 2,048-token probe budget, while OpenMinis itself defaults
// to 16,384 (Chat) / 32,768 (Responses) output tokens.
//
//   bun run scripts/probe-openminis-spacebunny.ts
//   MODEL=space-bunny-free bun run scripts/probe-openminis-spacebunny.ts
//   MODEL=mimo-v2.6-flash-free bun run ...  # compact generation is automatic
//   MODEL=mimo-v2.6-flash-free FULL_GENERATION=1 bun run ...  # opt into long SVG generation
//   FACADE=responses CASE=large bun run ...  # isolate a slow matrix slice
//   MATRIX=0 bun run scripts/probe-openminis-spacebunny.ts  # generation only

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"
import { handleMessagesRequest } from "../api/messages"
import { handleResponsesRequest } from "../api/responses"

const PORT = 8973
const KEY = process.env.PROXY_API_KEY ?? "openminis-probe-key"
const BASE = `http://127.0.0.1:${PORT}`
const MODEL = process.env.MODEL ?? "space-bunny-free"
const RUN_MATRIX = process.env.MATRIX !== "0"
// MiMo can take longer than the sandbox command budget to generate a complete
// SVG.  Keep the real tool-generation leg, but use a deterministic compact
// payload by default; the replay matrix below still sends every valid
// file_write shape, including large content.  Set FULL_GENERATION=1 to opt
// into the long generation leg explicitly.
const FULL_GENERATION = process.env.FULL_GENERATION === "1"
const COMPACT_GENERATION = process.env.COMPACT_GENERATION === "1" || (MODEL === "mimo-v2.6-flash-free" && !FULL_GENERATION)
const GENERATION_MAX_TOKENS = Math.max(512, Number(process.env.GENERATION_MAX_TOKENS ?? (COMPACT_GENERATION ? "2048" : "8192")))
const ONLY_FACADE = process.env.FACADE
const ONLY_CASE = process.env.CASE
const MATRIX_DELAY_MS = Math.max(0, Number(process.env.MATRIX_DELAY_MS ?? (MODEL === "mimo-v2.6-flash-free" ? "2000" : "650")))
const MAX_RATE_LIMIT_RETRIES = 3

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(30_000, retryAfter * 1000)
  return Math.min(20_000, 5_000 * 2 ** attempt)
}

const FILE_DESCRIPTION =
  "Write content to a file on the Linux filesystem. Creates the file if it doesn't exist. Use append mode to add to existing files."
const FILE_PROPERTIES = {
  tool_title: { type: "string", description: "A concise summary shown to the user." },
  path: { type: "string", description: "Absolute Linux path to write." },
  content: { type: "string", description: "The text content to write to the file." },
  append: { type: "boolean", description: "Append instead of overwriting (default false)." },
  create_dirs: { type: "boolean", description: "Create parent directories if needed (default false)." },
}
const FILE_REQUIRED = ["tool_title", "path", "content"]
const CHAT_TOOL = {
  type: "function",
  function: {
    name: "file_write",
    description: FILE_DESCRIPTION,
    parameters: { type: "object", properties: FILE_PROPERTIES, required: FILE_REQUIRED },
  },
}
const RESPONSES_TOOL = {
  type: "function",
  name: "file_write",
  description: FILE_DESCRIPTION,
  parameters: { type: "object", properties: FILE_PROPERTIES, required: FILE_REQUIRED },
}
const MESSAGES_TOOL = {
  name: "file_write",
  description: FILE_DESCRIPTION,
  input_schema: { type: "object", properties: FILE_PROPERTIES, required: FILE_REQUIRED },
}

interface Args {
  tool_title: string
  path: string
  content: string
  append?: boolean
  create_dirs?: boolean
}

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>鹈鹕</title><style>.wheel{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><svg><circle class="wheel" cx="20" cy="20" r="10"/></svg><script>const title = "a\\\"b";</script></body></html>`
const CASES: Array<{ name: string; args: Args }> = [
  { name: "required-only", args: { tool_title: "创建 HTML", path: "/root/pelican.html", content: "<h1>ok</h1>" } },
  { name: "optional-false", args: { tool_title: "创建 HTML", path: "/root/pelican.html", content: HTML, append: false, create_dirs: false } },
  { name: "append-true", args: { tool_title: "追加 HTML", path: "/root/pelican.html", content: "\n<!-- appended -->", append: true, create_dirs: false } },
  { name: "create-dirs-true", args: { tool_title: "创建嵌套文件", path: "/root/新建目录/pelican.html", content: "<p>ok</p>", append: false, create_dirs: true } },
  { name: "all-options-true", args: { tool_title: "追加嵌套文件 🦩", path: "/root/新建目录/pelican animation.html", content: HTML, append: true, create_dirs: true } },
  { name: "empty-content", args: { tool_title: "创建空文件", path: "/root/empty.txt", content: "", append: false, create_dirs: false } },
  { name: "unicode-escapes-newlines", args: { tool_title: "写入特殊字符", path: "/root/特殊 文件.txt", content: "第一行\\n第二行\\t制表\\n🦩🚲\\u00e9\\u00fc\\n<svg>\\\"quoted\\\"</svg>", append: false, create_dirs: true } },
  { name: "large-content", args: { tool_title: "写入较大 HTML", path: "/root/large.html", content: HTML + "\n<!-- padding -->".repeat(900), append: false, create_dirs: true } },
]

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers[key] = value
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      })
      const response = req.url === "/v1/responses"
        ? await handleResponsesRequest(request, { PROXY_API_KEY: KEY })
        : req.url === "/v1/messages"
          ? await handleMessagesRequest(request, { PROXY_API_KEY: KEY })
          : await handleChatRequest(request, { PROXY_API_KEY: KEY })
      const out: Record<string, string> = {}
      response.headers.forEach((value, key) => { out[key] = value })
      res.writeHead(response.status, out)
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

async function post(path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
}

function frames(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  const out: Array<{ type: string; data: Record<string, unknown> }> = []
  for (const block of text.split("\n\n")) {
    let type = ""
    let data = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) type = line.slice(7).trim()
      else if (line.startsWith("data: ")) data += line.slice(6)
    }
    if (!data || data === "[DONE]") continue
    try { out.push({ type, data: JSON.parse(data) as Record<string, unknown> }) } catch { /* heartbeat */ }
  }
  return out
}

function dataLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === "[DONE]") continue
    try { out.push(JSON.parse(payload) as Record<string, unknown>) } catch { /* heartbeat */ }
  }
  return out
}

interface Turn {
  status: number
  error: string | null
  terminal: boolean
  toolCalls: Array<{ id: string; name: string; arguments: string }>
}

async function run(path: string, body: unknown, headers?: Record<string, string>): Promise<Turn> {
  let response = await post(path, body, headers)
  for (let attempt = 0; response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
    const delay = retryDelay(response, attempt)
    await response.text()
    console.log(`${path}: upstream rate limited; retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
    await sleep(delay)
    response = await post(path, body, headers)
  }
  if (response.status !== 200) return { status: response.status, error: (await response.text()).replace(/\s+/g, " ").slice(0, 500), terminal: false, toolCalls: [] }
  const text = await response.text()
  if (path.endsWith("chat/completions")) {
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    let terminal = false
    for (const chunk of dataLines(text)) {
      const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0]
      const delta = (choice?.delta ?? choice?.message) as Record<string, unknown> | undefined
      for (const raw of (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
        const index = typeof raw.index === "number" ? raw.index : 0
        const fn = (raw.function ?? {}) as Record<string, unknown>
        const current = calls.get(index) ?? { id: "", name: "", arguments: "" }
        if (typeof raw.id === "string") current.id = raw.id
        if (typeof fn.name === "string") current.name = fn.name
        if (typeof fn.arguments === "string") current.arguments += fn.arguments
        calls.set(index, current)
      }
      if (choice?.finish_reason === "stop" || choice?.finish_reason === "tool_calls" || choice?.finish_reason === "length") terminal = true
    }
    return { status: response.status, error: text.includes("[muse-proxy upstream error]") ? "proxy error in content" : null, terminal: terminal && text.includes("[DONE]"), toolCalls: [...calls.values()] }
  }
  if (path.endsWith("responses")) {
    const list = frames(text)
    const calls = new Map<string, { id: string; name: string; arguments: string }>()
    for (const frame of list) {
      if (frame.type === "response.output_item.added") {
        const item = frame.data.item as Record<string, unknown>
        if (item?.type === "function_call") calls.set(String(item.id), { id: String(item.call_id ?? ""), name: String(item.name ?? ""), arguments: "" })
      } else if (frame.type === "response.function_call_arguments.delta") {
        const item = frame.data.item_id as string
        const call = calls.get(item)
        if (call) call.arguments += String(frame.data.delta ?? "")
      } else if (frame.type === "response.output_item.done") {
        const item = frame.data.item as Record<string, unknown>
        if (item?.type === "function_call") {
          const key = String(item.id)
          if (!calls.has(key)) calls.set(key, { id: String(item.call_id ?? ""), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") })
        }
      }
    }
    return { status: response.status, error: null, terminal: list.at(-1)?.type === "response.completed", toolCalls: [...calls.values()] }
  }
  const list = frames(text)
  const calls: Array<{ id: string; name: string; arguments: string }> = []
  let current: { id: string; name: string; arguments: string } | undefined
  for (const frame of list) {
    if (frame.type === "content_block_start") {
      const block = frame.data.content_block as Record<string, unknown>
      if (block?.type === "tool_use") current = { id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: "" }
    } else if (frame.type === "content_block_delta" && current) {
      const delta = frame.data.delta as Record<string, unknown>
      if (delta?.type === "input_json_delta") current.arguments += String(delta.partial_json ?? "")
    } else if (frame.type === "content_block_stop" && current) {
      calls.push(current)
      current = undefined
    }
  }
  return { status: response.status, error: null, terminal: list.at(-1)?.type === "message_stop", toolCalls: calls }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

function replayBody(facade: "chat" | "responses" | "messages", args: Args, requestedCallId = "call_openminis_file_write"): { path: string; body: unknown; headers?: Record<string, string> } {
  const callId = requestedCallId || "call_openminis_file_write"
  const result = JSON.stringify({ ok: true, path: args.path, bytes: Buffer.byteLength(args.content, "utf8"), tool_title: args.tool_title })
  if (facade === "chat") return {
    path: "/v1/chat/completions",
    body: {
      model: MODEL,
      stream: true,
      max_completion_tokens: 512,
      reasoning_effort: "high",
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "You are an OpenMinis coding agent." },
        { role: "user", content: "创建一个 HTML 文件。" },
        { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "file_write", arguments: JSON.stringify(args) } }] },
        { role: "tool", tool_call_id: callId, content: result },
        { role: "user", content: "文件已写入。只用一句话确认，不要再次调用工具。" },
      ],
      tools: [CHAT_TOOL],
      tool_choice: "auto",
    },
  }
  if (facade === "responses") return {
    path: "/v1/responses",
    body: {
      model: MODEL,
      stream: true,
      max_output_tokens: 512,
      store: false,
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", summary: "auto" },
      input: [
        { role: "user", content: "创建一个 HTML 文件。" },
        { type: "function_call", id: callId.startsWith("fc_") ? callId : `fc_${callId}`, call_id: callId, name: "file_write", arguments: JSON.stringify(args) },
        { type: "function_call_output", call_id: callId, output: result },
        { role: "user", content: "文件已写入。只用一句话确认，不要再次调用工具。" },
      ],
      tools: [RESPONSES_TOOL],
      tool_choice: "auto",
    },
  }
  const toolUseId = callId.startsWith("toolu_") ? callId : `toolu_${callId}`
  return {
    path: "/v1/messages",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: {
      model: MODEL,
      max_tokens: 512,
      stream: true,
      messages: [
        { role: "user", content: "创建一个 HTML 文件。" },
        { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "file_write", input: args }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }, { type: "text", text: "文件已写入。只用一句话确认，不要再次调用工具。" }] },
      ],
      tools: [MESSAGES_TOOL],
    },
  }
}

function parseGeneratedFileWrite(call: { name: string; arguments: string } | undefined): Args | null {
  if (!call || call.name !== "file_write") return null
  try {
    const value = JSON.parse(call.arguments) as Record<string, unknown>
    if (typeof value.tool_title !== "string" || typeof value.path !== "string" || typeof value.content !== "string") return null
    if (value.append !== undefined && typeof value.append !== "boolean") return null
    if (value.create_dirs !== undefined && typeof value.create_dirs !== "boolean") return null
    return value as unknown as Args
  } catch {
    return null
  }
}

async function generatedToolCall(facade: "chat" | "responses" | "messages"): Promise<Turn> {
  const common = COMPACT_GENERATION
    ? "必须调用 file_write 工具创建 /root/pelican.html，content 只写最小合法文本 <h1>ok</h1>，path 写 /root/pelican.html，tool_title 写 ok，append=false，create_dirs=true。调用后立即停止，不要输出解释。"
    : "你必须调用 file_write 工具创建 /root/pelican.html，内容是一个鹈鹕骑自行车的 SVG 动画。调用后停止，不要输出解释。"
  if (facade === "chat") return run("/v1/chat/completions", { model: MODEL, stream: true, max_completion_tokens: GENERATION_MAX_TOKENS, stream_options: { include_usage: true }, reasoning_effort: "high", messages: [{ role: "user", content: common }], tools: [CHAT_TOOL], tool_choice: "auto" })
  if (facade === "responses") return run("/v1/responses", { model: MODEL, stream: true, store: false, parallel_tool_calls: true, include: ["reasoning.encrypted_content"], max_output_tokens: GENERATION_MAX_TOKENS, reasoning: { effort: "high", summary: "auto" }, input: common, tools: [RESPONSES_TOOL], tool_choice: "auto" })
  return run("/v1/messages", { model: MODEL, stream: true, max_tokens: GENERATION_MAX_TOKENS, messages: [{ role: "user", content: common }], tools: [MESSAGES_TOOL] }, { "x-api-key": KEY, "anthropic-version": "2023-06-01" })
}

async function main(): Promise<void> {
  await startServer()
  let failures = 0
  console.log(`=== OpenMinis file_write compatibility probe (${MODEL}) ===`)
  for (const facade of ["chat", "responses", "messages"] as const) {
    if (ONLY_FACADE && facade !== ONLY_FACADE) continue
    const generated = await generatedToolCall(facade)
    const generatedCall = generated.toolCalls.find((call) => call.name === "file_write")
    const generatedArgs = parseGeneratedFileWrite(generatedCall)
    const generatedOk = generated.status === 200 && generated.terminal && generated.toolCalls.length > 0 && generatedArgs !== null
    console.log(`${facade}: generated tool call ${generatedOk ? "OK" : "FAIL"} status=${generated.status} terminal=${generated.terminal} calls=${generated.toolCalls.length} args=${generatedArgs ? Object.keys(generatedArgs).sort().join(",") : "invalid"} len=${generatedCall?.arguments.length ?? 0}${generated.error ? ` error=${generated.error}` : ""}`)
    if (!generatedOk) failures++
    if (generatedCall && generatedArgs) {
      const replay = replayBody(facade, generatedArgs, generatedCall.id)
      const followup = await run(replay.path, replay.body, replay.headers)
      const followupOk = followup.status === 200 && followup.terminal && followup.error === null
      console.log(`${facade}: generated tool replay ${followupOk ? "OK" : "FAIL"} status=${followup.status} terminal=${followup.terminal}${followup.error ? ` error=${followup.error}` : ""}`)
      if (!followupOk) failures++
      await sleep(MATRIX_DELAY_MS)
    }
    if (RUN_MATRIX) {
      for (const testCase of CASES) {
        if (ONLY_CASE && !testCase.name.includes(ONLY_CASE)) continue
        const replay = replayBody(facade, testCase.args)
        const result = await run(replay.path, replay.body, replay.headers)
        const ok = result.status === 200 && result.terminal && result.error === null
        console.log(`${facade}: ${testCase.name} ${ok ? "OK" : "FAIL"} status=${result.status} terminal=${result.terminal}${result.error ? ` error=${result.error}` : ""}`)
        if (!ok) failures++
        await sleep(MATRIX_DELAY_MS)
      }
    }
  }
  console.log(`=== ${failures === 0 ? "ALL CLEAN" : `${failures} failure(s)`} ===`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
