# task-5 · OpenCode Desktop 免费调用请求链正向还原

- 分析对象（只读，未修改）：`99-解包产物与运行时残留\OpenCode-Desktop-1.19.2-解包\out\main\chunks\node-ibnNxpSl.js`（665066 行，约 38 MB，下文所有 `:NNNNN` 均指该文件行号）
- 渲染层参考：`99-解包产物与运行时残留\OpenCode-Desktop-1.19.2-解包\out\renderer\assets\main-C07s90t2.js`
- 运行时数据：`%USERPROFILE%\.cache\opencode\models.json`、`%USERPROFILE%\.local\share\opencode\auth.json`
- 标记约定：**【证实】**= 有逐字代码证据；**【推断】**= 由证据合理外推，未直接观测；**【未证实】**= 无法从客户端产物判定
- 本次为纯静态分析，**未对 opencode.ai 发起任何写操作，未重启/未杀 OpenCode.exe**

---

## 0. 结论先行：「客户端比外部 curl 多了什么」

按「最可能解释 Lead 实测差异」排序：

| # | 客户端额外携带的东西 | 证据 | 强度 |
|---|---|---|---|
| 1 | **凭证可能是真实 OAuth access_token，而不是 `public`** —— 走 v2 `SessionRunnerModel.resolve` 路径时，集成连接（integration connection）解析出的凭据会被塞进 `bearer(credential.access)`；该凭据存在 `opencode.db` 的 `CredentialTable`，**不在 auth.json**，所以只看 auth.json 会误判为「未登录 → public」 | `:340566-340573`、`:340602-340609`、`:340672-340684`、`:61560-61624` | 强（代码证实两条路径并存；本机实际走哪条未证实） |
| 2 | **`User-Agent: opencode/1.19.2`**（精确字符串，无 channel、无 client 后缀），curl 一般不会带 | `:440941`、`:441035`、`:441039`、`:45655` | 强 |
| 3 | **6 个 `x-opencode-*` 头 + 1 个 `x-parent-session-id`**，其中 `x-opencode-project` / `x-opencode-request` 是**本地身份值**（项目 id / 本地 user id），不是任意字符串 | `:441020`、`:441027-441044` | 强 |
| 4 | **`stream: true` + `stream_options: {include_usage: true}`**（includeUsage 被强制打开） | `:328462`、`:325972`、`:656125-656127` | 强 |
| 5 | **请求体不含 `apiKey`**（被 `withDefaults` 剔除），认证只在头里 | `:340574-340583` | 强 |
| 6 | **`Authorization: Bearer <key>`** 形态（openai-compatible 分支），不是 `x-api-key` | `:340602-340609`、`:243223` | 强 |
| 7 | 无签名 / 无 HMAC / 无 nonce / 无时间戳 / 无设备指纹 | `x-opencode-signature` 0 命中；`createHmac` 8 处全来自 jwa/jws/oidc | 强 |

**即：客户端与 curl 的差异不在密码学，而在「身份载体」与「精确的 HTTP 形状」。** 若 Lead 的 curl 用的是 `Bearer public`，那么最可能的解释是：**桌面端实际不是 `public`，而是 `opencode.db` 里的 OAuth access_token**（或桌面端虽为 public，但服务端依据 `x-opencode-project` / `x-opencode-request` 判断该请求不属于任何已注册工作区而拒绝）。这两点都需要 runtime-proof 用抓包/查库确认。

---

## 1. 问题 1：`apiKey = "public"` 如何进入真实 HTTP 请求

### 1.1 `"public"` 的精确出现点（全 bundle 10 处，只有 2 处与 apiKey 有关）

- `:313636` **【证实】** 唯一赋值处：
  ```js
  provider9.request.body.apiKey = "public";
  ```
- `:654816` **【证实】** SDK 加载器对象字面量：
  ```js
  options: ok2 ? {} : { apiKey: "public" }
  ```
- 其余 8 处与主题无关：`:45771`（SQL `${table[TableSchema] ?? "public"}.${table[TableName]}`）、`:106652`（`type: [null, "restricted", "public"]`）、`:492332`/`:500984`/`:517915`/`:613463`（语言服务/枚举）、`:581963`/`:583212`（TS 编译器 `publicMemberModifier`）。

> 注：Lead 用正则 `apiKey:\s*"public"` 得到 0 命中，是因为这两处分别是**赋值语句**和**对象字面量**（`{ apiKey: "public" }` 中间是 `: ` 但 `"public"` 前有空格，且 `:313636` 用的是 `=`）。精确定位后命中 2 处，无第三处。

### 1.2 `public` 被写入的两条互斥路径

**路径 A（v1 目录插件，OpencodePlugin）** `:313630-313646`
```js
const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || item2.provider.request.body.apiKey);
...
provider9.request.body.apiKey = "public";     // :313636 无 key 时
```
- `connected` 来自 `ctx.integration.connection.active("opencode")`（`:313559-313564`、`:313572`），即「是否已连接 OpenCode Console 集成」。

**路径 B（SDK 自定义加载器 `custom4(dep).opencode`）** `:654799-654817`
```js
const ok2 = hasKey || Boolean(yield* dep.auth(input.id)) || Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey);
...
options: ok2 ? {} : { apiKey: "public" }      // :654816
```
- `dep.auth("opencode")` 读 `auth.json` 的 `opencode` 条目（`Auth` 服务 `:45444-45499`，file = `Path3.data/auth.json`，`:45454`）。

### 1.3 从 body 到 HTTP 头的精确链路 **【证实】**

**(a) apiKey 提取** `:340566-340573`
```js
apiKey = (model8, credential4) => {
  if (credential4?.type === "key")   return value3(credential4.key);
  if (credential4?.type === "oauth") return value3(credential4.access);   // ← OAuth 走这里
  const value4 = model8.request.body.apiKey ?? model8.api.settings?.apiKey;
  if (typeof value4 === "string") return value3(value4);                   // ← "public" 走这里
}
```

**(b) apiKey 从 HTTP body 中被剔除** `:340574-340583`
```js
withDefaults = (model8, route10) => {
  const body22 = model8.request.body;
  const httpBody = Object.hasOwn(body22, "apiKey")
    ? Object.fromEntries(Object.entries(body22).filter(([key2]) => key2 !== "apiKey"))
    : body22;
  return route10.with({
    provider: model8.providerID,
    endpoint: model8.api.url === void 0 ? void 0 : { baseURL: model8.api.url },
    headers: model8.request.headers,
    http: { body: httpBody },
    limits: { context: model8.limit.context, output: model8.limit.output }
  });
}
```
→ **`apiKey` 永远不会出现在 JSON body 里**，只作为认证凭据。

**(c) 认证方式选择** `:340601-340609`
```js
const key2 = apiKey(resolved, credential4);
if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai")
  return succeed7(withDefaults(resolved, route5).with({ auth: key2 === void 0 ? none3 : bearer(key2) })...);
if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic")
  return succeed7(withDefaults(resolved, route2).with({ auth: key2 === void 0 ? none3 : header("x-api-key", key2) })...);
if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url)
  return succeed7(withDefaults(resolved, route4).with({ auth: key2 === void 0 ? none3 : bearer(key2) })...);
```
→ `opencode` / `opencode-go` 的 npm 是 `@ai-sdk/openai-compatible`（见 §3），**命中第三分支 → `Authorization: Bearer <key2>`**。

**(d) SDK 侧真正落地** `:243219-243226`（另有同款拷贝 `:253569`）
```js
function createOpenAICompatible(options2) {
  ...
  ...options2.apiKey && { Authorization: `Bearer ${options2.apiKey}` },
```
- `:656148-656149` 决定 `options2.apiKey`：
  ```js
  if (options2["apiKey"] === void 0 && provider9.key) options2["apiKey"] = provider9.key;
  ```
- 而 `provider9.key` **只对 `type === "api"` 的凭据赋值** `:655998-656009`：
  ```js
  if (provider9.type === "api") {
    mergeProvider(providerID2, { source: "api", key: provider9.key });
  }
  ```
  → **OAuth 凭据不会产生 `provider9.key`**。在 v1 `Provider` 路径下，OAuth 登录的 opencode 请求 `options.apiKey` 会是 `undefined`（`ok2=true` → options `{}`），即**没有 Authorization 头**。这是本报告最重要的结构性发现之一（见 §7 风险）。

### 1.4 最终请求形态 **【证实】**

- URL：`{api}/chat/completions`，`api` 来自 provider 快照（§3）→ `https://opencode.ai/inference/v1/chat/completions`
  证据：`:328462` `url: this.config.url({path: "/chat/completions", modelId: this.modelId})`
- 头：`Authorization: Bearer <public | access_token>`、`User-Agent: opencode/1.19.2`、6 个 `x-opencode-*`、`Content-Type: application/json`
- 体：OpenAI 兼容 chat completions，`stream: true`、`stream_options: { include_usage: true }`、`model: "<目录 id>"`

---

## 2. 问题 2：是否存在非 `public` 的免费身份来源

### 2a. OAuth 设备流（完整字段与端点）**【证实】** `:313396-313518`

| 步骤 | 方法/端点 | 请求体 | 响应 schema |
|---|---|---|---|
| authorize | `POST https://opencode.ai/console/auth/device/code` | `{ client_id: "opencode-cli" }` | `Device = { device_code, user_code, verification_uri_complete, expires_in, interval }` `:313535-313541` |
| poll | `POST https://opencode.ai/console/auth/device/token` | `{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id }` | `DeviceToken2 = Union2([Token, TokenPending])` `:313547-313548` |
| refresh | `POST https://opencode.ai/console/auth/device/token` | `{ grant_type: "refresh_token", refresh_token, client_id }` | `Token = { access_token, refresh_token, expires_in }` `:313542-313546` |
| user | `GET https://opencode.ai/console/api/user` | bearer | `User4 = { id, email }` `:313549` |
| orgs | `GET https://opencode.ai/console/api/orgs` | bearer | `ArraySchema(Org2)`，`Org2 = { id, name }` `:313550` |
| config | `GET https://opencode.ai/console/api/config` | bearer + 可选 `x-org-id` | `RemoteResponse = Struct({ config: Info28 })` `:313534` |

- 常量 `:313520`：`defaultServer = "https://opencode.ai/console"`, `clientID2 = "opencode-cli"`；`:313533` `methodID = MethodID2.make("device")`
- 生成的凭据 `:313491-313512`：
  ```js
  OAuth2.make({
    type: "oauth", methodID,
    access: token.access_token, refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1e3,
    metadata: { server, accountID: user.id, email: user.email, orgID: org?.id, orgName: org?.name }
  })
  ```
- 轮询容错 `:313472-313490`：`authorization_pending` 继续、`slow_down` 加 5s、其他错误 fail
- 授权模式 `mode: "auto"`，提示文案 `` `Enter code: ${device.user_code}` ``

**判定：desktop 免费调用是否依赖这条设备流取得的 access_token？**
→ **【推断】取决于走哪条请求路径**，客户端里**两条路径并存**：

1. **v1 `LLM.run` 路径（`:441091-441114`）**：`auth10.get(providerID)` 取 `auth.json`，再 `prepare3` 组装头。`auth.json` 的 `opencode` 条目若为 `type:"oauth"`，`prepare3` 只把它用于 `isOpenaiOauth`（`:440943` 硬编码 `provider.id === "openai"`）**不用于 opencode**；而 `resolveSDK` 的 `provider9.key` 只认 `type:"api"` → **该路径下 OAuth token 不会进入 Authorization**。
2. **v2 `SessionRunnerModel.resolve` 路径（`:340668-340687`）**：
   ```js
   const connection = yield* integrations.connection.active(provider9?.integrationID ?? ID16.make(selected.providerID));
   return yield* resolve14(session, selected, connection ? yield* integrations.connection.resolve(connection) : void 0);
   ```
   → `resolve14` 内部即 `fromCatalogModel`（`:340597`），`credential4.type === "oauth"` → `bearer(credential4.access)`。**该路径下 OAuth access_token 会作为 `Authorization: Bearer` 发出。**

### 2b. 匿名设备注册 / guest / trial 端点
**【证实】不存在。** bundle 内 `opencode.ai` 全部 38 处命中已逐一分类（见 §3），除 §2a 的设备流/`api/*` 与 `models.opencode.ai`、`app.opencode.ai`、`install` 文档链接外，无 register/guest/trial/anonymous 端点。`grep entitlement|quota|subscription` 的命中全部来自第三方 SDK（google-auth、openai 兼容层）与 Effect PubSub 的 `subscription` 变量名，**与 opencode 额度无关**。

### 2c. `/console/api/config` 是否下发 apiKey / token / entitlement
**【证实】不下发 apiKey。** `:313437-313447`：
```js
const token = value4.type === "oauth" ? value4.access : value4.key;
return http5.execute(get15(`${server2}/api/config`).pipe(acceptJson, bearerToken(token), setHeaders(orgID ? { "x-org-id": orgID } : {})))
```
返回 `remote.config.provider`，在 `:313573-313581` 被应用：
```js
provider9.api = item3.npm ? { type: "aisdk", package: item3.npm, url: item3.api } : { type: "native", url: item3.api, settings: {} };
Object.assign(provider9.request.headers, item3.options?.headers);
Object.assign(provider9.request.body, withoutCredentials(item3.options));
```
- `withoutCredentials`（`:313448-313450`）**显式过滤掉 `apiKey` 与 `headers`**：
  ```js
  Object.fromEntries(Object.entries(body22 ?? {}).filter(([key2]) => key2 !== "apiKey" && key2 !== "headers"))
  ```
- 逐模型覆写（`:313583-313628`）会下发 `config6.status`、`config6.cost`、`config6.limit`、`config6.tool_call`、`config6.headers`、`config6.options`、`config6.provider.{npm,api}`、`variants`。
→ **`/api/config` 可以远程改写 baseURL、headers、模型开关与成本，但不携带 apiKey，也不含 entitlement/额度字段。**

### 2d. auth.json 之外的凭证存储 **【证实】存在**
- v1：`%USERPROFILE%\.local\share\opencode\auth.json`（`Auth` 服务 `:45444-45499`，路径 `:45454`；另有 `:248078`、`:269456-269461`、`:417108-417113`、`:420955-420960`）
  - **本机实况（只读）**：18 行，仅 4 个 `type:"api"` 条目 `asaf` / `cline-pass` / `workbuddy` / `tokenharhur`，**没有 `opencode` 条目**
- v2：`Service18 = "@opencode/v2/Credential"`（`:61560-61624`），`Info16 = { id, integrationID, label, value }`，持久化在 **SQLite `CredentialTable`**（列 `integration_id` / `label` / `value`，`:61590`、`:61607`）→ 即 `%USERPROFILE%\.local\share\opencode\opencode.db`
- **OAuth 设备流产生的 `OAuth2.make(...)` 正是 v2 `Credential`** → 落库位置是 `opencode.db`，**不是 auth.json**。
- `Auth.all4` 还支持 `process.env.OPENCODE_AUTH_CONTENT` 覆盖（`:45444-45499`）

> **这是「客户端比 curl 多了什么」的最有力候选**：如果本机已用 OpenCode Console 账号登录过，token 在 `opencode.db` 里，而 `auth.json` 里看不到，外部观察者会误以为客户端在用 `public`。

---

## 3. 问题 3：免费 / 付费 / Go 档的 baseURL 与路由差异

### 3.1 baseURL 不在 bundle 里，来自远端快照
- 快照来源 `:169208`：`Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"`；缓存 `:169209` `Path3.cache + "models.json"`
- `grep inference/v1` 在 bundle 内只命中 fireworks（`:242614`、`:428641`、`:645960`）与快照行 `:169228`、zenmux 判断 `:335776`
- 解析 `%USERPROFILE%\.cache\opencode\models.json`（脚本 `07-原始证据\data\q5.js`、`q6.js`）**【证实】**：

| provider | npm | api（baseURL） | models | 其它字段 |
|---|---|---|---|---|
| `opencode` | `@ai-sdk/openai-compatible` | `https://opencode.ai/inference/v1` | 124 | `env:["OPENCODE_API_KEY"]`, `name:"OpenCode"`, `doc:"https://opencode.ai/v2/docs/console/models/"`，**无 options / 无 headers** |
| `opencode-go` | `@ai-sdk/openai-compatible` | `https://opencode.ai/inference/go/v1` | 31 | `env:["OPENCODE_API_KEY"]`, `name:"OpenCode Go"`, `doc:".../console/go/"` |

### 3.2 差异结论
- **免费档 vs 付费档：同一 provider、同一 baseURL、同一路径 `/chat/completions`，无按 cost 切换 baseURL 的代码。** 差异只体现在**模型是否 `enabled`**（`:313640-313646` 把 `cost.input > 0` 的模型置 `draft.enabled = false`）。
- **Go 档是独立 provider**（`opencode-go`，baseURL 多一段 `/go`），不是同 provider 的开关。
- 未发现 `zen` 路径前缀（`/zen` 无命中）。
- `x-opencode-client` 的取值集合**不是枚举**，来自运行时 env（§5.4）。

---

## 4. 问题 4：是否存在客户端签名 / 指纹

**【证实】不存在。**
- `x-opencode-signature`：全 ocdesk **0 命中**
- `createHmac`：8 处，全部来自 npm 包（jwa / jws / oidc / ssh2），与请求构造无关
- `machineId` / `machine_id` / `installationId` / `fingerprint`（请求语境）：**0 命中**（`fingerprint` 命中集中在 SSH 指纹 `:366218-366247` 与 `system_fingerprint` 字段透传 `:263824`、`:330144`）
- `nonce` / `timestamp` 签名：无请求签名语境命中
- `InstallationVersion = "1.19.2"`, `InstallationChannel = "prod"`, `InstallationLocal`（`:45655-45657`）→ 仅用于 UA 与版本字段（`:157181`）

→ **客户端比 curl 多出来的东西是「身份头 + 精确 UA + 流式参数」，不是密码学签名。**

---

## 5. 问题 5：`x-opencode-*` 三值的来源与生成逻辑

### 5.1 全部构造点（`:441020-441044`）**【证实】**
```js
:441020  const opencodeProjectID = input.model.providerID.startsWith("opencode") ? (yield* context4).project.id : void 0;
...
:441027  const headers2 = {
:441028    "x-opencode-session-id": input.sessionID,
:441029    ...input.parentSessionID ? { "x-opencode-parent-session-id": input.parentSessionID } : {},
:441031    ...opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {},
:441032    ...(input.model.providerID.startsWith("opencode") ? {
:441033      "x-opencode-session": input.sessionID,
:441034      "x-opencode-request": input.user.id,
:441035      "x-opencode-client": input.flags.client,
:441036      "User-Agent": USER_AGENT2
:441037    } : {
:441038      "x-session-affinity": ...,
:441039      "X-Session-Id": ...,
:441040      "User-Agent": USER_AGENT2,
:441041      "x-parent-session-id": ...
:441042    }),
:441043    ...headers7            // 插件 chat.headers 注入
:441044  };
```

| 头 | 值来源 | 生成逻辑 |
|---|---|---|
| `x-opencode-session-id` | `input.sessionID` | 会话 id，**总是发送**（不限 provider） |
| `x-opencode-parent-session-id` | `input.parentSessionID` | 子会话才有 |
| `x-opencode-project` | `(yield* context4).project.id` | **本地项目 id**，仅 `providerID.startsWith("opencode")` |
| `x-opencode-session` | `input.sessionID` | 同上，与 `x-opencode-session-id` 同值 |
| `x-opencode-request` | `input.user.id` | **本地 user id**（`:441033`） |
| `x-opencode-client` | `input.flags.client` | `OPENCODE_CLIENT` env，默认 `"cli"` |
| `User-Agent` | `USER_AGENT2` | `` `opencode/${InstallationVersion}` `` = **`opencode/1.19.2`** |

### 5.2 `x-opencode-project` / `x-opencode-request` 是本地身份值
- `input.user.id` 由调用方（`LLM.run` 的 `input.user`）传入；客户端**没有**把 accountID / orgID 放进请求头（那些只在 `fetchProviders` 的 `x-org-id` 里出现，`:313442`）。
- 服务端是否校验这两个值：**【未证实】**。客户端侧无任何校验/回填逻辑，也无可观测的失败分支。

### 5.3 `USER_AGENT2`（`:440941`）
```js
var USER_AGENT2 = `opencode/${InstallationVersion}`;   // = "opencode/1.19.2"
```
注意与 `:169112` 的 `USER_AGENT = \`opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}\`` 是**两个不同的常量**；LLM 请求用的是 `USER_AGENT2`。

### 5.4 `x-opencode-client` 的确切取值集合
- `flags.client` 定义 `:383744`：`client: string3("OPENCODE_CLIENT").pipe(withDefault2("cli"))`
- `Flag.OPENCODE_CLIENT`（`:30822-30823`）：`return process.env["OPENCODE_CLIENT"] ?? "cli";`
- `grep OPENCODE_CLIENT` 全 ocdesk **仅 5 处**（`:30822`、`:30823`、`:95020`、`:169112`、`:383744`），**打包产物里没有硬编码 `"desktop"` 之类的值**
→ **取值集合 = 进程环境变量 `OPENCODE_CLIENT` 的任意值，未设置时为 `"cli"`。** desktop 实际取值需 runtime 确认（**【未证实】**）。

---

## 6. 问题 6：流式细节与分支差异

### 6.1 始终流式 **【证实】**
- `:328462`（openai-compatible chat）：
  ```js
  e = { ...i22, stream: true, stream_options: this.config.includeUsage ? { includeUsage: true } : void 0 }
  ```
- `:325972` `c.chatModel = n6`（`new On(u5, { ...e("chat"), includeUsage, ... })`）
- `includeUsage` 被强制打开 `:656125-656127`：openai-compatible 时 `options2["includeUsage"] = true`
→ 实际请求体带 **`"stream": true, "stream_options": {"include_usage": true}`**。

### 6.2 认证头分支差异 **【证实】**
| api.npm | 认证头 |
|---|---|
| `@ai-sdk/openai-compatible`（**opencode / opencode-go**） | `Authorization: Bearer <key>` |
| `@ai-sdk/openai` | `Authorization: Bearer <key>` |
| `@ai-sdk/anthropic` | `x-api-key: <key>` |

（`:340602-340609`；anthropic 分支要求 `resolved.api.type === "aisdk" && package === "@ai-sdk/anthropic"`。快照里 `qwen3.6-plus-free` 等 deprecated 免费模型带 `provider.npm = "@ai-sdk/anthropic"`，即**它们走 `x-api-key`**。）

### 6.3 插件钩子（可改写 headers / options）
- `prepare3`（`LLMRequestPrep.prepare`，`:440942-441046`）在发请求前触发两个钩子：
  - `:440981-440993` `chat.params` → 可改 `temperature/topP/topK/maxOutputTokens/options`（`options` 含 `apiKey`/`baseURL`）
  - `:440994-441002` `chat.headers` → 初始 `{ headers: {} }`，返回值在 `:441043` 合并
- **内置插件不会为 opencode 注入头**【证实】：
  - `:379288-379301` 是 Codex 插件：`if (input2.model.providerID !== "openai") return;`
  - `:384877-384902` 是 github-copilot 插件：`if (!incoming.model.providerID.includes("github-copilot")) return;`
  - `grep 'auth: {'` 命中的 8 个插件（`:379091` codex、`:384692` copilot、`:417783`/`:417831`/`:417863`/`:417903`/`:418210`/`:418382`/`:418695` MCP OAuth）**没有一个是 opencode**
- → 结论：**用户未装插件时，opencode 请求头只由 `:441027-441044` 决定。**

### 6.4 `prompt_cache_key` 与免费模型无关（修正前一版笔记）
- `:426673-426678`：只有 `@ai-sdk/deepinfra`/`@ai-sdk/cerebras`（→ `prompt_cache_key`）或 `@ai-sdk/openai`/`azure`/`xai`/`mistral`/`venice`（→ `promptCacheKey`）才设
- `:426704-426708`：`providerID.startsWith("opencode")` 的 `promptCacheKey`/`include`/`reasoningSummary` 分支**位于 `if (input.model.api.id.includes("gpt-5") ...)` 内部**（`:426691`），免费模型（如 `deepseek-v4.1-flash-free`）**不命中**
- → opencode 免费模型请求体**不含** `prompt_cache_key`。

---

## 7. 完整请求链（逐步）

```
① 模型选择
   SessionRunnerModel.resolve(session)                        :340672-340685
   → catalog.model.available() 过滤 supported(model)          :340674 / :340616
   → catalog.provider.get(selected.providerID)                :340682
   → integrations.connection.active(integrationID ?? providerID) :340683
   → integrations.connection.resolve(connection)              :340684
② 模型 → HTTP 描述
   fromCatalogModel(resolved, credential)                     :340597-340609
   → key2 = apiKey(resolved, credential)                      :340566-340573
        credential.type==="oauth" → credential.access         :340569-340570
        否则 model.request.body.apiKey ?? api.settings.apiKey  :340571-340573
   → withDefaults(...) 剔除 body.apiKey, 设 endpoint.baseURL   :340574-340583
   → auth = bearer(key2)   (openai-compatible)                :340607-340609
③ SDK 构建（v1 Provider 路径）
   resolveSDK(model, provider, envs)                          :656113-656169
   → options = {...provider.options}                          :656116
   → includeUsage = true                                      :656125-656127
   → baseURL = options.baseURL ?? model.api.url               :656128-656147
   → options.apiKey = provider.key  (仅 type==="api")          :656148-656149 / :656003-656008
   → fetch = timeoutFetch(options)                            :656163
   → createOpenAICompatible(options)                          :655316 / :243219
   → Authorization: `Bearer ${apiKey}`                        :243223
④ 请求装配
   LLM.run: getLanguage + config.get + getProvider + auth.get  :441091-441114
   prepare3: chat.params → chat.headers → resolveTools         :440981-441003
   headers: x-opencode-session-id / -project / -session /
            -request / -client / User-Agent                    :441027-441044
⑤ 发送
   POST {api}/chat/completions                                 :328462
   body: { model, messages, tools, stream:true,
           stream_options:{include_usage:true}, temperature, ... }
⑥ 失败处理
   retryable() 匹配 responseBody 含 "FreeUsageLimitError"       :441413-441417
        → action.reason = "free_tier_limit", 标题 "Free limit reached"
   含 "GoUsageLimitError"                                      :441426-441450
        → action.reason = "account_rate_limit", 解析 metadata.workspace/limitName
          + retry-after 头 → "It will reset in ..." 链接 .../workspace/<ws>/go
   policy2 最多重试 RETRY_MAX_RETRIES = 5                       :441504 / :441519
   渲染层仅对 provider ∈ {opencode, opencode-go} 弹升级引导      main-C07s90t2.js:152558-152564
```

---

## 8. 最小可复现请求草案

> **说明**：以下为**草案**，基于静态证据构造；`<...>` 需运行时取值。`User-Agent` 与 6 个 `x-opencode-*` 头来自 `:441027-441044`，`stream_options` 来自 `:328462`/`:656125-656127`，认证形态来自 `:340607-340609` + `:243223`。

```http
POST https://opencode.ai/inference/v1/chat/completions
Authorization: Bearer <apiKey>
Content-Type: application/json
User-Agent: opencode/1.19.2
x-opencode-session-id: <sessionID>
x-opencode-session: <sessionID>
x-opencode-request: <local user.id>
x-opencode-client: <OPENCODE_CLIENT, 默认 cli>
x-opencode-project: <project.id>
```
```json
{
  "model": "deepseek-v4.1-flash-free",
  "messages": [{"role": "user", "content": "hi"}],
  "stream": true,
  "stream_options": {"include_usage": true}
}
```

`<apiKey>` 的三种可能取值，按可能性排序：

| # | 取值 | 何时 | 证据 |
|---|---|---|---|
| 1 | **OAuth access_token**（`opencode.db` → CredentialTable，`integration_id="opencode"`） | 已登录 OpenCode Console 且走 v2 SessionRunnerModel 路径 | `:340569-340570`、`:340683-340684`、`:61560-61624` |
| 2 | `public` | 未登录且走 v1 目录插件 / SDK 加载器路径 | `:313636`、`:654816` |
| 3 | 服务账号 API key（`auth.json` 的 `opencode` 条目，`type:"api"`） | 用「API key (service account)」方式连接 | `:313570`、`:655998-656008` |

**外部 curl 若要逼近客户端行为，最小增量 = `User-Agent: opencode/1.19.2` + 6 个 `x-opencode-*` 头 + `stream:true` + `stream_options.include_usage`，并把 `Authorization` 换成 `opencode.db` 中的真实 OAuth access_token（而非 `public`）。**

### 8.1 头的最小必需性（推测，需 A/B 验证）
- `x-opencode-project` / `x-opencode-request` 是**服务端唯一能识别「请求属于哪个工作区/账号」的字段** → 若服务端据此判定免费额度归属，缺失会直接 403。【推断】
- `x-opencode-session-id` 与 `x-opencode-session` 同值重复发送（`:441028` 与 `:441033`），说明服务端可能分别用于路由与计费/会话跟踪。【推断】

---

## 9. 不确定项与建议验证

| # | 不确定项 | 为何无法从客户端判定 | 建议 |
|---|---|---|---|
| 1 | 本机 desktop 实际走 v1 还是 v2 请求路径 | 需要运行时栈或抓包 | runtime-proof 抓包看 `Authorization` 是否为 `public` |
| 2 | `opencode.db` 中是否存在 `integration_id="opencode"` 的 OAuth 凭据 | 6 GB SQLite，未查询（且属 runtime 范围） | `sqlite3 opencode.db "select integration_id,label,length(value) from credential"` |
| 3 | desktop 进程的 `OPENCODE_CLIENT` 实际值 | 打包产物无硬编码（仅 5 处引用，全为 env 读取） | 抓包看 `x-opencode-client` |
| 4 | 服务端为何对 `Bearer public` 返回 **403 FreeTierError** | 客户端**无 `FreeTierError` 字符串**（grep 0 命中），错误是服务端产生 | 服务端行为，需抓包 + 对照官方文档 |
| 5 | 免费额度数值/时间窗（请求数、token、金额） | 客户端无任何本地计数常量（`per day|per month|Free usage` 等仅命中 `:441519`） | 见 task-1 报告；需服务端或文档 |
| 6 | `x-opencode-project` / `x-opencode-request` 是否被服务端校验 | 客户端无校验/回填逻辑 | A/B 抓包：逐个头删掉看是否 403 |
| 7 | v1 路径下 OAuth 登录的 opencode 请求是否真的缺失 Authorization（`:655998-656008` 只认 `type==="api"`） | 静态分析显示是结构性缺口，但可能另有填充点未找到 | 抓包核对；或对 `provider9.key` 赋值点再做全量 grep |

---

## 10. 附：本报告使用的关键证据行号索引

| 主题 | 行号 |
|---|---|
| `"public"` 赋值 | `:313636`、`:654816` |
| apiKey 提取（key/oauth/body） | `:340566-340573` |
| apiKey 从 body 剔除 | `:340574-340583` |
| 认证分支（bearer / x-api-key） | `:340602-340609` |
| `Authorization: Bearer` 落地 | `:243223`、`:253569` |
| `provider9.key` 仅 `type==="api"` | `:655998-656009` |
| `resolveSDK`（includeUsage / baseURL / apiKey） | `:656113-656169` |
| `getLanguage` | `:656215-656231` |
| OAuth 设备流 | `:313396-313520` |
| `/console/api/config` | `:313437-313447` |
| `withoutCredentials` | `:313448-313450` |
| OpencodePlugin 主体 | `:313551-313652` |
| 免费门禁（enabled 过滤） | `:313630-313646` |
| v2 凭据表 | `:61560-61624` |
| `SessionRunnerModel.resolve` | `:340668-340687` |
| 快照来源 | `:169208-169209` |
| `LLM.run` | `:441091-441114` |
| `prepare3` / 头构造 | `:440942-441046`、`:441027-441044` |
| `USER_AGENT2` / 版本常量 | `:440941`、`:45655` |
| `OPENCODE_CLIENT` | `:30822-30823`、`:383744`、`:169112` |
| 流式 | `:328462`、`:325972`、`:656125-656127` |
| `promptCacheKey` 分支 | `:426673-426678`、`:426704-426708` |
| 内置 `chat.headers`/`chat.params` 插件 | `:379288-379301`、`:384877-384902` |
| 失败判定（free/go limit） | `:441406-441472`、`:441498-441518` |
| UI 升级引导（GO_UPSELL_PROVIDERS） | `main-C07s90t2.js:152558-152564` |

---

*报告完成时间：本次会话内。所有引用行号基于 `node-ibnNxpSl.js`（665066 行，`InstallationVersion = "1.19.2"`）。未修改任何被分析文件。*
