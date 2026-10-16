# OpenCode Desktop「FREE 模型限制」全景分析（Lead 综合报告）

- 分析对象：`%LOCALAPPDATA%\Programs\@opencode-aidesktop`（OpenCode Desktop，Electron，`InstallationVersion = "1.19.2"`，`InstallationChannel = "prod"`）
- 方法：4 名子代理并行 + Lead 实测。全部只读，未修改被分析文件、未重启 OpenCode 进程、未泄露任何密钥。
- 分报告：
  - `01-core-free-gate.md` — 主进程 bundle 逆向（core-gate）
  - `02-ui-and-gating.md` — 渲染层 / Electron 壳 / i18n（ui-gate）
  - `03-runtime-evidence.md` — 日志 / DB / 桌面状态实证（runtime-proof）
  - `04-external-docs.md` — 官方文档 + 上游源码交叉验证（external-docs）
- 上游仓库：`sst/opencode` → 301 → **`github.com/anomalyco/opencode`**（`default_branch=dev`，2026-10-16）；本机 bundle 与上游**零差异**。

---

## 0. 一句话结论

**「FREE 模型限制」不是一个数值，而是 5 层叠加的门禁：**

| # | 层 | 限制内容 | 具体数值 | 判定方 |
|---|---|---|---|---|
| 1 | 本地选择门禁 | 未登录时只能选 `cost.input === 0` 的模型 | 无数值（二值） | 客户端 |
| 2 | 客户端身份门禁 | 免费层**只能在 OpenCode 客户端内**调用 | 无数值 | 服务端（私有） |
| 3 | 地区门禁 | 部分地区直接 403 `RegionError` | 无数值 | 服务端（Cloudflare） |
| 4 | 服务端额度/限流 | 请求数 / token / 金额 / 时间窗 | **客户端与公开源码里都没有任何数值** | 服务端（私有） |
| 5 | 模型规格差异 | 部分 free 变体上下文/输出被砍 | 见 §6（最高砍 5× ctx / 12× out） | 模型目录 |

**最关键的一条**：客户端（38 MB bundle）与公开源码里**完全不存在**免费层的请求数、token、金额、时间窗阈值常量——只有两个响应体字符串匹配。真实阈值在服务端私有实现里，只能靠 `metadata.limitName` + `retry-after` 响应头反推。

---

## 1. 什么算「FREE 模型」

判定口径（三处一致）：`cost.input === 0 && cost.output === 0`。

- 服务端 provider：`opencode`（`name=OpenCode`，`api=https://opencode.ai/inference/v1`，`env=["OPENCODE_API_KEY"]`）；付费档 `opencode-go`（`api=https://opencode.ai/inference/go/v1`）。
- 官方文档列 **13 个 free models**，全部标注 **limited time**：DeepSeek V4.1 Flash Free、Exo Free、MiMo-V2.6-Flash Free、Nemotron 3 / 3.5 系、Big Pickle、Space Bunny Free、Cat Jam Free、LongCat 2.5 Preview Free、Muse Spark 1.3 Contributor Free、Jev 1.13 Free 等 —— https://opencode.ai/v2/docs/console/models/
- 本地缓存 `%USERPROFILE%\.cache\opencode\models.json`（来源 `Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"`，见 `node-ibnNxpSl.js:169208`；缓存路径 `:169209`）：
  - provider `opencode`：124 个模型 / 零 cost 41 个 / **活跃免费 10 个** / 已 deprecated 31 个
  - provider `opencode-go`：31 个模型 / 零 cost 3 个（活跃 2 个，与 opencode 交集）
- **重要**：`GET https://opencode.ai/inference/v1/models`（`Authorization: Bearer public`）→ **HTTP 200**，返回 **86 个模型**，其中包含全部付费前沿模型（`claude-opus-5-5`、`gpt-6-astra`、`grok-4.7`、`kimi-k3`…）。
  → **模型清单不是门禁**；免费/付费都列出来，门禁在推理时。

### 1.1 本地缓存 vs 服务端实时目录（缓存已过期）

| 差异 | 内容 |
|---|---|
| 只在服务端（4） | `jev-1.13-free`、`jev-1.13`、`test`、`claude-opus-5-5-backup` |
| 只在本地缓存（42） | 含 `nemotron-3-ultra-free`、`x-preview-f-free`、`step-5-preview-free` 及全部 deprecated 项 |

→ 客户端 `models.json` 是**陈旧缓存**，服务端 `/inference/v1/models` 才是权威；`nemotron-3-ultra-free` 已不再被服务端提供。

---

## 2. 第 1 层：本地选择门禁（唯一「客户端决定」的限制）

未登录（无 `OPENCODE_API_KEY` / 无 `connected` 登录态 / 无 provider apiKey）时：

**新版目录路径** `node-ibnNxpSl.js:313630-313646`：
```js
const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || item2.provider.request.body.apiKey);
catalog.provider.update(item2.provider.id, (provider9) => {
  if (!hasKey) provider9.request.body.apiKey = "public";     // :313636 匿名通道
});
if (hasKey) return;
for (const model8 of item2.models.values()) {
  if (!model8.cost.some((cost3) => cost3.input > 0)) continue;
  catalog.model.update(item2.provider.id, model8.id, (draft) => { draft.enabled = false; });  // :313644
}
```

**SDK 加载器路径** `node-ibnNxpSl.js:654799-654817`：无 key 时 `delete input.models[key]`（`value4.cost.input === 0` 才保留），`options: ok2 ? {} : { apiKey: "public" }`，`autoload: Object.keys(input.models).length > 0`。

上游确证：`packages/core/src/plugin/provider/opencode.ts:343` 注入字面量 `apiKey: "public"`；`:357-360` 未登录时本地禁用所有 `cost.input > 0` 的模型。

**边界**：
- 该门禁**只处理 provider `opencode`**，不处理 `opencode-go`（其可见性依赖远端 `https://opencode.ai/console/api/config`，`node-ibnNxpSl.js:313437-313447`、`:313534`、`:313573-313629`）。
- 远端 config 可随时覆写 `status` / `enabled` / `limit` / `cost` / `capabilities.tools`：`model8.status = config6.status ?? "active"`（`:313623`）、`model8.enabled = config6.status !== "deprecated"`（`:313624`）。
- **UI 的「免费」标识更宽松**：`main-C07s90t2.js:122461` `const isFree = (provider, cost) => provider === "opencode" && (!cost || cost.input === 0);`（`127735` 同口径 `isFree2`）——**没有 cost 元数据也判免费**；标签渲染 `:122540-122551`（`model.tag.free`），tooltip 追加 Free `:122223-122228`；排序靠 `popularProviders`（`:76691-76700`，`opencode` 第一）+ `sortGroupsBy`（`:122503-122509`）。

---

## 3. 第 2 层：客户端身份门禁（免费层「仅限客户端内」）

**Lead 实测（决定性证据）**：

| 请求 | 结果 |
|---|---|
| `GET /inference/v1/models` + `Bearer public` | **200**，86 个模型 |
| `POST /inference/v1/chat/completions`，`model=cat-jam-free`，`Bearer public` | **403** |
| `POST /inference/v1/chat/completions`，`model=claude-opus-5-5`，`Bearer public` | **401** |

403 响应体（逐字）：
```json
{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```
401 响应体（逐字）：
```json
{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}
```

**排除项（实测）**：补齐 OpenCode 自身标识头后**仍为 403** —— `User-Agent: opencode/1.19.2`、`x-opencode-client: desktop`、`x-opencode-session-id`、`x-opencode-session`、`x-opencode-project`、`x-opencode-request`，以及改用 `x-api-key: public`。
**排除地区/出口 IP**：直连与经 `--proxy http://127.0.0.1:7897` 结果相同，两者出口 IP 均为 `45.129.8.29`。
→ **不是单纯的头部检查**，疑似 TLS/客户端指纹或服务端私有凭证；不继续尝试绕过。

**上游代码级线索**：`infra/monitoring.ts:45` 以 `user_agent contains "opencode"` 识别免费层，`:59-60` 统计 `FreeUsageLimitError` / `GoUsageLimitError`。
`FreeTierError`、`"free tier can only be used from within OpenCode"`、`"Missing API key"` 在公开仓库与官方文档**全部未找到**（GitHub code search 401，改用 tarball 全量 grep 8,547 blob 替代）→ 属**服务端私有实现**，官方文档亦未明写此限制。

**地区门禁**：日志中出现过 403 `RegionError`（runtime-proof），与本条并列构成「外部/异地被拒」的两类原因。

---

## 4. 第 3 层：服务端额度/限流 —— 阈值不可见

### 4.1 客户端只有字符串匹配，没有任何计数

`retryable(error, provider)`（`node-ibnNxpSl.js:441406-441472`）：

```js
441411: if (!error.data.isRetryable && !(status2 !== void 0 && status2 >= 500) && !matchesRetryableMessage(error.data.message) && !matchesRetryableMessage(error.data.responseBody))
441412:   return;
441413: if (error.data.responseBody?.includes("FreeUsageLimitError")) {
441414:   return { message: GO_UPSELL_MESSAGE, action: { reason: "free_tier_limit", ... title: "Free limit reached",
441420:     message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
441421:     label: "subscribe", link: GO_UPSELL_URL } };
441425: }
441426: if (error.data.responseBody?.includes("GoUsageLimitError")) {
441427:   const body22 = parseJSON13(error.data.responseBody);
441428:   const workspace = str3(body22?.metadata?.workspace);
441429:   const limitName = str3(body22?.metadata?.limitName);
441430:   const retryAfter = num(error.data.responseHeaders?.["retry-after"]);
441445:   const message7 = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`;
441446:   const link2 = `https://opencode.ai/workspace/${workspace}/go`;
```

| reason | 触发条件 | 证据 |
|---|---|---|
| `free_tier_limit` | `responseBody.includes("FreeUsageLimitError")` | `node-ibnNxpSl.js:441413` |
| `account_rate_limit` | `responseBody.includes("GoUsageLimitError")` | `node-ibnNxpSl.js:441426` |

- 前置守卫靠 `isRetryable` 放行：`isRetryable = statusCode != null && (statusCode === 408 || 409 || 429 || >= 500)`（`:169802`）→ **HTTP 429 天然放行**。
- 全 bundle 检索：`UsageLimit|usage_limit|usageLimit|RateLimited` 仅命中 `:441413`、`:441426`；`daily|monthly|per day|Free usage|requests left` 仅命中 `:441519` 一行常量行。
- 上游唯一出处：`packages/ai/src/provider-error.ts:119-127` 的 `QUOTA_CODES`（含 `"gousagelimiterror"`、`"freeusagelimiterror"`），注释明写 **"OpenCode Zen reports account caps as typed 429/402 errors"** → 映射为 `QuotaExceeded`。

### 4.2 唯一的窗口线索

- `GoUsageLimitError` 响应体 `metadata.limitName`（如 `daily usage limit` / `weekly usage limit`）+ 响应头 `retry-after-ms` → `retry-after`（秒或 HTTP 日期），格式化为 `N days M hours` / `N hours M minutes` / `less than a minute`（`:441428-441443`）。
- 退避优先采用服务端头：`delay8(attempt, error, random)`（`:441375-441401`）；`cap(ms) = Math.min(ms, RETRY_MAX_DELAY)`（`:441372-441374`）。

### 4.3 客户端唯一写死的数字（都是重试策略，不是额度）

`node-ibnNxpSl.js:441519`：
```js
var GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go", GO_UPSELL_URL = "https://opencode.ai/go",
    RETRY_INITIAL_DELAY = 2e3, RETRY_BACKOFF_FACTOR = 2, RETRY_JITTER_FACTOR = 0.25,
    RETRY_MAX_DELAY_NO_HEADERS = 3e4, RETRY_MAX_DELAY = 2147483647, RETRY_MAX_RETRIES = 5;
```
| 常量 | 值 |
|---|---|
| `RETRY_INITIAL_DELAY` | 2000 ms |
| `RETRY_BACKOFF_FACTOR` | 2 |
| `RETRY_JITTER_FACTOR` | 0.25 |
| `RETRY_MAX_DELAY_NO_HEADERS` | 30000 ms |
| `RETRY_MAX_DELAY` | 2147483647 ms（≈24.8 天，有 `retry-after` 头时的上限） |
| `RETRY_MAX_RETRIES` | 5 |

→ 无响应头时约 2 / 4 / 8 / 16 / 30 秒。

### 4.4 官方口径（付费档才写了数字）

| 档位 | 价格 | 额度定义 | 时间窗 |
|---|---|---|---|
| OpenCode Go | **$10/月** | **月度美元额度** | **5 小时窗口 = 月度额度的 20%** |
| OpenCode Go Plus | **$40/月** | 同上 | 同上 |
| Free | $0 | **官方文档与公开源码均无任何数值** | 未知 |

来源：https://opencode.ai/v2/docs/console/go/ ｜ 上游 `services/www/src/docs/content/console/go.mdx`

> **核心否定结论**：免费层的每日/每月请求数、token 上限、时间窗、并发限制——官方文档与公开源码里**都没有**。任何具体数字都属编造。弹窗文案只提 $10 档，未提 $40 档。

---

## 5. 第 4 层：撞到限制后会发生什么

### 5.1 引擎侧：不硬阻塞、不降级、只重试 5 次

- 无任何 fallback / 模型切换 / provider 切换逻辑（`retryable` / `policy2` 路径中不存在）。
- `policy2(opts)`（`:441498-441518`）每次失败调用 `retryable(error, opts.provider)`（`:441501`）；上限 `if (meta2.attempt > RETRY_MAX_RETRIES) return done2(...)`（`:441504`）→ attempt 0..5，第 6 次失败放弃。
- 挂在 `SessionProcessor.process` 流管道：`retry2(policy2({ provider: input.model.providerID, ... set: (info22) => status2.set(ctx.sessionID, { type: "retry", attempt, message, action, next }) }))`（`:442179-442191`）。
- 放弃后写入 `ctx.assistantMessage.error` + `Event30.Error`（`:442153`），状态回 `idle`（`:442158`）。
- `SessionStatus` schema（`:420003-420031`）：`idle` | `{ type: "retry", attempt, message, action?: { reason, provider, title, message, label, link? }, next }` | `busy`；事件 `{ type: "session.status", sessionID, status }`。

### 5.2 渲染层：仅对 `opencode` / `opencode-go` 弹升级引导

- `main-C07s90t2.js:152558`：`const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"]);`
- `:152564`：`if (!GO_UPSELL_PROVIDERS.has(action.provider)) return;` → 非 opencode 系 provider 即使返回同样错误也**不弹窗**。
- 弹窗条件（`:152595-152607`）：① `status.type === "retry"` 且带 `action`；② 无其它 dialog（`:152602 if (dialog.active) return;`）；③ 同一 reason 在 `GO_UPSELL_WINDOW = 864e5`（24h，`:152557`）内未展示过（`:152606`）；④ 未勾选「不再显示」。
- 持久化键（`:152553-152557`），存于 `%APPDATA%\ai.opencode.desktop\opencode.global.dat` 的 `"go-upsell"`：

| 键 | 值 |
|---|---|
| `GO_UPSELL_FREE_TIER_LAST_SEEN_AT` | `"go_upsell_last_seen_at"` |
| `GO_UPSELL_FREE_TIER_DONT_SHOW` | `"go_upsell_dont_show"` |
| `GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT` | `"go_upsell_account_rate_limit_last_seen_at"` |
| `GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW` | `"go_upsell_account_rate_limit_dont_show"` |
| `GO_UPSELL_WINDOW` | `864e5`（24 小时） |

- 存储链：`Persist.global("go-upsell")`（`:152589`）→ `GLOBAL_STORAGE="opencode.global.dat"`（`:48877`）→ preload `storeGet/storeSet`（`out/preload/index.js:67-72`）→ `out/main/index.js:1157` `join(app.getPath("userData"), name)`。

### 5.3 弹窗动作（两处都容易误解）

| reason | 标题 / 按钮 | 动作 |
|---|---|---|
| `free_tier_limit` | Free limit reached / `subscribe` | 打开 `https://opencode.ai/go` **且**在应用内打开 provider 连接弹窗并 `controller.select("opencode-go")`（`:152626-152632`） |
| `account_rate_limit` | Go limit reached / `open settings` | **只外开网页** `https://opencode.ai/workspace/<workspace>/go`，不打开应用内设置（`:152650-152653` 空分支） |

- **`"Open settings"` 是误导性文案**：设置页里**没有**额度/余额/账单页。设置仅 General / Shortcuts / Providers / Models / Agents / Commands / MCP / Permissions（`:50665-50701`）。唯一的 "Usage" 是上下文 token 用量（`:50186-50200`），与计费无关。
- **`enable usage from your available balance` 在客户端无任何实现**：全树仅命中 core message（`node-ibnNxpSl.js:441445`）与 i18n 文案（`main-C07s90t2.js:10795`），无对应配置项 → 开关在服务端 / 网页控制台。
- **i18n 分支丢信息**：`main-C07s90t2.js:152588` `const isEnglish = () => locale2() === "en"`；英文直出服务端 `action.title/message/label`，非英文走 i18n → **非英文丢失 `It will reset in <resetIn>` 动态重置时间**，按钮从服务端小写 `subscribe`/`open settings` 变成规范化的 `订阅`/`打开设置`。中文文案（`zh-B5Hw0C7Y.js:89-91`）：「免费额度已用完」/「每月 $10 订阅 OpenCode Go…」/「订阅」。
- **死键**：`ui.sessionTurn.error.freeUsageExceeded` / `addCredits`（定义于 `:10789-10790` 及全部语言包）渲染层从未引用。

### 5.4 无功能级降级

- 全部活跃免费模型 `tool_call: true`、`reasoning: true`、`structured_output: true`。
- 反而**默认启用 Web 搜索**：`node-ibnNxpSl.js:637039-637040` `function webSearchEnabled(providerID2, flags2) { return providerID2 === ID7.opencode || providerID2 === ID7.make("opencode-go") || flags2.exa || flags2.parallel; }`
- 门禁代码只操作 `enabled` / 删除模型 / 改写 `apiKey`，**从不触碰 `capabilities.tools`**。唯一工具相关覆写来自远端 config（`:313573-313629`），属服务端可控元数据。

---

## 6. 第 5 层：模型规格差异（free 变体的硬性缩水）

| free 变体 | ctx / out | 对应付费 | ctx / out | ctx 倍数 | out 倍数 |
|---|---|---|---|---|---|
| `deepseek-v4.1-flash-free` | 200,000 / 32,000 | `deepseek-v4.1-flash` | 1,000,000 / 384,000 | **5.00×** | **12.00×** |
| `mimo-v2.6-flash-free` | 200,000 / 32,000 | `mimo-v2.6-flash`(go) | 1,048,576 / 131,072 | **5.24×** | **4.10×** |
| `space-bunny-free` | 1,048,576 / 524,288 | `space-bunny`(go) | 1,048,576 / 524,288 | 1.00× | 1.00× |
| `longcat-2.5-preview-free` | 1,000,000 / 131,072 | `longcat-2.0`(go) | 1,000,000 / 131,072 | 1.00× | 1.00× |
| `muse-spark-1.3-contributor-free` | 1,048,576 / 131,072 | `muse-spark-1.3-contributor`(go) | 1,048,576 / 131,072 | 1.00× | 1.00× |
| `nemotron-3.5-super-vl-free` | 1,048,576 / 131,072 | — | — | — | — |

**活跃免费模型全表（`opencode` provider，10 个，全部 `cost = 0`）**：

| id | context | output | attachment | reasoning |
|---|---|---|---|---|
| `longcat-2.5-preview-free` | 1,000,000 | 131,072 | ✅ | ✅ |
| `cat-jam-free` | 1,048,576 | 131,072 | ❌ | ✅ |
| `space-bunny-free` | 1,048,576 | 524,288 | ✅ | ✅ |
| `mimo-v2.6-flash-free` | 200,000 | 32,000 | ✅ | ✅ |
| `nemotron-3-ultra-free`（服务端已下架，仅存本地缓存） | 1,000,000 | 128,000 | ❌ | ✅ |
| `nemotron-3.5-lightning-free` | 262,144 | 262,144 | ❌ | ✅ |
| `nemotron-3.5-super-vl-free` | 1,048,576 | 131,072 | ✅ | ✅ |
| `deepseek-v4.1-flash-free` | 200,000 | 32,000 | ✅ | ✅ |
| `big-pickle` | 200,000 | 32,000 | ❌ | ✅ |
| `muse-spark-1.3-contributor-free` | 1,048,576 | 131,072 | ✅ | ✅ |

- 服务端新增但本地缓存没有：`jev-1.13-free`（尚未出现在 `models.json`）。
- 31 个 deprecated 免费模型默认不启用（`model8.enabled = config6.status !== "deprecated"`，`node-ibnNxpSl.js:313624`），且服务端已从目录移除；日志中另见 **410 ModelDeprecated**（`exo-free` 下架）。
- `attachment: false` 的免费模型（`cat-jam-free`、`big-pickle`、`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`）**不能传图片**。

---

## 7. 本机实测：免费通道的真实表现（runtime-proof）

### 7.1 用量规模（`opencode.db` → `message.data` 只读聚合）

| 指标 | 数值 |
|---|---|
| `opencode` provider 消息数 | **8,932 条**，占全部 assistant 消息 **99.5%**（8932 / 8976） |
| input tokens | **240,601,896** |
| output tokens | **14,242,636** |
| cache.read tokens | **1,060,749,766** |
| cost | **$0.000000** |
| 全库唯一付费 | **$0.082602**，来自 `cline-pass` |

- 成功 stream **16,479 次 / 267 会话**，失败率 ≈ **0.36%**。
- 日志跨度 `2026-09-01T13:58:48Z → 2026-10-16T04:13:49Z`；DB 仅剩 64 个 session（日志 267 / 事件 268）→ 上表为**下界**。

### 7.2 限制事件的真实形态 = 限流，不是耗尽

| 项目 | 数值 |
|---|---|
| `Rate limit exceeded` 次数 | **60 次**，跨 32 天（`2026-09-14T14:31:30.057Z` L4122 → `2026-10-16T02:12:55.070Z` L135962） |
| 峰值日 | **2026-09-17 = 37 次**；09-14=7、09-23=1、09-24=12、10-07=2、10-16=1 |
| 按模型归因 | `muse-spark-1.3-contributor-free` = **48**、`ling-3.0-flash-fin-free` = 6、`deepseek-v4.1-flash-free` = 1 |
| 429 三态 | `[429] Upstream error from Xiaomi: Request rate limited`（`server_error`）×2、`[429] Request rate limited`（`rate_limit_error`）×3（全在 2026-10-15） |
| 输出 token 限流 | `[rate_limit_exceeded] Output token rate limit exceeded` ×1（`2026-09-17T15:04:33.451Z`） |
| 其他 | 403 `RegionError`、410 `ModelDeprecated` |
| `FreeTierError` / `FreeUsageLimitError` / `GoUsageLimitError` / `free tier` 日志命中 | **全 0** |

### 7.3 用户确实撞过一次额度，并且永久静音了升级弹窗

`%APPDATA%\ai.opencode.desktop\opencode.global.dat` → `"go-upsell"`：
```json
{"go_upsell_last_seen_at":1789396439021,"go_upsell_dont_show":1789396439021,
 "go_upsell_account_rate_limit_last_seen_at":null,"go_upsell_account_rate_limit_dont_show":null}
```
- 换算：**2026-09-14 22:33:59 本地时间**；`last_seen_at` 与 `dont_show` **毫秒级同值** → 看到即勾选「不再显示」。
- 首次限流 `2026-09-14T14:31:30.057Z` → upsell 记录 `14:33:59.021Z`，**间隔仅 148.96 秒**。
- **后果（对用户最有用的操作结论）**：`free_tier_limit` 的升级弹窗**已永久静音**，用户今后只会看到重试卡片上的英文原文 `Free usage exceeded, subscribe to Go`，**再也看不到引导弹窗**。`account_rate_limit` 两项仍为 `null`，若触发仍会弹一次。
- 恢复弹窗的方法：清除 `opencode.global.dat` 中 `"go-upsell"` 的 `go_upsell_dont_show` 字段。

### 7.4 登录态与自定义 provider

- `%USERPROFILE%\.local\share\opencode\auth.json` **没有 `opencode` 条目**（只有 `asaf` / `cline-pass` / `workbuddy` / `tokenharhur`，全 `type=api`）→ 走匿名 `apiKey="public"` 通道，这也是 Lead 实测 `Bearer public` 的出处。
- `tokenharhur`（`http://127.0.0.1:8787/v1`）：42 次调用**全是** `claude-haiku-5.5:free`（另两个 `:free` 配置了但 0 调用）；2 次 **`The free offer for this model isn't available on this account`**（`2026-10-14T00:07:26.069Z`）→ 随后 6 次 `ECONNREFUSED 127.0.0.1:8787`（起于 `00:19:10.356Z`），反代进程已消失。
- `workbuddy`（`http://127.0.0.1:7863/v1`）：日志内 **0 次**调用。
- **无 Go 订阅的五重否定**：日志 `OpenCode Go` / `go plan` / `subscription` / `upgrade to` 命中 0；`global.dat` 仅 6 个顶层键（无 account/subscription/tier/quota）；`opencode.settings` 仅 4 个 UI 键；DB `account` / `control_account` / `credential` 表 0 行；`opencode` 侧消费 $0。

---

## 8. 端点与请求头（免费通道）

| 用途 | URL | 证据 |
|---|---|---|
| 免费/付费推理 | `https://opencode.ai/inference/v1` | provider 定义 |
| Go 推理 | `https://opencode.ai/inference/go/v1` | provider 定义 |
| 远端 provider/model 配置 | `https://opencode.ai/console/api/config`（`server2` 默认 `https://opencode.ai/console`） | `node-ibnNxpSl.js:313442`、`:313520` |
| 模型目录快照 | `https://models.opencode.ai`（`Flag.OPENCODE_MODELS_URL` 可覆写） | `:169208` |
| 升级落地页 | `https://opencode.ai/go` | `:441519` |
| 工作区 Go 设置 | `https://opencode.ai/workspace/<workspace>/go` | `:441446` |
| OAuth 设备流 | `/auth/device/token`、`/api/user`、`/api/orgs` | `:313472-313518` |

请求头构造（`node-ibnNxpSl.js:441020-441044`）：总是发 `x-opencode-session-id`；`providerID.startsWith("opencode")` 时额外发 `x-opencode-project`（project.id）、`x-opencode-session`、`x-opencode-request`（user.id）、`x-opencode-client`（`flags.client` ∈ {"app","cli","desktop"}，见 `:637252`），并设 `User-Agent: opencode/${InstallationVersion}`（`:440941` + `:45655` → `opencode/1.19.2`）；否则发 `x-session-affinity` + `X-Session-Id`。
服务端每次响应带 `x-opencode-log-id`（Lead 实测可见）。

---

## 9. 结论与可操作建议

1. **免费额度没有可查的数字**。客户端、公开源码、官方文档三处都没有免费层阈值；只有付费档（Go $10/月、Go Plus $40/月）以「月度美元额度」定义，且 5 小时窗口 = 月度额度 20%。要预判免费层何时断，只能靠观察 429/402 与 `retry-after`。
2. **最硬的两条限制是身份与地区**：免费层**只能在 OpenCode 客户端内**调用（外部脚本一律 403 `FreeTierError`），部分地区直接 403 `RegionError`。这不是配额，绕不过（也不建议绕）。
3. **免费层没有功能阉割**：工具调用、推理、Web 搜索全开，与付费同权。唯一实质缩水是**部分 free 变体的上下文/输出窗口**（如 `deepseek-v4.1-flash-free` 相比付费版 ctx 砍到 1/5、输出砍到 1/12）。
4. **免费模型会静默消失**：31 个已 deprecated，`nemotron-3-ultra-free` 已从服务端目录移除；本地 `models.json` 是陈旧缓存，以 `/inference/v1/models` 为准。
5. **你的升级弹窗自 2026-09-14 22:33:59 起已永久静音**——这是"看不到任何免费额度提示"的真正原因，不是功能故障。需要恢复就去掉 `opencode.global.dat` 里 `"go-upsell"` 的 `go_upsell_dont_show`。
6. **遇到限流时的正确预期**：不降级、不换模型，静默重试 5 次（2/4/8/16/30 秒退避，若服务端给 `retry-after` 则按它等，上限约 24.8 天），失败后该轮报错。失败率实测仅 0.36%，属可忽略噪声。
7. **想提高上限**：订阅 OpenCode Go（$10/月，或 Go Plus $40/月）；订阅后 `account_rate_limit` 分支会给出 `metadata.limitName`（daily / weekly）与精确重置时间。

---

## 10. 不确定项（明确不猜）

1. 免费层的真实阈值（请求数 / token / 金额 / 窗口 / 并发）——服务端私有，三处渠道均无。
2. `FreeTierError` 的精确判定谓词——已排除单纯头部检查与出口 IP 差异，疑似 TLS/客户端指纹或私有凭证；未继续验证（不绕过）。
3. `action.reason` 的下发方——服务端或未公开 SDK，公开仓库中不存在生产端代码。
4. `opencode-go` 的本地门禁——未走 `node-ibnNxpSl.js:313630-313646`，依赖远端 `/api/config`，未做活体验证。
5. 两套门禁写法差异：`:313641` 用 `!cost.some(c => c.input > 0)`，`:654809` 用 `cost.input === 0`；若某模型 `cost` 缺 `input` 字段两者会分歧（当前快照中未观察到）。
6. 官方数值有时效性（上游 dev 分支 `pushed_at` = 2026-10-16）；`/inference/v1/models` 的 86 个模型含付费模型，**不能当免费清单用**，以官方 13 条清单为准。
7. DB 仅剩 64 个 session（日志 267），§7.1 用量为下界。

---

## 附：证据索引

| 主题 | 位置 |
|---|---|
| `free_tier_limit` / `account_rate_limit` 产生 | `node-ibnNxpSl.js:441406-441472`（`:441413`、`:441417`、`:441426`、`:441450`） |
| 重试守卫 / `isRetryable` | `node-ibnNxpSl.js:441411` / `:169802` |
| 重试策略常量 | `node-ibnNxpSl.js:441519` |
| 退避实现 / cap | `node-ibnNxpSl.js:441372-441401` |
| 可重试正则表 | `node-ibnNxpSl.js:441525-441533` |
| 重试接入 SessionProcessor / 上限 | `node-ibnNxpSl.js:442179-442191` / `:441504` |
| `SessionStatus` schema / 事件 | `node-ibnNxpSl.js:420003-420031` |
| 请求头构造 | `node-ibnNxpSl.js:441020-441044` |
| 本地免费门禁（新版目录 / SDK 加载器） | `node-ibnNxpSl.js:313630-313646` / `:654799-654817` |
| 远端 config 拉取与覆写 | `node-ibnNxpSl.js:313437-313447`、`:313534`、`:313573-313629` |
| 模型快照来源 / 缓存 | `node-ibnNxpSl.js:169208-169209`、`:169228` |
| Web 搜索默认启用 | `node-ibnNxpSl.js:637039-637040` |
| 版本 / UA | `node-ibnNxpSl.js:45655`、`:440941` |
| `GO_UPSELL_PROVIDERS` / 白名单 return | `main-C07s90t2.js:152558`、`:152564` |
| 弹窗节流键 / 24h 窗口 / dialog.active | `main-C07s90t2.js:152553-152557`、`:152606`、`:152602` |
| 弹窗逻辑与动作 | `main-C07s90t2.js:152595-152633`、`:152626-152632`、`:152650-152653` |
| i18n 分支 / 死键 | `main-C07s90t2.js:152588`、`:10789-10796`、`:50169` |
| UI `isFree` / 标签 / 排序 | `main-C07s90t2.js:122461`、`:127735`、`:122540-122551`、`:122223-122228`、`:76691-76700`、`:122503-122509` |
| 设置页清单 / Usage 语义 | `main-C07s90t2.js:50665-50701`、`:50186-50200` |
| 存储链 | `main-C07s90t2.js:152589`、`:48877`；`out/preload/index.js:67-72`、`:95`；`out/main/index.js:1157` |
| 中文文案 | `zh-B5Hw0C7Y.js:89-91` |
| 上游消费端 | `packages/app/src/session/usage-exceeded-dialogs.tsx:19,:21,:45,:52`；`packages/ui/src/i18n/en.ts:81-88` |
| 上游匿名 key / 本地门禁 | `packages/core/src/plugin/provider/opencode.ts:343`、`:357-360` |
| 上游额度码 / 免费层识别 | `packages/ai/src/provider-error.ts:119-127`；`infra/monitoring.ts:45`、`:59-60` |
| 官方 Go 档位 | `services/www/src/docs/content/console/go.mdx`；https://opencode.ai/v2/docs/console/go/ |
| 官方免费模型清单 | https://opencode.ai/v2/docs/console/models/ |
