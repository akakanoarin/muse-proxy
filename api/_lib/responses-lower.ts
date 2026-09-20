// Normalize an inbound OpenAI Responses API request body into an opencode zen
// upstream Responses request. Unlike the chat facade (lower.ts), no semantic
// lowering is required — the upstream already speaks the Responses API — so
// this module only:
//   1. normalizes input shapes (string input, message items, tool items,
//      encrypted-reasoning replay items) into UpstreamInputItem[],
//   2. re-applies the muse-specific fingerprint rules shared with the chat
//      facade: store:false, include reasoning.encrypted_content, reasoning
//      summary "auto", effort whitelisting, the full opencode builtin tool
//      set (stubbed descriptions) with client tools appended, and
//      tool_choice forced to "auto" (the only value upstream accepts).
//
// Kept separate from lower.ts on purpose: the chat completions facade must
// stay byte-for-byte untouched, so no shared mutable logic is modified.

import {
  DEFAULT_REASONING_EFFORT,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type UpstreamInputItem,
  type UpstreamRequest,
  type UpstreamTool,
  type UpstreamToolChoice,
} from "./types.js"
import { appendClientTools } from "./tools.js"

export type NormalizeResult =
  | { request: UpstreamRequest; stream: boolean }
  | { error: { status: number; message: string; code?: string } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function normalizeEffort(value: unknown): ReasoningEffort {
  if (typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as ReasoningEffort
  }
  return DEFAULT_REASONING_EFFORT
}

function extractEffort(body: Record<string, unknown>): ReasoningEffort {
  if (isRecord(body.reasoning) && body.reasoning.effort !== undefined) {
    return normalizeEffort(body.reasoning.effort)
  }
  return DEFAULT_REASONING_EFFORT
}

function imageToDataUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.url === "string") return value.url
  return undefined
}

// User message content: a string or input_text/input_image content parts.
function userContentToParts(content: unknown):
  | { parts: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> }
  | { error: true } {
  const parts: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = []

  if (typeof content === "string") {
    parts.push({ type: "input_text", text: content })
    return { parts }
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) return { error: true }
      if (part.type === "input_text" && typeof part.text === "string") {
        parts.push({ type: "input_text", text: part.text })
        continue
      }
      if (part.type === "input_image") {
        const url = imageToDataUrl(part.image_url)
        if (url === undefined) return { error: true }
        parts.push({ type: "input_image", image_url: url })
        continue
      }
      return { error: true }
    }
    if (parts.length === 0) return { error: true }
    return { parts }
  }

  return { error: true }
}

// Assistant message content: a string or output_text/refusal content parts.
function assistantContentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      if (!isRecord(part)) return undefined
      if ((part.type === "output_text" || part.type === "refusal") && typeof part.text === "string") {
        texts.push(part.text)
        continue
      }
      return undefined
    }
    return texts.join("")
  }
  return undefined
}

// System/developer message content: a string or input_text parts.
function systemContentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      if (!isRecord(part)) return undefined
      if (part.type === "input_text" && typeof part.text === "string") {
        texts.push(part.text)
        continue
      }
      return undefined
    }
    return texts.join("\n")
  }
  return undefined
}

// Encrypted-reasoning replay items: with store:false upstream 400s on items
// without encrypted_content (see reasoning.ts), so items missing it are
// dropped, mirroring opencode's own store:false filter. Everything else is
// passed through verbatim — the inbound shape IS the upstream shape.
function reasoningReplayItem(item: Record<string, unknown>): UpstreamInputItem | undefined {
  const id = asString(item.id)
  const encryptedContent = asString(item.encrypted_content)
  if (id === undefined || id.length === 0) return undefined
  if (encryptedContent === undefined || encryptedContent.length === 0) return undefined
  const summary: Array<{ type: "summary_text"; text: string }> = []
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (isRecord(part) && part.type === "summary_text" && typeof part.text === "string") {
        summary.push({ type: "summary_text", text: part.text })
      }
    }
  }
  return { type: "reasoning", id, summary, encrypted_content: encryptedContent }
}

function functionCallItem(item: Record<string, unknown>): UpstreamInputItem | { error: true } {
  const callId = asString(item.call_id)
  const name = asString(item.name)
  if (callId === undefined || name === undefined) return { error: true }
  const args = asString(item.arguments) ?? "{}"
  return { type: "function_call", call_id: callId, name, arguments: args }
}

function functionCallOutputItem(item: Record<string, unknown>): UpstreamInputItem | { error: true } {
  const callId = asString(item.call_id)
  if (callId === undefined) return { error: true }
  const raw = item.output
  let output: string
  if (typeof raw === "string") {
    output = raw
  } else if (Array.isArray(raw) || isRecord(raw)) {
    output = JSON.stringify(raw)
  } else if (raw === undefined || raw === null) {
    output = ""
  } else if (typeof raw === "number" || typeof raw === "boolean") {
    output = String(raw)
  } else {
    return { error: true }
  }
  return { type: "function_call_output", call_id: callId, output }
}

function messageItem(item: Record<string, unknown>, state: { systemTexts: string[] }): UpstreamInputItem[] | { error: true } {
  const role = asString(item.role)
  if (role === "system" || role === "developer") {
    const text = systemContentToText(item.content)
    if (text === undefined) return { error: true }
    state.systemTexts.push(text)
    return []
  }

  if (role === "user") {
    const parts = userContentToParts(item.content)
    if ("error" in parts) return { error: true }
    return [{ role: "user", content: parts.parts }]
  }

  if (role === "assistant") {
    const text = assistantContentToText(item.content)
    if (text === undefined) return { error: true }
    if (text.length === 0) return []
    return [{ role: "assistant", content: [{ type: "output_text", text }] }]
  }

  return { error: true }
}

// One inbound input item (of either the shorthand `{role, content}` form or
// the typed `{type: ...}` form) into zero or more upstream items.
function normalizeInputItem(
  entry: unknown,
  state: { systemTexts: string[] },
): UpstreamInputItem[] | { error: true } {
  if (!isRecord(entry)) return { error: true }

  const type = asString(entry.type)

  if (type === undefined || type === "message") {
    return messageItem(entry, state)
  }

  if (type === "function_call") {
    const item = functionCallItem(entry)
    return "error" in item ? item : [item]
  }

  if (type === "function_call_output") {
    const item = functionCallOutputItem(entry)
    return "error" in item ? item : [item]
  }

  if (type === "reasoning") {
    const item = reasoningReplayItem(entry)
    return item ? [item] : []
  }

  if (type === "item_reference") {
    // Stateless proxy: there is no stored response to reference.
    return { error: true }
  }

  return { error: true }
}

// Same rule as the chat facade: always send the full builtin set (stubbed
// descriptions) first, then the client's own function tools. The Responses
// API tool shape is flat ({type:"function", name, ...}), but clients that
// mistakenly send the chat-nested shape are tolerated.
function mergeToolsWithBuiltins(value: unknown): UpstreamTool[] {
  const client: UpstreamTool[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue
      let name: string | undefined
      let description: string | undefined
      let parameters: Record<string, unknown> | undefined
      if (entry.type === "function") {
        name = asString(entry.name)
        description = asString(entry.description)
        parameters = isRecord(entry.parameters) ? entry.parameters : undefined
        if (name === undefined && isRecord(entry.function)) {
          // Chat-nested shape fallback.
          const fn = entry.function
          name = asString(fn.name)
          description = asString(fn.description) ?? description
          parameters = isRecord(fn.parameters) ? fn.parameters : parameters
        }
      }
      if (name === undefined) continue
      client.push({
        type: "function",
        name,
        description: description ?? "",
        parameters: parameters ?? { type: "object", properties: {} },
      })
    }
  }
  return appendClientTools(client)
}

function clampMaxOutputTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), MAX_OUTPUT_TOKENS)
}

export interface NormalizeOptions {
  /** opencode session id used as the upstream prompt_cache_key. */
  sessionId?: string
}

export function normalizeResponsesRequest(body: unknown, options: NormalizeOptions = {}): NormalizeResult {
  if (!isRecord(body)) {
    return { error: { status: 400, message: "request body must be a JSON object" } }
  }

  // Stateless proxy: previous_response_id requires server-side storage.
  const previousResponseId = body.previous_response_id
  if (previousResponseId !== undefined && previousResponseId !== null && previousResponseId !== "") {
    return {
      error: {
        status: 400,
        message: "previous_response_id is not supported: this proxy is stateless; send the full conversation in `input` instead",
        code: "previous_response_id_unsupported",
      },
    }
  }

  const state = { systemTexts: [] as string[] }
  const input: UpstreamInputItem[] = []

  const instructions = asString(body.instructions)
  if (instructions !== undefined) state.systemTexts.push(instructions)

  const rawInput = body.input
  if (typeof rawInput === "string") {
    input.push({ role: "user", content: [{ type: "input_text", text: rawInput }] })
  } else if (Array.isArray(rawInput)) {
    for (const entry of rawInput) {
      const items = normalizeInputItem(entry, state)
      if ("error" in items) {
        return { error: { status: 400, message: "unsupported input item", code: "unsupported_input_item" } }
      }
      input.push(...items)
    }
  } else {
    return { error: { status: 400, message: "`input` is required and must be a string or an array of items", code: "missing_input" } }
  }

  const request: UpstreamRequest = {
    model: MODEL_ID,
    input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: extractEffort(body), summary: "auto" },
  }
  if (options.sessionId) request.prompt_cache_key = options.sessionId

  if (state.systemTexts.length > 0) {
    request.input = [{ role: "system", content: state.systemTexts.join("\n") }, ...request.input]
  }

  // Free-tier fingerprint: full opencode builtin set + client tools;
  // tool_choice is always "auto" upstream (same as the chat facade).
  request.tools = mergeToolsWithBuiltins(body.tools)
  request.tool_choice = "auto" as UpstreamToolChoice

  if (typeof body.temperature === "number") request.temperature = body.temperature
  if (typeof body.top_p === "number") request.top_p = body.top_p
  const maxOutputTokens = clampMaxOutputTokens(body.max_output_tokens)
  if (maxOutputTokens !== undefined) request.max_output_tokens = maxOutputTokens

  const wantsStream = body.stream === true
  return { request, stream: wantsStream }
}
