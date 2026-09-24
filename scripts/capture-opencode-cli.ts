// Real-CLI capture probe: runs the genuine opencode CLI against a local
// capture server so we can record the exact wire request the CLI emits for
// an oa-compat (openai-compatible) free model. Usage:
//   bun run scripts/capture-opencode-cli.ts [modelId] [port]
import { spawn } from "child_process"
import http from "http"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"

const model = process.argv[2] ?? "mimo-v2.6-flash-free"
const port = Number(process.argv[3] ?? 8901)
// Path to a preinstalled opencode binary (skip bunx resolution entirely).
const bin = process.argv[4] ?? "opencode"
const HOME = "/tmp/oc-home"

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, ".config", "opencode"), { recursive: true })
writeFileSync(
  join(HOME, ".config", "opencode", "opencode.json"),
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    provider: {
      probeprovider: {
        npm: "@ai-sdk/openai-compatible",
        name: "Probe Provider",
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "probe-key" },
        models: {
          [model]: { name: "Probe Model" },
        },
      },
    },
    model: `probeprovider/${model}`,
  }),
)

let n = 0
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", (c) => chunks.push(c as Buffer))
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString()
    writeFileSync(
      `/tmp/capture-${++n}.json`,
      JSON.stringify(
        {
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: (() => {
            try {
              return JSON.parse(body || "{}")
            } catch {
              return body
            }
          })(),
        },
        null,
        2,
      ),
    )
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "captured-by-probe" } }))
  })
})
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r))

const child = spawn(bin, ["run", "-m", `probeprovider/${model}`, "say PONG"], {
  env: { ...process.env, HOME, OPENCODE_DISABLE_AUTOUPDATE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
})
let out = ""
let err = ""
child.stdout.on("data", (d) => (out += d))
child.stderr.on("data", (d) => (err += d))
const code = await new Promise<number>((r) => child.on("exit", r))
console.log("CLI exit:", code)
console.log("CLI out:", out.slice(0, 300))
if (err) console.log("CLI err:", err.slice(0, 600))
console.log("captures:", n)
setTimeout(() => {
  server.close()
  process.exit(0)
}, 500)
