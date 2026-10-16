# OpenCode 免费层网关（类 new-api / sub2api 管理面板）

零依赖、零安装：纯 Node 原生模块（`node:http` / `node:https` / `node:tls` / `node:sqlite` / `node:crypto`），
前端是单文件原生 JS + CSS（无 CDN、可离线）。不需要 `npm install`。

---

## 快速开始

> 下面所有路径都以**项目根目录**（`opencode免费层逆向与网关\`）为基准。

```powershell
cd "01-管理面板"
$env:PANEL_PORT = "8790"          # 可选，默认 8790
node server.mjs                   # 用 PATH 上的 node；也可设 $env:NODE_EXE 指定
```

> 也可以直接双击同目录的 `启动面板.cmd`（内部用 `%~dp0`，换盘符/改目录都不用改脚本）。
> 停止用 `停止面板.cmd`。数据库 `panel.db` 与脚本同目录，路径不写死。

- 管理面板：<http://127.0.0.1:8790/>
- OpenAI 兼容接口：`http://127.0.0.1:8790/v1/chat/completions`
- 初始管理员密码：`admin123`（登录后请在「系统设置」里改掉）

首次使用：登录 → 「渠道管理」→ 新增渠道（点「填入免费模型」按钮）→ 「令牌管理」→ 新建令牌 → 用令牌调 `/v1`。

---

## 客户端接入

面板同时提供**两条协议**，因为免费层的模型是**按协议绑定**的：

| 端点 | 协议 | 谁会用到 |
|------|------|----------|
| `POST /v1/chat/completions` | OpenAI **Chat Completions** | OpenAI SDK、各类 Chat 客户端 |
| `POST /v1/responses` | OpenAI **Responses API** | **Codex**（`wire_api = "responses"`）、CC Switch |
| `GET /v1/models` | — | 模型列表 |

```bash
# Chat Completions（非流式）
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer sk-oc-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}]}'

# Chat Completions（流式）
curl -N http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer sk-oc-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free","stream":true,"messages":[{"role":"user","content":"数到三"}]}'

# Responses API（Codex 形状；SSE 原样透传）
curl -N http://127.0.0.1:8790/v1/responses \
  -H "Authorization: Bearer sk-oc-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"muse-spark-1.3-contributor-free","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"数到三"}]}],"stream":true}'
```

任何 OpenAI SDK 都可以把 `base_url` 指到 `http://127.0.0.1:8790/v1`、`api_key` 填面板里生成的令牌。
`model` 填 `auto` 时网关会展开渠道下的全部模型并自动故障转移。

### ⚠️ 模型按协议绑定（实测）

**这是最容易踩的坑**：同一个免费层里，不同模型挂在不同的协议上。用错协议会得到
`400 Model does not support this protocol.`（不是 403）。

### 完整兼容矩阵（2026-10-17 实测，10 个免费模型）

| 模型 | `/v1/chat/completions` | `/v1/responses` |
|------|:---:|:---:|
| `deepseek-v4.1-flash-free` | ✅ 200 | ❌ 400 |
| `longcat-2.5-preview-free` | ✅ 200 | ❌ 400 |
| `space-bunny-free` | ✅ 200 | ❌ 400 |
| `mimo-v2.6-flash-free` | ✅ 200 | ❌ 400 |
| `nemotron-3.5-lightning-free` | ✅ 200 | ❌ 400 |
| `nemotron-3.5-super-vl-free` | ✅ 200 | ❌ 400 |
| `nemotron-3-ultra-free` | ✅ 200 | ❌ 400 |
| `big-pickle` | ✅ 200 | ❌ 400 |
| `cat-jam-free` | ✅ 200 | ❌ 400 |
| **`muse-spark-1.3-contributor-free`** | ❌ 400 | ✅ **200** |

**结论：9 个只支持 chat，1 个（muse-spark）只支持 responses，没有一个两者都支持。**

### ✅ 面板做的是「协议互转」——两种协议都能用全部模型

**你不需要关心模型挂在哪个协议上**。面板内置 [`bridge.mjs`](bridge.mjs)：

| 客户端发到 | 模型原生协议 | 面板行为 |
|---|---|---|
| `/v1/chat/completions` | chat | 直通（不转换） |
| `/v1/chat/completions` | **responses**（muse-spark） | 请求转 responses → 上游 responses → 响应 SSE 转回 chat |
| `/v1/responses` | responses | 直通 |
| `/v1/responses` | **chat**（其余 9 个） | 请求转 chat → 上游 chat → 响应 SSE 转成 Responses 事件 |

所以 **CC Switch 里配 `openai_chat` 还是 `openai_responses`，全部 10 个模型都能用**。

转换细节：
- **请求**：chat `messages`（含 `tool_calls` / `tool`）↔ responses `input`（含 `function_call` / `function_call_output`）；
  嵌套 `tools` ↔ 扁平 `tools`；`system` ↔ `instructions`；`max_tokens` ↔ `max_output_tokens`
- **响应**：chat SSE ↔ Responses 事件流
  （`response.created` → `output_item.added` → `content_part.added` → `output_text.delta` →
  `output_text.done` → `content_part.done` → `output_item.done` → `response.completed`），工具调用双向转换
- **门禁**：转换后仍会补上必需的 `read` 工具并按名去重

### 🔄 上游 free 模型的动态发现（下游列表自动跟着变）

上游的 free 模型集合**会随时增删**。面板内置 [`model-registry.mjs`](model-registry.mjs) 自动跟上：

```
GET https://opencode.ai/inference/v1/models   ← 权威清单，实测**无需任何门禁头**，87 个模型
        │
        ├─ 筛出 free 候选（名字 -free 结尾 / big-pickle / 渠道里手配的）
        │
        └─ 对每个候选发**最小 body** 的真实请求探测
```

**关键：额度耗尽也能判定可用性**，因为 HTTP 状态码本身就够用：

| 探测结果 | 判定 |
|---|---|
| `200` | ✅ 可用 |
| `429` | ✅ **可用**（模型存在且免费层可用，只是额度耗尽） |
| `400 Model does not support this protocol` | 换另一个协议再试；两边都拒 → ❌ 不可用 |
| `404` | ❌ 上游已下线 |
| `401/402/403` | ❌ 需要付费/被拒绝 |

实测一轮（14 个 free 候选，34.6 秒）：

| 变化 | 模型 |
|---|---|
| **新增可用** | `beam-free`、`glm-5.3-flash-free`、`muse-spark-1.2-contributor-free` |
| **已下线剔除** | `nemotron-3-ultra-free`（404） |
| 探测不可用 | `jev-1.13-free`（两种协议都被拒） |

> ⚠️ **探测才是权威，上游清单不是**：`cat-jam-free` 探测 200 可用，但 `/v1/models` 里根本没有它。
> 所以「可用性」一律以探测为准，清单只用来**发现**新模型。

### 下游 `/v1/models` 的行为

- 默认只返回**探测可用**的模型（实测 10 个手配 → 动态 **12 个**）
- `GET /v1/models?all=1` 返回全部 free 候选，带 `available` / `status` / 原因，便于排查
- 每个模型带 `available`、`status`（`available` / `quota` / `wrong-protocol` / `not-found` …）、`protocols`
- 路由也会用动态列表：发现新模型后 `auto` 立刻能选到它；已下线的自动剔除

### 管理 API

| 端点 | 说明 |
|---|---|
| `GET /api/models/catalog` | 完整目录：上游总数、free 候选数、可用数、已下架数、每个模型的探测状态 |
| `POST /api/models/refresh` | 立即重新发现 + 探测（`?probe=0` 只拉清单不探测） |
| `POST /api/models/enabled?id=…&on=0` | 单个模型是否暴露给下游 |

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `PANEL_MODEL_DISCOVERY` | `1` | `0` 关闭动态发现，退回渠道手配 |
| `MODEL_REFRESH_MS` | `1800000` | 自动刷新间隔（30 分钟）；启动后 5 秒先跑一次 |
| `MODEL_PROBE_TIMEOUT` | `45000` | 单模型探测超时 |

> 探测用**最小 body**（只带一个 `read` 工具），成功的每次约 300 prompt tokens，
> 而不是 `full` 模式 agent body 的 9,600 —— 所以自动刷新很便宜。

---

### 面板为此做了什么

| 机制 | 行为 |
|------|------|
| **协议互转** | 见上表。客户端与模型协议不一致时自动桥接 |
| **原生优先排序** | `model: "auto"` 时，原生支持当前协议的模型排在前面（少一次转换） |
| **只有都不可用才拦** | 模型两种协议都确认不可用时才返回 `400`，其余一律放行 |
| **`/v1/models` 标注** | 每个模型带 `protocols` 与 `endpoints` 字段 |
| **探测 API** | `GET /api/protocols` 读表 · `POST /api/protocols/probe` 启动异步探测 · `GET /api/protocols/probe` 轮询进度 |
| **CLI 探测** | `node probe_protocols.mjs`（`--dry` 只打印不写库） |
| **429 不误判** | 探测遇到额度耗尽/网络错误时**保留旧判定**，绝不会把可用模型错标成「协议不支持」 |

> 探测用**最小 body**（只带一个 `read` 工具），每次成功约 300 prompt tokens，
> 而不是完整 agent body 的 9,600 —— 20 次探测总共几千 tokens。上一轮全量探测 **12ms 返回、33s 跑完**。

### 💰 请求体模式：`full` vs `minimal`（省 97% tokens）

因为 system prompt 完全不必要（见上），面板支持两种请求体：

| 模式 | body | prompt tokens/次 | 说明 |
|------|------|------------------|------|
| `full`（默认） | 38,763 字符完整 agent 结构 | **9,596**（cached 9,472） | 与真实 OpenCode 客户端最接近 |
| `minimal` | 只发调用方的 messages + 一个 `read` 工具（~350 字符） | **297** | 省 97%；不污染客户端提示词 |

开通（两种方式任选）：

```powershell
$env:PANEL_BODY_MODE = "minimal"     # 全局
# 或只对某个渠道：settings_config 里 extra.body_mode = "minimal"
```

两者都实测 200。**网关场景推荐 `minimal`**：
既省共享每日额度（同一个桶，省下来就是多出来的调用次数），
也不会用 opencode 的 system prompt 去干扰 Codex / Claude Code 自己的提示词。

> 默认仍是 `full`，不改变已验证的行为。要省额度就显式开 `minimal`。

### 接 Codex / CC Switch

Codex 的 `wire_api` 是 `"responses"`，让它把请求发到面板即可 —— **协议配哪种都行，因为有桥接**：

**方式 A：CC Switch 指向面板**（保留界面与切换能力）
| 项 | 填 |
|---|---|
| API 请求地址 | `http://127.0.0.1:8790/v1` |
| API Key | 面板「令牌管理」里生成的 `sk-oc-…` |
| Header 覆盖 | **清空** |
| Body 覆盖 | **清空** |
| API 格式 / 协议 | `openai_responses`（Codex 原生）或 `openai_chat` —— **两种都能用全部模型** |

之后 Codex → CC Switch → 面板 → 上游（协议不一致时面板自动互转）。

**方式 B：让 Codex 直连面板**（绕过 CC Switch 的翻译）
```toml
# ~/.codex/config.toml
model_provider = "custom"
model = "muse-spark-1.3-contributor-free"

[model_providers.custom]
name = "custom"
base_url = "http://127.0.0.1:8790/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "sk-oc-xxxxxxxx"   # 面板里生成的令牌
```

> 用面板时，CC Switch 里那个 `x-opencode-session` / `user-agent` 的 **Header 覆盖可以删掉**——
> 面板自己会生成正确的 session 并设置 UA。（CC Switch 的"路由模式"下，那份编辑的也只是存储配置。）

---

## 上游适配：OpenCode 免费层是怎么被接住的

网关不是简单反代，它必须复刻 OpenCode 客户端自身的请求形状，否则上游直接回
`403 FreeTierError`（"free tier can only be used from within OpenCode"）。经过 100+ 次对照实验
（四轮单变量消融，见 [`../04-门禁判别实验/verify_recipe*.mjs`](../04-门禁判别实验/)），
门禁的判据被钉死为**五条**：

| # | 判据 | 违反后果 |
|---|------|----------|
| 1 | `user-agent` 匹配 `^opencode/v?<版本>`，**大小写不敏感** | 形状不符 → **403** |
| 2 | UA 里的版本 **≥ 1.18.0** | 版本过低 → **426**（不是 403） |
| 3 | `x-opencode-session` = `ses_` + 12 hex + 14 base62 | 缺失/形状错 → **403** |
| 4 | 12 hex 段的**低 12 位 ∈ `[0xfc0, 0xfff]`** | 越界 → **403** |
| 5 | **`body.stream === true`** | 非流式 → **403** |
| 6 | **`tools` 里必须有一个 `name: "read"` 的工具（区分大小写）** | 否则 → **403** |

> **实测澄清**：system prompt 的长度和内容**都不校验**（200 字符也能过）。
> 唯一真正需要「完整」的东西是那个叫 `read` 的工具。面板对此有**无条件守卫**
> （`upstream.mjs` 的 `ensureReadTool` / `ensureReadToolResponses`）——
> 调用方把 `tools` 清空也不会 403。

**可选**：`x-opencode-session-id`（**可以完全不要**，但一旦提供就必须满足判据 3+4）、
`authorization`（`Bearer public` 可省）、`x-opencode-request`、`x-opencode-client`、`x-opencode-project`。
**排除项**：出口 IP、操作系统、进程环境、Node/Electron 运行时、TLS 指纹、客户端证书、签名头、请求路径。


请求体必须带上完整的 OpenCode agent 结构（system prompt 约 12.9 KB + 12 个 tools），
换成最小 body 会被判 403。所以网关用一份静态模板 `body_template.json`（39,185 B）做骨架，
把调用方传入的 messages/tools 拼接进去。

### 因此网关内部做了三件事

1. **`upstream.mjs` 的 `UA_OPENCODE`** 固定发 `opencode/1.19.2 ...` —— 既满足判据 1 的形状，
   也满足判据 2 的 `≥ 1.18.0`。渠道可以自定义 UA，但**低于 1.18.0 会直接吃 426**。
2. **`upstream.mjs` 的 `makeSessionId()`** 生成 `ses_` + 9 hex + `ffe` + 14 base62，
   保证 `low12 == 0xffe ∈ [0xfc0,0xfff]`。
3. **非流式请求也强制走上游流式**（`body.stream = true`），拿到 SSE 后由
   `server.mjs` 的 `aggregateSSE()` 在本地拼回一个标准 `chat.completion`
   （含 `content` / `reasoning_content` / `tool_calls` / `usage`）。
   这是最初 `/v1/chat/completions` 一直 403 的根因。

---

## 功能

### 渠道管理
- 多渠道路由、优先级排序、启停、一键测试连通性
- 「填入免费模型」「只填已探明可用」按钮，省去手抄模型名
- 每个渠道可配独立代理串（逗号分隔多节点，自动轮换与健康冷却）
- 渠道类型：`opencode`（免费层形状复刻）/ `openai`（通用 OpenAI 兼容）

### 令牌管理
- `sk-oc-` 前缀的随机密钥、配额与用量统计、模型白名单、过期时间、启停、用量重置
- 每个令牌的调用量与 token 消耗在仪表盘可查

### 智能路由与容错
- `model=auto` 展开渠道下全部模型；指定模型不可用时自动故障转移
- 429：按 `retry-after` 精确熔断到额度重置点（免费层额度**所有模型共用一个桶**，每天 00:00 UTC / 北京时间 08:00 整点重置）
- 403 / 400：冷却 10 分钟并换下一个候选
- 5xx / 网络错误：继续下一个候选
- 代理池：HTTP CONNECT 与 SOCKS5/SOCKS5H（手写 RFC1928 + RFC1929），按 inflight 最少选择，故障节点冷却

### 观测
- 仪表盘：请求数 / 成功率 / token 消耗 / 平均延迟、近 14 天柱状图、按模型、按渠道、按令牌、失败分布、当前冷却列表
- 请求日志：时间、令牌、渠道、模型 → 上游模型、出口代理、prompt/completion/total tokens、延迟、TTFT、状态、错误、客户端 IP；支持过滤、分页、清空

---

## 文件

| 文件 | 说明 |
|------|------|
| `server.mjs` | HTTP 服务：管理 API + OpenAI 兼容 API + SSE 聚合 |
| `db.mjs` | `node:sqlite` 存储（渠道 / 令牌 / 日志 / 设置），WAL 模式 |
| `upstream.mjs` | 传输层（直连 + HTTP/SOCKS5 代理池）、opencode/openai 请求构造、id 生成、`read` 工具守卫、协议探测 |
| **`bridge.mjs`** | **协议互转**：chat ↔ responses 的请求体与 SSE 事件流双向转换（纯逻辑，无网络依赖）|
| `probe_protocols.mjs` | 探测每个模型支持哪个协议，写入 `model_protocols` 表（`--dry` 只打印）|
| `public/index.html` | 单文件管理面板（深色主题，原生 JS） |
| `body_template.json` | OpenCode agent 请求体骨架（chat/completions 格式，从真实引擎请求捕获） |
| `body_template_responses.json` | 同一份 agent 结构的 **Responses API 格式**：`instructions` = 12,988 字符 system prompt，`tools` = 12 个扁平工具。给 `/v1/responses` 用 |
| `panel.db`（+ `-wal`/`-shm`） | SQLite 数据库（首次启动自动创建）。可用 `PANEL_DB` 改位置 |
| `启动面板.cmd` / `停止面板.cmd` | 双击启动 / 停止（内部用 `%~dp0`，换盘符不用改） |
| [`自检.ps1`](自检.ps1) | **可用性自检**：起临时实例（默认 8799）跑 16 项检查（含真实上游调用与双向桥接），跑完自动关闭，不影响 8790 上的实例 |
| `quota_experiment.mjs` | 额度受控实验：Phase 1 全模型探测 → Phase 2 高频打满 → Phase 3 复探 → 判决是否共享同一个桶 |
| `.testkey` | 面板测试用令牌（仅本机调试） |

---

## 自检

```powershell
cd "01-管理面板"
powershell -ExecutionPolicy Bypass -File .\自检.ps1
```

11 项：必需文件 → `node --check` → 起服务 → `GET /` → 登录 → 渠道 → 令牌 → 统计 →
`/v1/models` → **非流式端到端（真实上游，校验返回 PONG）** → **流式 SSE**。
用独立端口 8799，跑完自动关闭，**不影响**你在 8790 上跑的面板。

> 整个归集目录的 6 大类 15 项全量自检，见 [`../自检全部.ps1`](../自检全部.ps1)
> 或双击 [`../一键自检.cmd`](../一键自检.cmd)。

---

## 已知限制

- **额度天花板不在网关**：免费层额度是**所有免费模型共用一个每日桶**（实测：`big-pickle`、`nemotron-3.5-super-vl-free`
  在本机调用次数为 0，却和打了 6000 次的 `mimo-v2.6-flash-free` 同时 429，且 `retry-after` 指向同一个重置点）。
  桶打满就只能等次日 08:00（北京）。注意换代理 IP **不会**刷新额度。
- 每次调用有固定开销约 **9,500 input tokens**（完整 agent 结构所致），即使只问一个字也要付这个成本。
- 上游延迟 2–37 秒不可控；`nemotron-3-ultra-free` 实测单次 44–303 秒，**不要放进高频轮转**。
- `cat-jam-free`、`muse-spark-1.3-contributor-free` 返回 **403 RegionError**（地区门禁，本机出口在日本），
  换到受支持地区的代理节点可能可用。
- 上游文档明确写着免费层"只能在 OpenCode 内使用"。当前能打通仅因为门禁只做请求形状校验
  （无签名、无证书、无设备绑定），**对方随时可以加真实证明使这套方案失效**。
