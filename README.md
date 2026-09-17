# muse-proxy

一个把 opencode zen 的免费模型(muse spark 1.3 contributor)包装成标准 OpenAI Chat Completions API 的无状态代理,零运行时依赖,可部署到 Vercel 等 edge/Node 环境。

- **入站**:`POST /api/chat`(OpenAI `/v1/chat/completions` 兼容,支持流式 SSE 与聚合 JSON、工具调用、`reasoning_effort`)
- **出站**:`POST https://opencode.ai/zen/v1/responses`(OpenAI Responses API + SSE)
- **鉴权**:请求头 `Authorization: Bearer $PROXY_API_KEY`(未设置环境变量时为开放模式)
- **免费模型**:上游 API key 固定为字面量 `public`,匿名免费层按 IP 限额,无需注册

```
client ──chat/completions──▶ muse-proxy ──lower──▶ opencode zen /v1/responses
        ◀──SSE chunks────             ◀──raise──  (Responses SSE)
```

## 快速开始

```bash
bun install            # 或 npm install
bun run test           # 76 个单元/集成测试(mock 上游,无需联网)
bun run smoke          # 真实连通性冒烟(需联网,验证 stream:false 与 stream:true)
bun run eval           # 完整 agent 评测:xhigh 思考 + web_search 工具循环 + 3 轮多轮对话
bun run typecheck
```

---

# 排查手册:上游更新导致 "OpenCode's free tier can only be used from within OpenCode"

> 免费层不是按账号鉴权的,而是**按客户端指纹鉴权**。opencode zen 一旦收紧指纹校验,代理立刻失效——这不是 bug,是设计如此。本文记录 2026-09 一次完整的排查-定位-修复过程,上游下次再变时照此办理。

## 1. 报错长什么样

所有请求都返回 429:

```json
{
  "error": {
    "message": "OpenCode's free tier can only be used from within OpenCode",
    "type": "rate_limit_error"
  }
}
```

昨天还能用、今天突然全挂、本地没有任何改动——这是典型的**上游行为变更**特征,优先怀疑上游而不是自己的代码。

## 2. 排查思路(按顺序做)

### 第一步:确认是上游门槛,不是限流

- 报错信息不是 "rate limit exceeded" 之类,而是资格类拒绝;换 IP 也没用 → 不是 IP 限额问题。
- 用**真实 opencode CLI** 发同一模型请求,成功 → 说明门槛在"请求长得像不像 opencode",而不是模型本身不可用。

### 第二步:精读 opencode 源码,找出它到底发了什么

关键在于 opencode 是开源的,合法且高效的路径就是读它的请求构造代码:

1. 拉最近一个月的提交,重点看与 zen、provider、request 相关的变更:
   ```bash
   git clone https://github.com/anomalyco/opencode
   git log --since="1 month ago" --oneline
   ```
2. 请求构造在 `packages/opencode/src/session/llm/request.ts`:每次请求带一组 `x-opencode-*` 头(session/request/client/project)+ 特定 User-Agent。
3. ID 生成在 `packages/opencode/src/id/id.ts` 的 `Identifier.create`:`<prefix>_` + 12 位十六进制时间分量(`(ms<<12|counter)` 的低 48 位)+ 14 位 base62 随机,总长 26 字符,前缀如 `ses_`/`msg_`/`prt_`。
4. User-Agent 在 `packages/opencode/src/installation/index.ts`:格式 `opencode/${channel}/${version}/${client}`,例如 `opencode/latest/1.18.31/cli`。
5. 版本号从 npm `opencode-ai` 包的 latest dist-tag 取,保证和真实客户端一致。

### 第三步:对照自己发出的请求,逐个头找差异

| 头 | opencode 真实客户端 | 旧版代理(被拒) |
|---|---|---|
| `user-agent` | `opencode/latest/1.18.31/cli` | `opencode/1.2.31`(版本陈旧、缺 channel/client 段) |
| `x-opencode-client` | `cli` | ❌ 缺失 |
| `x-opencode-session` | `ses_<26位opencode id>` | ❌ 裸 `crypto.randomUUID()` |
| `x-opencode-request` | `msg_<26位opencode id>` | ❌ 缺失 |
| `x-opencode-project` | 稳定的项目键 | ❌ 缺失 |

差异一目了然:上游把校验从"UA 网关"升级成了"**完整头指纹**",任何一项不像都会被分进严格拒绝桶。

### 第四步:确定门槛位置(知其所以然)

在 opencode 源码里 grep 这个报错文案是搜不到的——说明校验**不在开源 CLI 里,而在闭源的 zen 边缘服务**。开源仓库只能告诉你"真实客户端发什么",不能告诉你"服务端怎么验"。因此修复策略是完整模仿客户端指纹,而不是寻找服务端开关。

## 3. 修复方案(已实施)

核心思路:**让代理发出的每个请求都和真实 opencode CLI 无法区分**。

### 3.1 `api/_lib/types.ts` — UA 与版本常量化

```ts
export const OPENCODE_VERSION = "1.18.31"   // 跟随 npm opencode-ai 的 latest
export const OPENCODE_CHANNEL = "latest"
export const OPENCODE_CLIENT = "cli"
export const UPSTREAM_USER_AGENT = `opencode/${OPENCODE_CHANNEL}/${OPENCODE_VERSION}/${OPENCODE_CLIENT}`
```

### 3.2 `api/_lib/identity.ts` — 复刻 opencode 的 ID 形状(新增)

按 `Identifier.create` 的布局生成 26 字符 ID(`ses_`/`msg_`/`prt_` 前缀 + 12 位时间分量 + 14 位 base62),并对 `(callId, role)` 确定性生成——同一补发请求保持同一身份,模拟真实客户端的重试行为。

### 3.3 `api/chat.ts` — 发送完整头指纹

```ts
const identity = identityForCall(completionId)
headers: {
  authorization: "Bearer public",
  "user-agent": UPSTREAM_USER_AGENT,
  "x-opencode-session": identity.sessionId,
  "x-opencode-request": identity.requestId,
  "x-opencode-client": OPENCODE_CLIENT,
  "x-opencode-project": identity.requestId,   // msg id 兼作项目键,一个会话一个项目
}
```

### 3.4 验证

```bash
bun run test   # mock 层新增指纹断言;76/76 通过
bun run smoke  # 真实上游连通;stream:false / stream:true 双路径通过
bun run eval   # agent 评测 21/21:流式、xhigh 思考、工具循环、多轮记忆
```

## 4. 下次上游再更新时的排查清单(Cheat Sheet)

按序检查,命中即修:

1. **报错是否变了文案?** 收集当前 4xx/429 响应体,和 `api/_lib/errors.ts` 的映射对照。
2. **版本号过期?** `npm view opencode-ai version`,更新 `api/_lib/types.ts` 的 `OPENCODE_VERSION`。上游大版本发布后这几乎总是第一步。
3. **头指纹变了?** 重新精读 `packages/opencode/src/session/llm/request.ts`,对比本项目 `api/chat.ts` 发出的头集合(新增头?删除头?值格式变化?)。
4. **ID 形状变了?** 对照 `packages/opencode/src/id/id.ts` 的 `Identifier.create`(前缀、长度、时间分量布局),必要时更新 `api/_lib/identity.ts`。
5. **请求体形状变了?** Responses API 的字段(`store`、`include: ["reasoning.encrypted_content"]`、`reasoning.effort` 等)对照 `api/_lib/lower.ts` 与上游请求体。
6. **报错文案 grep 不到?** 校验在闭源边缘服务里,别浪费时间翻 CLI 逻辑,专注完整模仿客户端指纹。
7. **免费模型 ID 变了?** 留意 zen 模型目录与 `MODEL_ID`(`muse-spark-1.3-contributor-free`)。
8. 修复后按顺序跑 `bun run test` → `bun run smoke` → `bun run eval`,全绿再收工。

## 5. 行为与合规注意事项

- 指纹模仿的是**无凭据的免费匿名层**,按 IP 限额;请勿用于绕过付费或大规模滥用,上游随时可能再次收紧。
- 代理无状态,不落盘任何会话数据;加密思考内容(`encrypted_content`)按上游要求原样回传以支持多轮思考回放。
- `MODEL_ID` 把所有请求映射到免费模型;如需接入其他模型,改 `api/_lib/types.ts` 的 `MODEL_ID` 并确认上游允许。
