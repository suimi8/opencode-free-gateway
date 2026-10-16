# 01 — OpenCode Desktop「FREE 模型限制」核心引擎分析报告

> ## ⚠️ 2026-10-17 更正（先读这段）
>
> 本报告写于第 1 轮（core-gate）。其中关于**请求门禁**的部分已被后续四轮单变量消融更正：
>
> | 原结论 | 实测更正 |
> |--------|----------|
> | `x-opencode-session-id` 必需 | ❌ **可以完全删掉**，仍 200。真正必需的是 `x-opencode-session` |
> | UA 只要以 `opencode/` 开头 | ⚠️ **还要版本 ≥ 1.18.0**，否则 **426**（不是 403）|
> | 门禁 = 4 条 | 实为 **5 条** |
>
> 复现脚本：[`../04-门禁判别实验/verify_recipe*.mjs`](../04-门禁判别实验/)。
> 权威判据见 [`../README.md`](../README.md) 与 [`../04-门禁判别实验/README.md`](../04-门禁判别实验/README.md)。
> 本报告关于**额度/客户端行为**的其余结论不受影响。

- 任务：task-1（owner: core-gate）
- 分析对象（只读，未修改任何文件）：
  - 主进程 bundle：`99-解包产物与运行时残留\OpenCode-Desktop-1.19.2-解包\out\main\chunks\node-ibnNxpSl.js`（665066 行，约 38 MB）
  - 渲染层 bundle：`99-解包产物与运行时残留\OpenCode-Desktop-1.19.2-解包\out\renderer\assets\main-C07s90t2.js`（161562 行）
  - 活体模型快照：`%USERPROFILE%\.cache\opencode\models.json`（5672382 字节）
- 解包来源：`%LOCALAPPDATA%\Programs\@opencode-aidesktop\resources\app.asar`
- 结论一句话：**免费层的“额度”完全由服务端判定；客户端只做两件事——(a) 无 API key 时本地禁用所有 `cost.input > 0` 的模型（免费门禁），(b) 通过响应体字符串 `FreeUsageLimitError` / `GoUsageLimitError` 识别额度耗尽并弹升级引导。客户端不含任何请求数/token/金额阈值常量。**

---

## 1) `free_tier_limit` / `account_rate_limit` 的产生点与判定条件

### 1.1 产生点：`retryable(error, provider)`（`node-ibnNxpSl.js:441406-441472`）

```js
441406: function retryable(error, provider9) {
441407:   if (ContextOverflowError2.isInstance(error))
441408:     return;
441409:   if (APIError2.isInstance(error)) {
441410:     const status2 = error.data.statusCode;
441411:     if (!error.data.isRetryable && !(status2 !== void 0 && status2 >= 500) && !matchesRetryableMessage(error.data.message) && !matchesRetryableMessage(error.data.responseBody))
441412:       return;
441413:     if (error.data.responseBody?.includes("FreeUsageLimitError")) {
441414:       return {
441415:         message: GO_UPSELL_MESSAGE,
441416:         action: {
441417:           reason: "free_tier_limit",
441418:           provider: provider9,
441419:           title: "Free limit reached",
441420:           message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
441421:           label: "subscribe",
441422:           link: GO_UPSELL_URL
441423:         }
441424:       };
441425:     }
441426:     if (error.data.responseBody?.includes("GoUsageLimitError")) {
441427:       const body22 = parseJSON13(error.data.responseBody);
441428:       const workspace = str3(body22?.metadata?.workspace);
441429:       const limitName = str3(body22?.metadata?.limitName);
441430:       const retryAfter = num(error.data.responseHeaders?.["retry-after"]);
...
441445:       const message7 = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`;
441446:       const link2 = `https://opencode.ai/workspace/${workspace}/go`;
441447:       return {
441448:         message: `${message7} - ${link2}`,
441449:         action: {
441450:           reason: "account_rate_limit",
441451:           provider: provider9,
441452:           title: "Go limit reached",
441453:           message: message7,
441454:           label: "open settings",
441455:           link: link2
441456:         }
441457:       };
441458:     }
```

**判定条件（两条，均为纯字符串匹配，无本地计数）：**

| reason | 触发条件 | 来源 |
|---|---|---|
| `free_tier_limit` | `error.data.responseBody?.includes("FreeUsageLimitError")` | `node-ibnNxpSl.js:441413` |
| `account_rate_limit` | `error.data.responseBody?.includes("GoUsageLimitError")` | `node-ibnNxpSl.js:441426` |

**前置守卫**（不满足则直接 `return`，不会产生这两个 reason）——`node-ibnNxpSl.js:441411`：

```js
if (!error.data.isRetryable && !(status2 !== void 0 && status2 >= 500) && !matchesRetryableMessage(error.data.message) && !matchesRetryableMessage(error.data.responseBody))
  return;
```

- 即：只要 `isRetryable === true`，或 HTTP 状态码 `>= 500`，或 message/responseBody 命中 `RETRYABLE_MESSAGE_PATTERNS`，守卫即通过。
- `isRetryable` 默认值（`node-ibnNxpSl.js:169802`）：
  ```js
  isRetryable = statusCode != null && (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500)
  ```
  → **HTTP 429 天然满足 `isRetryable`**，所以「429 + body 含 `FreeUsageLimitError`」必然进入升级引导分支。
- 可重试消息正则（`node-ibnNxpSl.js:441525-441533`）：
  ```js
  RETRYABLE_MESSAGE_PATTERNS = [
    /429|500|502|503|504|524/i,
    /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
    /overloaded|service unavailable|...|provider returned error|.../i,
    /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|.../i,
    /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
    /try your request again|retry your request|resource exhausted|resource_exhausted/i,
    /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i
  ];
  ```
- `matchesRetryableMessage` 定义于 `node-ibnNxpSl.js:441473`。

### 1.2 调用链

1. `policy2(opts)`（`node-ibnNxpSl.js:441498-441518`）在每次失败时调用 `retryable(error, opts.provider)`（`:441501`）。
2. 在 `SessionProcessor.process` 的流处理管道中通过 `retry2(policy2({...}))` 挂载（`node-ibnNxpSl.js:442179-442191`）：
   ```js
   442179: })), catchCauseIf2((cause) => !hasInterruptsOnly2(cause), (cause) => fail7(squash(cause))), retry2(policy2({
   442180:   provider: input.model.providerID,
   442181:   parse: parse24,
   442182:   set: (info22) => {
   442183:     return status2.set(ctx.sessionID, {
   442184:       type: "retry",
   442185:       attempt: info22.attempt,
   442186:       message: info22.message,
   442187:       action: info22.action,
   442188:       next: info22.next
   442189:     });
   442190:   }
   442191: })), catch_2(halt), ensuring2(cleanup()));
   ```
3. `policy2` 内部把 `message` / `action` / `next` 写入会话状态（`node-ibnNxpSl.js:441509-441514`）：
   ```js
   yield* opts.set({
     attempt: meta2.attempt,
     message: retry3.message,
     action: retry3.action,
     next: now4 + wait2
   });
   ```

### 1.3 关键结论

- **客户端不存在任何本地额度计数器**（无请求数、无 token 计费、无金额累计）。整个 bundle 中 `UsageLimit` / `usage_limit` / `usageLimit` / `RateLimited` 仅命中 `:441413` 与 `:441426` 两处。
- `free_tier_limit` 的 `provider` 字段来自 `input.model.providerID`，因此对任意 provider 都可能出现，但 UI 只对 `opencode` / `opencode-go` 弹窗（见 §3）。
- `GoUsageLimitError` 分支额外解析服务端返回的 `metadata.workspace`（用于拼接 `https://opencode.ai/workspace/<id>/go`）与 `metadata.limitName`（用于文案前缀，例如 “daily usage limit” / “weekly usage limit”），并读取 `retry-after` 响应头把重置时间格式化为 “N days M hours” / “N hours M minutes” / “less than a minute”（`node-ibnNxpSl.js:441428-441443`）。

---

## 2) 具体数值与时间窗

**结论：客户端没有任何额度数值与时间窗常量。**

| 检索项 | 结果 |
|---|---|
| `per day\|per month\|per hour\|daily\|monthly\|Free usage\|free requests\|requests left` | 全 bundle 仅命中 `node-ibnNxpSl.js:441519`（即 `GO_UPSELL_MESSAGE` 所在常量行） |
| `UsageLimit\|usage_limit\|usageLimit\|RateLimited` | 仅命中 `:441413`、`:441426` |
| `FreeUsageLimitError` | 仅命中 `:441413`（判定）与 `:441519` 无关行 |
| `GoUsageLimitError` | 仅命中 `:441426` |

客户端唯一的**数值常量**是重试策略（`node-ibnNxpSl.js:441519`）：

```js
var GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go", GO_UPSELL_URL = "https://opencode.ai/go", RETRY_INITIAL_DELAY = 2e3, RETRY_BACKOFF_FACTOR = 2, RETRY_JITTER_FACTOR = 0.25, RETRY_MAX_DELAY_NO_HEADERS = 3e4, RETRY_MAX_DELAY = 2147483647, RETRY_MAX_RETRIES = 5, RETRYABLE_MESSAGE_PATTERNS;
```

- `RETRY_INITIAL_DELAY = 2000 ms`
- `RETRY_BACKOFF_FACTOR = 2`
- `RETRY_JITTER_FACTOR = 0.25`
- `RETRY_MAX_DELAY_NO_HEADERS = 30000 ms`（无响应头时的退避上限）
- `RETRY_MAX_DELAY = 2147483647 ms`（约 24.8 天；有 `retry-after` 头时允许的最大等待）
- `RETRY_MAX_RETRIES = 5`

退避实现 `delay8(attempt, error, random)`（`node-ibnNxpSl.js:441375-441401`）：

```js
441375: function delay8(attempt, error, random4 = Math.random()) {
441376:   if (error) {
441377:     const headers7 = error.data.responseHeaders;
441378:     if (headers7) {
441379:       const retryAfterMs2 = headers7["retry-after-ms"];
...
441386:       const retryAfter = headers7["retry-after"];
441387:       if (retryAfter) {
441388:         const parsedSeconds = Number.parseFloat(retryAfter);
441389:         if (!Number.isNaN(parsedSeconds)) {
441390:           return cap(Math.ceil(parsedSeconds * 1e3));
441391:         }
441392:         const parsed = Date.parse(retryAfter) - Date.now();
...
441397:       return cap(exponential2(attempt, random4));
441398:     }
441399:   }
441400:   return cap(Math.min(exponential2(attempt, random4), RETRY_MAX_DELAY_NO_HEADERS));
441401: }
```

- `cap(ms) = Math.min(ms, RETRY_MAX_DELAY)`（`node-ibnNxpSl.js:441372-441374`）
- **优先采用服务端响应头 `retry-after-ms`（毫秒）→ `retry-after`（秒或 HTTP 日期）**，这是唯一能反映服务端真实时间窗的信号，且完全由服务端下发。
- 无响应头时：`min(2^attempt * 2000 * jitter, 30000)` → 约 2s / 4s / 8s / 16s / 30s（第 5 次被 30s 上限截断）。

**因此：请求数 / token / 金额 / 每日·每月·滚动窗口等阈值必须由服务端 `https://opencode.ai/inference/v1`（以及 `/inference/go/v1`）判定，客户端不可见。** 服务端下发的 `metadata.limitName` 与 `retry-after` 是唯一的窗口线索。

---

## 3) 耗尽后的行为

### 3.1 主进程侧：不降级、只重试，5 次后报错

- 重试上限（`node-ibnNxpSl.js:441504`）：
  ```js
  441504:     if (meta2.attempt > RETRY_MAX_RETRIES)
  441505:       return done2(meta2.attempt);
  ```
  → 最多重试 5 次（attempt 0..5），第 6 次失败即放弃。
- **不自动切换/降级模型**，不自动改用 `opencode-go`，不修改 provider。整个 `retryable` / `policy2` 路径没有任何模型选择或 fallback 逻辑。
- 会话进入 `type: "retry"` 状态并携带 `action`（`node-ibnNxpSl.js:442183-442189`）。
- 放弃后错误写入 assistant message 并通过事件发布（`node-ibnNxpSl.js:442153` `ctx.assistantMessage.error` + `Event30.Error`），随后 `:442158` 把状态置回 `idle`。

### 3.2 状态 schema 与事件

`node-ibnNxpSl.js:420003-420031`：

- `SessionStatus` = Union[`idle`, `{ type: "retry", attempt: NonNegativeInt, message: String5, action: optional({ reason, provider, title, message, label, link? }), next: NonNegativeInt }`, `busy`]
- 事件：`{ type: "session.status", sessionID, status }`

### 3.3 渲染层侧：仅对 opencode / opencode-go 弹升级引导

`out\renderer\assets\main-C07s90t2.js:152558`：

```js
const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"]);
```

`main-C07s90t2.js:152564`：

```js
if (!GO_UPSELL_PROVIDERS.has(action.provider)) return;
```

→ **非 opencode 系 provider 即使返回同样的 `FreeUsageLimitError`，也不会弹升级窗**，只会在会话里显示重试/错误状态。这是「仅影响 opencode」的直接证据。

节流与持久化键（`main-C07s90t2.js:152553-152557`）：

| 键 | 值 |
|---|---|
| `GO_UPSELL_FREE_TIER_LAST_SEEN_AT` | `"go_upsell_last_seen_at"` |
| `GO_UPSELL_FREE_TIER_DONT_SHOW` | `"go_upsell_dont_show"` |
| `GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT` | `"go_upsell_account_rate_limit_last_seen_at"` |
| `GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW` | `"go_upsell_account_rate_limit_dont_show"` |
| `GO_UPSELL_WINDOW` | `864e5`（24 小时） |

弹窗条件（`main-C07s90t2.js:152595-152607`）：监听 `session.status`，仅当

1. `status.type === "retry"` 且携带 `action`；
2. 当前无其它 dialog（`dialog.active` 为假）；
3. 同一 reason 在 `GO_UPSELL_WINDOW`（24h）内未展示过：`if (seen2 && Date.now() - seen2 < GO_UPSELL_WINDOW) return;`（`:152606`）；
4. 用户未勾选“不再显示”；

才弹出 `DialogUsageExceeded`。

- `free_tier_limit` 分支（`main-C07s90t2.js:152608-152633`）：关闭时若未勾选“不再显示”，会打开 `DialogConnectProvider` 并 `controller.select("opencode-go")` —— 即引导用户切到 Go 订阅。
- i18n 文案键：`dialog.usageExceeded.freeTier.{title,description,actionLabel}`、`dialog.usageExceeded.accountRateLimit.{title,description,actionLabel}`、`dialog.usageExceeded.dontShowAgain`（示例 `out\renderer\assets\ja-C72S_l2L.js:89-94`；`freeTier.description` 日文为「月額 $10」）。

### 3.4 行为总结

| 维度 | 行为 |
|---|---|
| 是否硬阻塞 | 否（不是本地硬阻塞）；表现为连续 5 次重试失败 → 该轮请求报错 |
| 是否自动降级 | 否 |
| 影响范围 | 服务端按 key/workspace 判定；UI 引导仅对 `opencode` / `opencode-go` |
| 恢复信号 | 服务端 `retry-after` / `retry-after-ms` 响应头；`GoUsageLimitError` 还会给 `metadata.limitName` |
| 用户可见出口 | 升级弹窗（24h 节流、可“不再显示”）+ `https://opencode.ai/go` / `https://opencode.ai/workspace/<workspace>/go` |

---

## 4) 客户端 FREE 门禁（本地限制，与额度限制是两套机制）

这是客户端唯一真正“本地决定”的限制：**没有 API key 时，只保留 `cost.input === 0` 的模型。**

### 4.1 新版目录路径（`OpencodePlugin`，`node-ibnNxpSl.js:313551` 起）

`node-ibnNxpSl.js:313630-313646`：

```js
313630:         const item2 = catalog.provider.get(ID7.opencode);
313631:         if (!item2)
313632:           return;
313633:         const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || item2.provider.request.body.apiKey);
313634:         catalog.provider.update(item2.provider.id, (provider9) => {
313635:           if (!hasKey)
313636:             provider9.request.body.apiKey = "public";
313637:         });
313638:         if (hasKey)
313639:           return;
313640:         for (const model8 of item2.models.values()) {
313641:           if (!model8.cost.some((cost3) => cost3.input > 0))
313642:             continue;
313643:           catalog.model.update(item2.provider.id, model8.id, (draft) => {
313644:             draft.enabled = false;
313645:           });
313646:         }
```

要点：

- `hasKey` 三来源：环境变量 `OPENCODE_API_KEY`、`connected`（登录态）、`item2.provider.request.body.apiKey`。
- 无 key 时把请求体 `apiKey` 覆写为字面量 `"public"`（`:313636`）——即所谓匿名免费通道。
- 无 key 时遍历 `opencode` provider 的**全部**模型，凡 `cost` 中存在任一 `input > 0` 的条目一律 `draft.enabled = false`（`:313641-313645`）。
- 注意：此处只处理 `opencode`（`ID7.opencode`），**不处理 `opencode-go`**；`opencode-go` 的免费模型可见性由后面的 SDK 加载器与远端 config 决定。

### 4.2 旧版 / SDK 自定义加载器路径（`node-ibnNxpSl.js:654799-654817`）

```js
654799:     opencode: fnUntraced2(function* (input) {
654800:       const env2 = yield* dep.env();
654801:       const hasKey = iife2(() => {
654802:         if (input.env.some((item2) => env2[item2]))
654803:           return true;
654804:         return false;
654805:       });
654806:       const ok2 = hasKey || Boolean(yield* dep.auth(input.id)) || Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey);
654807:       if (!ok2) {
654808:         for (const [key2, value4] of Object.entries(input.models)) {
654809:           if (value4.cost.input === 0)
654810:             continue;
654811:           delete input.models[key2];
654812:         }
654813:       }
654814:       return {
654815:         autoload: Object.keys(input.models).length > 0,
654816:         options: ok2 ? {} : { apiKey: "public" }
654817:       };
654818:     }),
```

- 无 key（`ok2 === false`）时**直接 `delete`** 掉 `cost.input !== 0` 的模型（`:654811`），语义与 `:313641` 一致，仅写法不同（`=== 0` 保留 vs `!some(input > 0)` 保留）。
- `options: ok2 ? {} : { apiKey: "public" }`（`:654816`）——与 `:313636` 同源。
- `autoload: Object.keys(input.models).length > 0`（`:654815`）：若免费模型被删光则整个 provider 不自动加载。

### 4.3 远端 provider 配置覆写（版本门控）

- `fetchProviders`：`get15(\`${server2}/api/config\`)` + `bearerToken(token)` + `x-org-id`（`node-ibnNxpSl.js:313437-313447`；`:313442`）。
- `defaultServer = "https://opencode.ai/console"`，`clientID2 = "opencode-cli"`（`:313520`）。
- OAuth 设备流：`/auth/device/token`、`/api/user`、`/api/orgs`（`:313472-313518`）。
- 响应 schema：`RemoteResponse = Struct({ config: Info28 })`（`:313534`）。
- v2 catalog 覆写（`:313573-313629`）：用远端 config 覆写 `provider.api`、`model.capabilities.tools`、`cost`（`remoteCost`，`:313451-313471`）、`limit`（`:313626 model8.limit = { ...config6.limit }`）、`status`：
  - `model8.status = config6.status ?? "active"`（`:313623`）
  - `model8.enabled = config6.status !== "deprecated"`（`:313624`）
- 即：**哪些模型算免费、限额是多少，服务端 `/api/config` 可以随时改写**，客户端快照只是缓存。

---

## 5) FREE 模型清单

数据源：`%USERPROFILE%\.cache\opencode\models.json`（与 bundle `node-ibnNxpSl.js:169228` 的 `loadSnapshot` 同源；来源 `Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"`，见 `:169208`；缓存路径 `Path3.cache + "models.json"`，见 `:169209`）。
判定条件：`cost.input === 0 && cost.output === 0`（与门禁逻辑一致）。
全量导出：`07-原始证据\data\opencode-models.txt`；汇总：`07-原始证据\data\free-summary.txt`。

### 5.1 provider `opencode`（共 124 个模型；免费 41 个；其中活跃 10 个）

活跃免费模型（`status !== "deprecated"`，全部 `tool_call: true`，`cost = {"input":0,"output":0,"cache_read":0}`）：

| id | context | output | attachment | reasoning | last_updated |
|---|---|---|---|---|---|
| `longcat-2.5-preview-free` | 1 000 000 | 131 072 | true | true | 2026-09-25 |
| `cat-jam-free` | 1 048 576 | 131 072 | false | true | 2026-10-12 |
| `space-bunny-free` | 1 048 576（input 524 288） | 524 288 | true | true | 2026-09-23 |
| `mimo-v2.6-flash-free` | 200 000 | 32 000 | true | true | 2026-09-22 |
| `nemotron-3-ultra-free` | 1 000 000 | 128 000 | false | true | 2026-06-04 |
| `nemotron-3.5-lightning-free` | 262 144 | 262 144 | false | true | 2026-08-11 |
| `nemotron-3.5-super-vl-free` | 1 048 576（input 1 048 576） | 131 072 | true | true | 2026-10-15 |
| `deepseek-v4.1-flash-free` | 200 000 | 32 000 | true | true | 2026-09-10 |
| `big-pickle` | 200 000（input 160 000） | 32 000 | false | true | 2025-10-17 |
| `muse-spark-1.3-contributor-free` | 1 048 576 | 131 072 | true | true | 2026-09-02 |

另有 **31 个已 `deprecated` 的免费模型**（仍 `tool_call: true`，但因 `:313624` 的 `enabled = status !== "deprecated"` 默认不启用）：
`ling-3.0-flash-fin-free`、`fledge-alpha-free`、`qwen3.6-plus-free`、`glm-5-free`、`glm-4.7-free`、`kimi-k2.5-free`、`minimax-m3-free`、`minimax-m2.5-free`、`mimo-v2-pro-free`、`trinity-large-preview-free`、`exo-free`、`ring-2.6-1t-free`、`longcat-2.0-free`、`hy3-preview-free`、`nemotron-3-super-free`、`minimax-m2.1-free`、`mimo-v2.5-free`、`grok-code`、`ling-2.6-flash-free`、`deepseek-v4-flash-free`、`hy3-free`、`mimo-v2-omni-free`、`ling-3.0-flash-free`、`north-mini-code-free`、`mimo-v2-flash-free`、`step-5-preview-free`、`x-preview-f-free` 等。

`opencode` 付费模型 83 个（非零 cost），例如：
`gpt-5.4`（in 2.5 / out 15）、`claude-haiku-4-5`（1 / 5）、`gpt-5.4-pro`（30 / 180）、`deepseek-v4-flash`（0.14 / 0.28）、`gemini-3-pro`（2 / 12）、`kimi-k3`（3 / 15）、`glm-4.6`（0.6 / 2.2）。

### 5.2 provider `opencode-go`（共 31 个模型；免费 3 个，活跃 2 个）

| id | context | output | 状态 |
|---|---|---|---|
| `longcat-2.5-preview-free` | 1 000 000 | 131 072 | 活跃免费 |
| `cat-jam-free` | 1 048 576 | 131 072 | 活跃免费 |
| `step-5-preview-free` | 1 000 000 | 65 536 | deprecated |

付费 28 个，例如 `deepseek-v4.1-flash`（0.15 / 0.6）、`glm-5.3`（1.4 / 4.4）、`kimi-k3`（3 / 15）、`space-bunny`（0.15 / 0.6）。

**要点：`opencode-go` 的免费模型是 `opencode` 免费模型的子集（2 个交集：`longcat-2.5-preview-free`、`cat-jam-free`），且 Go 的付费模型同样需要有效 key/余额。**

---

## 6) 远端端点与请求头

### 6.1 provider 定义

| 字段 | `opencode` | `opencode-go` |
|---|---|---|
| id | `opencode` | `opencode-go` |
| name | OpenCode | OpenCode Go |
| npm | `@ai-sdk/openai-compatible` | `@ai-sdk/openai-compatible` |
| api | `https://opencode.ai/inference/v1` | `https://opencode.ai/inference/go/v1` |
| env | `["OPENCODE_API_KEY"]` | `["OPENCODE_API_KEY"]` |
| doc | `https://opencode.ai/v2/docs/console/models/` | `https://opencode.ai/v2/docs/console/go/` |

### 6.2 请求头（`node-ibnNxpSl.js:441027-441044`）

```js
441020:     const opencodeProjectID = input.model.providerID.startsWith("opencode") ? (yield* context4).project.id : void 0;
441027:       headers: {
441028:         "x-opencode-session-id": input.sessionID,
441029:         ...input.parentSessionID ? { "x-opencode-parent-session-id": input.parentSessionID } : {},
441030:         ...input.model.providerID.startsWith("opencode") ? {
441031:           ...opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {},
441032:           "x-opencode-session": input.sessionID,
441033:           "x-opencode-request": input.user.id,
441034:           "x-opencode-client": input.flags.client,
441035:           "User-Agent": USER_AGENT2
441036:         } : {
441037:           "x-session-affinity": input.sessionID,
441038:           "X-Session-Id": input.sessionID,
441039:           "User-Agent": USER_AGENT2
441040:         },
441041:         ...input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {},
441042:         ...input.model.headers,
441043:         ...headers7
441044:       }
```

- 总是发送：`x-opencode-session-id`；有父会话时附加 `x-opencode-parent-session-id` 与 `x-parent-session-id`。
- `providerID.startsWith("opencode")` 时**额外**发送：`x-opencode-project`（project.id）、`x-opencode-session`、`x-opencode-request`（user.id）、`x-opencode-client`（`flags.client`），并覆盖 `User-Agent`。
- 否则发送 `x-session-affinity` + `X-Session-Id`（第三方 provider 的会话粘性）。
- 认证头不在 `retryable`/header 构造里硬编码，来自 provider 配置的 `apiKey`（免费通道为字面量 `"public"`）。

### 6.3 相关端点汇总

| 用途 | URL | 证据 |
|---|---|---|
| 免费/付费推理 | `https://opencode.ai/inference/v1` | provider 定义 |
| Go 推理 | `https://opencode.ai/inference/go/v1` | provider 定义 |
| 远端 provider/model 配置 | `https://opencode.ai/console/api/config`（`server2` 默认 `https://opencode.ai/console`） | `node-ibnNxpSl.js:313442`、`:313520` |
| 模型目录快照 | `https://models.opencode.ai`（`Flag.OPENCODE_MODELS_URL` 可覆写） | `node-ibnNxpSl.js:169208` |
| 升级落地页 | `https://opencode.ai/go` | `node-ibnNxpSl.js:441519` |
| 工作区 Go 设置 | `https://opencode.ai/workspace/<workspace>/go` | `node-ibnNxpSl.js:441446` |
| OAuth 设备流 | `/auth/device/token`、`/api/user`、`/api/orgs` | `node-ibnNxpSl.js:313472-313518` |
| 文档 | `https://opencode.ai/v2/docs/console/models/`、`.../go/` | provider 定义 |

注：`HTTP-Referer` / `X-Title: "opencode"` 出现在 `node-ibnNxpSl.js:305427-305461`、`:318474`、`:320762`、`:335776-335780`、`:655025-655055`、`:655377-655386`，这些多为第三方转售 provider 的标记，**不是** zen/免费通道的额度相关头。

---

## 7) 功能级限制

**结论：没有功能级限制。免费模型工具调用、推理、附件、Web 搜索均与付费模型同权。**

- 全部免费模型 `tool_call: true`（§5 快照）；`structured_output: true`、`reasoning: true` 亦一致。
- Web 搜索反而**默认对 opencode 系启用**（`node-ibnNxpSl.js:637039-637040`）：
  ```js
  637039: function webSearchEnabled(providerID2, flags2) {
  637040:   return providerID2 === ID7.opencode || providerID2 === ID7.make("opencode-go") || flags2.exa || flags2.parallel;
  ```
- 无任何「免费模型禁用工具」的分支：`retryable` / `policy2` / 门禁代码（`:313630-313646`、`:654799-654817`）只操作 `enabled` / 删除模型 / 改写 `apiKey`，从不触碰 `capabilities.tools`。
- 唯一的工具相关覆写来自远端 config（`:313573-313629` 覆写 `model.capabilities.tools`），属服务端可控的模型元数据，而非「免费层降级」。
- 其他与 provider 特化相关的代码（`node-ibnNxpSl.js:426105` 与 deepseek-v4-flash 相关、`:426639`、`:426704` 在 `providerID.startsWith("opencode") && setCacheKey !== false` 时设置 cache key、`:428945`）经检查均与免费层限制无关。

---

## 8) 不确定项 / 未决问题

1. **服务端真实阈值不可见**：`FreeUsageLimitError` / `GoUsageLimitError` 在客户端仅作为字符串出现，请求数 / token / 金额 / 时间窗（每日、每月、滚动）的数值全部由服务端 `https://opencode.ai/inference/v1` 与 `/inference/go/v1` 判定。客户端唯一线索是 `GoUsageLimitError` 响应体里的 `metadata.limitName` 与响应头 `retry-after` / `retry-after-ms`。需要抓包（external-docs / runtime-proof）或服务端文档才能给出具体数字。
2. **两套免费门禁语义相同但写法不同**：`:313641` 用 `!model8.cost.some(c => c.input > 0)`，`:654809` 用 `value4.cost.input === 0`。若某模型 `cost` 数组元素缺 `input` 字段，两者行为可能分歧（`undefined > 0` 为 false → 保留；`undefined === 0` 为 false → 删除）。当前快照中所有免费模型 `cost.input` 均为显式 `0`，未观察到分歧。
3. **`opencode-go` 未走 `:313630-313646` 的本地门禁**：该分支只处理 `ID7.opencode`。`opencode-go` 的免费模型可见性依赖 SDK 加载器与远端 `/api/config`，本报告未做活体验证。
4. **重试时序为推算**：`RETRY_INITIAL_DELAY=2000`、`BACKOFF_FACTOR=2`、`JITTER=0.25`、`RETRY_MAX_DELAY_NO_HEADERS=30000`，在无 `retry-after` 头时约 2/4/8/16/30 秒；具体每次的随机抖动值未实测。
5. **`hasKey` 的真实取值**：`process.env.OPENCODE_API_KEY`、登录态 `connected`、`auth.json` 内容属 runtime-proof 范围，本次未读取本机 `%USERPROFILE%\.local\share\opencode\auth.json`（419 B），故无法判定本机当前是「匿名 public 通道」还是「已登录」。
6. **`retry-after` 与 `RETRY_MAX_DELAY=2147483647`**：若服务端下发极大的 `retry-after`，客户端会等待至多约 24.8 天（`cap` 只截断到 `RETRY_MAX_DELAY`），这在实际会话中可能表现为长时间卡在 `retry` 状态。未实测服务端是否真会下发如此大的值。

---

## 附：证据索引（文件:行号）

| 主题 | 位置 |
|---|---|
| `free_tier_limit` / `account_rate_limit` 产生 | `node-ibnNxpSl.js:441406-441472`（`:441413`、`:441417`、`:441426`、`:441450`） |
| 重试守卫 | `node-ibnNxpSl.js:441411` |
| 重试策略常量 | `node-ibnNxpSl.js:441519` |
| 退避实现 | `node-ibnNxpSl.js:441372-441401` |
| 可重试正则表 | `node-ibnNxpSl.js:441525-441533` |
| `policy2` 重试策略 | `node-ibnNxpSl.js:441498-441518`（上限 `:441504`） |
| 重试接入 SessionProcessor | `node-ibnNxpSl.js:442179-442191` |
| `isRetryable` 默认 | `node-ibnNxpSl.js:169802` |
| SessionStatus schema / 事件 | `node-ibnNxpSl.js:420003-420031` |
| 请求头构造 | `node-ibnNxpSl.js:441020-441044` |
| 本地免费门禁（新版目录） | `node-ibnNxpSl.js:313630-313646` |
| 本地免费门禁（SDK 加载器） | `node-ibnNxpSl.js:654799-654817` |
| 远端 config 拉取 / 覆写 | `node-ibnNxpSl.js:313437-313447`、`:313534`、`:313573-313629` |
| 模型快照来源 / 缓存 | `node-ibnNxpSl.js:169208-169209`、`:169228` |
| Web 搜索默认启用 | `node-ibnNxpSl.js:637039-637040` |
| GO_UPSELL_PROVIDERS | `main-C07s90t2.js:152558`、`:152564` |
| 弹窗节流键 / 窗口 | `main-C07s90t2.js:152553-152557`、`:152606` |
| 弹窗逻辑 | `main-C07s90t2.js:152595-152633` |
| i18n 文案 | `out\renderer\assets\ja-C72S_l2L.js:89-94` 等各语言包 |
| 模型清单数据 | `%USERPROFILE%\.cache\opencode\models.json`；导出 `07-原始证据\data\opencode-models.txt` |
