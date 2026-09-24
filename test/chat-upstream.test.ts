// Unit tests for the oa-compat upstream converter (chat-upstream.ts):
// lowering to chat-completions wire shape and raising chat-completions SSE
// back into a FULL canonical Responses event lifecycle.

import { describe, expect, it } from "vitest"
import { OaCompatRaiser, isDonePayload, lowerChatUpstream, lowerInputToMessages, toolsToChatShape } from "../api/_lib/chat-upstream"
import { MODELS, resolveModel, MODEL_MUSE, type UpstreamInputItem } from "../api/_lib/types"
import { modelsList } from "../api/models"

describe("lowerInputToMessages", () => {
  it("lowers system/user/assistant roles", () => {
    const input: UpstreamInputItem[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ]
    expect(lowerInputToMessages(input)).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ])
  })

  it("lowers multi-part user content to text/image_url blocks", () => {
    const input: UpstreamInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,xx" }] },
    ]
    expect(lowerInputToMessages(input)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
        ],
      },
    ])
  })

  it("replays function_call round-trips as assistant tool_calls + tool result", () => {
    const input: UpstreamInputItem[] = [
      { type: "function_call", call_id: "call_1", name: "echo", arguments: "{\"text\":\"hi\"}" },
      { type: "function_call_output", call_id: "call_1", output: "echoed: hi" },
    ]
    expect(lowerInputToMessages(input)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "echoed: hi" },
    ])
  })

  it("drops reasoning replay items (session-bound blobs)", () => {
    const input = [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
    ] as unknown as UpstreamInputItem[]
    expect(lowerInputToMessages(input)).toEqual([])
  })
})

describe("lowerChatUpstream", () => {
  it("targets the resolved model id and always streams with usage", () => {
    const request = lowerChatUpstream({
      model: MODELS["mimo-v2.6-flash-free"]!,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [],
    })
    expect(request.model).toBe("mimo-v2.6-flash-free")
    expect(request.stream).toBe(true)
    expect(request.stream_options).toEqual({ include_usage: true })
  })

  it("carries the builtin gate tools in chat-nested shape", () => {
    const request = lowerChatUpstream({
      model: MODELS["space-bunny-free"]!,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [],
    })
    expect(Array.isArray(request.tools)).toBe(true)
    expect(request.tools!.length).toBeGreaterThan(5)
    expect(request.tool_choice).toBe("auto")
    for (const tool of request.tools!) {
      expect(tool.type).toBe("function")
      expect(typeof tool.function.name).toBe("string")
    }
  })

  it("skips reasoning_effort for models without efforts (mimo)", () => {
    const mimo = lowerChatUpstream({
      model: MODELS["mimo-v2.6-flash-free"]!,
      input: [],
      tools: [],
      effort: "high",
    })
    expect(mimo.reasoning_effort).toBeUndefined()

    const bunny = lowerChatUpstream({
      model: MODELS["space-bunny-free"]!,
      input: [],
      tools: [],
      effort: "xhigh",
    })
    expect(bunny.reasoning_effort).toBe("xhigh")
  })

  it("maps maxOutputTokens to max_tokens", () => {
    const request = lowerChatUpstream({
      model: MODELS["mimo-v2.6-flash-free"]!,
      input: [],
      tools: [],
      maxOutputTokens: 4096,
    })
    expect(request.max_tokens).toBe(4096)
  })
})

describe("toolsToChatShape", () => {
  it("converts flat Responses tools to chat-nested shape, preserving strict", () => {
    const chat = toolsToChatShape([
      { type: "function", name: "a", description: "da", parameters: { type: "object" }, strict: true },
      { type: "function", name: "b", description: "", parameters: {} },
    ])
    expect(chat).toEqual([
      { type: "function", function: { name: "a", description: "da", parameters: { type: "object" }, strict: true } },
      { type: "function", function: { name: "b", description: "", parameters: {} } },
    ])
  })
})

describe("effort clamping per model", () => {
  it("mimo: effort always dropped (reasoning always on, no levels)", () => {
    const request = lowerChatUpstream({ model: MODELS["mimo-v2.6-flash-free"]!, input: [], tools: [], effort: "high" })
    expect(request.reasoning_effort).toBeUndefined()
  })

  it("space-bunny: accepted levels forwarded, none clamped to minimal", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const request = lowerChatUpstream({ model: MODELS["space-bunny-free"]!, input: [], tools: [], effort: level })
      expect(request.reasoning_effort).toBe(level)
    }
    const none = lowerChatUpstream({ model: MODELS["space-bunny-free"]!, input: [], tools: [], effort: "none" })
    expect(none.reasoning_effort).toBe("minimal")
  })

  it("clampEffortForModel: unknown values dropped, muse whitelist untouched", () => {
    const muse = resolveModel(MODEL_MUSE)
    expect(muse.efforts).toContain("none")
    const garbage = lowerChatUpstream({ model: MODELS["space-bunny-free"]!, input: [], tools: [], effort: "ultra" })
    expect(garbage.reasoning_effort).toBeUndefined()
  })
})

describe("/v1/models catalog", () => {
  const created = 1_758_000_000
  const list = modelsList(created)

  it("lists all three free models with reasoning metadata", () => {
    const ids = list.data.map((m: { id: string }) => m.id)
    expect(ids).toEqual([
      "muse-spark-1.3-contributor-free",
      "mimo-v2.6-flash-free",
      "space-bunny-free",
    ])
    for (const entry of list.data) {
      expect(entry.object).toBe("model")
      expect(Array.isArray(entry.reasoning_levels)).toBe(true)
      expect(typeof entry.reasoning).toBe("boolean")
    }
  })

  it("advertises the probed effort levels per model", () => {
    const byId = new Map(
      list.data.map((m: { id: string }) => [m.id, m as unknown as { reasoning: boolean; reasoning_levels: string[] }]),
    )
    expect(byId.get("mimo-v2.6-flash-free")!.reasoning_levels).toEqual([])
    expect(byId.get("mimo-v2.6-flash-free")!.reasoning).toBe(true)
    expect(byId.get("space-bunny-free")!.reasoning_levels).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"])
    expect(byId.get("muse-spark-1.3-contributor-free")!.reasoning_levels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
  })
})

describe("OaCompatRaiser: canonical Responses lifecycle", () => {
  const MODEL = "mimo-v2.6-flash-free"

  function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return { choices: [{ index: 0, delta, finish_reason: null }], ...extra }
  }

  it("emits response.created before anything else, then item lifecycle and response.completed", () => {
    const raiser = new OaCompatRaiser(MODEL, "resp_test_1", 123)
    const events = [
      ...raiser.handle(chunk({ content: "He" })),
      ...raiser.handle(chunk({ content: "y" }, { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })),
      ...raiser.handle({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ...raiser.finishStream(),
    ]
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("response.created")
    expect(types).toContain("response.output_item.added")
    expect(types).toContain("response.output_text.delta")
    expect(types).toContain("response.output_text.done")
    expect(types).toContain("response.output_item.done")
    expect(types.at(-1)).toBe("response.completed")

    // ordering: created < added < deltas < done < completed
    const indexOf = (t: string) => types.indexOf(t)
    expect(indexOf("response.created")).toBeLessThan(indexOf("response.output_item.added"))
    expect(indexOf("response.output_item.added")).toBeLessThan(indexOf("response.output_text.delta"))
    expect(indexOf("response.output_text.delta")).toBeLessThan(indexOf("response.output_text.done"))
    expect(indexOf("response.output_text.done")).toBeLessThan(indexOf("response.completed"))

    const completed = events.at(-1) as unknown as { response: { usage: Record<string, unknown>; status: string } }
    expect(completed.response.status).toBe("completed")
    expect(completed.response.usage).toEqual({
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      input_tokens_details: null,
      output_tokens_details: null,
    })

    const itemDone = events.find((e) => e.type === "response.output_item.done" && (e.item as { type?: string }).type === "message") as unknown as { item: { content: Array<{ type: string; text: string }> } } | undefined
    expect(itemDone).toBeDefined()
    expect(itemDone!.item.content[0]!.text).toBe("Hey")
  })

  it("reasoning deltas stream as reasoning_text.delta before the message item", () => {
    const raiser = new OaCompatRaiser(MODEL, "resp_test_2", 123)
    const events = [
      ...raiser.handle(chunk({ reasoning_content: "think" })),
      ...raiser.handle(chunk({ content: "answer" })),
      ...raiser.handle({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ...raiser.finishStream(),
    ]
    const types = events.map((e) => e.type)
    expect(types).toContain("response.reasoning_text.delta")
    const reasoningIdx = types.indexOf("response.reasoning_text.delta")
    const addedIdx = types.indexOf("response.output_item.added")
    expect(reasoningIdx).toBeGreaterThan(0) // after response.created
    expect(addedIdx).toBeGreaterThan(reasoningIdx)
  })

  it("tool calls flush as function_call items with streamed arguments before completion", () => {
    const raiser = new OaCompatRaiser("space-bunny-free", "resp_test_3", 123)
    const events = [
      ...raiser.handle(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: "{\"te" } }] })),
      ...raiser.handle(chunk({ tool_calls: [{ index: 0, function: { arguments: "xt\":\"hi\"}" } }] })),
      ...raiser.handle({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      ...raiser.finishStream(),
    ]
    const toolDone = events.filter((e) => e.type === "response.output_item.done" && (e.item as { type?: string }).type === "function_call")
    expect(toolDone).toHaveLength(1)
    const item = (toolDone[0] as unknown as { item: { call_id: string; name: string; arguments: string } }).item
    expect(item.call_id).toBe("call_1")
    expect(item.name).toBe("echo")
    expect(item.arguments).toBe("{\"text\":\"hi\"}")

    const completedIdx = events.map((e) => e.type).lastIndexOf("response.completed")
    expect(events.map((e) => e.type).indexOf("response.output_item.done")).toBeLessThan(completedIdx)
  })

  it("ignores the trailing cost frame (choices: []) and malformed JSON", () => {
    const raiser = new OaCompatRaiser(MODEL, "resp_test_4", 123)
    // The cost frame yields no choice-level events; only the lazy lifecycle
    // opener (response.created) may come out, never any delta/done noise.
    const costEvents = raiser.handle({ choices: [], cost: { input: 1 } })
    expect(costEvents.every((e) => e.type === "response.created")).toBe(true)
    expect(isDonePayload("[DONE]")).toBe(true)
    expect(isDonePayload("{}")).toBe(false)
  })

  it("degenerate empty stream still yields created -> completed", () => {
    const raiser = new OaCompatRaiser(MODEL, "resp_test_5", 123)
    const events = raiser.finishStream()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("response.created")
    expect(types.at(-1)).toBe("response.completed")
  })
})
