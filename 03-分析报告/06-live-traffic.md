# 06 — 正向取证：运行中 OpenCode Desktop 的真实出站请求

**执行者**：teammate `traffic-capture`（task-6）
**目标**：零侵入回答「客户端比外部 curl 多了什么才能拿到 200」
**约束遵守**：未重启 / 未杀进程 / 未中断 OpenCode Desktop；未修改或删除任何文件；未输出任何 key/token/邮箱明文；未做绕过鉴权尝试；未发起新的模型推理请求。
**结论（先说）**：**零侵入手段本身没有拿到真实请求头**（没能拦到活的出站 HTTP），但零侵入手段**拿到了决定性的静态证据**：出站请求头的**唯一构造点**及其逐字段来源，与 Lead 洁净室捕获的 200 请求形状**完全吻合**，并解释了为什么外部 curl 必然 403。

---

## 1. 进程表（零侵入，`Get-CimInstance Win32_Process`）

| PID | 父 PID | 角色（由命令行判定） | 关键参数 |
|---|---|---|---|
| 11320 | 13124 | 主进程 `OpenCode.exe --updated` | — |
| 22700 | 11320 | crashpad-handler | `--database=…\ai.opencode.desktop\Crashpad` |
| 8224 | 11320 | gpu-process | `--user-data-dir=…\ai.opencode.desktop` |
| 28624 | 11320 | utility / **network.mojom.NetworkService** | `--service-sandbox-type=none` |
| **30128** | 11320 | utility / **node.mojom.NodeService**（即 opencode 引擎 sidecar，127.0.0.1:55434） | `--user-data-dir=…\ai.opencode.desktop` |
| 42788 | 11320 | renderer | `--app-path=…\resources\app.asar`，`--enable-sandbox` |
| 27664 | 11320 | utility / audio.mojom.AudioService | — |

关键点：**引擎不是独立 `node.exe`，而是 Electron 的 Node utility 进程（PID 30128）**，其环境变量（含 `OPENCODE_SERVER_USERNAME` / 随机 UUID 密码 / `OPENCODE_CLIENT`）由主进程注入，**不落盘、外部进程不可读**（Windows 上读取另一进程环境需调试器，属侵入手段，未执行）。命令行中**没有任何 port/token/密码明文参数**。

---

## 2. 凭证位置表（脱敏）

| 位置 | 结论 | 证据 |
|---|---|---|
| `%USERPROFILE%\.local\share\opencode\auth.json` | **存在（419 B，mtime 2026-10-14 07:55:16），但无 `opencode` 条目** | 顶层键仅 4 个：`asaf` / `cline-pass` / `workbuddy` / `tokenharhur`，每个为 `{type, key}`。**没有任何 `opencode`/`opencode-zen` 条目** → 免费身份不来自此文件 |
| `…\ai.opencode.desktop\opencode.global.dat`（118 KB） | 命中 0 | 关键词扫描 `access_token`/`refresh_token`/`device_code`/`oauth`/`Bearer`/`api_key`/`Authorization` 全部 0 命中；内容是 UI 状态（命令目录、会话搜索、i18n 标题） |
| `…\default.dat`(975B) / `opencode.settings`(156B) / `Local State`(490B) / `Preferences`(57B) / `Network\Network Persistent State`(794B) | 命中 0 | 同上关键词扫描 |
| `…\Local Storage\leveldb\000010.log`、`…\Session Storage\000003.log` | **无法读取（文件被运行中进程独占，IOException）** | 未强制复制、未使用影子副本，避免干扰运行中的 app |
| `…\ai.opencode.desktop\` 下 **无 `Cookies` 文件** | 该 profile 未持有 opencode.ai 的 Chromium cookie | 目录清单中不存在 `Network\Cookies` |
| `…\drafts.sqlite`(70 MB) / `opencode.db`(6.1 GB) | 未做整体加载（遵守禁令）；本次不需要 | — |
| 环境变量（本会话 `Get-ChildItem Env:`） | 仅 `ELECTRON_RUN_AS_NODE`（len=1，为 Lead 洁净室实验遗留），**无 `OPENCODE_*`** | sidecar 环境不继承给外部 shell |

**判定**：本机**没有**持久化的 opencode OAuth access_token / API key。免费调用**不需要**客户端持有任何持久凭证。

---

## 3. 零侵入拿到的决定性静态证据（主 bundle）

文件：`99-解包产物与运行时残留\OpenCode-Desktop-1.19.2-解包\out\main\chunks\node-ibnNxpSl.js`（38,809,523 B，minified；下给 **行号 @ 字节偏移**）

### 3.1 出站请求头的唯一构造点 —— `LLMRequestPrep.prepare`

`node-ibnNxpSl.js:441028`（@27690858）逐字：

```js
const opencodeProjectID = input.model.providerID.startsWith("opencode") ? (yield* context4).project.id : void 0;
return {
  system, messages, tools: ..., params, messageTransformOptions: options2,
  headers: {
    "x-opencode-session-id": input.sessionID,
    ...input.parentSessionID ? { "x-opencode-parent-session-id": input.parentSessionID } : {},
    ...input.model.providerID.startsWith("opencode") ? {
      ...opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {},
      "x-opencode-session": input.sessionID,
      "x-opencode-request": input.user.id,
      "x-opencode-client": input.flags.client,
      "User-Agent": USER_AGENT2
    } : {
      "x-session-affinity": input.sessionID,
      "X-Session-Id": input.sessionID,
      "User-Agent": USER_AGENT2
    },
    ...input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {},
    ...input.model.headers,
    ...headers7
  }
}
```

**这就是「客户端比 curl 多了什么」的答案**：只要 `providerID` 以 `opencode` 开头（免费模型正是 `opencode` provider），客户端就**额外注入 5 个头**：`x-opencode-session-id`、`x-opencode-session`、`x-opencode-request`、`x-opencode-client`、`User-Agent`（+ 可选 `x-opencode-project`、`x-opencode-parent-session-id`）。非 opencode provider 走的是完全不同的 `x-session-affinity` / `X-Session-Id` 分支 —— 说明这组头是 **opencode 自家推理端点专用的客户端标识**。

### 3.2 各字段来源（逐条溯源）

| 头 | 值来源 | 证据 |
|---|---|---|
| `User-Agent` | ``USER_AGENT2 = `opencode/${InstallationVersion}` `` → 实测 `opencode/1.19.2` | `node-ibnNxpSl.js:440941`（@27687163） |
| `x-opencode-client` | `input.flags.client` ← `OPENCODE_CLIENT` 环境变量，**默认 `"cli"`** | `node-ibnNxpSl.js:383744`（@25488586）：`client: string3("OPENCODE_CLIENT").pipe(withDefault2("cli"))`；`node-ibnNxpSl.js:30822`（@1060902）：`get OPENCODE_CLIENT(){ return process.env["OPENCODE_CLIENT"] ?? "cli" }` |
| `x-opencode-session-id` / `x-opencode-session` | `session.id`，形如 `ses_<hex><base62>` | 同 3.1；另有 `promptCacheKey2 = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id`（`node-ibnNxpSl.js:341343` @24115126） |
| `x-opencode-request` | `input.user.id`（消息 id，`msg_…`） | 同 3.1 |
| `x-opencode-project` | `context.project.id`（默认项目即 `global`） | 同 3.1 |

### 3.3 `Authorization: Bearer public` 是设计如此，不是门禁

`node-ibnNxpSl.js:654816`（@38225510），`opencode` provider 的 options 解析：

```js
const hasKey = iife2(() => { if (input.env.some((item2) => env2[item2])) return true; return false; });
const ok2 = hasKey || Boolean(yield* dep.auth(input.id)) || Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey);
if (!ok2) {
  for (const [key2, value4] of Object.entries(input.models)) {
    if (value4.cost.input === 0) continue;
    delete input.models[key2];       // 无 key → 只保留 cost.input === 0 的免费模型
  }
}
return { autoload: Object.keys(input.models).length > 0, options: ok2 ? {} : { apiKey: "public" } };
```

→ 无任何 key 时：**删掉全部付费模型，只留 `cost.input === 0` 的免费模型，并把 apiKey 硬编码为 `"public"`**。所以 `Bearer public` 是给服务端做「匿名免费档」标记用的，**它本身不构成鉴权**，这也解释了 Lead 外部 curl 带 `Bearer public` 免费模型得到 403 而非 401。

### 3.4 provider 与端点

`node-ibnNxpSl.js:169228`（@10735746）：

```js
opencode: { id: "opencode", env: ["OPENCODE_API_KEY"], npm: "@ai-sdk/openai-compatible",
            api: "https://opencode.ai/inference/v1", name: "OpenCode",
            doc: "https://opencode.ai/v2/docs/console/models/",
            models: { "ling-3.0-flash-fin-free": {...}, ... } }
```

### 3.5 请求签名机制：**不存在**（复核 Lead 结论）

- `x-opencode-signature` → **0 命中**
- `createHmac` 命中全部来自 npm 依赖（jwa/jws/oidc），非请求构造路径
- 请求头构造只有 3.1 一处，无任何 HMAC / 时间戳 / nonce 逻辑

### 3.6 OAuth 设备流确实存在，但**未被使用**

`clientId = "opencode-cli"`（`node-ibnNxpSl.js:57204` @1895366）、`${server}/auth/device/code`（`:57418` @1904843）、`${server}/auth/device/token`（`:57440` @1905927）、TokenRefresh（`:57318` @1899940）。**但**：
- `auth.json` 无 `opencode` 条目（§2）
- 桌面状态目录无 `access_token`/`refresh_token`/`device_code` 任何命中（§2）
→ **设备流在本机从未走通/从未落盘，免费调用不依赖它**。这是对 Lead 初始假设 #1 的**否定结论**（重要，避免后续误判）。

### 3.7 引擎对本地 server 的鉴权

`OPENCODE_SERVER_USERNAME=opencode` + 随机 UUID 密码经环境变量注入 sidecar（不落盘），HTTP Basic。因此本地 401 是引擎自身门禁，与 opencode.ai 出站鉴权**无关**。

---

## 4. 结论一：零侵入手段是否拿到了真实请求头

**没有拿到「活的」请求头。** 零侵入路径（进程表 / 凭证位置 / 状态文件 / leveldb / 日志）**不存在**可读的明文出站头：

- 状态文件无凭证关键词命中；`auth.json` 无 opencode 条目；leveldb 被独占锁无法读取（未强取）；
- 未发现任何本地请求日志落盘出站头（详见 §5）；
- sidecar 环境变量不落盘、外部不可读。

**但是**，零侵入拿到了**比抓包更强的因果证据**：请求头的唯一构造点（§3.1）与全部字段来源（§3.2），并证明**没有任何签名机制**（§3.5）。据此可**先验预测**出站头的完整形状，与 Lead 洁净室实测的 200 请求**逐字段一致**（§6）。即：**答案是静态可判定的，不需要抓包也能给出。**

---

## 5. 日志侧（负面结论）

- `%USERPROFILE%\.local\share\opencode\log\opencode.log`（≈27 MB）：未包含出站请求头级日志（客户端无 `FreeTierError` 字样 —— 该字符串在 bundle 中 **0 命中**，证实 403 由**远端服务端**产生，客户端不参与该判定）。
- `…\ai.opencode.desktop\logs\20261016T034020\{main,renderer,utility,network,onboarding,crash}.log`：均为 app 生命周期日志，非 HTTP 请求日志。

---

## 6. 结论二：真实出站请求形状（由 Lead 洁净室捕获，本节引用，未自行复现）

Lead 以 `ELECTRON_RUN_AS_NODE=1 OpenCode.exe engine_boot2.mjs 19991` 启动**独立隔离引擎**（独立 XDG 目录、无 `OPENCODE_API_KEY`、端口 19991），在 `globalThis.fetch` 上挂包装器落盘到 `07-原始证据\engine_http.jsonl`，发起一次真实免费调用 → **HTTP 200**：

```
POST https://opencode.ai/inference/v1/chat/completions
authorization: Bearer public
content-type: application/json
user-agent: opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24
x-opencode-client: desktop
x-opencode-project: global
x-opencode-request: msg_…
x-opencode-session: ses_…
x-opencode-session-id: ses_…          (与 x-opencode-session 同值)
body: 完整 agent body（system prompt ≈12,988 字符 + tools + stream:true
      + stream_options.include_usage + max_tokens:32000）
→ 200
```

**与 §3 静态证据的一致性核验（本节的价值）**：

| 捕获到的头 | §3 静态预测 | 一致？ |
|---|---|---|
| `authorization: Bearer public` | §3.3 `options: { apiKey: "public" }` | ✅ |
| `user-agent: opencode/1.19.2 …` | §3.2 `opencode/${InstallationVersion}` = `opencode/1.19.2` | ✅（其后 `ai-sdk/provider-utils/4.0.23 runtime/node.js/24` 由 `@ai-sdk/openai-compatible` 拼接） |
| `x-opencode-client: desktop` | §3.2 `OPENCODE_CLIENT` 默认 `cli`，桌面端注入 `desktop` | ✅ 唯一非默认值，**必须显式设置** |
| `x-opencode-project: global` | §3.1 `context.project.id` | ✅ |
| `x-opencode-request: msg_…` | §3.1 `input.user.id` | ✅ |
| `x-opencode-session` / `x-opencode-session-id` 同值 | §3.1 两处均取 `input.sessionID` | ✅ |
| 无 `x-opencode-signature` | §3.5 无签名机制 | ✅ |

**为什么外部 curl 必然 403**：`providerID.startsWith("opencode")` 分支注入的 `x-opencode-session-id` / `x-opencode-session`（`ses_` 形 id）与 `x-opencode-client` 是服务端判定「来自 OpenCode 内部」的依据；curl 缺少这些头即命中 `FreeTierError: OpenCode's free tier can only be used from within OpenCode.`

---

## 7. 需用户批准的方案（**未执行**；现已非必需，仅存档）

> 因 §3 + §6 已形成闭环，**该方案不再需要执行**。以下为原始备案，供审计。

**方案 A — 洁净室复刻（首选，零风险，已验证可行）**
用 `ELECTRON_RUN_AS_NODE=1` 启动**独立**引擎实例，`--require` 预加载钩子劫持 `http/https.request` 与 `fetch`，落盘 JSONL（参考本机 skill `node-cli-traffic-capture`）。
- 命令要点：`ELECTRON_RUN_AS_NODE=1 "<install>\OpenCode.exe" <hook-boot>.mjs <port>`，钩子由 `NODE_OPTIONS=--require <hook>.cjs` 注入
- 落盘：`07-原始证据\engine_http.jsonl`
- 收益：拿到完整头/体/状态码，且**不触碰用户正在使用的实例**
- 风险：低（独立 XDG 目录，需注意不与主实例抢配置/DB；本方案已由 Lead 实测 200 成功）
- 回滚：删除临时目录与 hook 文件即可

**方案 B — 在运行中主实例上抓包（不推荐）**
对 PID 30128 注入 `NODE_OPTIONS`/调试器。
- 风险：**必须重启 OpenCode Desktop**，打断用户会话、可能影响未保存草稿；Node utility 进程的 `NODE_OPTIONS` 需在主进程启动前注入
- 结论：**已被否决**，且方案 A 已达成同等目标

---

## 8. 一句话交付

零侵入**未**截获活体请求头，但**定位到唯一的请求头构造点**（`node-ibnNxpSl.js:441028` @27690858），证明客户端在 `opencode` provider 分支额外注入 `x-opencode-session-id` / `x-opencode-session` / `x-opencode-request` / `x-opencode-client` / `User-Agent`，其中 `x-opencode-client` 来自 `OPENCODE_CLIENT` 环境变量（默认 `cli`，桌面端为 `desktop`，见 `:383744` @25488586），且**不存在任何请求签名**；`Bearer public` 由 `:654816` @38225510 在无 key 时硬编码，非鉴权。此静态结论与 Lead 洁净室捕获的 200 请求逐字段吻合 —— **「客户端比 curl 多了什么」= 这组 `x-opencode-*` 客户端标识头**。
