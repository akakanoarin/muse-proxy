// oa-compat upstream converter: lowers inbound bodies from all three facades
// into an OpenAI Chat Completions request for the zen /v1/chat/completions
// endpoint, and raises the oa-compat SSE stream back into the opencode zen
// Responses events the existing raise layers already understand.
//
// WHY THIS EXISTS: the zen edge routes every model by format, and the two new
// free models only live on the oa-compat format (probed 2026-09-24):
//   - mimo-v2.6-flash-free: on /v1/responses the upstream 500s; the CLI ships
//     it via @ai-sdk/openai-compatible (chat completions).
//   - space-bunny-free: on /v1/responses it 401s "Model space-bunny-free is
//     not supported for format openai".
// muse-spark-1.3-contributor-free keeps using the Responses upstream and the
// untouched lower*.ts path; this module only serves the new models.
//
// Free-tier fingerprint on /v1/chat/completions (probed with the real CLI
// request captured via scripts/capture-opencode-cli.ts):
//   - the header fingerprint is the same as on /v1/responses, EXCEPT the
//     session ids MUST be time-encoded (ms<<12 hex) — random-hex ids trip the
//     FreeTierError gate. identityForCall already produces exactly that.
//   - the body must carry the opencode builtin tool names in the CHAT
//     (nested) tool shape and stream:true for mimo; stubbed descriptions,
//     appended client tools, reasoning_effort, and max_tokens are all fine.
//     space-bunny is looser (works without tools and non-streaming) but we
//     send the same shape for both.
//
// SSE vocabulary of the oa-compat endpoint (probed):
//   mimo: delta.reasoning + reasoning_details chunks, delta.tool_calls with
//         streamed arguments, finish "stop"/"tool_calls", usage chunk, [DONE],
//         then a trailing {"choices":[],"cost":{...}} frame that must be
//         ignored. space-bunny sometimes aggregates the whole message into a
//         single frame and uses delta.reasoning_content instead.

import type { ModelInfo, UpstreamInputItem, UpstreamTool } from "./types.js"
import { appendClientTools } from "./tools.js"
import { clampEffortForModel } from "./types.js"

export type ChatUpstreamRequest = {
  model: string
  messages: Array<Record<string, unknown>>
  stream: true
  max_tokens?: number
  stream_options: { include_usage: true }
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>
  tool_choice?: "auto"
  reasoning_effort?: string
  temperature?: number
  top_p?: number
}

// ---------------------------------------------------------------------------
// Lowering: UpstreamInputItem[] -> chat messages
// ---------------------------------------------------------------------------

function systemItemToMessage(item: Extract<UpstreamInputItem, { role: "system" }>): Record<string, unknown> {
  return { role: "system", content: item.content }
}

function userItemToMessage(item: Extract<UpstreamInputItem, { role: "user" }>): Record<string, unknown> {
  const parts = item.content
  if (parts.length === 1 && parts[0]?.type === "input_text") {
    return { role: "user", content: parts[0].text }
  }
  return {
    role: "user",
    content: parts.map((part) =>
      part.type === "input_text"
        ? { type: "text", text: part.text }
        : { type: "image_url", image_url: { url: part.image_url } },
    ),
  }
}

function assistantItemToMessages(
  item: Extract<UpstreamInputItem, { role: "assistant" }>,
): Record<string, unknown> {
  return { role: "assistant", content: item.content.map((part) => part.text).join("") }
}

function functionCallItemToMessage(item: Extract<UpstreamInputItem, { type: "function_call" }>): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } },
    ],
  }
}

function functionCallOutputItemToMessage(
  item: Extract<UpstreamInputItem, { type: "function_call_output" }>,
): Record<string, unknown> {
  return { role: "tool", tool_call_id: item.call_id, content: item.output }
}

export function lowerInputToMessages(input: UpstreamInputItem[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  for (const item of input) {
    // Encrypted reasoning replay is session-bound; drop (same as muse path).
    if ("type" in item) {
      if (item.type === "function_call") {
        messages.push(functionCallItemToMessage(item))
      } else if (item.type === "function_call_output") {
        messages.push(functionCallOutputItemToMessage(item))
      }
      continue
    }
    if (item.role === "system") {
      messages.push(systemItemToMessage(item))
    } else if (item.role === "user") {
      messages.push(userItemToMessage(item))
    } else {
      messages.push(assistantItemToMessages(item))
    }
  }
  return messages
}

type ChatToolShape = NonNullable<ChatUpstreamRequest["tools"]>

// The oa-compat gate fingerprints the CHAT (nested) tool shape; the facades'
// mergeToolsWithBuiltins produce the flat Responses shape. Convert back.
export function toolsToChatShape(tools: UpstreamTool[]): ChatToolShape {
  return tools.map((tool) => {
    const fn: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean } = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }
    if (tool.strict !== undefined) fn.strict = tool.strict
    return { type: "function" as const, function: fn }
  })
}

export interface LowerChatUpstreamOptions {
  /** Resolved catalog entry (must be an oa-compat model). */
  model: ModelInfo
  /** Lowered input items (from any facade's lower step). */
  input: UpstreamInputItem[]
  /** Flat upstream tools, already merged with the builtin set. */
  tools: UpstreamTool[]
  /** Reasoning effort selected by the facade's own mapping. */
  effort?: string
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

export function lowerChatUpstream(options: LowerChatUpstreamOptions): ChatUpstreamRequest {
  const { model, input, tools } = options
  const request: ChatUpstreamRequest = {
    model: model.id,
    messages: lowerInputToMessages(input),
    stream: true,
    stream_options: { include_usage: true },
  }
  // mimo rejects stream:false on the free tier; space-bunny tolerates it, and
  // the raise layer aggregates either way, so always stream upstream.
  if (options.maxOutputTokens !== undefined) request.max_tokens = options.maxOutputTokens
  const toolList = toolsToChatShape(appendClientTools(tools))
  // The gate requires the builtin names to be present (mimo enforces this in
  // practice; space-bunny does not) — mirror the Responses-path rule.
  if (toolList.length > 0) {
    request.tools = toolList
    request.tool_choice = "auto"
  }
  // Forward the effort only when the model accepts it; "none" clamps to the
  // lowest level instead of tripping space-bunny's upstream 400.
  const effort = clampEffortForModel(model, options.effort)
  if (effort !== undefined) {
    request.reasoning_effort = effort
  }
  if (options.temperature !== undefined) request.temperature = options.temperature
  if (options.topP !== undefined) request.top_p = options.topP
  return request
}

// ---------------------------------------------------------------------------
// Raising: oa-compat SSE chunks -> zen Responses events
// ---------------------------------------------------------------------------

export interface ResponsesEvent {
  type: string
  [key: string]: unknown
}

interface PendingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

// Raises oa-compat chat-completions chunks into the FULL canonical Responses
// event lifecycle. The muse path forwards real zen Responses SSE verbatim
// (including response.created, output_item.added, output_text.done, …);
// oa-compat upstreams only speak chat-completions, so this raiser fabricates
// the same lifecycle: strict Responses SDKs (e.g. OpenAI's) require
// response.created → output_item.added → deltas → output_item.done →
// response.completed ordering, message items closed with output_text.done,
// and a terminal response.completed carrying the usage.
export class OaCompatRaiser {
  private readonly model: string
  private readonly responseId: string
  private readonly createdAt: number
  private toolCalls = new Map<number, PendingToolCall>()
  private usage: Record<string, unknown> | undefined
  private finish: string | null = null
  private started = false
  private openedMessage = false
  private textSoFar = ""
  private messageIndex: number | undefined
  private itemIdSeq = 0

  constructor(model: string, responseId?: string, createdAt?: number) {
    this.model = model
    this.responseId = responseId ?? `resp_${crypto.randomUUID()}`
    this.createdAt = createdAt ?? Math.floor(Date.now() / 1000)
  }

  /** response.created once per stream, lazily before the first event. */
  private ensureStarted(events: ResponsesEvent[]): void {
    if (this.started) return
    this.started = true
    const response = this.terminalResponse(null)
    events.unshift({ type: "response.created", response })
  }

  /** Open the assistant message item lazily before the first text delta. */
  private ensureMessageOpen(events: ResponsesEvent[]): void {
    if (this.openedMessage) return
    this.openedMessage = true
    this.messageIndex = this.itemIdSeq++
    const item = {
      type: "message",
      id: `msg_${this.responseId}`,
      role: "assistant",
      status: "in_progress",
      content: [],
    }
    events.push(
      { type: "response.output_item.added", output_index: this.messageIndex, item },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: this.messageIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
    )
  }

  /** Close the assistant message item when the finish reason arrives. */
  private closeMessage(events: ResponsesEvent[]): void {
    if (!this.openedMessage) return
    this.openedMessage = false
    const itemId = `msg_${this.responseId}`
    events.push(
      {
        type: "response.output_text.done",
        item_id: itemId,
        output_index: this.messageIndex,
        content_index: 0,
        text: this.textSoFar,
      },
      {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: this.messageIndex,
        content_index: 0,
        part: { type: "output_text", text: this.textSoFar },
      },
      {
        type: "response.output_item.done",
        output_index: this.messageIndex,
        item: {
          type: "message",
          id: itemId,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: this.textSoFar }],
        },
      },
    )
  }

  /** Feed one parsed chat-completions chunk; returns zero or more events. */
  handle(chunk: Record<string, unknown>): ResponsesEvent[] {
    const events: ResponsesEvent[] = []
    this.ensureStarted(events)
    if (typeof chunk.usage === "object" && chunk.usage !== null) {
      this.usage = chunk.usage as Record<string, unknown>
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) {
      const record = choice as Record<string, unknown>
      const delta = (record.delta ?? record.message) as Record<string, unknown> | undefined
      if (!delta) continue

      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === "string" && reasoning.length > 0) {
        events.push(this.reasoningDelta(reasoning))
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.ensureMessageOpen(events)
        this.textSoFar += delta.content
        events.push(this.textDelta(delta.content))
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          if (typeof raw !== "object" || raw === null) continue
          const call = raw as Record<string, unknown>
          const index = typeof call.index === "number" ? call.index : 0
          const fn = (typeof call.function === "object" && call.function !== null ? call.function : {}) as Record<string, unknown>
          const existing = this.toolCalls.get(index) ?? { index, id: "", name: "", arguments: "" }
          if (typeof call.id === "string" && call.id) existing.id = call.id
          if (typeof fn.name === "string" && fn.name) existing.name = fn.name
          if (typeof fn.arguments === "string") existing.arguments += fn.arguments
          this.toolCalls.set(index, existing)
        }
      }
      if (typeof record.finish_reason === "string" && record.finish_reason) {
        this.finish = record.finish_reason
      }
    }
    // Close the message item once the stream signals its finish reason, then
    // flush any completed tool calls (all before response.completed).
    if (this.finish !== null) {
      this.closeMessage(events)
      events.push(...this.flushToolCalls())
    }
    return events
  }

  /** Terminal events when the oa-compat stream ends ([DONE] or EOF). */
  finishStream(): ResponsesEvent[] {
    const events: ResponsesEvent[] = []
    if (!this.started) {
      // Degenerate empty stream: still emit a well-formed lifecycle.
      this.ensureStarted(events)
    }
    this.closeMessage(events)
    events.push(...this.flushToolCalls())
    events.push({
      type: "response.completed",
      response: {
        id: this.responseId,
        object: "response",
        created_at: this.createdAt,
        status: "completed",
        model: this.model,
        output: [],
        error: null,
        incomplete_details: null,
        usage: this.usage ? this.mapUsage(this.usage) : null,
      },
    })
    return events
  }

  private terminalResponse(usage: Record<string, unknown> | null): Record<string, unknown> {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status: "completed",
      model: this.model,
      output: [],
      error: null,
      incomplete_details: null,
      usage,
    }
  }

  private flushToolCalls(): ResponsesEvent[] {
    if (this.toolCalls.size === 0) return []
    const events: ResponsesEvent[] = []
    for (const call of [...this.toolCalls.values()].sort((a, b) => a.index - b.index)) {
      events.push({
        type: "response.output_item.done",
        output_index: this.itemIdSeq++,
        item: {
          type: "function_call",
          id: call.id || `call_${call.index}`,
          call_id: call.id || `call_${call.index}`,
          name: call.name,
          arguments: call.arguments,
        },
      })
    }
    this.toolCalls.clear()
    return events
  }

  private textDelta(text: string): ResponsesEvent {
    return {
      type: "response.output_text.delta",
      item_id: `msg_${this.responseId}`,
      output_index: this.messageIndex,
      content_index: 0,
      delta: text,
    }
  }

  private reasoningDelta(text: string): ResponsesEvent {
    return { type: "response.reasoning_text.delta", delta: text }
  }

  private mapUsage(usage: Record<string, unknown>): Record<string, unknown> {
    const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0
    const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0
    const details = (usage.completion_tokens_details ?? null) as Record<string, unknown> | null
    return {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens,
      input_tokens_details: null,
      output_tokens_details: details ? { reasoning_tokens: details.reasoning_tokens ?? null } : null,
    }
  }
}

// Parse one `data:` payload from the oa-compat SSE stream into zero or more
// upstream-shaped events. `null` chunks (cost frames, [DONE]) yield nothing;
// [DONE] is handled by the caller via `isDonePayload`.
export function isDonePayload(payload: string): boolean {
  return payload.trim() === "[DONE]"
}

export function raiseOaCompatChunk(payload: string, raiser: OaCompatRaiser): ResponsesEvent[] {
  let chunk: Record<string, unknown>
  try {
    chunk = JSON.parse(payload) as Record<string, unknown>
  } catch {
    return []
  }
  return raiser.handle(chunk)
}
