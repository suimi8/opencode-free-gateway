# 04 — 外部权威口径：OpenCode 免费模型与 OpenCode Go 的限制

**任务**：task-4（external-docs）｜**状态**：完成
**执行人**：external-docs（teammate）
**取证时间基准**：仓库 `dev` 分支最新提交 `pushed_at = 2026-10-16T04:02:29Z`；本机客户端版本 `1.19.2`（`channel=prod`）
**约束遵守**：全程只读；未登录、未提交任何表单、未使用任何本机密钥、未重启 OpenCode 进程。

---

## 0. 可达性与方法说明（重要，影响证据强度）

| 通道 | 结果 | 说明 |
|---|---|---|
| `web_search` | **不可用** | 报错：`DeepSeek search has no API key for "DEEPSEEK_API_KEY"`。本次未使用任何搜索引擎结果，全部结论来自官方站点直取 + 官方仓库源码。 |
| `web_fetch` | **全部失败** | 报错：`URL hostname "opencode.ai" resolves to a non-public IP address`（github.com 同样失败）。 |
| 根因 | 本机 TUN 代理 Fake-IP | 网卡 `Meta`（`Meta Tunnel`）状态 Up，地址 `198.18.0.1`；DNS 对 `opencode.ai` / `github.com` 均返回 `198.18.0.x`（RFC2544 保留段）。`web_fetch` 拒绝非公网 IP。 |
| 绕行方案 | **只读 curl 经本机 HTTP 代理** | `WinINET ProxyServer = 127.0.0.1:7897`（Clash/Mihomo 混合端口）。`curl.exe --proxy http://127.0.0.1:7897` 可正常出网。所有请求均为 GET/OPTIONS 只读，未附带任何凭证。 |

> 结论强度：官方站点与官方仓库内容为**一手证据**；经代理取回的 HTML/JSON 与仓库 tarball 均落地存档于 `07-原始证据\raw\` 与 `...\repo\opencode-dev\`，可复核。

---

## 1. URL 清单（全部实测可点击，GET 状态码已验证）

### 1.1 官方站点

| URL | 状态 | 内容要点 |
|---|---|---|
| https://opencode.ai/docs/ | 200 (99,209 B) | 文档首页 |
| https://opencode.ai/v2/docs | 200 (20,149 B) | v2 文档索引 |
| https://opencode.ai/v2/docs/console/models/ | 200 (55,656 B) | **Zen / Console 模型页（含 Free models 小节）** |
| https://opencode.ai/v2/docs/console/go/ | 200 (55,169 B) | **OpenCode Go 订阅页（含限流数值表）** |
| https://opencode.ai/go | 200 (63,650 B) | Go 落地页 |
| https://opencode.ai/zen | 200 (38,332 B) | Zen 落地页 |
| https://opencode.ai/console | 200 (2,488 B) | Console 入口 |
| https://opencode.ai/config.json | 200 (63,387 B, `application/json`) | 配置 JSON Schema |
| https://opencode.ai/changelog.json | 200 (11,176 B) | 更新日志 |
| https://models.opencode.ai | 200 (2,024,465 B) | 模型目录站点 |
| https://app.opencode.ai | 200 (2,884 B) | Web 应用入口 |

> **注意**：`https://opencode.ai/docs/zen/` 返回 **302 → `https://opencode.ai/v2/docs/console/models/`**。即「Zen 文档」的规范地址是 `console/models/`。

### 1.2 官方文档源码（GitHub，可直接引用行号）

| URL | 说明 |
|---|---|
| https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/console/go.mdx | **Go 计划与限流数值的唯一权威源** |
| https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/console/models.mdx | **Free models 清单的权威源** |
| https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/console/billing.mdx | 计费 |
| https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/console/api/inference.mdx | 推理 API |
| https://github.com/anomalyco/opencode/tree/dev/services/www/src/docs/content/console | 全部 Console 文档 |

> **仓库重命名事实**：`https://github.com/sst/opencode` → **301 → `https://github.com/anomalyco/opencode`**（`full_name = anomalyco/opencode`，`id = 975734319`，`default_branch = dev`，stars 213,988，`fork = false`）。即 sst/opencode 就是 anomalyco/opencode，非两个仓库。

---

## 2. 官方明写的数值（一手，可直接引用）

### 2.1 OpenCode Go 订阅档位 — `console/go.mdx:9-11`

| 计划 | 价格 | 官方描述 |
|---|---|---|
| **Go** | **$10/month** | Lower-cost access to the models below |
| **Go Plus** | **$40/month** | Higher usage limits across the models below |

官方原文（`go.mdx:13`）：
> Go works like any other provider in OpenCode. You subscribe to OpenCode Go and get your API key. It's **completely optional** and you don't need it to use OpenCode.

官方限制模型（`go.mdx`）：
- 「Usage limits are defined as **monthly dollar amounts**」
- 「Each model has the following usage limits: **5-hour — 20% of the monthly limit**」

### 2.2 Go 计划「每 5 小时 / 每周 / 每月」请求数（官方估算表，`go.mdx:237-271`）

> 官方表述：These tables **estimate** request counts based on typical Go usage patterns.

| Model | Req / 5h | Req / week | Req / month |
|---|---|---|---|
| GLM-5.3-Flash | 6,320 | 15,790 | 31,580 |
| GLM-5.3 | 220 | 540 | 1,080 |
| GLM-5.2 | 880 | 2,150 | 4,300 |
| Kimi K3 | 110 | 250 | 490 |
| Kimi K2.7 Code | 1,350 | 3,380 | 6,750 |
| Kimi K2.6 | 1,150 | 2,880 | 5,750 |
| LongCat-2.0 | 11,400 | 28,600 | 57,200 |
| **LongCat 2.5 Preview Free** | **Unlimited** | **Unlimited** | **Unlimited** |
| Step 5 Preview（4x 限时） | 1,720 | 4,280 | 8,520 |
| **Cat Jam Free** | **Unlimited** | **Unlimited** | **Unlimited** |
| MiMo-V2.6-Flash | 30,100 | 75,200 | 150,400 |
| MiMo-V2.6-Pro | 3,250 | 8,150 | 16,300 |
| MiMo-V2.5 | 30,100 | 75,200 | 150,400 |
| MiMo-V2.5-Pro | 3,250 | 8,150 | 16,300 |
| MiniMax M3 | 3,200 | 8,000 | 16,000 |
| MiniMax M2.7 | 3,400 | 8,500 | 17,000 |
| Muse Spark 1.3 Contributor | 45,300 | 113,300 | 226,600 |
| Muse Spark 1.2 Contributor | 45,300 | 113,300 | 226,600 |
| Qwen3.8 Max | 160 | 400 | 810 |
| Qwen3.8 Flash | 5,400 | 13,500 | 27,000 |
| Qwen3.7 Plus | 4,300 | 10,800 | 21,600 |
| DeepSeek V4.1 Flash | 34,670 | 86,670 | 173,330 |
| DeepSeek V4 Pro | 1,050 | 2,600 | 5,200 |
| Hy4 preview | 1,350 | 3,380 | 6,770 |
| Hy3 | 4,300 | 10,750 | 21,500 |
| Space Bunny | 3,130 | 7,810 | 15,630 |
| Grok 4.7 | 169 | 423 | 845 |
| Grok 4.6 | 169 | 423 | 845 |
| GPT 6 Luna | 4,230 | 10,560 | 21,130 |
| GPT 5.6 Luna | 2,050 | 5,100 | 10,250 |
| Claude Haiku 5.5 | 3,850 | 9,620 | 19,230 |
| Gemini 4 Argon Contributor（2x 限时） | 440 | 1,080 | 2,120 |

Go Plus 同表在 `go.mdx:275-...`，数值整体约为 Go 的 2–4 倍（例：GLM-5.3-Flash 18,960 / 47,370 / 94,740）。

### 2.3 官方 Free models 清单 — `console/models.mdx:319-333`（共 13 条）

官方逐条原文（**均未给出任何限流数值**）：

- DeepSeek V4.1 Flash Free — free for a limited time；provider 零保留、不用于训练
- Exo Free — limited time，收集反馈
- MiMo-V2.6-Flash Free — limited time
- MiMo-V2.5 Free — limited time
- Nemotron 3 Ultra Free — limited time
- Nemotron 3.5 Lightning Free — limited time
- Nemotron 3.5 Super VL Free — limited time
- Big Pickle — stealth model，free for a limited time
- Space Bunny Free — stealth model，零保留
- Cat Jam Free — stealth model，保留 30 天用于安全；**区域封锁**（含中国内地/香港/澳门、俄罗斯等）
- LongCat 2.5 Preview Free — 零保留
- Muse Spark 1.3 Contributor Free — limited time
- Jev 1.13 Free — limited time

> **官方未明写项**：免费层的**每日/每月请求数、token 上限、时间窗、并发数**，官方文档中**均无任何数值**。唯一与「免费」相关的数值出现在 Go 订阅页（上表），且那是**付费 Go 订阅**的额度，不是免费层额度。

### 2.4 免费模型的 API 端点（官方文档表格）

`console/models.mdx` 给出免费模型走 **`https://opencode.ai/inference/openai/v1/chat/completions`**（`@ai-sdk/openai-compatible`）；Gemini 系走 `https://opencode.ai/inference/google/v1beta/models/...`。

---

## 3. 端点清单

### 3.1 从本机 bundle 提取（`99-解包产物与运行时残留\OpenCode-Desktop-1.19.2-解包\out\`，841 个 JS/JSON 文件，752 个唯一 URL）

对 `opencode.ai` 相关端点去重后：

| 端点 | 用途（据 bundle 上下文） |
|---|---|
| `https://opencode.ai/console` | Console 基址；`packages/core/src/plugin/provider/opencode.ts:20` `defaultServer` |
| `https://opencode.ai/inference/v1` | Zen 推理基址 |
| `https://opencode.ai/inference/go/v1` | **Go 订阅推理基址** |
| `https://opencode.ai/inference/google/v1beta/models/...` | Gemini 系模型 |
| `https://opencode.ai/inference/openai/v1/chat/completions` | 免费模型 OpenAI 兼容端点 |
| `https://opencode.ai/config.json` | 配置 JSON Schema（`$schema`） |
| `https://opencode.ai/changelog.json` | 更新日志 |
| `https://opencode.ai/desktop-theme.json` | 桌面主题 |
| `https://opencode.ai/desktop-feedback` | 桌面反馈 |
| `https://opencode.ai/install`、`/v2/install` | 安装脚本 |
| `https://opencode.ai/go`、`/zen` | 落地页 |
| `https://opencode.ai/v2/docs`、`/v2/docs/console/go/`、`/v2/docs/console/models/` | 文档 |
| `https://models.opencode.ai` | 模型目录 |
| `https://app.opencode.ai` | Web 应用 |
| `https://opencode.ai/workspace/$` | 工作区 |
| `https://opencode.ai/docs/providers/#custom-provider`、`/docs/agents`、`/docs/commands`、`/docs/themes/` | 文档锚点 |
| `https://opencode.ai/` | 出现在 `HTTP-Referer` 头（多处，如 `node-ibnNxpSl.js:305427`） |

其他相关域名：`https://zenmux.ai/api/v1`（ZenMux 兼容网关）、`https://github.com/anomalyco/opencode`（issues / bug_report / feature_request 模板）、`https://discord.com/invite/opencode`。

### 3.2 只读实测结果（无凭证；GET/OPTIONS）

| 端点 | 方法 | 状态码 | 备注 |
|---|---|---|---|
| `https://opencode.ai/docs/` | GET | **200** | 文档首页 |
| `https://opencode.ai/v2/docs/console/go/` | GET | **200** | Go 官方页 |
| `https://opencode.ai/v2/docs/console/models/` | GET | **200** | Free models 官方页 |
| `https://opencode.ai/inference/v1/models` | GET | **200** | 86 个模型 id |
| `https://opencode.ai/inference/go/v1/models` | GET | **200** | 37 个模型 id |
| `https://opencode.ai/inference/v1/models` | OPTIONS | **200** | `access-control-allow-origin: *`；`allow-methods: GET, OPTIONS`；`allow-headers: Content-Type, Authorization, X-Api-Key, X-Opencode-Org-Id` |
| `https://opencode.ai/inference/v1/chat/completions` | GET / OPTIONS | **404** | 该路由仅接受 POST |
| `https://opencode.ai/inference/v1/chat/completions` | POST（无凭证） | **400** | 我方探测；**未携带任何凭证** |
| `https://opencode.ai/api/v2/config` | GET | **404** | 需凭证；客户端用 `Authorization: Bearer`（`opencode.ts:493`） |
| `https://opencode.ai/config.json` | GET | **200** | JSON Schema |
| `https://opencode.ai/changelog.json` | GET | **200** | |
| `https://api.github.com/search/code?q=free_tier_limit+repo:sst/opencode` | GET | **401** | `{"message":"Requires authentication"}` — **如实记录，未尝试绕过** |
| `https://github.com/sst/opencode` | GET | **301** | → `anomalyco/opencode` |

> **重要修正**：`GET /inference/v1/models` 返回的 86 个模型**包含全部付费前沿模型**（`claude-opus-5-5`、`gpt-6-astra`、`grok-4.7`、`kimi-k3` …）。**该端点不是免费层门禁**，它只是完整目录。免费层的实际门禁在**请求时**（见 §4.5）。

---

## 4. GitHub 源码交叉验证（仓库 `anomalyco/opencode`，分支 `dev`）

下载 tarball（79.7 MB，8,547 个 blob，`truncated=false`）后本地全量 grep。**结论：本机 bundle 与上游源码逐字一致，未发现任何差异。**

### 4.1 `free_tier_limit` / `account_rate_limit` — **找到（消费端）**

`packages/app/src/session/usage-exceeded-dialogs.tsx`：

```ts
11: const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"
13: const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"
15: const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"
17: const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"
19: const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs
21: const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])
```

```ts
45:   if (action.reason === "free_tier_limit") {
52:   if (action.reason === "account_rate_limit") {
```

行为差异（`:116-151`）：
- `free_tier_limit` → 弹窗；用户关闭时若非「不再提示」，会 `controller.select("opencode-go")` **引导订阅 Go**（`:130`）。
- `account_rate_limit` → 弹窗；**不引导订阅**（`:144-148` 只记录时间戳）。

**与本地逆向结论完全一致**：provider id `opencode` / `opencode-go`、24 小时冷却 `GO_UPSELL_WINDOW = 86_400_000`。

### 4.2 文案 — `packages/ui/src/i18n/en.ts:81-88`

```ts
81:   "dialog.usageExceeded.freeTier.title": "Free limit reached",
82:   "dialog.usageExceeded.freeTier.description":
83:     "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
84:   "dialog.usageExceeded.freeTier.actionLabel": "Subscribe",
85:   "dialog.usageExceeded.accountRateLimit.title": "Go limit reached",
86:   "dialog.usageExceeded.accountRateLimit.description":
87:     "Usage limit reached. To continue using this model now, enable usage from your available balance",
88:   "dialog.usageExceeded.accountRateLimit.actionLabel": "Open settings",
```

> `$10/month` 与官方 Go 档位一致；但注意官方 Go 是 **$10 与 $40 两档**，弹窗只提 $10。

### 4.3 免费层的真实门禁机制 — `packages/core/src/plugin/provider/opencode.ts:337-362`

```ts
337: const item = providers.get(Provider.ID.opencode)
338: if (!item) return
339: const hasKey = Boolean(process.env.OPENCODE_API_KEY || snapshot.connection || item.provider.settings?.apiKey)
340: providers.update(item.provider.id, (provider) => {
341:   if (!hasKey) {
342:     provider.activation = "enabled"
343:     provider.settings = { ...provider.settings, apiKey: "public" }
344:   }
345: })
...
347: yield* ctx.model.transform((models) => {
...
355:   if (hasKey) return
356:   for (const model of models.list(item.provider.id)) {
357:     if (!model.cost.some((cost) => cost.input > 0)) continue
358:     models.update(item.provider.id, model.id, (draft) => {
359:       draft.enabled = false
360:     })
361:   }
362: })
```

**要点（代码推断，非官方文档）**：
- 未登录时客户端注入**字面量 API key `"public"`**（`:343`）——这就是 Lead 实测的 `Authorization: Bearer public` 的来源。
- 未登录时**本地禁用所有 `cost.input > 0` 的模型**（`:357-360`），即只有 **$0 模型**可选。门禁是「客户端本地过滤 + 服务端限流」双层。
- 登录走 OAuth device flow：`POST {server}/auth/device/code`（`client_id = "opencode-cli"`，`:127`）、`POST {server}/auth/device/token`（`:149`、`:590`）、`GET {server}/api/user`（`:613`）、`GET {server}/api/orgs`（`:614`）、`GET {server}/api/v2/config`（`:493`）、`POST {server}/api/websearch`（`:389`）、`{server}/auth/sso/{connectionID}/start?redirectTo=`（`:528`）。

### 4.4 服务端错误类型 → 客户端配额错误 — `packages/ai/src/provider-error.ts:119-127`

```ts
119: // OpenCode Zen reports account caps as typed 429/402 errors that are not throttles.
120: const QUOTA_CODES = new Set([
121:   "insufficient_quota",
122:   "usage_not_included",
123:   "billing_error",
124:   "gousagelimiterror",
125:   "freeusagelimiterror",
126:   "creditlimitexceeded",
127: ])
```

**这是 `FreeUsageLimitError` / `GoUsageLimitError` 在公开仓库中的唯一出现点**（另见 `packages/ai/test/provider-error.test.ts:271-272`、`infra/monitoring.ts:59-60`）。

**推断出的完整因果链**：
1. 服务端（OpenCode Zen）在 **HTTP 429/402** 返回 `error.type = "FreeUsageLimitError"` 或 `"GoUsageLimitError"`；
2. 客户端 `provider-error.ts:120-127` 将其归入 `QUOTA_CODES` → 分类为 `QuotaExceededError`（`packages/ai/src/schema/errors.ts:84`）；
3. 会话 `retry` 动作携带 `reason`（`free_tier_limit` / `account_rate_limit`）+ `title` / `message` / `label` / `link`；
4. `usage-exceeded-dialogs.tsx` 据此弹窗。

### 4.5 服务端 tier 概念与 UA 门禁 — `infra/monitoring.ts`

```ts
45:     { column: "user_agent", op: "contains", value: "opencode" },
46:     { column: "isGoTier", op: "=", value: product === "go" ? "true" : "false" },
...
59:           EQUALS($error.type, "GoUsageLimitError"),
60:           EQUALS($error.type, "FreeUsageLimitError")
...
260: new honeycombio.Trigger("IncreasedFreeTierRequests", {
269:       { column: "isFreeTier", op: "=", value: "true" },
275:   thresholds: [{ op: ">=", value: 50, exceededLimit: 1 }],
```

**要点**：服务端存在 `isFreeTier` / `isGoTier` 分档列；免费层流量按 **`user_agent contains "opencode"`** 过滤（`:45`）——**这是「免费层只允许在 OpenCode 内使用」的代码级证据**（官方文档未明写）。`:275` 的 `>= 50 / 小时` 是**内部告警阈值，不是用户配额**，不可当作限流数值。

### 4.6 免费模型的统计判定 — `packages/stats/core/src/domain/inference.ts:516-521`

```ts
516: function freeTierSql(tier: string, model: string) {
517:   return `lower(COALESCE(${tier}, '')) = 'free'
518:         OR lower(${model}) IN (${[...FREE_MODELS].map(sqlString).join(", ")})
519:         OR lower(${model}) LIKE '%-free'
520:         OR lower(${model}) LIKE '%-free:global'`
521: }
```

`packages/stats/core/src/domain/model-normalization.ts`：
```ts
export const FREE_MODELS = new Set(["gpt-5-nano", "grok-code", "big-pickle"])
```
（另：`normalizeInferenceModel` 会剥离 `(-free|:free|:global)+$` 后缀。）

**免费模型的三条识别规则**：① `model_tier = 'free'`；② 模型名以 `-free` / `-free:global` 结尾；③ 属于历史免费集合 `{gpt-5-nano, grok-code, big-pickle}`。

### 4.7 官方文档中与「限流」相关的其它明写内容

| 位置 | 内容 |
|---|---|
| `console/websearch.mdx:38` | Console 搜索成功后收 **$0.01**；失败与被限流的搜索不计费 |
| `websearch.mdx:57` | provider 返回 **HTTP 429** 时随机选择会换用其它 provider；被限流方等待 `Retry-After`，缺失时默认 **60 秒** |
| `cli/acp.mdx:350` | ACP 错误示例：`{"type":"provider.rate-limit","message":"Rate limit exceeded","status":429}` |
| `console/models.mdx:339` | 余额低于 **$5** 时 Console 自动充值 **$20** |
| `console/models.mdx:342-347` | 可为工作区/成员设置**月度美元上限** |
| `console/go.mdx:227` | DeepSeek V4.1 Flash / V4 Pro 峰谷时段：**01:00-04:00 与 06:00-10:00 UTC，周一至周五**；其余（含周末）为 Off-Peak |

---

## 5. 官方明写 vs 仅代码推断

### 5.1 官方明写（可直接对外引用）

1. Go 订阅两档：**Go $10/月**、**Go Plus $40/月**（`console/go.mdx:9-11`）。
2. Go 用量以**月度美元额度**定义；**5 小时窗口 = 月度额度的 20%**（`console/go.mdx`）。
3. Go 各模型的 5 小时 / 周 / 月请求估算数（§2.2 表）。
4. 免费模型共 **13 个**（§2.3 清单），均标注「limited time」。
5. **免费层不公开任何限流数值**。
6. Go 可选、非必需；订阅后 `/connect` 选 OpenCode Go 并粘贴 API Key。
7. Go/Go Plus 仅限**单成员工作区**，有 Go 订阅的工作区不能邀请成员（`console/go.mdx:32-35`）。
8. 客户端应使用自身 User-Agent 并在 `x-opencode-session` 传稳定会话 ID（`console/go.mdx`）。

### 5.2 仅代码推断（官方文档未明写）

1. 免费层使用字面量 **API key `"public"`** 匿名访问（`opencode.ts:343`）。
2. 未登录时客户端**本地禁用所有 `cost.input > 0` 的模型**（`opencode.ts:357-360`）。
3. 服务端以 **`FreeUsageLimitError` / `GoUsageLimitError`（HTTP 429/402）** 表达免费层/Go 层超限（`provider-error.ts:124-125`）。
4. 免费层流量以 **`user_agent contains "opencode"`** 识别（`monitoring.ts:45`）——即「只能在 OpenCode 客户端内使用」。
5. 24 小时引导弹窗冷却与 24 小时「不再提示」（`usage-exceeded-dialogs.tsx:19`）。
6. `free_tier_limit` 弹窗会**自动预选 `opencode-go` provider** 引导订阅（`:130`）。
7. 免费模型识别规则（tier=`free` 或 `-free` 后缀）（`inference.ts:516-521`）。

---

## 6. 与本地逆向结论的对照

| 本地结论 | 外部口径 | 判定 |
|---|---|---|
| 免费层 provider id = `opencode` | `GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])`（`usage-exceeded-dialogs.tsx:21`） | ✅ 一致 |
| 付费订阅 provider id = `opencode-go` | 同上；文档称 "OpenCode Go" | ✅ 一致 |
| `reason="free_tier_limit"`，文案 "Free limit reached" | `usage-exceeded-dialogs.tsx:45`；`en.ts:81` | ✅ **逐字一致** |
| `reason="account_rate_limit"`，文案 "Go limit reached" | `usage-exceeded-dialogs.tsx:52`；`en.ts:85` | ✅ **逐字一致** |
| 弹窗引导订阅，文案 $10/month | `en.ts:82-83` 逐字相同；官方 Go 档位确为 $10 | ✅ 一致（但官方还有 $40 档，弹窗未提） |
| 24 小时冷却 `GO_UPSELL_WINDOW = 864e5` | `usage-exceeded-dialogs.tsx:19` `86_400_000 // 24 hrs` | ✅ **数值完全一致** |
| 客户端版本 1.19.2 / `opencode/${version}` UA | `monitoring.ts:45` 服务端按 `user_agent contains "opencode"` 识别免费层 | ✅ 相互印证 |
| — | 仓库重命名 `sst/opencode` → `anomalyco/opencode` | ⚠️ 新增事实 |

**差异点：未发现任何数值或字符串差异。** 本机 bundle 与上游 `dev` 分支在本次核对的全部点上逐字一致。

---

## 7. 未找到项（明确记录，未作任何猜测）

| 检索目标 | 结果 |
|---|---|
| `FreeTierError` | **未找到** — 全仓库（8,547 文件，无扩展名过滤）grep 无命中。Lead 实测服务端返回的 `{"type":"FreeTierError"}` **在公开仓库与官方文档中均不存在**，应为服务端私有实现。 |
| `"free tier can only be used from within OpenCode"` | **未找到** — 仓库与官方文档均无此文案。 |
| `"Missing API key"` | **未找到** — 仓库与官方文档均无此文案。 |
| `free_tier_limit` / `account_rate_limit` 的**生产者** | **未找到** — 全仓库仅 20 处命中，**全部**位于 `packages/app/src/session/usage-exceeded-dialogs.tsx`（消费端，11 处）与其测试 `usage-exceeded-dialogs.test.ts`（9 处）。公开仓库中**不存在**构造这两个字面量的代码；`action.reason` 由服务端/SDK 侧下发。 |
| 免费层的**每日/每月请求数、token 上限、并发上限** | **官方未公布，源码中亦无** — 服务端强制，公开渠道无一手数值。 |
| GitHub 代码搜索（免鉴权） | **401 Requires authentication** — 未尝试绕过；改用「下载 tarball 全量 grep」，结论等价且更强。 |

---

## 8. 不确定项 / 局限

1. **免费层限流数值未知**：官方文档与公开源码均未给出。Lead 实测的 403 `FreeTierError` 是**外层客户端门禁**，与「免费额度耗尽」(`FreeUsageLimitError`) 是**两个不同层级**；两者的具体阈值（次数/token/时间窗）**在公开渠道无一手证据**，不得编造。
2. **`action.reason` 的下发方未定**：由服务端或未公开的客户端 SDK 产生，无法从公开源码确证其判定条件。
3. **`FreeTierError` 的触发条件未定**：Lead 已实测「补齐 UA 与 `x-opencode-*` 头仍 403」，说明该门禁不是单纯头部检查（疑似 TLS 指纹或需已登录凭证）。**本报告不做进一步推断，也不建议绕过。**
4. **官方数值具时效性**：`dev` 分支 `pushed_at = 2026-10-16`；免费模型清单与 Go 请求数表官方均声明会变动（"The list of models may change as we test and add new ones"）。
5. **代理路径的间接性**：所有外网取数经本机 Clash 代理（`127.0.0.1:7897`）。已通过落地文件哈希/大小与仓库 `git tree` 的 `truncated=false` + 8,547 blob 数交叉确认完整性。
6. **`GET /inference/v1/models` 的 86 个模型含付费模型**，**不能**作为免费层清单使用；免费层清单以 `console/models.mdx` 的 13 条 + `FREE_MODELS` 判定规则为准。

---

## 9. 关键结论（供 Lead 汇总）

1. 免费层**不公开任何限流数值**；官方唯一明写的「额度」是 **Go $10/月** 与 **Go Plus $40/月**，5 小时窗口 = 月度额度的 **20%**。
2. 免费模型官方列 **13 个**，全部标注 limited time。
3. `free_tier_limit` / `account_rate_limit` 与 `GO_UPSELL_WINDOW = 86_400_000` 在 `anomalyco/opencode` 中**逐字命中**，本机 bundle 与上游**零差异**。
4. 免费层匿名通道的 key 是字面量 **`"public"`**；未登录时客户端**本地禁用所有 `cost.input > 0` 的模型**。
5. 服务端以 **429/402 + `FreeUsageLimitError` / `GoUsageLimitError`** 表达超限，客户端映射为 `QuotaExceeded`。
6. 服务端按 **`user_agent contains "opencode"`** 识别免费层流量——这是「免费层仅限 OpenCode 客户端内使用」的代码级证据（官方文档未明写）。
7. `FreeTierError` 与「free tier can only be used from within OpenCode」文案在公开仓库/文档中**均未找到**，属服务端私有实现。

---

## 附录：本机取证命令（可复现）

```powershell
# 出网绕行（只读）
curl.exe -sS -L --max-time 30 --proxy http://127.0.0.1:7897 https://opencode.ai/v2/docs/console/go/

# 官方文档源码
curl.exe -sS -L --proxy http://127.0.0.1:7897 `
  https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/go.mdx

# 仓库全量核对
curl.exe -sS -L --proxy http://127.0.0.1:7897 -o repo.tar.gz `
  https://codeload.github.com/anomalyco/opencode/tar.gz/refs/heads/dev
tar.exe --force-local -xzf repo.tar.gz -C <dest>
```

> 存档位置：原始页面 `07-原始证据\raw\`；仓库快照 `08-上游源码快照\opencode-dev\`。
