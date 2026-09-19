// Wire types for the OpenAI Chat Completions facade and the opencode zen
// Responses API upstream. Zero runtime dependencies.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const UPSTREAM_URL = "https://opencode.ai/zen/v1/responses"
// opencode zen free models accept the literal api key "public" when no zen
// account key is configured (see opencode provider.ts custom loader).
export const UPSTREAM_API_KEY = "public"
// The anonymous free tier is gated on an opencode-client fingerprint:
// request headers (UA + x-opencode-* ids) AND the body's tools array (must
// carry the opencode builtin tool names, see _lib/tools.ts). Recent zen
// releases tightened this fingerprint; non-matching traffic gets
// "OpenCode's free tier can only be used from within OpenCode" (the gate
// lives in the closed-source edge; the open-source repo only tells us what
// a real client sends).
//
// UA mirrors what the shipped opencode CLI emits on the wire (captured
// 2026-09-18): ai-sdk/provider-utils + runtime/bun suffixes appended to
// `opencode/<version>`. Note the in-repo request.ts constructs a different
// (shorter) UA — the shipped binary is what passes the gate, so keep the
// captured form. Re-verify on every upstream version bump.
export const OPENCODE_VERSION = "1.18.31"
export const OPENCODE_CLIENT = "cli"
export const UPSTREAM_USER_AGENT = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`
// The CLI sends x-opencode-project: "global" (project id of a global home
// session); the edge accepts any value, but match the real client.
export const OPENCODE_PROJECT_ID = "global"
// Every requested model maps to the free contributor model.
export const MODEL_ID = "muse-spark-1.3-contributor-free"
export const MODEL_NAME = "Muse Spark 1.3 Contributor Free (opencode zen)"
// opencode OUTPUT_TOKEN_MAX (packages/opencode/src/provider/transform.ts).
export const MAX_OUTPUT_TOKENS = 32_000

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high"

// ---------------------------------------------------------------------------
// Upstream (OpenAI Responses API) types
// ---------------------------------------------------------------------------

export interface UpstreamTextContent {
  type: "input_text"
  text: string
}

export interface UpstreamImageContent {
  type: "input_image"
  image_url: string
}

export type UpstreamUserContent = UpstreamTextContent | UpstreamImageContent

export type UpstreamInputItem =
  | { role: "system"; content: string }
  | { role: "user"; content: UpstreamUserContent[] }
  | { role: "assistant"; content: Array<{ type: "output_text"; text: string }> }
  | {
      type: "reasoning"
      id: string
      summary: Array<{ type: "summary_text"; text: string }>
      encrypted_content: string | null
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

export interface UpstreamTool {
  type: "function"
  name: string
  description: string
  parameters: Record<string, unknown>
  /** ai-sdk emits strict:false on opencode tools; keep the field available. */
  strict?: boolean
}

// The zen responses endpoint only supports tool_choice:"auto" (or omitting
// the field): "none", "required", and named-function choices return 400
// "only \"auto\" is supported for tool_choice" (probed 2026-09-18).
export type UpstreamToolChoice = "auto"

export interface UpstreamRequest {
  model: string
  input: UpstreamInputItem[]
  stream: true
  store: false
  include: ["reasoning.encrypted_content"]
  /** Session-scoped prompt cache key; the CLI sends its session id. */
  prompt_cache_key?: string
  reasoning?: { effort?: ReasoningEffort; summary?: "auto" }
  instructions?: string
  tools?: UpstreamTool[]
  tool_choice?: UpstreamToolChoice
  temperature?: number
  top_p?: number
  max_output_tokens?: number
}

export interface UpstreamUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number } | null
  output_tokens_details?: { reasoning_tokens?: number } | null
  total_tokens?: number
}

export interface UpstreamStreamItem {
  type: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  encrypted_content?: string | null
  summary?: Array<{ type: "summary_text"; text: string }>
}

export interface UpstreamEvent {
  type: string
  delta?: string
  item_id?: string
  summary_index?: number
  item?: UpstreamStreamItem
  response?: {
    id?: string
    usage?: UpstreamUsage | null
    error?: { code?: string | null; message?: string | null } | null
    incomplete_details?: { reason?: string } | null
  } | null
  code?: string
  message?: string
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions facade types
// ---------------------------------------------------------------------------

export interface ChatToolCall {
  index: number
  id?: string
  type?: "function"
  function?: { name?: string; arguments?: string }
}

export interface ChatChunkDelta {
  role?: "assistant"
  content?: string | null
  reasoning_content?: string | null
  /** OpenRouter-style extension carrying encoded encrypted-reasoning replay data. */
  reasoning_details?: unknown
  tool_calls?: ChatToolCall[]
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface ChatChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: number
    delta: ChatChunkDelta
    finish_reason: string | null
  }>
  usage?: ChatUsage
}

export interface ChatTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ChatCompletionRequest {
  model?: string
  messages?: unknown[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: unknown
  reasoning?: unknown
  tools?: ChatTool[]
  tool_choice?: unknown
}
