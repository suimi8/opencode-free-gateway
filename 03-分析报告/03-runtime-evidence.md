# 03 — 运行时取证报告：OpenCode Desktop「FREE 模型限制」

- 任务：task-3（owner `runtime-proof`）
- 取证时间：本次会话
- 取证方式：**全只读**。未重启/未杀任何进程，未修改任何日志、DB、配置。SQLite 一律以 `file:...?mode=ro` 只读打开。
- 脱敏声明：本报告不含任何 API key、token、cookie、邮箱或账户名明文。`auth.json` 仅列出 provider 名与 `type`。

---

## 0. 一句话结论

本机**确实撞过 OpenCode 免费（Free）模型的额度/限流**——证据是应用自己写入的 `go_upsell_last_seen_at` 键，其时间戳落在**第一次** `Rate limit exceeded` 之后 **149 秒**；但**没有任何证据表明用户已订阅 OpenCode Go**（无 "OpenCode Go" 字样、无订阅字段、account/credential 表 0 行、全库累计消费仅 $0.0826 且来自第三方 provider）。

免费限制在本机的实际表现是**混合型**，需分两层看：

| 层 | 提供方 | 表现 |
|---|---|---|
| A. OpenCode 官方免费模型（providerID=`opencode`，modelID 以 `-free` 结尾） | `opencode.ai`（`/zen/v1`、`/inference/v1`，Cloudflare 前置） | **429 Rate limit exceeded**（60 行）、**403 RegionError「This model is not available in your country.」**、**410 ModelDeprecated**、大量 5xx/连接层失败 |
| B. 用户自建本地反代 `:free` 模型（providerID=`tokenharhur` → `127.0.0.1:8787`） | 本地反代 → 上游中转 | **「The free offer for this model isn't available on this account.」**（账号级免费额度门槛），随后反代**进程消失**（ECONNREFUSED 127.0.0.1:8787） |

关键区别：A 的 `-free` 是 OpenCode 官方免费额度（限流/限地区）；B 的 `:free` 是**第三方中转商**的免费档，与 OpenCode 无关。

**用量量化（本报告最硬的一组数字）**：主库聚合显示用户通过 `opencode` 免费通道消耗 **2.406 亿 input + 1,424 万 output + 10.6 亿 cache-read tokens，计价 $0.00**，占全部 assistant 消息的 **99.5%（8,932 / 8,976）**。免费额度被"用到很重"是确定事实。

**授权机制**：`auth.json` 中**没有 `opencode` 条目** → 本机走匿名 `apiKey="public"` 通道。该通道**只在 OpenCode 客户端内部可用**（Lead 实测同 key 裸 curl → 403 `FreeTierError: "OpenCode's free tier can only be used from within OpenCode."`），因此"app 内免费可用、外部被拒"是**客户端身份门禁**，而非额度耗尽。详见 §3.4。

---

## 1. 日志基线

- 路径：`%USERPROFILE%\.local\share\opencode\log\opencode.log`
- 体量：约 27 MB / 139,5xx 行
- 时间跨度：**首行 `2026-09-01T13:58:48.006Z` ～ 末行 `2026-10-16T04:13:49.662Z`**（UTC），即约 45 天
  ```
  timestamp=2026-09-01T13:58:48.006Z level=INFO run=ad41c90d message="creating instance" directory="%USERPROFILE%"
  timestamp=2026-10-16T04:13:49.662Z level=INFO run=d3e42f48 message="llm runtime ...
  ```
- 日志为追加型单文件，未见轮转截断，可视为该窗口的完整运行记录。

> ⚠️ **保留期差异（重要）**：日志覆盖 09-01 起 45 天，但主库 `opencode.db` 只保留到 **2026-10-10 之后**（见 §3.3），说明 DB 被裁剪/迁移过。**日志是长窗口唯一权威来源，DB 是近 4 天的高精度来源**，二者互补。

---

## 2. 免费 / 额度 / 限流事件原始行（必查项 1）

### 2.1 命中总数与首末时间

`grep 'Rate limit exceeded'` → **60 行**（其中 55 行为 `message="stream error"`，5 行为配对的 `message=process` 终结行）。

**首次（line 4122）：**
```
timestamp=2026-09-14T14:31:30.057Z level=ERROR run=e3fe5a74 message="stream error" providerID=opencode modelID=ling-3.0-flash-fin-free session.id=ses_f60367c3affeasQdbdIYyP7kCs small=false agent=build mode=primary error.error="AI_APICallError: Error from provider (Console): Rate limit exceeded. Please try again later."
```

**最近一次（line 135962）：**
```
timestamp=2026-10-16T02:12:55.070Z level=ERROR run=de0381bb message="stream error" providerID=opencode modelID=deepseek-v4.1-flash-free session.id=ses_ec828e9acffeIK1lwQrMdVbbmN small=false agent=compaction mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."
```

> 跨度：2026-09-14 → 2026-10-16，持续约 32 天，**不是一次性抖动**。

### 2.2 按日期频次

| 日期（UTC） | 次数 |
|---|---|
| 2026-09-14 | 7 |
| 2026-09-17 | **37** |
| 2026-09-23 | 1 |
| 2026-09-24 | 12 |
| 2026-10-07 | 2 |
| 2026-10-16 | 1 |

2026-09-17 为最严重的一天（37 次），样本原始行：
```
timestamp=2026-09-17T05:53:32.674Z level=ERROR run=d6be9320 message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=ses_f52b3d92affeCH0hkQxV6KPwkp small=false agent=build mode=primary error.error="AI_APICallError: Error from provider (Console): Rate limit exceeded. Please try again later."
```

### 2.3 按 modelID 归因

| modelID | 限流次数 | 备注 |
|---|---|---|
| `muse-spark-1.3-contributor-free` | **48** | 主犯，`contributor` 字面即"贡献者免费档" |
| `ling-3.0-flash-fin-free` | 6 | |
| `deepseek-v4.1-flash-free` | 1 | 仅 `agent=compaction` 时触发 |

### 2.4 限流措辞变体（含 429 语义）

```
Rate limit exceeded. Please try again later.            ×47
Rate limit exceeded. Please retry after a brief wait.   ×13
```
后者（`retry after a brief wait`）是服务端明确的下游节流措辞。

### 2.5 上游层面的限流（非 Console 前缀）

```
Upstream error from Xiaomi: Request rate limited      ×2
```
这是 OpenCode 转发到小米（mimo 系列上游）时被限流——即**限流发生在 OpenCode 之外的上游**，OpenCode 只是透传。

### 2.6 HTTP 429 的持久化证据（`opencode.global.dat` 通知历史）

日志之外，桌面端把终结性错误写进了 `opencode.global.dat` 的 `notification` 数组，其中 **6 条 `statusCode: 429`**，原始片段：
```json
{"directory":"D:\\Downloads\\果果剧库","time":1789625142736,"viewed":true,"type":"error","session":"ses_f52b3d92affeCH0hkQxV6KPwkp","error":{"name":"APIError","data":{"message":"Error from provider (Console): Rate limit exceeded. Please try again later.","statusCode":429,"isRetryable":true,"responseHeaders":{"cf-placement":"remote-ORD","cf-ray":"a3c5ddb0dab512ad-LAX","connection":"keep-alive","content-length":"143","content-type":"application/json","date":"Thu, 17 Sep 2026 05:56:28 GMT","server":"cloudflare"},"responseBody":"{\"type\":\"error\"...
```
→ 限流响应经 **Cloudflare** 返回（`server: cloudflare`、`cf-placement: remote-ORD`、`cf-ray` 存在），确证 `opencode.ai` 边缘即返回 429。

---

## 3. 实际使用过的 provider / model 及免费判定（必查项 2）

日志中 `message=stream providerID=X modelID=Y` 全量聚合（调用次数）：

| # | providerID | modelID | 次数 | 免费判定 |
|---|---|---|---|---|
| 1 | `opencode` | `mimo-v2.6-flash-free` | 6337 | ✅ 免费（`-free`） |
| 2 | `opencode` | `muse-spark-1.3-contributor-free` | 4902 | ✅ 免费（contributor 档） |
| 3 | `opencode` | `space-bunny-free` | 1564 | ✅ 免费 |
| 4 | `opencode` | `nemotron-3-ultra-free` | 1472 | ✅ 免费 |
| 5 | `opencode` | `ling-3.0-flash-fin-free` | 1018 | ✅ 免费 |
| 6 | `opencode` | `deepseek-v4.1-flash-free` | 700 | ✅ 免费 |
| 7 | `openagents-gateway` | `glm-5.3` | 464 | ❌ 第三方网关（非 OpenCode 免费额度） |
| 8 | `opencode` | `mimo-v2.5-free` | 285 | ✅ 免费 |
| 9 | `cline-pass` | `cline-pass/deepseek-v4.1-flash` | 206 | ❌ Cline Pass 订阅 |
| 10 | `opencode` | `nemotron-3.5-lightning-free` | 85 | ✅ 免费 |
| 11 | `asaf` | `DeepSeek-V4-Flash-0731` | 55 | ❌ 第三方 API |
| 12 | `opencode` | `ling-3.1-flash-free` | 49 | ✅ 免费 |
| 13 | `opencode` | `union-alpha` | 45 | ❌ 无 `-free` 后缀（付费/额度模型） |
| 14 | `tokenharhur` | `claude-haiku-5.5:free` | 42 | ⚠️ 本地反代免费档 |
| 15 | `openagents-gateway` | `glm-5.3-flash` | 26 | ❌ |
| 16 | `openagents-gateway` | `deepseek-v4.1-flash` | 10 | ❌ |
| 17 | `cline-pass` | `cline-pass/glm-5.3-flash` | 6 | ❌ |
| 18 | `opencode` | `step-5-preview-free` | 6 | ✅ 免费 |
| 19 | `opencode` | `longcat-2.5-preview-free` | 1 | ✅ 免费 |
| 20 | `opencode` | `exo-free` | 1 | ✅ 免费（后已废弃） |
| 21 | `cline-pass` | `cline-pass/deepseek-v4-flash` | 1 | ❌ |
| 22 | `cline-pass` | `cline-pass/kimi-k2.6` | 1 | ❌ |

**结论：本机 ~94% 的模型调用落在 `opencode` provider 的 `-free` 模型上**（6337+4902+1564+1472+1018+700+285+85+49+45+6+1+1 = 16,465 / 约 17,530 次总调用）。用户**主要就是靠 OpenCode 免费模型在干活**，这就是免费额度被反复撞到的原因。

另外按 provider 出现的总行数（含非 stream 行）：
```
providerID=openagents-gateway   506
providerID=cline-pass           229
providerID=asaf                  56
providerID=tokenharhur           50
providerID=workbuddy              0   ← 配置了但从未成功调用
127.0.0.1:7863                    0   ← workbuddy 反代从未在日志中出现
```

### 3.1 免费模型成功调用的时间范围与量级（Lead 追问 ①）

**首次成功调用（日志首条 opencode stream 行）：**
```
timestamp=2026-09-14T11:23:28.292Z level=INFO run=e3fe5a74 message=stream providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=ses_f60579bfcffe88Rg2RhEEf39CD small=true agent=title mode=primary
```
**最近成功调用（就在取证前）：**
```
timestamp=2026-10-16T04:13:04.565Z level=INFO run=d3e42f48 message=stream providerID=opencode modelID=deepseek-v4.1-flash-free session.id=ses_ec7023cfeffeJCioqVt6MsOCJI small=false agent=build mode=primary
```

**量级：**
```
providerID=opencode 总行数              = 17,467   （与 Lead 的 17,457 一致，差值来自本次取证期间新增行）
message=stream providerID=opencode 行数 = 16,479
日志中不同 session.id 数                = 267
```
即：**免费通道在 09-14 → 10-16 的 32 天里被成功流式调用约 16,479 次，覆盖 267 个会话**，且**在限流（09-14）之后仍长期可用** —— 说明 429 是**突发限流**而非**硬性额度耗尽**（否则不会后续还能跑 1.6 万次）。

Lead 提供的日志内模型 id 字面命中次数（含 stream / 错误 / 配置等多种行）：
```
mimo-v2.6-flash-free        12833
muse-spark*                 10077
nemotron*                    3298
space-bunny-free             3158
deepseek-v4.1-flash-free     1426
longcat-2.5-preview-free        2
cat-jam-free                    0
big-pickle                      0
jev-1.13-free                   0
```
→ `cat-jam-free` / `big-pickle` / `jev-1.13-free` 在日志中**从未出现**（列表里有但本机没跑过）。

### 3.2 关键词精确计数（Lead 追问 ②）

| 关键词 | 日志命中 |
|---|---|
| `Rate limit` | **60** |
| `rate limit`（小写） | 7 |
| `rate_limit` | 5 |
| `exceeded` | 68 |
| `quota` | 7 |
| `Quota` | 1 |
| `429`（裸数字，含噪声） | 2033 |
| `usage limit` / `usage_limit` | **0** |
| `FreeTierError` | **0** |
| `FreeUsageLimitError` | **0** |
| `GoUsageLimitError` | **0** |
| `free tier` / `free_tier` | **0** |
| `Go limit` | **0** |
| `opencode-go` | **0** |
| `zen` | 687（其中 633 为裸 `zen`，370 为 `zenmux`） |

**关键判读：**
- `FreeTierError` / `FreeUsageLimitError` / `GoUsageLimitError` 全部 **0** —— **OpenCode 客户端从未抛出过「免费额度用尽」这类强类型错误**，本机遇到的全是 HTTP 429 透传（`rate_limit_error` / `server_error`）。
- `quota` 的 7 次命中经上下文检查**全部是用户自己的脚本名/文件**（`quota-probe.js`、`quota.txt`、`_QuotaWorker`），**与 OpenCode 额度机制无关**，不可作为证据。
- `zenmux` 370 次也全是用户脚本名（`zenmux_turnstile_mint.py`、`zenmux_auto_gui.py`、`zenmux_verify_flow.py`、`zenmux_onekey_cli.py`），**`providerID=zenmux` = 0**，`zenmux` 不是本机 provider。

**429 的三种原始措辞（日志全文只有这 5 条 `[429]`，全在 2026-10-15）：**
```
timestamp=2026-10-15T03:26:45.881Z level=ERROR run=f8c90a69 message="stream error" providerID=opencode modelID=mimo-v2.6-flash-free session.id=ses_ec2df2d2cffeMBEAQfxUONJKjU small=false agent=compaction mode=primary error.error.message="Streaming response failed: [429] Upstream error from Xiaomi: Request rate limited" error.error.type=server_error
timestamp=2026-10-15T06:40:57.156Z level=ERROR run=f8c90a69 message="stream error" providerID=opencode modelID=mimo-v2.6-flash-free session.id=ses_ec7023cfeffeJCioqVt6MsOCJI small=false agent=build mode=primary error.error.message="Streaming response failed: [429] Upstream error from Xiaomi: Request rate limited" error.error.type=server_error
timestamp=2026-10-15T06:48:40.004Z level=ERROR run=f8c90a69 message="stream error" providerID=opencode modelID=mimo-v2.6-flash-free session.id=ses_ec7023cfeffeJCioqVt6MsOCJI small=false agent=compaction mode=primary error.error.message="Streaming response failed: [429] Request rate limited" error.error.type=rate_limit_error error.error.param=null
timestamp=2026-10-15T06:49:08.914Z level=ERROR run=f8c90a69 ... 同上 error.error.type=rate_limit_error error.error.param=null
timestamp=2026-10-15T06:49:19.218Z level=ERROR run=f8c90a69 ... 同上 error.error.type=rate_limit_error error.error.param=null
```

**另一种限流类型（输出 token 速率限制，仅 1 次）：**
```
timestamp=2026-09-17T15:04:33.451Z level=ERROR run=4e7e61ac message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=ses_f52b564a4ffebaRopyhX0qoFb1 small=false agent=build mode=primary error.error="AI_APICallError: Error from provider (Console): Upstream request failed: [rate_limit_exceeded] Output token rate limit exceeded. Please retry after a brief wait."
```
→ 说明限制**同时作用于请求速率与输出 token 速率**。

### 3.3 主库中的 token / cost 累计（Lead 追问 ③）

`message` 表 JSON 字段含 `providerID` / `modelID` / `cost` / `tokens`，可直接聚合（只读）：

| providerID | 消息数 | cost (USD) | tokens.input | tokens.output | cache.read | cache.write | reasoning |
|---|---|---|---|---|---|---|---|
| **`opencode`** | **8,932** | **0.000000** | **240,601,896** | **14,242,636** | **1,060,749,766** | 0 | 4,605,040 |
| `tokenharhur` | 37 | 0.000000 | 1,828,888 | 38,103 | 7,673,915 | 0 | 0 |
| `cline-pass` | 4 | **0.082602** | 338,148 | 1,108 | 997,632 | 0 | 2,794 |
| `openagents-gateway` | 3 | 0.000000 | 30,275 | 157 | 15,104 | 0 | 187 |
| **合计** | **8,976** | **0.082602** | | | | | |

**这是本报告最有分量的量化结论：**
> 用户在本机通过 `opencode` 免费通道消耗了 **2.406 亿 input tokens + 1,424 万 output tokens + 10.6 亿 cache-read tokens**，**计价成本 $0.00**。
> 全库 8,976 条 assistant 消息中 **8,932 条（99.5%）走的是 OpenCode 免费通道**；唯一真实付费（$0.0826）来自第三方 `cline-pass`。

**时间范围（DB 侧，仅覆盖近 4 天）：**
```
opencode            2026-10-12 09:56:52  →  2026-10-16 04:13:46   8,933 msgs
tokenharhur         2026-10-13 23:56:18  →  2026-10-14 00:19:09      37 msgs
cline-pass          2026-10-13 05:14:30  →  2026-10-13 05:15:43       4 msgs
openagents-gateway  2026-10-10 20:50:19  →  2026-10-10 22:52:53       3 msgs
```
DB 中 `session` 表仅 **64 行**，而日志中 session 数 267、`event` 表中 `session.created.1` 事件 **268** 条、`message.removed.1` 事件 **262** 条 → **历史会话已被清理/裁剪**，故 DB 的 token/cost 累计是**下界**，真实累计用量远高于上表。

### 3.4 为何「app 内免费可用、外部 curl 被拒」（Lead 追问的解释）

Lead 实测：
- `Bearer public` 直接 `POST https://opencode.ai/inference/v1/chat/completions`（免费模型）→ **403 `FreeTierError: "OpenCode's free tier can only be used from within OpenCode."`**；付费模型 → **401 `AuthError: Missing API key.`**；补齐 app 标识头后仍 403。
- `GET https://opencode.ai/inference/v1/models`（`Bearer public`）→ 200，86 个模型。

本机侧印证：
- `auth.json` **没有 `opencode` 条目**（只有 asaf / cline-pass / workbuddy / tokenharhur，全部 `type=api`）→ **本机未登录 OpenCode 账号**，走的是匿名 `apiKey="public"` 通道。
- 但日志里免费模型**正常流式返回**（§3.1，16,479 次成功）。

**解释：** OpenCode 免费档的授权不取决于"有没有 API key"，而取决于**调用方是否为 OpenCode 客户端本体**（服务端按客户端身份/指纹判定，文案即 `can only be used from within OpenCode`）。
- 桌面端 Electron 主进程发出的请求携带了 app 身份特征 → **放行**（消耗匿名免费额度，限流后返回 429）。
- 裸 curl / 第三方脚本（包括用户自建的反代）→ **403 FreeTierError 直接拒绝**，连额度都不给。

这恰好解释了 `tokenharhur`(8787) 这类本地反代的困境：它想复用 OpenCode 免费池，但在服务端看来是"非 OpenCode 客户端"，只能落到上游中转商自己的免费档规则上（§4.2 的 `free offer isn't available on this account`）。

> 旁证：日志中 `client=desktop` 命中 **0** 次 → **客户端身份标记不写进日志**，所以"app 内放行"这一判定发生在服务端，本机日志无法直接观测，只能由"同 key 外部 403 / app 内成功"的对照推出。


---

## 4. 用户 `:free` 后缀模型与两个本地反代（必查项 3）

### 4.1 配置事实（`%USERPROFILE%\.config\opencode\opencode.jsonc`）

- `workbuddy` → `baseURL: http://127.0.0.1:7863/v1`，模型 `Deepseek-V4.1-Flash / Hy3 / Step-5-Preview / Deepseek-V4-Flash / Deepseek-V4-Pro / Space-Bunny`（名称带 GBK 乱码前缀「国际/国内」）
- `tokenharhur` → `baseURL: http://127.0.0.1:8787/v1`，模型 **`claude-haiku-5.5:free`、`deepseek-v4.1-flash:free`、`mimo-v2.6-flash:free`**
- `disabled_providers: []`（无 provider 被禁用）

### 4.2 `tokenharhur`（127.0.0.1:8787）—— 真正被用过的 `:free`

- 调用 42 次，**全部是 `claude-haiku-5.5:free`**；`deepseek-v4.1-flash:free` 与 `mimo-v2.6-flash:free` **配置了但从未被调用**（0 次）。
- 首末调用：`2026-10-13T23:56:20.011Z` → `2026-10-14T00:20:14.773Z`（同一 run `a417927d`）。
- **服务端免费门槛错误（2 次）**，原始行：
```
timestamp=2026-10-14T00:07:26.069Z level=ERROR run=a417927d message="stream error" providerID=tokenharhur modelID=claude-haiku-5.5:free session.id=ses_ec843e130ffehsz1gsQpm1cHlE small=false agent=general mode=subagent error.error="AI_APICallError: The free offer for this model isn't available on this account. Use the paid model 'claude-haiku-5.5' with a balance or a Pass, or choose another free model."
```
  → 这是**上游中转商**的账号级判定：该账号不享受 `claude-haiku-5.5` 的免费档，被要求改走付费/Pass。
- **随后反代进程消失**：`2026-10-14T00:19:10.356Z` 起连续 6 条
```
... error.error="AI_APICallError: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:8787 (cause: Error: ...
```
  时间点：`00:19:10.356Z`、`00:19:12.426Z`、`00:19:16.810Z`、`00:19:26.213Z`、`00:19:44.769Z`、`00:20:14.784Z`（+1 条 process 行）。
  → 与 Lead 侦察到的"8787 拒绝连接"完全吻合，且**发生时间可定位**：2026-10-14 00:19Z 之后该反代再未恢复（日志内无后续成功记录）。

### 4.3 `workbuddy`（127.0.0.1:7863）—— 零调用

- 日志中 `providerID=workbuddy` 0 次、`127.0.0.1:7863` 0 次。**该反代在本日志窗口内从未被 OpenCode 调用过**，因此日志里没有它的 401/限流痕迹。Lead 实测的 7863 → 401 属于当前状态，不是历史失败记录。

### 4.4 OpenCode 官方 `-free` 模型的"限制痕迹"（除限流外）

来自 `opencode.global.dat` 通知历史（HTTP 状态码统计：400×14、403×3、404×2、410×1、429×6）：

- **403 地区限制**（2 次）：
```json
{"message":"This model is not available in your country.","statusCode":403,"isRetryable":false,"responseHeaders":{...,"server":"cloudflare","date":"Thu, 24 Sep 2026 20:22:23 GMT"},"responseBody":"{\"type\":\"error\",\"error\":{\"type\":\"RegionError\",\"message\":\"This model is not available in your country.\"}}","metadata":{"url":"https://opencode.ai/zen/v1/responses"}}
```
- **410 模型已废弃**（1 次，`exo-free`）：
```json
{"message":"Model exo-free has been deprecated.","statusCode":410,...,"responseBody":"{\"type\":\"error\",\"error\":{\"type\":\"ModelDeprecated\",\"message\":\"Model exo-free has been deprecated.\"},\"metadata\":{\"model\":\"exo-free\"}}","metadata":{"url":"https://opencode.ai/inference/v1/chat/completions"}}
```
- **400 invalid_request**（`muse-spark-1.3-contributor-free`，`https://opencode.ai/zen/v1/responses`）——免费模型对请求体较敏感。

### 4.5 上游端点清单（来自通知里的 `metadata.url`）

```
https://opencode.ai/zen/v1/responses                 ×19
https://opencode.ai/inference/v1/chat/completions     ×7
https://opencode.ai/zen/v1/chat/completions           ×3
https://api.cline.bot/api/v1/chat/completions         ×2
https://opencode.ai/inference/v1/responses            ×1
```
→ `opencode` provider 走的是 **`opencode.ai/zen/v1` 与 `opencode.ai/inference/v1`**（即 OpenCode Zen 免费池），错误文案统一前缀 `Error from provider (Console):`。

### 4.6 其它高频错误（说明"限制"不只表现为 429）

`error.error=` 全量聚合 Top：
```
343  AI_APICallError: Cannot connect to API: other side closed (cause: SocketError: ...)
244  AI_APICallError: Error from provider (Console): Upstream request failed: Endpoint is unavailable.
 61  AI_APICallError: Cannot connect to API: Client network socket disconnected before secure TLS ...
 39  AI_APICallError: Upstream request failed: Endpoint is unavailable.
 39  AI_APICallError: Error from provider (Console): Rate limit exceeded. Please try again later.
 25  AI_APICallError: Cannot connect to API: Connect Timeout Error (attempted address: opencode.ai:443, timeout: 10000ms)
 15  AI_APICallError: Upstream request failed: Model is unavailable.
 12  AI_APICallError: Error from provider (Console): Rate limit exceeded. Please retry after a brief wait.
 12  AI_APICallError: Error from provider (Console): The backend is temporarily overloaded. Ple...
  3  AI_APICallError: Rate limit exceeded. Please try again later.
  2  AI_APICallError: This model is not available in your country.
```
→ `opencode.ai:443` 连接超时 25 次；免费池的"端点不可用/后端过载/模型不可用"是常态噪声。**免费额度的真实体验 = 限流 + 端点不稳定 + 地区限制 三重叠加。**

---

## 5. `go_upsell_*` 键：是否真撞过免费额度（必查项 4）——**核心证据**

文件：`%APPDATA%\ai.opencode.desktop\opencode.global.dat`
节点原文（`go-upsell`，值是内嵌 JSON 字符串）：

```json
"go-upsell": "{\"go_upsell_last_seen_at\":1789396439021,\"go_upsell_dont_show\":1789396439021,\"go_upsell_account_rate_limit_last_seen_at\":null,\"go_upsell_account_rate_limit_dont_show\":null}"
```

| 键 | 原始值 | 换算 |
|---|---|---|
| `go_upsell_last_seen_at` | `1789396439021` | **UTC 2026-09-14T14:33:59.021Z ／ 本地(UTC+8) 2026-09-14 22:33:59** |
| `go_upsell_dont_show` | `1789396439021` | **与上一项完全相同**（同一毫秒被置为"不再显示"） |
| `go_upsell_account_rate_limit_last_seen_at` | `null` | 从未触发 |
| `go_upsell_account_rate_limit_dont_show` | `null` | 从未触发 |

### 5.1 时间线因果（决定性）

```
2026-09-14T14:31:30.057Z  第 1 次 "Rate limit exceeded"（providerID=opencode / ling-3.0-flash-fin-free）
2026-09-14T14:31:32.379Z  重试
2026-09-14T14:31:33.636Z  再限流
2026-09-14T14:31:38.009Z  重试
2026-09-14T14:31:40.336Z  再限流
2026-09-14T14:31:50.196Z  重试
2026-09-14T14:31:52.721Z  再限流
2026-09-14T14:32:11.777Z  重试
2026-09-14T14:32:14.650Z  再限流
2026-09-14T14:32:49.952Z  重试
2026-09-14T14:32:52.252Z  再限流 + message=process 终结（会话 ses_f60367c3affeasQdbdIYyP7kCs 中断）
                          ↓ 148.96 秒
2026-09-14T14:33:59.021Z  go_upsell_last_seen_at 写入（= 同时 go_upsell_dont_show 写入）
```

**解释**：连续 6 次限流把会话打死之后，应用在 **2 分 29 秒后**弹出 OpenCode Go 升级引导（`go_upsell_last_seen_at`），用户当场点了"不再显示"（`go_upsell_dont_show` 与 seen_at 时间戳**毫秒级完全相同**，说明是"看到即关闭"的一次性交互，而非两次独立事件）。

> ⚠️ 注意语义区分：`go_upsell_last_seen_at` 是**通用**的 Go 引导（撞限流即触发）；`go_upsell_account_rate_limit_*` 是**账号级** Go 限流引导，二者均为 `null` 表示**从未见过账号级版本**。

### 5.2 交叉验证：数据库中不存在真正的 upsell 事件

对 6 GB 主库 `%USERPROFILE%\.local\share\opencode\opencode.db`（只读）的 `event` 表（295,868 行）做 `LIKE '%upsell%'` → 8 行命中，**逐条检查全部为误报**（Windows 容器 SVG 路径 `.../wsxpacks/Account/assets/assets/images/upsell-app-ai-refresh.svg`、`ipinfo.io` 的 `utm_campaign=upsell_sister_sites` 等工具输出文本），**没有一条是 OpenCode 的 Go upsell 事件**。

→ 结论：**upsell 的"是否见过/是否不再显示"状态只存在于客户端 `opencode.global.dat`，不落服务端事件流**。因此 5.1 的时间戳是唯一且可靠的"真撞过免费额度"证据。

---

## 6. `opencode.settings` / `opencode.global.dat` 中的账户、订阅、额度字段（必查项 5）

### 6.1 `opencode.settings`（全文键值，仅 4 项）

```
oldLayoutEligible             = false
tauriMigrated                 = true
windowIds                     = "c2e0deae-b084-4f5d-91a1-3e4215a01f23"
firstLaunchOnboardingComplete = true
```
→ **不含任何账户、订阅、额度、tier、plan 字段。**

### 6.2 `opencode.global.dat`（118,121 字符）

顶层键仅 6 个：
```
command.catalog.v1
go-upsell
layout
model
notification
server
```
- **没有** `account` / `subscription` / `plan` / `tier` / `quota` / `balance` / `zen` 等键。
- `go-upsell` 节点见 §5（唯一与额度相关的节点）。
- `model` 节点 = 用户最近选择的模型列表（`visibility: "show"`），示例：
```json
{"user":[{"providerID":"opencode","modelID":"muse-spark-1.2-contributor-free","visibility":"show"},{"providerID":"opencode","modelID":"nemotron-3-ultra-free","visibility":"show"},{"modelID":"nemotron-3.5-lightning-free","providerID":"opencode","visibility":"show"},{"modelID":"mimo-v2.5-free","providerID":"opencode","visibility":"show"}, ...]}
```
  → 用户收藏/展示的模型**清一色是 `opencode` 的 `-free` 模型**，与其实际调用分布一致。
- `notification` 节点 = 通知历史（含 §2.6 / §4.4 的 429、403、410 原始响应）。

### 6.3 数据库侧账户/订阅/消费（只读交叉验证）

- `account`、`control_account`、`credential` 表：**0 行**。
- 全库累计 `cost` 合计：**约 $0.0826**，且全部来自 `cline-pass`（第三方订阅），**`opencode` provider 侧 cost 为 0**——因为 `-free` 模型计价为 0。
- 日志全文检索：`"OpenCode Go"` 0 次、`"opencode go"` 0 次、`"Go plan"` 0 次、`"go plan"` 0 次、`"upgrade to"` 0 次、`"Free plan"` 0 次。

### 6.4 `auth.json`（仅列名与 type，无明文）

`%USERPROFILE%\.local\share\opencode\auth.json`：

| provider | type |
|---|---|
| `asaf` | `api` |
| `cline-pass` | `api` |
| `workbuddy` | `api` |
| `tokenharhur` | `api` |

→ 4 个自定义 API provider，**没有任何 `opencode` 官方账号 OAuth/登录凭据**（`opencode` provider 靠内置匿名/免费通道工作，无独立凭据条目）。

---

## 7. 结论（必查项 6）

### 7.1 本机免费限制的实际表现属于哪一类

**混合型（Mixed），但主因是 A 类：**

1. **A 类为主 — OpenCode 官方免费池限流/地区限制**
   - 60 次 `Rate limit exceeded`（2026-09-14 ～ 2026-10-16，跨 32 天，峰值 09-17 单日 37 次），HTTP **429**，经 Cloudflare 从 `opencode.ai` 边缘返回。
   - 另有 5 条 `[429]` 原生措辞（全部 2026-10-15）：`[429] Upstream error from Xiaomi: Request rate limited`（`type=server_error`）×2、`[429] Request rate limited`（`type=rate_limit_error`）×3。
   - 1 条 `[rate_limit_exceeded] Output token rate limit exceeded`（2026-09-17）→ 限制同时作用于**请求速率与输出 token 速率**。
   - **403 RegionError「This model is not available in your country.」** —— 免费模型存在地区可用性门槛。
   - **410 ModelDeprecated（`exo-free`）** —— 免费模型随时下架。
   - 大量 5xx/连接层失败（`opencode.ai:443` 连接超时 25 次、`Endpoint is unavailable` 283 次、`other side closed` 343 次）——免费池稳定性差。
   - **判定依据：用户 ~94% 的调用量都在 `opencode` 的 `-free` 模型上**（日志 16,479 次成功 stream 调用 / 267 个会话；DB 侧 8,932 条消息、2.406 亿 input tokens、**$0.00**），是免费额度的重度使用者。
   - **重要限定：这是"突发限流"，不是"额度耗尽"**。限流失败 60 次 vs 成功 16,479 次（失败率 ≈0.36%），且 **09-14 首次限流之后仍持续成功调用到 10-16**；日志中 `FreeTierError` / `FreeUsageLimitError` / `GoUsageLimitError` 均为 **0**。→ 免费池给的是**速率上限**，不是**总量上限**。
   - **授权是"客户端身份门禁"**：`auth.json` 无 `opencode` 条目，走匿名 `apiKey="public"`；该 key 在 OpenCode 客户端内可用、裸 curl 被 403 `FreeTierError` 拒绝（§3.4）。

2. **B 类为次 — 本地反代 `tokenharhur` 的账号级免费门槛**
   - `The free offer for this model isn't available on this account. Use the paid model 'claude-haiku-5.5' with a balance or a Pass`（2 次，2026-10-14T00:07:26Z）。
   - 随后 `127.0.0.1:8787` **ECONNREFUSED**（2026-10-14T00:19:10Z 起 6 次）→ 反代进程已消失。
   - 注意：这是**第三方中转商**的免费档规则，**与 OpenCode 的免费限制无关**，不应混为一谈。

3. **`workbuddy`（127.0.0.1:7863）零调用** —— 日志中无任何调用或失败记录，其 401 属当前态而非历史痕迹。

### 7.2 有无证据表明已订阅 OpenCode Go

**没有。** 五重否定：

1. 日志全文无 `OpenCode Go` / `go plan` / `subscription` / `upgrade to` 字样（命中 0）。
2. `opencode.global.dat` 无 account / subscription / plan / tier / quota 键。
3. `opencode.settings` 仅 4 个 UI 状态键。
4. 数据库 `account` / `control_account` / `credential` 表 0 行。
5. 全库累计消费 $0.0826 且全部来自 `cline-pass`，`opencode` 侧消费为 0。

**但**：`go_upsell_last_seen_at` = `2026-09-14T14:33:59.021Z` **明确证明用户曾因撞到免费额度而收到过 OpenCode Go 的升级引导**，并在同一毫秒选择"不再显示"。即：**Go 引导被触发过并被用户永久关闭**；`go_upsell_account_rate_limit_*` 保持 `null`，说明"账号级限流"这一档引导从未出现。

---

## 8. 原始证据索引（便于复核）

| 证据 | 位置 |
|---|---|
| 首次限流行 | `opencode.log` line 4122 |
| 末次限流行 | `opencode.log` line 135962 |
| 09-17 峰值样本 | `opencode.log` `2026-09-17T05:53:32.674Z` |
| 09-14 连续限流 + upsell 时间线 | `opencode.log` line 4118–4138 |
| `free offer` 错误 | `opencode.log` `2026-10-14T00:07:26.069Z` |
| 8787 ECONNREFUSED | `opencode.log` `2026-10-14T00:19:10.356Z` ～ `00:20:14.785Z` |
| `[429]` 原生措辞（5 条） | `opencode.log` `2026-10-15T03:26:45.881Z` ～ `06:49:19.218Z` |
| `Output token rate limit exceeded` | `opencode.log` `2026-09-17T15:04:33.451Z` |
| 首次/末次免费成功调用 | `opencode.log` `2026-09-14T11:23:28.292Z` / `2026-10-16T04:13:04.565Z` |
| `go_upsell_*` 原文 | `opencode.global.dat` → `"go-upsell"` 节点 |
| 429 / 403 / 410 原始响应 | `opencode.global.dat` → `"notification"` 数组 |
| 模型展示列表 | `opencode.global.dat` → `"model"` 节点 |
| token/cost 累计 | `opencode.db` → `message.data` 的 `$.cost` / `$.tokens.*` 聚合 |
| provider 配置 | `%USERPROFILE%\.config\opencode\opencode.jsonc` |
| provider 凭据名 | `%USERPROFILE%\.local\share\opencode\auth.json`（仅名 + type） |

---

## 8.5 与 Lead 侦察数据的交叉验证

| Lead 提供 | 本报告复核结果 |
|---|---|
| `auth.json` 只有 4 个 provider、**无 `opencode` 条目** | ✅ 确认（asaf / cline-pass / workbuddy / tokenharhur，全 `type=api`）→ 匿名 `apiKey="public"` |
| `FreeTierError` / `FreeUsageLimitError` / `GoUsageLimitError` / `free tier` / `free_tier` = 0 | ✅ 全部确认 = 0 |
| `providerID=opencode` = 17,457 次 | ✅ 复核 17,467（差值来自本次取证期间新增行，同量级） |
| 免费模型当前仍在成功调用（`2026-10-16T04:11:36.739Z` 等） | ✅ 确认，末次成功 `2026-10-16T04:13:04.565Z` |
| 免费模型 id 命中次数（mimo 12833 / space-bunny 3158 / …） | ✅ 采纳，见 §3.1 |
| `cat-jam-free` / `big-pickle` / `jev-1.13-free` = 0 | ✅ 确认（列表有、本机未跑过） |
| `client=desktop` = 0 | ✅ 确认（客户端身份标记不入日志） |
| 裸 curl 免费模型 → 403 `FreeTierError`；付费 → 401 `AuthError` | ✅ 与"app 内 16,479 次成功"对照，推出**客户端身份门禁**，见 §3.4 |
| 8787 拒绝连接 | ✅ 定位到起始时刻 `2026-10-14T00:19:10.356Z`（`free offer` 报错后 12 分钟） |
| 7863 需鉴权（401） | ⚠️ 日志内 `providerID=workbuddy` / `127.0.0.1:7863` 均 **0 次**，无历史痕迹，只能由实时探测确认 |

**Lead 未覆盖、本报告新增的关键发现：**
1. `go_upsell_last_seen_at` = `1789396439021`（**2026-09-14T14:33:59.021Z**），`go_upsell_dont_show` 同值 → **真撞过免费额度并关闭了 Go 引导**。
2. `go_upsell_account_rate_limit_*` = `null` → 账号级限流引导从未出现。
3. DB 聚合：`opencode` 免费通道 **2.406 亿 input tokens / $0.00**。
4. 1 条 `Output token rate limit exceeded`（输出 token 速率限制）。
5. 5 条原生 `[429]`（Xiaomi 上游限流 + OpenCode `rate_limit_error`）。
6. 403 RegionError（地区限制）与 410 ModelDeprecated（`exo-free` 下架）。

---

## 9. 未决 / 边界说明

- `workbuddy`(7863) 的 401 无法从日志取证（窗口内 0 次调用），只能由 Lead 的实时探测确认。
- `event` 表中 706 条 `Rate limit` 字面命中与 8 条 `upsell` 命中经逐条抽样确认为**工具输出/提示词文本误报**，未作为证据使用。
- 桌面端 `logs\` 目录下 `network.netlog` 等文件仅含 NetLog 元数据，未提供额外限流证据。
- DB 仅保留 64 个 session（日志 267 / 事件 268），历史会话已被清理 → **§3.3 的 token/cost 是下界**。
- `429` 裸数字在日志中命中 2033 次，绝大多数为行号/ID/时间戳噪声；本报告只采用语义明确的 60 条 `Rate limit exceeded` + 5 条 `[429]` + 1 条 `Output token rate limit exceeded`。
- `quota`（7 次）与 `zenmux`（370 次）经上下文检查全为**用户自己的脚本/文件名**，已排除。
- 本次取证未使用任何写入操作；未触碰运行中的 7 个 OpenCode 进程。
