// Probe (not part of the test suite): the exact user field report —
// "给我创建一个html,实现一个鹈鹕骑自行车的svg动画" sent VERBATIM to
// space-bunny-free through the real proxy chat facade, then continued
// conversationally like a real client (assistant replay + follow-ups),
// watching for the "works for a few sentences then keeps erroring" pattern.
//   bun run scripts/probe-spacebunny-pelican.ts            (through the proxy)
//   MODEL=mimo-v2.6-flash-free bun run ...                 (control)
//   TURNS=10 REPLAY_REASONING=0 bun run ...                (variants)

import * as http from "node:http"
import { handleChatRequest } from "../api/chat"

const PORT = 8967
const KEY = process.env.PROXY_API_KEY ?? "probe-key"
const MODEL = process.env.MODEL ?? "space-bunny-free"
const MAX_TURNS = Number(process.env.TURNS ?? 8)
const REPLAY_REASONING = process.env.REPLAY_REASONING !== "0"

const FIRST_MESSAGE = "给我创建一个html,实现一个鹈鹕骑自行车的svg动画"

const FOLLOW_UPS = [
  "很好,请把鹈鹕的喙做大一点,再加上海鸥背景,输出完整代码。",
  "继续,给车轮加上辐条并让它们转动起来,输出完整代码。",
  "再改进一下:鹈鹕腿部要有踩踏板动作,输出完整代码。",
  "换成日落配色,加上渐变天空,输出完整代码。",
  "最后加一个“重新播放”按钮,输出完整代码。",
]

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

interface TurnResult {
  status: number
  httpError: string | null
  content: string
  reasoning: string
  finish: string | null
  sawDone: boolean
  inStreamError: string | null
  unparseable: number
  chunks: number
}

async function chatTurn(messages: unknown[]): Promise<TurnResult> {
  const result: TurnResult = {
    status: 0, httpError: null, content: "", reasoning: "", finish: null,
    sawDone: false, inStreamError: null, unparseable: 0, chunks: 0,
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, stream: true, messages }),
    signal: AbortSignal.timeout(600_000),
  })
  result.status = res.status
  if (res.status !== 200) {
    result.httpError = (await res.text()).replace(/\s+/g, " ").slice(0, 400)
    return result
  }
  if (!res.body) {
    result.httpError = "no body"
    return result
  }
  const decoder = new TextDecoder()
  let buffer = ""
  const reader = res.body.getReader()
  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload.length === 0) continue
      if (payload === "[DONE]") {
        result.sawDone = true
        break outer
      }
      result.chunks++
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null }>
          error?: { message?: string } | string
        }
        if (chunk.error) {
          result.inStreamError = typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? JSON.stringify(chunk.error)
        }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {}
          if (typeof delta.content === "string") result.content += delta.content
          if (typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content
          if (typeof delta.reasoning === "string") result.reasoning += delta.reasoning
          if (typeof choice.finish_reason === "string" && choice.finish_reason) result.finish = choice.finish_reason
        }
      } catch {
        result.unparseable++
      }
    }
  }
  return result
}

async function main(): Promise<void> {
  await startServer()
  console.log(`=== pelican probe (proxy chat facade, model=${MODEL}, turns<=${MAX_TURNS}) ===`)
  console.log(`first message: ${JSON.stringify(FIRST_MESSAGE)}`)
  const messages: unknown[] = [{ role: "user", content: FIRST_MESSAGE }]
  let failures = 0
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const started = Date.now()
    const result = await chatTurn(messages)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const problems: string[] = []
    if (result.httpError) problems.push(`HTTP ${result.status}: ${result.httpError}`)
    if (result.inStreamError) problems.push(`in-stream error: ${result.inStreamError}`)
    if (!result.sawDone) problems.push("stream closed WITHOUT [DONE]")
    if (!result.finish && !result.httpError) problems.push("no finish_reason")
    if (result.unparseable > 0) problems.push(`${result.unparseable} unparseable data lines`)
    if (result.content.includes("[muse-proxy upstream error]")) problems.push("proxy error notice in content")
    const ok = problems.length === 0
    if (!ok) failures++
    console.log(
      `turn ${turn} [${seconds}s] ${ok ? "OK" : "FAIL"} status=${result.status} finish=${result.finish ?? "?"} ` +
      `content=${result.content.length}ch reasoning=${result.reasoning.length}ch chunks=${result.chunks} done=${result.sawDone}`,
    )
    for (const problem of problems) console.log(`  !! ${problem}`)
    if (result.content.length > 0) console.log(`  head: ${JSON.stringify(result.content.slice(0, 120))}`)
    if (!ok && failures >= 2) {
      console.log("two consecutive failures — stopping")
      break
    }
    // Replay the assistant turn the way a real OpenAI-compatible agent does.
    const assistant: Record<string, unknown> = { role: "assistant", content: result.content }
    if (REPLAY_REASONING && result.reasoning.length > 0) assistant.reasoning_content = result.reasoning
    messages.push(assistant)
    messages.push({ role: "user", content: FOLLOW_UPS[(turn - 1) % FOLLOW_UPS.length] })
  }
  console.log(`pelican probe finished: ${failures === 0 ? "ALL CLEAN" : `${failures} failed turn(s)`}`)
  process.exit(0)
}

await main()
