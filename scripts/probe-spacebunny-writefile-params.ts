// Probe (not part of the test suite): the field agent calls a WRITE-FILE tool
// whose arguments carry the FULL HTML document — replayed on the next turn as
// assistant.tool_calls[].function.arguments (plus, for some SDKs, the
// reasoning_content of that assistant turn). Sweep every plausible write-tool
// parameter shape/size/charset through the REAL proxy chat facade (streaming)
// to find what space-bunny-free's oa-compat edge rejects with 400
// "invalid_request_error: invalid request".
//   bun run scripts/probe-spacebunny-writefile-params.ts            (all cases)
//   ONLY=edits bun run ...                                          (one case)
// The turn-2 ask is a SHORT CONFIRMATION on purpose: what is under test is
// whether the upstream ACCEPTS the replayed history (tool_call arguments with
// a full HTML document + tool result), not generation length.

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"

const PORT = 8969
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

// ---------------------------------------------------------------------------
// The write tool definitions an agent might declare (every plausible shape).
// ---------------------------------------------------------------------------

interface ClientTool {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

const WRITE_TOOLS: Record<string, ClientTool> = {
  "w-str-concat": {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target file path" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  "w-str-concat-extra": {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["overwrite", "append"] },
          encoding: { type: "string" },
          create_dirs: { type: "boolean" },
        },
        required: ["path", "content"],
      },
    },
  },
  "w-parts-array": {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          parts: { type: "array", items: { type: "string" }, description: "Content chunks concatenated in order" },
        },
        required: ["path", "parts"],
      },
    },
  },
  "w-edits-replace": {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { old: { type: "string" }, new: { type: "string" } },
              required: ["old", "new"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  "w-patch-strings": {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          replacements: {
            type: "array",
            items: {
              type: "object",
              properties: { oldString: { type: "string" }, newString: { type: "string" } },
              required: ["oldString", "newString"],
            },
          },
        },
        required: ["path", "replacements"],
      },
    },
  },
  "w-legacy-str-replace": {
    type: "function",
    function: {
      name: "str_replace",
      description: "Replace strings in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          replacements: {
            type: "array",
            items: {
              type: "object",
              properties: { oldString: { type: "string" }, newString: { type: "string" } },
              required: ["oldString", "newString"],
            },
          },
          allowMultiple: { type: "boolean" },
        },
        required: ["path", "replacements"],
      },
    },
  },
}

// ---------------------------------------------------------------------------
// A realistic pelican-bike HTML document used as the tool-call payload.
// ---------------------------------------------------------------------------

function htmlDoc(target: number): string {
  const head = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>鹈鹕骑自行车 SVG 动画</title>
  <style>
    body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: linear-gradient(#bfe3ff, #eaf7ff); }
    .scene { width: min(720px, 92vw); }
    .wheel { animation: spin 1.4s linear infinite; transform-origin: center; transform-box: fill-box; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .pelican { animation: bob 0.8s ease-in-out infinite alternate; }
    @keyframes bob { to { transform: translateY(-8px); } }
    .road { stroke-dasharray: 26 14; animation: move 0.9s linear infinite; }
    @keyframes move { to { stroke-dashoffset: -40; } }
  </style>
</head>
<body>
  <div class="scene">
    <svg viewBox="0 0 720 480" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="一只鹈鹕骑自行车">
      <g class="pelican">
        <ellipse cx="360" cy="230" rx="52" ry="64" fill="#4a5568"/>
        <ellipse cx="360" cy="220" rx="38" ry="50" fill="#f7fafc"/>
        <circle cx="360" cy="160" r="26" fill="#4a5568"/>
        <circle cx="352" cy="156" r="3.2" fill="#fff"/>
        <circle cx="368" cy="156" r="3.2" fill="#fff"/>
        <path d="M 360 170 Q 430 178 436 196 Q 400 206 358 188 Z" fill="#f6ad55"/>
        <rect x="322" y="228" width="52" height="12" rx="6" fill="#e53e3e"/>
      </g>
      <g class="wheel"><circle cx="268" cy="330" r="58" fill="none" stroke="#2d3748" stroke-width="7"/><line x1="268" y1="272" x2="268" y2="388" stroke="#a0aec0" stroke-width="2.5"/></g>
      <g class="wheel"><circle cx="472" cy="330" r="58" fill="none" stroke="#2d3748" stroke-width="7"/><line x1="472" y1="272" x2="472" y2="388" stroke="#a0aec0" stroke-width="2.5"/></g>
      <line class="road" x1="0" y1="410" x2="720" y2="410" stroke="#4a5568" stroke-width="5"/>
    </svg>
  </div>
</body>
</html>`
  const blocks: string[] = [head]
  let total = head.length
  let i = 0
  while (total < target) {
    i++
    const block = `\n  <!-- 变体 ${i}: 车轮半径 ${40 + (i % 12)}px, 背景色 #%${(i * 7) % 255},${(i * 13) % 255},${(i * 29) % 255}, 动画 ${(0.6 + (i % 9) / 10).toFixed(1)}s -->\n  <div class="note">设计说明 ${i}: 保持语义化结构与可访问性,尊重 prefers-reduced-motion,键盘可达。</div>`
    blocks.push(block)
    total += block.length
  }
  return blocks.join("")
}

// ---------------------------------------------------------------------------
// Cases: write-tool argument SHAPES an agent SDK might emit.
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>

interface Case {
  name: string
  tool: string
  args: (doc: string) => Args
  withAssistantReasoning?: boolean
}

const CASES: Case[] = [
  // 1. classic write_file {path, content} — content = the full HTML.
  { name: "path+content(12k html)", tool: "w-str-concat", args: (d) => ({ path: "pelican-bike.html", content: d }) },
  { name: "path+content(40k html)", tool: "w-str-concat", args: (d) => ({ path: "pelican-bike.html", content: htmlDoc(40_000) }) },
  { name: "path+content+extras(12k)", tool: "w-str-concat-extra", args: (d) => ({ path: "pelican-bike.html", content: d, mode: "overwrite", encoding: "utf-8", create_dirs: true }) },
  // 2. parts array: content split into chunks (some SDKs chunk big writes).
  { name: "path+parts[](12k in 8 chunks)", tool: "w-parts-array", args: (d) => {
      const size = Math.ceil(d.length / 8)
      const parts: string[] = []
      for (let i = 0; i < d.length; i += size) parts.push(d.slice(i, i + size))
      return { path: "pelican-bike.html", parts }
    } },
  // 3. edits array: old/new full-document pairs (str_replace style).
  { name: "path+edits[old->new full doc]", tool: "w-edits-replace", args: (d) => ({ path: "pelican-bike.html", edits: [{ old: htmlDoc(400), new: d }] }) },
  // 4. replacements with oldString/newString (the "apply_patch" shape).
  { name: "path+replacements[oldString->newString]", tool: "w-patch-strings", args: (d) => ({ path: "pelican-bike.html", replacements: [{ oldString: htmlDoc(400), newString: d }] }) },
  // 5. legacy tool name str_replace.
  { name: "str_replace path+replacements", tool: "w-legacy-str-replace", args: (d) => ({ path: "pelican-bike.html", replacements: [{ oldString: htmlDoc(400), newString: d }] }) },
  // 6. content with unicode-heavy payload (emoji, CJK, control-ish chars).
  { name: "path+content(unicode/emoji/control)", tool: "w-str-concat", args: (d) => ({
      path: "pelican-bike.html",
      content: d + "\n<!-- 🦩🚲 unicode note: 鹈鹕 \u00e9\u00fc\u4e2d\u6587 \t trailing-tab \u0000-safe? -->",
    }) },
  // 7. content with escape-heavy payload (backslashes, quotes, newlines).
  { name: "path+content(escape-heavy)", tool: "w-str-concat", args: (d) => ({
      path: "pelican-bike.html",
      content: `const s = ${JSON.stringify(d)};\nconst t = "line1\\nline2\\t\\u4e2d\\u6587 \\\\ path C:\\Users\\test";\n<!-- ${d.slice(0, 1000)} -->`,
    }) },
  // 8. assistant turn replayed WITH reasoning_content alongside the tool call.
  { name: "path+content(12k)+assistant reasoning replay", tool: "w-str-concat", args: (d) => ({ path: "pelican-bike.html", content: d }), withAssistantReasoning: true },
  // 9. deep diff: many small replacements (like a real editor loop).
  { name: "path+replacements[40 small edits]", tool: "w-patch-strings", args: (d) => ({
      path: "pelican-bike.html",
      replacements: Array.from({ length: 40 }, (_, i) => ({ oldString: `设计说明 ${i + 1}`, newString: `设计说明 ${i + 1}(已修改 ${i})` })).concat([{ oldString: htmlDoc(400), newString: d }]),
    }) },
]

// ---------------------------------------------------------------------------
// Harness: turn 1 asks for the file (model calls the write tool), we execute
// it locally, turn 2 replays the assistant tool-call turn + tool result —
// the exact pattern that previously killed the conversation.
// ---------------------------------------------------------------------------

interface Turn {
  status: number
  httpError: string | null
  content: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  finish: string | null
  sawDone: boolean
  inStreamError: string | null
}

async function chatTurn(messages: unknown[], tools: unknown[]): Promise<Turn> {
  const turn: Turn = { status: 0, httpError: null, content: "", reasoning: "", toolCalls: [], finish: null, sawDone: false, inStreamError: null }
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, stream: true, messages, tools, tool_choice: "auto" }),
    signal: AbortSignal.timeout(300_000),
  })
  turn.status = res.status
  if (res.status !== 200) {
    turn.httpError = (await res.text()).replace(/\s+/g, " ").slice(0, 300)
    return turn
  }
  const text = await res.text()
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === "[DONE]") {
      if (payload === "[DONE]") turn.sawDone = true
      continue
    }
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>
        error?: { message?: string }
      }
      if (chunk.error) turn.inStreamError = chunk.error.message ?? JSON.stringify(chunk.error)
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {}
        if (typeof delta.content === "string") turn.content += delta.content
        if (typeof delta.reasoning_content === "string") turn.reasoning += delta.reasoning_content
        for (const call of delta.tool_calls ?? []) {
          if (call.id && call.function?.name) turn.toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? "" })
          else if (call.function?.arguments && turn.toolCalls.length > 0) turn.toolCalls[turn.toolCalls.length - 1]!.arguments += call.function.arguments
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) turn.finish = choice.finish_reason
      }
    } catch {
      turn.inStreamError = `unparseable: ${line.slice(0, 80)}`
    }
  }
  return turn
}

function summarizeArgs(args: Args): string {
  const out: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out.push(`${key}=${value.length}ch`)
    else if (Array.isArray(value)) out.push(`${key}[]=${value.length}`)
    else if (typeof value === "object" && value !== null) out.push(`${key}={}`)
    else out.push(`${key}=${String(value)}`)
  }
  return out.join(" ")
}

async function main(): Promise<void> {
  await startServer()
  console.log(`=== write-file parameter sweep (proxy chat facade, model=${MODEL}) ===`)
  const doc = htmlDoc(12_000)
  let failed = 0
  for (const c of CASES) {
    if (ONLY && !c.name.includes(ONLY)) continue
    const tool = WRITE_TOOLS[c.tool]!
    const label = `${c.name} [${summarizeArgs(c.args(doc))}]`
    try {
      // Turn 1: ask for the file; expect (or force) a tool call.
      const messages: unknown[] = [
        { role: "system", content: "You are a coding agent. Use the write_file tool to create files. Always call the tool with COMPLETE file content." },
        { role: "user", content: "请创建 pelican-bike.html:实现一个鹈鹕骑自行车的 SVG 动画。必须调用 write_file 工具写入完整文件。" },
      ]
      const t1 = await chatTurn(messages, [tool])
      if (t1.status !== 200 || t1.inStreamError) {
        console.log(`  ${label}: TURN1 FAIL ${t1.status ?? ""} ${t1.httpError ?? t1.inStreamError ?? ""}`)
        failed++
        continue
      }
      // Execute the tool locally and build the replay turn.
      const call = t1.toolCalls[0]
      let args: Args = {}
      try {
        args = call ? (JSON.parse(call.arguments) as Args) : c.args(doc)
      } catch {
        args = c.args(doc)
      }
      // Overwrite the content-bearing args with OUR canonical payload so every
      // case tests the same document in the same shape (the model's own
      // output length varies run to run).
      if ("content" in args) args.content = doc
      if ("parts" in args) {
        const size = Math.ceil(doc.length / 8)
        const parts: string[] = []
        for (let i = 0; i < doc.length; i += size) parts.push(doc.slice(i, i + size))
        args.parts = parts
      }
      if ("edits" in args) args.edits = [{ old: htmlDoc(400), new: doc }]
      if ("replacements" in args) args.replacements = [{ oldString: htmlDoc(400), newString: doc }]
      args.path = "pelican-bike.html"

      const assistant: Record<string, unknown> = { role: "assistant", content: t1.content || null }
      if (c.withAssistantReasoning && t1.reasoning) assistant.reasoning_content = t1.reasoning
      assistant.tool_calls = [{ id: call?.id ?? "call_probe_1", type: "function", function: { name: call?.name ?? "write_file", arguments: JSON.stringify(args) } }]
      messages.push(assistant)
      messages.push({ role: "tool", tool_call_id: call?.id ?? "call_probe_1", content: JSON.stringify({ ok: true, bytes: doc.length }) })
      messages.push({ role: "user", content: "文件已写入。用一句话确认即可,不要输出代码。" })

      const t2 = await chatTurn(messages, [tool])
      if (t2.status !== 200 || t2.inStreamError) {
        console.log(`  ${label}: REPLAY FAIL turn2 HTTP ${t2.status} ${t2.httpError ?? t2.inStreamError ?? ""} finish=${t2.finish ?? "?"}`) // tool_args accepted? -> this line is the signal
        failed++
        continue
      }
      console.log(`  ${label}: OK t1(${t1.content.length}ch,${t1.toolCalls.length}tc) t2(${t2.content.length}ch finish=${t2.finish})`)
    } catch (error) {
      console.log(`  ${label}: EXCEPTION ${String(error).slice(0, 200)}`)
      failed++
    }
  }
  console.log(`sweep finished: ${failed === 0 ? "ALL CLEAN" : `${failed} failing case(s)`}`)
  process.exit(0)
}

await main()
