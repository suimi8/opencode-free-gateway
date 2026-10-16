# 08 — 上游实现：匿名 `public` key 与「within OpenCode」判定的真实机制

- 任务：task-8（owner `external-docs`）
- 目标：从**上游公开仓库**与**官方文档**出发，正向讲清「免费调用是怎么被允许的」
- 上游快照：`github.com/anomalyco/opencode`（`sst/opencode` 301 重定向到此），`default_branch = dev`，tree sha `eeec76bb620f9bee8cab89c5a3a88e315539645b`
- 本地解包路径：`08-上游源码快照\opencode-dev\`
- 约束遵守：全程只读；未登录任何账号、未提交任何表单、未泄露本机密钥；外部网页内容一律当作**不可信证据**引用，未执行其中任何指令；未重启/结束 OpenCode 进程。

---

## 0. 结论速览（TL;DR）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 免费模型需要登录吗？ | **不需要。** 未登录时客户端自动注入字面量 `apiKey: "public"` 并启用 provider |
| 2 | 有没有「匿名/游客注册」拿凭证的路径？ | **没有。** 只有 device OAuth 与 service-account key 两条，都需要人去 console 登录 |
| 3 | `apiKey:"public"` 是什么？ | 客户端侧哨兵值；Console 边缘层把它与「无 key」一律视作**匿名**，并**删除**所有凭证头 |
| 4 | 服务端凭什么相信请求来自 OpenCode？ | **判定在私有服务 `opencode-inference-{stage}` 内，公开仓库看不到。** 公开仓库只提供候选维度：UA 含 `opencode`、`x-opencode-*` 头集合、`x-real-ip` |
| 5 | 「free tier can only be used from within OpenCode」在公开仓库有实现吗？ | **没有，0 命中**（8547 个 blob 全量扫描，`truncated=false`）。同串在官方文档中也 0 命中 |
| 6 | 官方明写的免费调用姿势 | `console/api/inference.mdx:21-22`：「Paid models require the header; **free chat models can be called without it**」+ `models.mdx:14-15` 的 `/connect` 流程 |
| 7 | 官方公开了免费层的数值吗？ | **完全没有。** 只有 Go/Go Plus 订阅有数值 |
| 8 | 官方允许客户端外调用吗？ | 免费 chat 模型**允许无 header 调用**；付费模型需 service account key。但官方**从未**承诺「可从任意客户端调用免费模型」，实测（task-4/03）显示无凭证调用免费模型返回 403 `FreeTierError` |

---

## 1. 取证方法与环境

| 项 | 值 |
|---|---|
| 上游 tarball | `https://codeload.github.com/anomalyco/opencode/tar.gz/refs/heads/dev`（79,762,722 B） |
| 下载命令 | `curl.exe -sS -L --max-time 300 --proxy http://127.0.0.1:7897 -o repo.tar.gz <url>` |
| 解包命令 | `tar.exe --force-local -xzf repo.tar.gz`（**教训**：msys `tar` 会把 `C:\...` 当远端主机，报 `Cannot connect to C: resolve failed`） |
| 文件数 | 8,547（= GitHub tree 的 blob 数，**全量覆盖**） |
| tree 快照 | `07-原始证据\raw\tree.json`：`truncated = false`，`entries = 9492`（blobs 8547 / trees 945） |
| 检索方式 | `Select-String -SimpleMatch` 精确串搜（非正则），见第 4 章 |
| 网络绕行 | 本机 TUN Fake-IP 使 `web_fetch` 报 `resolves to a non-public IP`；`web_search` 无 API key 不可用。改用 `curl.exe --proxy http://127.0.0.1:7897` 只读 GET |

> 说明：本轮所有官方页面抓取均为 **GET**，未附带任何凭证，未登录，未提交表单。

---

## 2. Q1 — `packages/core/src/plugin/provider/opencode.ts` 逐段精读（共 667 行）

### 2.1 常量与 Schema（`:20-87`）

```ts
20: const defaultServer = "https://opencode.ai/console"
21: const clientID = "opencode-cli"
22: const methodID = Integration.MethodID.make("device")
```

```ts
59: const Device = Schema.Struct({
60:   device_code: Schema.String,
61:   user_code: Schema.String,
62:   verification_uri_complete: Schema.String,
63:   expires_in: Schema.Number,
64:   interval: Schema.Number,
65: })
66: const Token = Schema.Struct({
67:   access_token: Schema.String,
68:   refresh_token: Schema.String,
69:   expires_in: Schema.Number,
70:   org_id: Schema.optional(Schema.NullOr(Schema.String)),
71: })
72: const TokenPending = Schema.Struct({ error: Schema.String })
73: const DeviceToken = Schema.Union([Token, TokenPending])
74: const User = Schema.Struct({ id: Schema.String, email: Schema.String })
75: const Org = Schema.Struct({ id: Schema.String, name: Schema.String })
```

`:82` `InvalidGrant = { error: Literal("invalid_grant") }`；`:85` `signedOutMessage = "Reconnect OpenCode Console to continue"`。

### 2.2 OAuth 设备流（`:105-182`）

```ts
105: function oauth(http: HttpClient.HttpClient) {
106:   return {
107:     integrationID: Integration.ID.make("opencode"),
108:     method: {
109:       id: methodID,
110:       type: "oauth",
111:       label: "OpenCode Console account",
112:       form: [
113:         { key: "server", type: "string", format: "uri", hidden: true, default: defaultServer },
120:       ],
121:     },
122:     authorize: (answer) =>
123:       Effect.gen(function* () {
124:         const server = yield* normalizeServer(answer.server ?? defaultServer)
125:         const device = yield* post(
126:           http,
127:           `${server}/auth/device/code`,
128:           { client_id: clientID, supports_org_scope: true },
129:           Device,
130:         )
131:         const verification = yield* Effect.try({ ... 校验 verification_uri_complete 必须是 http/https ... })
140:         return {
141:           mode: "auto" as const,
142:           url: verification.href,
143:           instructions: `Enter code: ${device.user_code}`,
144:           callback: poll(http, server, device.device_code, Duration.seconds(device.interval)),
145:         }
146:       }),
```

刷新（`:147-179`）：

```ts
149:         const response = yield* send(http, `${serverUrl(credential)}/auth/device/token`, {
150:           grant_type: "refresh_token",
151:           refresh_token: credential.refresh,
152:           client_id: clientID,
153:         })
154:         if (response.status === 400) {
155:           const body = yield* HttpClientResponse.schemaBodyJson(InvalidGrant)(response).pipe(Effect.option)
156:           if (Option.isSome(body)) return yield* new SignedOutError()
157:         }
```
`:162-178` 持久化轮换后的 access/refresh/expires，并在 `token.org_id` 存在时写入 `metadata.orgID` / `orgName`。

### 2.3 「Console 读 UA 识别 OpenCode」——**官方代码注释明写**（`:189-191`）

```ts
189:     // Every request here goes to the Console, which reads the User-Agent to tell which OpenCode a member runs
190:     // and whether it evaluates the policies it is being sent.
191:     const http = HttpClient.mapRequest(client, HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)))
```

这是本轮最重要的**正面**证据：**Console 侧确实以 User-Agent 作为识别「哪个 OpenCode」的既有维度**，并且这条注释出自官方仓库自身。

### 2.4 注册的两种凭证方式（`:255-261`）

```ts
255:     yield* ctx.integration.transform((editor) => {
256:       editor.update("opencode", (integration) => {
257:         integration.name = "OpenCode Console"
258:       })
259:       editor.method.update(oauth(http))
260:       editor.method.update({ integrationID: "opencode", method: { type: "key", label: "API key (service account)" } })
261:     })
```

→ opencode integration 只有两条 method：**device OAuth** 与 **service account API key**。**没有**匿名/游客/trial 第三种。

### 2.5 Console 远端配置注入（`:265-335`）

- `:271` `provider.integrationID = Integration.ID.make("opencode")`
- `:275-280` `provider.settings = Provider.mergeOverlay(withoutCredentials(provider.settings), withoutCredentials(item.settings))`；`provider.headers` / `provider.body` 同法合并
- `:283-327` 逐模型覆盖：`family`/`name`/`modelID`/`compatibility`/`package`/`capabilities`/`settings`/`headers`/`body`/`variants`
- `:314-323` **cost 来自 Console 配置**（可被服务端下发覆盖）
- `:324` `model.enabled = !config.disabled` ← 服务端可逐个开关模型
- `:325` `if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }`
- `:564-569` `withoutCredentials()` 明确剥离 `["apiKey", "authToken", "accessToken"]`

### 2.6 **`apiKey: "public"` 注入条件**（`:337-346`，逐字）

```ts
337:       const item = providers.get(Provider.ID.opencode)
338:       if (!item) return
339:       const hasKey = Boolean(process.env.OPENCODE_API_KEY || snapshot.connection || item.provider.settings?.apiKey)
340:       providers.update(item.provider.id, (provider) => {
341:         if (!hasKey) {
342:           provider.activation = "enabled"
343:           provider.settings = { ...provider.settings, apiKey: "public" }
344:         }
345:       })
346:     })
```

判定 `hasKey` 的三个来源：① 环境变量 `OPENCODE_API_KEY`；② `snapshot.connection`（即 Console 设备流已登录）；③ provider settings 里已有的 apiKey。

### 2.7 **models 过滤条件**（`:347-362`，逐字）

```ts
347:     yield* ctx.model.transform((models) => {
348:       const item = models.provider.get(Provider.ID.opencode)
349:       if (!item) return
350:       const hasKey = Boolean(
351:         process.env.OPENCODE_API_KEY ||
352:           snapshot.connection ||
353:           (item.provider.settings?.apiKey && item.provider.settings.apiKey !== "public"),
354:       )
355:       if (hasKey) return
356:       for (const model of models.list(item.provider.id)) {
357:         if (!model.cost.some((cost) => cost.input > 0)) continue
358:         models.update(item.provider.id, model.id, (draft) => {
359:           draft.enabled = false
360:         })
361:       }
362:     })
```

关键点：判据是 **`cost.input > 0`**（只看 input 价）。因此 **output-only 计费模型也被当作免费保留**——官方测试 `provider-opencode.test.ts:1790`「treats output-only cost as free without credentials」正是断言这一点。

### 2.8 其余注入点（本文件内）

| 位置 | 注入内容 |
|---|---|
| `:389-397` | Web Search：`POST ${server}/api/websearch`，`bearerToken(token)` + `x-org-id`（有 orgID 时） |
| `:493-496` | `GET ${server}/api/v2/config` + `credentialHeaders(value)` |
| `:552-558` | `credentialHeaders()`：`authorization: Bearer ${access \| key}` + `x-org-id` |
| `:560-562` | `serverUrl()`：来自 `credential.metadata.server`，否则 `defaultServer` |

**baseURL 不在本文件注入**——它由 Console 下发的 `providers.opencode.settings.baseURL` 提供（官方示例 `console/api/index.mdx:132`：`"baseURL": "https://opencode.ai/inference/openai/v1"`）。

### 2.9 其他辅助函数

- `:209-247` `load()`：`ctx.integration.connection.active("opencode")` → `resolve(credential)` → `fetchConfig`
- `:433-447` `apply()` / `refresh()` / `check()`：快照变化才重建
- `:449-467` `explain()`：会话 HTTP 401/403 时 `check()`，若连接状态异常则把响应替换为 `{"error":{"type":"authentication_error","message":...}}`
- `:485` 每 **1 分钟** `check()` 一次
- `:489-521` `fetchConfig()`：`GET /api/v2/config`；`404 → undefined`；`401 → SignedOutError`；`403 + {_tag:"SsoRequired"} → SsoRequiredError`
- `:523-531` `ssoUrl()`：`${base}/auth/sso/${connectionID}/start?redirectTo=`
- `:584-607` `poll()`：`POST ${server}/auth/device/token`，`grant_type=urn:ietf:params:oauth:grant-type:device_code`；`authorization_pending → 重试`；`slow_down → wait+5s`
- `:609-640` `credential()`：`GET ${server}/api/user`、`GET ${server}/api/orgs`

### 2.10 **全局**注入点：`packages/core/src/session/model-request.ts:283-291`

这才是「我是 OpenCode」的完整自证头集合（对**所有**模型请求生效，不限 opencode provider）：

```ts
281:         http: {
282:           headers: {
283:             "x-opencode-session-id": session.id,
284:             ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
285:             "x-session-affinity": affinity,
286:             "X-Session-Id": affinity,
287:             ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
288:             "User-Agent": App.useragent(app),
289:             "x-opencode-project": session.projectID,
290:             "x-opencode-session": affinity,
291:             "x-opencode-client": app.name,
292:           },
293:         },
```

另有 `packages/core/src/generate.ts:70`：`http: { headers: { "x-opencode-session": SessionID.create() } }`。

**真实 UA 格式**（`packages/core/src/app.ts:24-26`）：

```ts
24: export function useragent(app: Info) {
25:   return `opencode/${app.channel}/${app.version}/${app.name}`
26: }
```

`app.name` 默认 `"opencode"`（`:16-22`）。即真实 UA 形如 `opencode/prod/1.19.2/opencode`——**含 4 段**。Lead 侦察时用的 `opencode/1.19.2` **少了两段**，格式与上游不一致（见第 8 章不确定项）。

---

## 3. Q2 — 上游 auth 流程与「匿名/设备注册」路径

### 3.1 `opencode auth login` 对 opencode provider 走什么

- CLI 命令定义：`packages/cli/src/commands/commands.ts:162` → `Argument.withDescription("Integration ID, name, or well-known provider URL")`
- CLI 测试：`packages/cli/test/auth.test.ts:34` → `expect(login.stdout).toContain("Integration ID, name, or well-known provider URL")`
- 选到 `opencode` integration 后，由 `opencode.ts:255-261` 注册的**两条 method** 决定：
  1. **device OAuth**（`type: "oauth"`，label `OpenCode Console account`）→ `POST ${server}/auth/device/code` → 浏览器打开 `verification_uri_complete` → 轮询 `POST ${server}/auth/device/token`
  2. **API key (service account)**（`type: "key"`）→ 粘贴 console 里创建的 `oc_sk_...`

### 3.2 有没有「匿名/设备注册」取免费凭证的路径？

**没有。** 检索（全仓库 8547 文件，`Select-String -SimpleMatch`）：

| 串 | 命中 | 说明 |
|---|---|---|
| `anonymous` | 相关仅 1 处 | `packages/console/app/src/lib/inference-proxy.ts:42` — 服务端把 `public` 当匿名；其余命中为编译器/代码风格术语（`anonymous object`、`anonymous function`、`anonymous types`） |
| `guest` | 0 相关 | 唯一命中 `packages/merman/src/flowchart/flowchart.test.ts:2399` 测试字符串 |
| `trial` | 0 相关 | 命中为 e2e 的 `click({ trial: true })`、`enterprise.mdx` 销售文案「Do a trial internally」、`terms-of-service/index.tsx:319-321` 促销条款 |
| `/auth/device` | 有 | 仅 `opencode.ts:127`、`:149`、`:590`（device flow 本体） |
| `well-known` | 0 相关 | 命中为 `.well-known/opencode`（**组织远端配置**，`packages/core/src/wellknown.ts:66`）与 MCP OAuth 的 `.well-known/oauth-*`、GitHub JWKS——**都不是免费凭证注册** |
| `oauth` | 有 | 设备流 + MCP OAuth + 各 provider OAuth；无匿名注册 |

→ **不存在匿名注册、游客凭证、trial token 的代码路径。**

### 3.3 免费模型是否需要登录？**不需要**（三重证据）

1. **客户端代码**：`opencode.ts:337-345` 未登录（`hasKey === false`）时 `provider.activation = "enabled"` 且 `apiKey = "public"`；`:347-362` 只把 `cost.input > 0` 的模型本地禁用，`cost.input === 0` 的免费模型保持 `enabled`。
2. **官方测试**（`packages/core/test/plugin/provider-opencode.test.ts`）：
   - `:1752` `it.effect("uses a public key and disables paid models without credentials")` → 断言 `settings?.apiKey === "public"`、paid 模型 `enabled === false`
   - `:1770` `it.effect("keeps free models without credentials")` → 断言 `apiKey === "public"`、`activation === "enabled"`、`catalog.available()` 含 `Provider.ID.opencode`、free 模型 `enabled === true`
   - `:1790` `it.effect("treats output-only cost as free without credentials")` → output-only 模型 `enabled === true`
3. **官方文档**：`console/api/inference.mdx:21-22`「Paid models require the header; **free chat models can be called without it**.」（已在 live 页面核对，见第 5 章）

### 3.4 未登录 `public` 通道 vs 登录后通道，服务端有什么不同？

- **公开仓库无法回答**：判定逻辑在私有服务内（见第 4.2 节）。
- **客户端侧可确认的差异**：
  - 登录后 → `snapshot.connection` 非空 → `hasKey === true` → **不**注入 `"public"`，且**不**禁用付费模型（`opencode.ts:350-355`）；
  - 登录后才会 `GET /api/v2/config` 拿到 Console 下发的 provider/model/cost/policy/MCP/websearch 配置（`:209-247`、`:489-521`），并带上 `x-org-id`（`:552-558`）；
  - 未登录 → 请求只可能落到免费模型（付费模型在本地已被 `enabled = false`）。
- 结论：**服务端对两条通道的差别属于「未公开实现」，本轮不作推断性断言。**

---

## 4. Q3 — 「within OpenCode」判定：可复核的负面证据链 + 正面线索

### 4.1 负面证据链（可复核）

**仓库与快照**

- `https://github.com/sst/opencode` → **301** → `https://github.com/anomalyco/opencode`（`full_name = anomalyco/opencode`，`id = 975734319`，`default_branch = dev`）
- tarball：`https://codeload.github.com/anomalyco/opencode/tar.gz/refs/heads/dev`，79,762,722 B
- tree 元数据：`truncated = false`，`entries = 9492`，**`blobs = 8547`**，`trees = 945`，`sha = eeec76bb620f9bee8cab89c5a3a88e315539645b`
- 解包后本地文件数 **8,547** —— 与 blob 数一致，证明**扫描是全量的，没有因 GitHub tree 截断而漏文件**

**扫描命令（原文，可复现）**

```powershell
$p='08-上游源码快照\opencode-dev'
$strings=@('FreeTierError','free tier can only be used from within OpenCode',
  'can only be used from within OpenCode','Missing API key','within OpenCode',
  'FreeUsageLimitError','GoUsageLimitError','free_tier_limit','account_rate_limit',
  'GO_UPSELL','opencode-inference','isFreeTier','isGoTier','x-opencode-signature',
  'apiKey: "public"','key === "public"','!key || key === "public"')
$files = Get-ChildItem $p -Recurse -File
foreach($s in $strings){
  $hits = Select-String -Path ($files.FullName) -SimpleMatch -Pattern $s
  "{0,-52} hits={1}" -f $s, ($hits | Measure-Object).Count
}
```

**结果（精确命中数 + 位置）**

| 搜索串 | 命中 | 位置 |
|---|---|---|
| `FreeTierError` | **0** | — |
| `free tier can only be used from within OpenCode` | **0** | — |
| `can only be used from within OpenCode` | **0** | — |
| `within OpenCode` | **0** | — |
| `Missing API key` | **0** | — |
| `x-opencode-signature` | **0** | — |
| `opencode-inference` | 1 | `infra/console.ts:76` |
| `apiKey: "public"` | 1 | `packages/core/src/plugin/provider/opencode.ts:343` |
| `key === "public"` | 1 | `packages/console/app/src/lib/inference-proxy.ts:42` |
| `!key \|\| key === "public"` | 1 | `packages/console/app/src/lib/inference-proxy.ts:42` |
| `FreeUsageLimitError` | 3 | `infra/monitoring.ts:60`、`packages/ai/src/provider-error.ts:125`、`packages/ai/test/provider-error.test.ts:272` |
| `GoUsageLimitError` | 3 | `infra/monitoring.ts:59`、`packages/ai/src/provider-error.ts:124`、`packages/ai/test/provider-error.test.ts:271` |
| `free_tier_limit` | 2 | `packages/app/src/session/usage-exceeded-dialogs.tsx:45`、`:116` |
| `account_rate_limit` | 18 | 全部在 `usage-exceeded-dialogs.tsx` + `usage-exceeded-dialogs.test.ts` |
| `isFreeTier` | 1 | `infra/monitoring.ts:269` |
| `isGoTier` | 2 | `infra/monitoring.ts:46`、`:137` |

**解读**

- 字面量 `"free tier can only be used from within OpenCode"` 在**公开仓库中不存在**，在**官方文档中也不存在**（第 5 章检索）。
- `free_tier_limit` / `account_rate_limit` 只出现在 `packages/app/src/session/usage-exceeded-dialogs.tsx`（**消费端**，弹窗逻辑）与其单测中；公开仓库**没有任何代码构造这两个字面量**。
- `FreeTierError` 0 命中；`FreeUsageLimitError` / `GoUsageLimitError` 只作为**已收到的错误类型**被识别（`packages/ai/src/provider-error.ts:119-127` 的 `QUOTA_CODES`）与告警（`infra/monitoring.ts:59-60`），**没有生产者**。
- `x-opencode-signature` 0 命中 → **请求侧不存在签名机制**（与 Lead 的侦察一致）。`createHmac` 命中全部来自 npm 包与 `packages/server/src/auth.ts:64` 的本地会话口令，与本主题无关。

### 4.2 为什么找不到：判定实现在**本仓库之外**的服务里

`infra/console.ts:5-13`：

```ts
 5: // Preview stages have no new Console or inference deployment to forward to.
 6: const migrationDomain =
 7:   $app.stage === "production" ? "opencode.ai" : $app.stage === "dev" ? "dev.opencode.ai" : undefined
 8: const consoleMigration = new sst.Linkable("ConsoleMigration", {
 9:   properties: {
10:     consoleUrl: migrationDomain ? `https://${migrationDomain}/console` : "",
11:     inferenceUrl: migrationDomain ? `https://${migrationDomain}/inference` : "",
12:   },
13: })
```

`infra/console.ts:72-77`：

```ts
72:           // Same-zone fetch to inference re-enters as a public request and loses the client IP.
73:           if (migrationDomain)
74:             args.bindings = $resolve(args.bindings).apply((bindings) => [
75:               ...(bindings ?? []),
76:               { type: "service", name: "INFERENCE", service: `opencode-inference-${$app.stage}` },
77:             ])
```

**关键事实**：本仓库只以 Cloudflare **service binding 名称**引用 `opencode-inference-${$app.stage}`；`sst.config.ts` 里**没有**任何 `new sst.cloudflare.Worker("Inference", …)` 定义（全文已读：只 import 了 `infra/webapp.ts`、`infra/stage.ts`、`infra/app.ts`、`infra/stats.ts`、`infra/console.ts`、`infra/share.ts`、`infra/monitoring.ts`）。→ **inference 服务是独立部署、源码不在此公开仓库的 Worker。**

`packages/console/app/src/lib/inference-proxy.ts:17` 的注释是官方自认：

```ts
17: // New inference owns authentication, model availability, free-tier access, and billing.
```

→ **「free-tier access」的实现在私有服务里。公开仓库只有消费端（客户端弹窗）与边缘转发层。**

### 4.3 公开仓库中唯一与 `public` 直接相关的**服务端**代码（全文 61 行）

`packages/console/app/src/lib/inference-proxy.ts`：

```ts
 1: import { Resource } from "@opencode/console-resource"
 3: const paths: Record<string, string | undefined> = {
 4:   "POST /zen/v1/chat/completions": "/openai/v1/chat/completions",
 5:   "POST /zen/v1/responses": "/openai/v1/responses",
 6:   "POST /zen/v1/messages": "/anthropic/v1/messages",
 7:   "POST /zen/v1/systemone": "/systemone/v1/systemone",
 8:   "POST /zen/go/v1/chat/completions": "/go/openai/v1/chat/completions",
 9:   "POST /zen/go/v1/responses": "/go/openai/v1/responses",
10:   "POST /zen/go/v1/messages": "/go/anthropic/v1/messages",
11:   "POST /zen/go/v1/systemone": "/go/systemone/v1/systemone",
12:   "GET /zen/v1/models": "/v1/models",
13:   "GET /zen/go/v1/models": "/go/v1/models",
14:   "GET /zen/go/v1/usage": "/go/v1/usage",
15: }
17: // New inference owns authentication, model availability, free-tier access, and billing.
18: export async function proxyInference(request: Request) {
28:   const key = url.pathname.endsWith("/messages")
29:     ? request.headers.get("x-api-key")
30:     : path.startsWith("/google/")
31:       ? request.headers.get("x-goog-api-key")
32:       : request.headers.get("authorization")?.split(" ")[1]
34:   const destination = new URL(Resource.ConsoleMigration.inferenceUrl)
39:   const forwarded = new Request(destination, request)
40:   for (const name of ["host", "content-length"]) forwarded.headers.delete(name)
41:   // Keyless requests must reach new inference without credentials; `public` is not an API key there.
42:   const anonymous = !key || key === "public"
43:   if (anonymous) for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) forwarded.headers.delete(name)
44:   if (!anonymous) forwarded.headers.set("authorization", `Bearer ${key}`)
45:   const ip = request.headers.get("cf-connecting-ip")
46:   if (ip) forwarded.headers.set("x-real-ip", ip)
47:   const requestID = request.headers.get("x-opencode-request-id") ?? request.headers.get("x-opencode-request")
48:   if (requestID) forwarded.headers.set("x-opencode-request-id", requestID)
50:   const response = await (Resource.INFERENCE as { fetch: typeof fetch })
51:     .fetch(forwarded, { redirect: "manual" })
```

**官方自认的两点**：
1. `:41` 注释 —— `public` **不是** API key，无凭证请求应当**不带任何凭证**到达新 inference；
2. `:42-44` —— 边缘把 `public` 与「无 key」**统一当匿名**，并**删除** `authorization` / `x-api-key` / `x-goog-api-key`。

**该边缘只登记了 `/zen/*`**：`packages/console/app/src/routes/zen/**` 共 12 个薄壳文件（191–346 B），全部形如

```ts
1: import type { APIEvent } from "@solidjs/start/server"
2: import { proxyInference } from "~/lib/inference-proxy"
4: export function POST(input: APIEvent) {
5:   return proxyInference(input.request)
6: }
```

而 `packages/console/app/src/routes/` 下**没有** `inference/` 目录，`middleware.ts`（全文 27 行）也只处理 `/auth`、`/workspace` 的重定向。→ **客户端与官方文档使用的 `/inference/*` 路径不经过这个公开的边缘层，直接落到私有 inference worker。** 公开仓库在此处断链。

### 4.4 正面线索：服务端**可能**用什么判定

按证据强度排序（**全部来自公开仓库**）：

| # | 候选判据 | 证据 |
|---|---|---|
| 1 | **User-Agent 含 `opencode`** | `infra/monitoring.ts:45`：`{ column: "user_agent", op: "contains", value: "opencode" }`；同一过滤条件在 `:91`、`:136`、`:268` 重复，且与 `isGoTier`（`:46`、`:137`）、`isFreeTier`（`:269`）并列 → UA 是官方既有的 tier 归因维度。真实 UA 见 `packages/core/src/app.ts:24-26`：`opencode/${channel}/${version}/${name}` |
| 2 | **Console 读 UA 识别 OpenCode** | `packages/core/src/plugin/provider/opencode.ts:189-190` 官方注释：「Every request here goes to the Console, which reads the User-Agent to tell which OpenCode a member runs」 |
| 3 | **`x-opencode-*` 头集合** | `packages/core/src/session/model-request.ts:283-291`：`x-opencode-session-id`、`x-opencode-parent-session-id`、`x-opencode-project`、`x-opencode-session`、`x-opencode-client` |
| 4 | **`x-opencode-client: app.name`** | 同上 `:291`；语义即「哪个客户端」。官方 `go.mdx:83-84` 也要求第三方客户端「Identify itself with its own user agent … rather than a generic SDK or HTTP-library name」 |
| 5 | **`x-opencode-session` / `x-session-affinity`** | `model-request.ts:285`、`:290`；官方 `go.mdx:85-86` 明确要求发送 |
| 6 | **`x-real-ip`（源自 `cf-connecting-ip`）** | `inference-proxy.ts:45-46` —— 唯一被显式转发的客户端网络标识，可用于 IP/地区与频次判定 |
| 7 | **TLS/JA3/JA4 指纹** | **公开仓库 0 证据**。无签名机制（`x-opencode-signature` 0 命中），`createHmac` 命中均与本主题无关 |

**结论（必须写清）**：公开仓库**无法证明**服务端实际用的是哪一条或哪几条组合；能确认的只有——UA 与 `x-opencode-*` 头是官方**既有且自认**的客户端身份维度，而 TLS 指纹属于**无证据的猜测**。

### 4.5 `infra/` 目录全量清单（8 个文件，全部已读）

| 文件 | 大小 | 与 free tier / 限流 / 计费 / 监控的关系 |
|---|---|---|
| `infra/monitoring.ts` | 8028 B | **最相关**。Honeycomb 查询与告警：`:45` UA contains "opencode"；`:46`/`:137` `isGoTier`；`:59-60` `GoUsageLimitError`/`FreeUsageLimitError`；`:260-287` `Trigger("IncreasedFreeTierRequests")`，`:269` `isFreeTier = "true"`，`:275` `thresholds: [{ op: ">=", value: 50, exceededLimit: 1 }]`（**内部告警阈值，不是用户配额**），`:276` baseline `offsetMinutes: 1440` |
| `infra/console.ts` | 3145 B | `:8-13` `ConsoleMigration`（`inferenceUrl = https://<domain>/inference`）；`:20-21` ZenData/ZenDataNew 归档 bucket（注释：writer removed May 2026，无人读写）；`:36-39` LogProcessor worker；`:41-82` Console SolidStart；`:76` INFERENCE service binding |
| `infra/app.ts` | 1904 B | `:13` `new sst.cloudflare.Worker("Api", …)`（opencode.ai API worker） |
| `infra/stats.ts` | 3315 B | `:99` KV namespace `"inference"`；`:104` StatsSyncService —— 统计用，非门禁 |
| `infra/share.ts` | 838 B | Share worker，无关 |
| `infra/webapp.ts` | 524 B | beta stage webapp，无关 |
| `infra/stage.ts` | 1117 B | stage/domain 判定，无关 |
| `infra/secret.ts` | 289 B | secret 引用，无关 |

`infra/` 内**没有任何**免费层门禁实现；它只是告警与部署编排。

---

## 5. Q4 — 官方「如何使用免费模型」的正确步骤 + 原文句子

### 5.1 三个直接回答

| 问题 | 答案 | 依据 |
|---|---|---|
| 需要登录吗？ | 免费模型**不需要**；付费模型需要 | `console/api/inference.mdx:21-22` |
| 需要 console 注册吗？ | 免费模型**不需要**；Console 付费模型与 Go 需要 | `console/models.mdx:14-15`、`console/go.mdx:19-20` |
| 有地区限制吗？ | 有，但**只针对两个模型族** | `models.mdx:330`、`go.mdx:225`、`go.mdx:61-62` |

### 5.2 官方文档里**没有**「如何使用免费模型」这一节

`services/www/src/docs/content/console/` 下共 15 个 mdx（`billing`/`budgets`/`go`/`index`/`members`/`models`/`providers`/`scim`/`sso`/`websearch`/`workspaces` + `api/{budgets,index,inference,providers}`），导航定义在 `services/www/src/docs/lib/navigation.ts:131-161`。**没有任何页面标题或小节叫「免费模型怎么启用」**；免费模型只在「模型清单 + 价格表」里被列举。

### 5.3 全部与 free / limit / rate limit / quota / region 相关的**官方原文句子**

**`console/models.mdx`（Free models 与价格）**

- `:6-7` `OpenCode Console provides a list of models tested and verified by the OpenCode team. Sign in, add credits, and get an API key to use them with OpenCode or another coding agent.`
- `:9-10` `Console works like any other provider in OpenCode. It's **completely optional**, and you can use any other provider instead. For a subscription with included usage, see OpenCode Go.`
- `:14-15` `1. Sign in to the console, add your billing details and credits, and copy your API key.` / `2. Run /connect in the TUI, choose the OpenCode pay-as-you-go provider, and paste your API key.`
- `:195` `Use jev-1.13-free instead of jev-1.13 to use the limited-time free model.`
- `:205-217` 价格表 13 行，Input/Output/Cache Read 全为 `Free`：Big Pickle、DeepSeek V4.1 Flash Free、Space Bunny Free、Cat Jam Free、LongCat 2.5 Preview Free、Exo Free、MiMo-V2.6-Flash Free、MiMo-V2.5 Free、Nemotron 3 Ultra Free、Nemotron 3.5 Lightning Free、Nemotron 3.5 Super VL Free、Muse Spark 1.3 Contributor Free、Jev 1.13 Free
- `:319-333` `### Free models` 共 13 条，**每条都只写 "for a limited time"，无任何数值**
- `:330` `Cat Jam Free is a stealth model that's free on OpenCode for a limited time. Its provider does not use your data for model training and retains it for 30 days for safety reasons. It's not available in Angola, Belarus, Cambodia, China (including Hong Kong and Macau), Cuba, the Democratic Republic of the Congo, Equatorial Guinea, Iran, Iraq, Laos, Libya, Nigeria, North Korea, Russia, Syria, Turkmenistan, Uzbekistan, Venezuela, or the Crimea, Donetsk, and Luhansk regions of Ukraine.`
- `:339` `If your balance goes below $5, Console automatically reloads $20.`
- `:342-347` `### Monthly limits` — `You can set a monthly usage limit for the entire workspace and for each member of your team.`（**这是用户自设的预算，不是免费层额度**）
- `:376-387` 隐私例外：Big Pickle / Exo Free / MiMo-V2.6-Flash Free / MiMo-V2.5 Free 免费期数据可用于改进模型；Nemotron 三个 Free 为 NVIDIA trial；Cat Jam Free 保留 30 天；Muse Spark 1.3 Contributor Free 可用于训练 Meta 模型

**`console/go.mdx`（订阅数值，免费模型的唯一数值出现在这里）**

- `:8-11` `| **Go** | **$10/month** | Lower-cost access to the models below |` / `| **Go Plus** | **$40/month** | Higher usage limits across the models below |`
- `:13` `Go works like any other provider in OpenCode. You subscribe to OpenCode Go and get your API key. It's **completely optional** and you don't need it to use OpenCode.`
- `:15` `The service is designed primarily for international users and provides stable global access.`
- `:19-20` `1. Sign in to the OpenCode Console, subscribe to Go or Go Plus, add your billing details, and copy your API key.` / `2. Run /connect in the TUI, select **OpenCode Go**, and paste your API key.`
- `:33-34` `Go and Go Plus are for workspaces with a single member … A workspace with a Go subscription cannot invite members.`
- `:52` `- **LongCat 2.5 Preview Free** (limited time)`
- `:54` `- **Cat Jam Free** (limited time, limited regions)`
- `:61-62` `- **Muse Spark 1.3 Contributor** ([limited regions](https://ai.developer.meta.com/legal/geographic-use-policy))` / 1.2 同
- `:76-86` `OpenCode Go is designed for OpenCode and other coding agents that produce similar types of requests. Traffic is monitored for abuse that degrades the experience for other users.` + `1. Send typical coding agent traffic 2. Identify itself with its own user agent, such as my-coding-agent/1.0, rather than a generic SDK or HTTP-library name. 3. Send a stable session ID in x-opencode-session for each conversation so we can optimize routing and prompt caching.`
- `:88-113` `### Validated clients`（Hermes / Claude Code / Codex / ZCode / Pi / jcode / Kilo Code CLI）与 `### Known problematic clients`（DeepSeek Harness / GitHub Copilot Chat / Kimi Code / MiMo Code）
- `:117-124` `Usage limits are defined as monthly dollar amounts. … Each model has the following usage limits: 5-hour — 20% of the monthly limit; weekly — 50%; and monthly — 100%.`
- `:140`、`:142`、`:186`、`:188`、`:246`、`:248`、`:284`、`:286` — `LongCat 2.5 Preview Free` 与 `Cat Jam Free` 的 monthly limit 在 Go 与 Go Plus 两表中均为 **`Unlimited`**
- `:223` `**LongCat 2.5 Preview Free:** Free for a limited time.`
- `:225` `**Cat Jam Free:** Free for a limited time. Not available in Angola, Belarus, Cambodia, China (including Hong Kong and Macau), Cuba, the Democratic Republic of the Congo, Equatorial Guinea, Iran, Iraq, Laos, Libya, Nigeria, North Korea, Russia, Syria, Turkmenistan, Uzbekistan, Venezuela, or the Crimea, Donetsk, and Luhansk regions of Ukraine.`
- `:344` `<Callout type="tip">If you reach the usage limit, you can continue using the free models.</Callout>` ← **官方明写：Go 额度用尽后仍可继续用免费模型**
- `:346` `Usage limits may change as we learn from early usage and feedback.`
- `:350-354` `### Usage beyond limits` — `If you also have credits in your Console balance, you can enable the **Use balance** option in the console. When enabled, Go will fall back to your pay-as-you-go balance after you've reached your usage limits instead of blocking requests.`
- `:409-417` `To use Go in OpenCode, connect with /connect and set the model using the format opencode-go/<model-id>` + `"model": "opencode-go/kimi-k3"`

**`console/api/inference.mdx`（免费调用的官方授权语句）**

- `:6-7` `Console inference serves OpenAI, Anthropic, and Gemini-compatible APIs from https://opencode.ai/inference. Send a JSON POST request to the endpoint that matches the model's API family.`
- `:21-22` `Replace <token> with a service account key created in the Console. **Paid models require the header; free chat models can be called without it.**`
- `:46` `Open models such as kimi-k2.6, glm-5.1, minimax-m2.7, and the free models use the Chat Completions API.`
- `:37-42` `See the model endpoints table, or fetch the live list:` `curl https://opencode.ai/inference/v1/models`

**`console/api/index.mdx`（service account 与 device flow 的官方对外说明）**

- `:19-22` 端点总表：`Inference | https://opencode.ai/inference/...`、`Providers | https://opencode.ai/inference/custom/...`、`Budgets | /api/v1/budgets/members`、`Config | GET /api/v2/config`
- `:24-42` `## Service accounts` — `Open **Keys** and click **Add Service Account** …` → `oc_sk_1a2b3c4d5e6f_...` → `Authorization: Bearer oc_sk_...`
- `:46-49` 权限表：`Inference only` → `Inference and Providers requests, and GET /api/v2/config.`
- `:57` `Automations using a revoked or expired key get HTTP 401 immediately.`
- `:73-112` `## Device flow` — `OpenCode signs in with the OAuth device authorization grant (RFC 8628). **Other CLIs can use the same flow.**`；`expires_in (600 seconds)`、`interval (5 seconds)`；`POST ${CONSOLE_URL}/auth/device/code`（`client_id` + `supports_org_scope=true`）；轮询 `POST ${CONSOLE_URL}/auth/device/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）；未批准时 `400 authorization_pending`；成功返回 `access_token, refresh_token, expires_in, org_id`
- `:112` `Each refresh token can be used once. Reusing an old refresh token revokes the whole session.`
- `:132-135` 配置示例：`"baseURL": "https://opencode.ai/inference/openai/v1"`、`"apiKey": "{env:OPENCODE_CONSOLE_TOKEN}"`、`"headers": { "x-opencode-org-id": "org_..." }`

**`console/budgets.mdx`**

- `:55-62` 表：`Paid Console models | Yes`、`Web search | Yes`、**`Free models | No`**、**`Go usage within the plan | No`**、`Go extra usage paid from credits | Yes`
- `:66-71` `New requests fail with HTTP 429 until the budget resets or an admin raises it. The response does not say which budget was reached.` / `Upstream request failed: Account budget exceeded`

**`console/providers.mdx`**

- `:92` `Turn **Free models** off to block free models for the workspace.` ← 默认开启，可被 workspace 管理员关闭
- `:99-100` `Members run /connect and choose the workspace. Each enabled provider appears as the workspace name followed by the provider name, and /models lists its enabled models.`

**`console/billing.mdx`**

- `:54-58` `Paid requests fail with HTTP 402 once the balance reaches zero.` / `Upstream request failed: Insufficient account funds`
- `:83-84` `Turn on **Extra usage** on the **Overview** credits card to pay from credits once a Go limit is reached.`

**`console/index.mdx`**

- `:14` `[OpenCode Go and Go Plus](/console/go), $10 and $40 monthly subscriptions for open source model access`
- `:21-23` `1. Sign in to the Console. 2. Subscribe to Go, add credits, or connect a provider. 3. Run /connect in OpenCode and choose the workspace.`

### 5.4 live 页面核对（只读 GET，经 `--proxy http://127.0.0.1:7897`）

| URL | 状态 | 大小 | 关键串核对 |
|---|---|---|---|
| `https://opencode.ai/v2/docs/console/api/inference/` | **200** | 19,626 B | `Paid models require the header; free chat models can be called without it.` ✅ 命中 |
| `https://opencode.ai/v2/docs/console/api/` | **200** | 26,987 B | `Device flow`、`Inference only`、`authorization_pending`、`oc_sk_` ✅ |
| `https://opencode.ai/v2/docs/console/models/` | **200** | 55,656 B | `Free models` @16979、`limited time` @17042 ✅ |
| `https://opencode.ai/v2/docs/console/go/` | **200** | 55,169 B | `continue using the free models` @13804、`20% of the monthly limit` @4417、`Not available in Angola` @8672 ✅ |
| `https://opencode.ai/v2/docs/console/` | **200** | 10,531 B | — |
| `https://opencode.ai/docs/console/models/` | **404** | 104 B | 规范路径是 `/v2/docs/...`（`/docs/console/go/` 亦返回 200/55,169 B） |

> 存档：`07-原始证据\raw\live_v2_*.html` 与同名 `.txt`（去标签正文）。

---

## 6. Q5 — 官方是否公开了免费层的任何数值？

**结论：没有公开任何免费层数值。**

**检索证据（页面 + 关键词）**

- 页面集合：`services/www/src/docs/content/console/**` 全部 15 个 mdx（见 5.2），逐一通读。
- 关键词：`free` / `Free` / `limit` / `Limit` / `rate` / `quota` / `Quota` / `region` / `Region` / `requests` / `concurrency` / `window` / `per day` / `per month`。
- 结果：
  - **唯一带数值的限流**是 **Go / Go Plus 订阅**：月额度（美元）、`5-hour — 20% of the monthly limit; weekly — 50%; monthly — 100%`、按模型估算的 requests per 5h/week/month 表（`go.mdx:237-320`，官方标注为 estimate）。
  - **Console 付费层**只有余额/预算规则：`<$5` 自动充值 `$20`（`models.mdx:339`）、余额耗尽 `402`（`billing.mdx:54`）、预算超限 `429`（`budgets.mdx:66`）。
  - **免费模型**：无请求数、无 token 上限、无时间窗、无并发上限。`models.mdx:319-333` 的 13 条全部只写 `for a limited time`。
  - 免费模型**唯一**可量化的官方数值是 Go 表里的 `Unlimited`（`go.mdx:140,142,186,188,246,248,284,286`），而那是**订阅内**的额度，不是免费层额度。
- 交叉核对（task-4 结论，本轮沿用未重复抓取）：`https://opencode.ai/inference/v1/models` → **200**，86 个模型 id；`https://opencode.ai/inference/go/v1/models` → **200**，37 个模型。两者是**模型目录**，不含任何限额字段。

---

## 7. Q6 — 客户端外合法调用免费模型的官方方式

官方**明确承认存在**，且给了三条路径：

### 7.1 免费 chat 模型：**不需要任何凭证**

> `console/api/inference.mdx:21-22`：`Paid models require the header; free chat models can be called without it.`

端点（来自 `console/models.mdx:35-123` 的 Endpoint 列）：

| 免费模型 | 端点 | AI SDK |
|---|---|---|
| DeepSeek V4.1 Flash Free、Space Bunny Free、Cat Jam Free、LongCat 2.5 Preview Free、Exo Free、MiMo-V2.6-Flash Free、MiMo-V2.5 Free、Nemotron 3 Ultra Free、Nemotron 3.5 Lightning Free、Nemotron 3.5 Super VL Free | `https://opencode.ai/inference/openai/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| Muse Spark 1.3 Contributor Free | `https://opencode.ai/inference/openai/v1/responses` | `@ai-sdk/openai` |
| Jev 1.13 Free | `https://opencode.ai/inference/systemone/v1/systemone` | — |
| Big Pickle | `https://opencode.ai/inference/openai/v1/chat/completions` | `@ai-sdk/openai-compatible` |

目录端点：`GET https://opencode.ai/inference/v1/models`（`api/inference.mdx:41`）。

### 7.2 Service account key（付费模型必需，免费模型亦可用）

> `console/api/index.mdx:24-42`：`Open **Keys** and click **Add Service Account** … Open the service account and click **Add API Key** … Copy the key. It is shown only once.` → `oc_sk_1a2b3c4d5e6f_...` → `Authorization: Bearer oc_sk_...`

权限：`Inference only` 允许 Inference + Providers 请求与 `GET /api/v2/config`（`:46-49`）。

### 7.3 Go 订阅后拿 key

> `console/go.mdx:19`：`Sign in to the OpenCode Console, subscribe to Go or Go Plus, add your billing details, and copy your API key.`
> `go.mdx:409-410`：`To use Go in OpenCode, connect with /connect and set the model using the format opencode-go/<model-id>`
> `go.mdx:424`：`curl https://opencode.ai/inference/go/v1/models`

### 7.4 第三方 CLI 可用同一 device flow

> `console/api/index.mdx:75`：`OpenCode signs in with the OAuth device authorization grant (RFC 8628). **Other CLIs can use the same flow.**`

`POST https://opencode.ai/console/auth/device/code`（`client_id` + `supports_org_scope=true`）→ 轮询 `POST https://opencode.ai/console/auth/device/token`。

### 7.5 **重要限定（必须标为不确定/不支持）**

官方写的是「free chat models can be called **without it [the header]**」，**从未**写「without OpenCode」「from any client」。而 task-4 的实测显示：用 `curl` 直接 `POST` 免费模型、带 `Authorization: Bearer public` 时返回 **403 `FreeTierError`**；付费模型同路径返回 `Missing API key`。→ **文档的「无需 header」与实测并不矛盾（header 确实不需要），但「从任意客户端调用免费模型」官方未承诺、实测也不成立。** 详见第 8 章不确定项。

---

## 8. 「官方认可的正确用法」小节

1. **想用免费模型 → 什么都不用做。** OpenCode 未登录时自动把 opencode provider 置为 `activation: "enabled"`、注入 `apiKey: "public"`，并保留所有 `cost.input === 0` 的模型（`packages/core/src/plugin/provider/opencode.ts:337-345`、`:347-362`）。TUI 里直接 `/models` 选免费模型即可。**不需要** console 账号、**不需要**登录、**不需要** API key。
2. **想用 Console 付费模型 → 登录 + 拿 key。** `https://opencode.ai/console` → 加额度/绑卡 → 复制 API key（或建 service account）→ `/connect` 选 OpenCode pay-as-you-go provider → `/models`（`console/models.mdx:14-21`）。
3. **想用 Go / Go Plus → 订阅 + 拿 key。** console 订阅 `$10`/`$40` → 复制 API key → `/connect` 选 **OpenCode Go** → `/models`；配置文件写 `"model": "opencode-go/<model-id>"`（`console/go.mdx:19-30`、`:409-417`）。注意 Go/Go Plus 仅限单成员 workspace（`go.mdx:32-35`）。
4. **Go 额度用尽时 → 免费模型仍可用。** 官方明写：`If you reach the usage limit, you can continue using the free models.`（`go.mdx:344`）。这也是客户端 `account_rate_limit`（「Go limit reached」）弹窗**不**引导订阅的原因。
5. **第三方客户端 → 官方允许，但有行为要求。** 发典型 coding agent 流量；用**自己的** UA（如 `my-coding-agent/1.0`），不要用通用 SDK/HTTP 库名；每会话发稳定 `x-opencode-session`（`go.mdx:76-86`）。官方维护 validated / problematic 客户端清单（`go.mdx:88-113`）。
6. **团队管理 → 可整体封锁免费模型。** console 的 Models 页 `Turn **Free models** off to block free models for the workspace.`（`console/providers.mdx:92`）。免费模型不计入预算（`console/budgets.mdx:60`）。
7. **设备流对外可用。** `console/api/index.mdx:75`：其他 CLI 可用同一 RFC 8628 设备流。
8. **不要尝试绕门禁。** 官方对 Go 流量明写「Traffic is monitored for abuse that degrades the experience for other users」（`go.mdx:77-78`），并对 free tier 设了内部告警（`infra/monitoring.ts:260-287`）。本轮**未做任何绕过尝试**，仅做只读 GET。

---

## 9. 官方明写 / 仅代码推断 / 未找到 / 不确定项

### 9.1 官方**明写**（有 URL 或仓库路径:行号）

| 事实 | 出处 |
|---|---|
| 免费 chat 模型可**不带** `Authorization` 调用 | `console/api/inference.mdx:21-22`（live 已核） |
| Go 额度用尽后仍可继续用免费模型 | `console/go.mdx:344`（live 已核） |
| 免费模型共 13 个，全部 "for a limited time" | `console/models.mdx:319-333`（live 已核） |
| Cat Jam Free 地区封锁名单 | `console/models.mdx:330`、`console/go.mdx:225` |
| Go $10/月、Go Plus $40/月；5h=20% / 周=50% / 月=100% | `console/go.mdx:8-11`、`:121-122`（live 已核） |
| 免费模型不计入 workspace 预算 | `console/budgets.mdx:55-62` |
| workspace 可整体关闭免费模型 | `console/providers.mdx:92` |
| service account key 格式 `oc_sk_...` 与 `Inference only` 权限 | `console/api/index.mdx:24-49` |
| 设备流 RFC 8628，`expires_in=600`、`interval=5`，其他 CLI 可用 | `console/api/index.mdx:73-112` |
| 余额耗尽 `402`、预算超限 `429`、余额 <$5 自动充值 $20 | `console/billing.mdx:54`、`console/budgets.mdx:66`、`console/models.mdx:339` |
| Console **读 User-Agent** 识别是哪个 OpenCode | `packages/core/src/plugin/provider/opencode.ts:189-190`（官方代码注释） |
| `public` **不是** API key；无凭证请求应不带凭证到达 inference | `packages/console/app/src/lib/inference-proxy.ts:41` |
| 新 inference **拥有** auth / 模型可用性 / **free-tier access** / 计费 | `packages/console/app/src/lib/inference-proxy.ts:17` |

### 9.2 仅**代码推断**（公开仓库有实现，但官方文档未明写）

| 推断 | 依据 |
|---|---|
| 未登录时注入 `apiKey: "public"` 并启用 provider | `opencode.ts:337-345` + 官方测试 `provider-opencode.test.ts:1770-1788` |
| 未登录时按 `cost.input > 0` 本地禁用付费模型 | `opencode.ts:347-362`（判据只取 `input`） |
| 边缘层把 `public`/无 key 统一当匿名并删除凭证头 | `inference-proxy.ts:42-44` |
| `hasKey` 三个来源：`OPENCODE_API_KEY` / Console 连接 / settings.apiKey | `opencode.ts:339`、`:350-353` |
| UA 是免费层/Go 层的归因维度 | `infra/monitoring.ts:45`、`:91`、`:136`、`:268` 与 `isGoTier`/`isFreeTier` 并列 |
| 客户端自证头集合 | `packages/core/src/session/model-request.ts:283-291` |
| 免费层门禁实现在**仓库外**的 `opencode-inference-{stage}` Worker | `infra/console.ts:76`（仅 service binding 引用）+ `sst.config.ts` 无该 Worker 定义 + `inference-proxy.ts:17` 注释 |

### 9.3 明确**未找到**（0 命中，未猜测）

| 串 / 事实 | 结果 |
|---|---|
| `FreeTierError` | 全仓库 0 命中；官方文档 0 命中 |
| `free tier can only be used from within OpenCode` | 全仓库 0 命中；官方文档 0 命中 |
| `can only be used from within OpenCode` / `within OpenCode` | 0 命中 |
| `Missing API key` | 0 命中 |
| `x-opencode-signature` | 0 命中 → **请求侧无签名机制** |
| `free_tier_limit` / `account_rate_limit` 的**生产者** | 公开仓库不存在；只有消费端 `packages/app/src/session/usage-exceeded-dialogs.tsx` |
| 匿名/游客/trial 注册路径 | 0 命中（`guest`/`trial` 命中均无关） |
| 免费层的请求数 / token / 时间窗 / 并发数值 | 官方文档与公开仓库**均无** |
| TLS/JA3/JA4 指纹判定的任何证据 | 0 命中 |

### 9.4 不确定项（明确标注，不作断言）

1. **服务端「within OpenCode」的具体判据**——UA？`x-opencode-*` 头？IP？组合？**公开仓库无法证明**。仅有候选维度（第 4.4 节）。
2. **`/inference/*` 的路由归属**——公开仓库只登记 `/zen/*`（`inference-proxy.ts:3-15` + `routes/zen/**` 12 个薄壳），`routes/` 下无 `inference/` 目录。因此 `/inference/*` 不经该边缘层，但公开仓库无法解释它如何落到 inference worker。
3. **路径命名差异**——官方文档写 `/inference/openai/v1/chat/completions`、`/inference/v1/models`（`api/inference.mdx:30-42`），而 task-4/03 实测用的是 `/inference/v1/chat/completions` 并拿到 `FreeTierError`（非 404）。→ 该路径是 inference worker 的合法路由，但**公开仓库无对应代码**，本报告不对其语义下结论。
4. **UA 格式差异（可能影响判定复现）**——上游真实 UA 是 `opencode/${channel}/${version}/${name}`（`packages/core/src/app.ts:24-26`，例 `opencode/prod/1.19.2/opencode`），而侦察时用的是 `opencode/1.19.2`（少 channel 与 name 两段）。这**可能**是 UA 类判定未通过的原因之一，但**未验证**；本报告不建议再尝试。
5. **`x-opencode-request-id`**——边缘会转发它（`inference-proxy.ts:47-48`），但公开仓库**没有任何代码生成它**（客户端 0 命中）。它来自何处（客户端版本差异？Cloudflare？）未知。
6. **`/zen/*` 与 `/inference/*` 是否为同一后端**——`paths` 表把 `/zen/v1/*` 映射到 `/openai/v1/*`、`/go/openai/v1/*` 等**去掉 `zen` 段**的路径，与 `/inference/*` 的命名一致；但两者是否共用同一 worker，公开仓库无法确认。
7. **本报告未重复执行任何模型调用**：task-4/03 的 403 实测结果直接引用，本轮只做只读 GET（官方文档页）与本地文件检索。

---

## 10. URL 清单

**官方文档（canonical `/v2/docs/...`）**

- [Console API — Inference](https://opencode.ai/v2/docs/console/api/inference/) ← **「free chat models can be called without it」** 出处
- [Console API — Overview](https://opencode.ai/v2/docs/console/api/) ← service account、device flow、`/api/v2/config`
- [Console — Models](https://opencode.ai/v2/docs/console/models/) ← 13 个免费模型、价格表、地区限制
- [Console — Go](https://opencode.ai/v2/docs/console/go/) ← $10/$40、5h/week/month、免费模型 Unlimited、validated clients
- [Console — Intro](https://opencode.ai/v2/docs/console/)
- [Console — Billing](https://opencode.ai/v2/docs/console/billing/)（live 未抓，本地源 `services/www/src/docs/content/console/billing.mdx`）
- [Console — Budgets](https://opencode.ai/v2/docs/console/budgets/)（同上，本地源 `console/budgets.mdx:55-62`）
- [Console — Providers](https://opencode.ai/v2/docs/console/providers/)（同上，本地源 `console/providers.mdx:92`）
- [Docs 首页](https://opencode.ai/docs/)（task-4 抓取：200 / 99,209 B）
- [旧路径 /docs/console/models/](https://opencode.ai/docs/console/models/) → **404**（非规范路径）

**端点（只读核验）**

- `https://opencode.ai/inference/v1/models` — 200，86 个模型 id（模型目录，非门禁）
- `https://opencode.ai/inference/go/v1/models` — 200，37 个模型
- `https://opencode.ai/inference/openai/v1/chat/completions` — 免费模型官方端点（`api/inference.mdx:32`）
- `https://opencode.ai/inference/openai/v1/responses`、`https://opencode.ai/inference/anthropic/v1/messages`、`https://opencode.ai/inference/google/v1beta/models/<model>:generateContent`
- `https://opencode.ai/inference/systemone/v1/systemone` — Jev 模型
- `https://opencode.ai/console/api/v2/config` — workspace 配置
- `https://opencode.ai/console/auth/device/code`、`https://opencode.ai/console/auth/device/token` — RFC 8628 设备流
- `https://opencode.ai/console/api/user`、`https://opencode.ai/console/api/orgs` — 登录后账号信息
- `https://opencode.ai/console/api/websearch` — Web Search
- `https://opencode.ai/console/auth/sso/<connectionId>/start?redirectTo=`

**上游仓库**

- [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode)（`sst/opencode` 301 到此，`default_branch = dev`，id `975734319`）
- [tarball（dev）](https://codeload.github.com/anomalyco/opencode/tar.gz/refs/heads/dev)
- [issues/PR 引用示例](https://github.com/anomalyco/opencode/pull/55680)（CHANGELOG `:24` 提到的 protocol-specific inference endpoints）

**第三方引用（官方文档内的外链）**

- [Meta Geographic Use Policy](https://ai.developer.meta.com/legal/geographic-use-policy)
- [Meta contributor tier 定价/限流](https://dev.meta.ai/docs/pricing-rate-limits#contributor-tier)
- [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)
- [RFC 8628（OAuth 2.0 Device Authorization Grant）](https://datatracker.ietf.org/doc/html/rfc8628)

---

## 附录 A — 上游关键文件与行号索引

| 文件 | 关键行 | 内容 |
|---|---|---|
| `packages/core/src/plugin/provider/opencode.ts` | `:20-22` | `defaultServer` / `clientID = "opencode-cli"` / `methodID = "device"` |
| 同上 | `:59-75` | `Device` / `Token` / `TokenPending` / `DeviceToken` / `User` / `Org` schema |
| 同上 | `:105-182` | `oauth()`：device code、refresh、label |
| 同上 | `:189-191` | **Console 读 UA 识别 OpenCode**（官方注释） |
| 同上 | `:255-261` | 注册 device OAuth + `key`（service account）两种 method |
| 同上 | `:265-335` | Console `/api/v2/config` → provider/model/cost/limit/enabled 注入 |
| 同上 | `:337-346` | **`apiKey: "public"` 注入条件** |
| 同上 | `:347-362` | **按 `cost.input > 0` 本地禁用付费模型** |
| 同上 | `:364-420` | Web Search（`/api/websearch` + bearer + `x-org-id`） |
| 同上 | `:489-521` | `fetchConfig()` → `GET /api/v2/config`（404/401/403 语义） |
| 同上 | `:552-558` | `credentialHeaders()`：`authorization` + `x-org-id` |
| 同上 | `:584-607` | `poll()` device token 轮询（`authorization_pending` / `slow_down`） |
| 同上 | `:609-640` | `credential()` → `/api/user` + `/api/orgs` |
| `packages/core/src/session/model-request.ts` | `:283-291` | 客户端自证头集合（9 个） |
| `packages/core/src/app.ts` | `:24-26` | `useragent() = opencode/${channel}/${version}/${name}` |
| `packages/core/src/generate.ts` | `:70` | 会话标题请求注入 `x-opencode-session` |
| `packages/core/test/plugin/provider-opencode.test.ts` | `:1752-1806` | 三个「无凭证」测试（public key / free 保留 / output-only） |
| `packages/console/app/src/lib/inference-proxy.ts` | `:3-15` | `/zen/*` → 新 inference 路径映射表 |
| 同上 | `:17` | **官方自认：新 inference 拥有 free-tier access** |
| 同上 | `:41-48` | `public` 当匿名、删凭证头、补 `x-real-ip` / `x-opencode-request-id` |
| `packages/console/app/src/routes/zen/**` | 12 文件 | 191–346 B 薄壳，全部 `proxyInference(input.request)` |
| `packages/console/app/src/middleware.ts` | 全文 27 行 | 仅 `/auth`、`/workspace` 重定向；无 `/inference` 处理 |
| `packages/ai/src/provider-error.ts` | `:119-127` | `QUOTA_CODES` 含 `gousagelimiterror` / `freeusagelimiterror` |
| `packages/app/src/session/usage-exceeded-dialogs.tsx` | `:19`、`:21`、`:45`、`:52`、`:116-151` | `GO_UPSELL_WINDOW = 86_400_000`、`GO_UPSELL_PROVIDERS`、两个 reason 的消费端分支 |
| `infra/console.ts` | `:8-13`、`:72-77` | `ConsoleMigration.inferenceUrl`；INFERENCE service binding `opencode-inference-${stage}` |
| `infra/monitoring.ts` | `:45`、`:46`、`:59-60`、`:137`、`:260-287` | UA contains "opencode"；`isGoTier`；两个 UsageLimit 错误；`isFreeTier` 告警阈值 50 |
| `services/www/src/docs/content/console/api/inference.mdx` | `:21-22`、`:46` | 免费模型免 header；免费模型走 Chat Completions |
| `services/www/src/docs/content/console/api/index.mdx` | `:19-22`、`:24-49`、`:73-112`、`:132-135` | 端点表、service account、device flow、config 示例 |
| `services/www/src/docs/content/console/models.mdx` | `:14-15`、`:195`、`:205-217`、`:319-333`、`:330`、`:339` | `/connect` 流程、13 免费模型、价格、地区限制、自动充值 |
| `services/www/src/docs/content/console/go.mdx` | `:8-11`、`:19-20`、`:52-62`、`:76-113`、`:117-124`、`:140-142`、`:186-188`、`:223-225`、`:246-248`、`:284-286`、`:344`、`:409-424` | 定价、步骤、地区、客户端要求、额度、Unlimited、**免费模型兜底** |
| `services/www/src/docs/content/console/budgets.mdx` | `:55-62`、`:66-71` | 免费模型不计预算；429 语义 |
| `services/www/src/docs/content/console/providers.mdx` | `:92`、`:99-100` | 可关闭免费模型；`/connect` + `/models` |
| `services/www/src/docs/content/console/billing.mdx` | `:54-58`、`:83-84` | 402 余额耗尽；Go 超额用 credits |
| `services/www/src/docs/lib/navigation.ts` | `:131-161` | Console 文档导航（证明没有「免费模型使用」页） |

## 附录 B — 本轮抓取产物

| 路径 | 内容 |
|---|---|
| `07-原始证据\raw\tree.json` | GitHub tree 快照（`truncated=false`，9492 entries） |
| `07-原始证据\raw\live_v2_api_inference_.html` / `.txt` | `/v2/docs/console/api/inference/` 原始 HTML 与去标签正文 |
| `07-原始证据\raw\live_v2_api_.html` / `.txt` | `/v2/docs/console/api/` |
| `07-原始证据\raw\live_v2_models_.html` / `.txt` | `/v2/docs/console/models/` |
| `07-原始证据\raw\live_v2_go_.html` / `.txt` | `/v2/docs/console/go/` |
| `07-原始证据\raw\live_v2_console_index.html` | `/v2/docs/console/` |
| `07-原始证据\raw\live_go_.html` / `.txt` | `/docs/console/go/`（非规范路径，200，同 55,169 B） |
| `08-上游源码快照\opencode-dev\` | 上游 dev 分支全量解包（8,547 文件） |

---

*报告结束。所有结论均标注来源（URL 或 `仓库路径:行号`）；「官方明写」「仅代码推断」「未找到」「不确定」四类严格分列，见第 9 章。*
