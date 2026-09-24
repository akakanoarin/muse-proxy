// Probe (not part of the test suite): find the space-bunny-free upstream 400
// trigger ("invalid_request_error: invalid request" mid-conversation in the
// field) by replaying SYNTHETIC large histories directly against the real
// upstream (network required). No long generations: each request asks for a
// short answer, so a full size sweep runs in well under a minute.
// Usage: bun run scripts/probe-spacebunny-size.ts [model ...]
//
// Shapes tested per model:
//   S<k>:  system + user(penguin ask) + assistant(<k>-char HTML) + user(short)
//   D<k>:  two big assistant turns (<k> chars each) + short final user
// A 200 means the shape is accepted; 400/429 prints the upstream body.

export {}

const OA_COMPAT_URL = "https://opencode.ai/zen/v1/chat/completions"
const MODELS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["space-bunny-free", "mimo-v2.6-flash-free"]

function headersFor(callId: string) {
  // Realistic 26-char opencode ids (12 hex time component + 14 base62).
  const time = Date.now().toString(16).slice(-12).padStart(12, "0")
  const rand = Math.random().toString(36).slice(2).padEnd(14, "0").slice(0, 14)
  const sid = `ses_${time}${rand}`
  const rid = `msg_${time}${rand}`
  return {
    authorization: "Bearer public",
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
    "x-opencode-session": sid,
    "x-opencode-request": rid,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-probe-call": callId,
  }
}

// Deterministic-ish synthetic HTML: a penguin-riding-a-bicycle SVG animation
// whose sections repeat with varying numbers so the content is realistic and
// not a single repeated token.
function synthHtml(chars: number): string {
  const base = `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><title>企鹅骑自行车</title>
<style>
body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:linear-gradient(#dff3ff,#fff)}
.scene{width:600px}
.wheel{animation:spin 1.2s linear infinite;transform-origin:center}
@keyframes spin{to{transform:rotate(360deg)}}
.penguin{animation:bob 0.6s ease-in-out infinite alternate}
@keyframes bob{to{transform:translateY(-6px)}}
.road{stroke-dasharray:24 12;animation:move 0.8s linear infinite}
@keyframes move{to{stroke-dashoffset:-36}}
</style></head>
<body><div class="scene">
<svg viewBox="0 0 600 400" xmlns="http://www.w3.org/2000/svg">
<g class="penguin">
<ellipse cx="300" cy="200" rx="46" ry="58" fill="#223"/>
<ellipse cx="300" cy="190" rx="34" ry="46" fill="#fff"/>
<circle cx="300" cy="140" r="24" fill="#223"/>
<circle cx="292" cy="136" r="3" fill="#fff"/><circle cx="308" cy="136" r="3" fill="#fff"/>
<polygon points="300,144 316,150 300,154" fill="#f90"/>
<rect x="270" y="196" width="44" height="10" rx="5" fill="#e62"/>
</g>
<g class="wheel"><circle cx="220" cy="290" r="52" fill="none" stroke="#333" stroke-width="6"/>
<line x1="220" y1="238" x2="220" y2="342" stroke="#999" stroke-width="2"/>
<line x1="168" y1="290" x2="272" y2="290" stroke="#999" stroke-width="2"/></g>
<g class="wheel"><circle cx="400" cy="290" r="52" fill="none" stroke="#333" stroke-width="6"/>
<line x1="400" y1="238" x2="400" y2="342" stroke="#999" stroke-width="2"/>
<line x1="348" y1="290" x2="452" y2="290" stroke="#999" stroke-width="2"/></g>
<line class="road" x1="0" y1="350" x2="600" y2="350" stroke="#555" stroke-width="4"/>
</svg></div></body></html>`
  const blocks: string[] = [base]
  let total = base.length
  let i = 0
  while (total < chars) {
    i++
    const block = `\n<!-- section ${i}: extra scene details, comment ${i} -->\n<!-- 变体说明 ${i}: 调整车轮半径为 ${40 + (i % 12)}px, 背景色 #%${(i * 7) % 255},${(i * 13) % 255},${(i * 29) % 255}, 动画时长 ${(0.6 + (i % 9) / 10).toFixed(1)}s -->\n<div class="note">设计变体 ${i}:保持组件语义化与可访问性,尊重 prefers-reduced-motion,并确保键盘可达。</div>`
    blocks.push(block)
    total += block.length
  }
  return blocks.join("")
}

interface Case {
  name: string
  assistantSizes: number[]
  effort?: string
}

async function runCase(model: string, c: Case): Promise<void> {
  const messages: unknown[] = [
    { role: "system", content: "You are a senior front-end engineer." },
    { role: "user", content: "写一个 HTML 页面:企鹅骑自行车的 SVG 动画。先输出完整代码。" },
  ]
  for (const size of c.assistantSizes) {
    messages.push({ role: "assistant", content: synthHtml(size) })
    if (size !== c.assistantSizes[c.assistantSizes.length - 1]) {
      messages.push({ role: "user", content: "再补充一个深色模式变体,输出完整代码。" })
    }
  }
  messages.push({ role: "user", content: "用 50 字总结上面代码的动画实现要点,不要输出代码。" })

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    max_tokens: 32,
  }
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8")
  const totalChars = c.assistantSizes.reduce((a, b) => a + b, 0)
  try {
    const res = await fetch(OA_COMPAT_URL, {
      method: "POST",
      headers: headersFor(`size-${model}-${c.name}`),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) {
      const text = await res.text()
      console.log(`  ${model} ${c.name} (~${totalChars}ch, ${bytes}B): HTTP ${res.status} — ${text.replace(/\s+/g, " ").slice(0, 220)}`)
      return
    }
    const text = await res.text()
    let out = 0
    try {
      const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }
      out = (parsed.choices?.[0]?.message?.content ?? "").length
    } catch {
      // non-JSON 200 body: report head
      console.log(`  ${model} ${c.name} (~${totalChars}ch, ${bytes}B): 200 non-JSON: ${text.replace(/\s+/g, " ").slice(0, 120)}`)
      return
    }
    console.log(`  ${model} ${c.name} (~${totalChars}ch, ${bytes}B): 200 out=${out}ch`)
  } catch (error) {
    console.log(`  ${model} ${c.name}: FETCH FAILED — ${String(error).slice(0, 160)}`)
  }
}

const CASES: Case[] = [
  { name: "S50k", assistantSizes: [50_000] },
  { name: "S80k", assistantSizes: [80_000] },
  { name: "S120k", assistantSizes: [120_000] },
  { name: "S160k", assistantSizes: [160_000] },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const model of MODELS) {
  console.log(`\n=== ${model} ===`)
  for (const c of CASES) {
    await runCase(model, c)
    await sleep(1200)
  }
}
console.log("\ndone")
