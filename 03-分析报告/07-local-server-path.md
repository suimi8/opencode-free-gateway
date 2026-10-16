# 07 — 本地 opencode server 路径：鉴权、启动、DB 字段级样本与可复现免费调用

- 任务：task-7（owner `runtime-proof`）
- 取证方式：**全程只读**。未重启/未杀进程、未修改任何文件、未主动发起推理请求。
- 目标实例：PID **30128**，`127.0.0.1:55434`（用户正在运行的 OpenCode Desktop sidecar）
- 相关文件：
  - `%APPDATA%\ai.opencode.desktop\logs\20261016T034020\main.log`
  - `%USERPROFILE%\.local\share\opencode\opencode.db`
  - `%USERPROFILE%\.local\share\opencode\log\opencode.log`
  - `%LOCALAPPDATA%\Programs\@opencode-aidesktop\resources\app.asar`

---

## 0. 一句话结论

本机**存在非交互可复现的免费调用路径**：本地 sidecar 是一个标准 opencode HTTP server（`127.0.0.1:55434`），使用 **HTTP Basic（用户名 `opencode`）** 鉴权，口令由主进程生成并通过**环境变量**注入 sidecar；`POST /session` + `POST /session/{id}/message` 即可在 `providerID=opencode` 的免费模型上拿到 200 与 `cost:0`。Lead 已在隔离洁净室实例（端口 19991）实测跑通同一条路径。

---

## 1. 本地 server 的鉴权方式

### 1.1 鉴权形态

| 项 | 结论 |
|---|---|
| 方案 | **HTTP Basic Authentication** |
| 用户名 | `opencode`（固定） |
| 口令 | 来自 sidecar 进程的**环境变量** `OPENCODE_SERVER_PASSWORD`（只报位置与形态，**值不输出**） |
| 无凭证结果 | `401`（Lead 已实测所有端点对无凭证请求返回 401） |
| 请求头形态 | `Authorization: Basic base64("opencode:<password>")` |

### 1.2 凭证来源判定链（为什么不是命令行/不是文件）

1. **不是命令行参数**：`Get-CimInstance Win32_Process` 读到的 PID 30128 完整 CommandLine 只有 Electron 的通用开关，**没有任何端口、token 或 server 相关参数**：

```
"%LOCALAPPDATA%\Programs\@opencode-aidesktop\OpenCode.exe" --type=utility
  --utility-sub-type=node.mojom.NodeService --lang=zh-CN --service-sandbox-type=none
  --user-data-dir="%APPDATA%\ai.opencode.desktop"
  --standard-schemes=oc --secure-schemes=oc --fetch-schemes=oc --streaming-schemes=oc
  --field-trial-handle=... --pseudonymization-salt-handle=... --mojo-platform-channel-handle=2992 /prefetch:14
```

   → 该进程是 Electron 的 **NodeService utility 子进程**，由 `utilityProcess.fork()` 拉起，因此 `argv` 只剩 Electron 自身的开关。

2. **环境变量名来自二进制**：对 `app.asar` 做 `rg -a -o "OPENCODE_[A-Z_]+"` 得到的环境变量清单中包含：

```
OPENCODE_CONSOLE_TOKEN
OPENCODE_SERVER_PASSWORD
OPENCODE_API_KEY
OPENCODE_AUTH_CONTENT
OPENCODE_CLIENT
OPENCODE_CONFIG_DIR
OPENCODE_DB
...
```

   其中 `OPENCODE_SERVER_PASSWORD` 即 sidecar 的 Basic 口令来源；`OPENCODE_CLIENT` 即前一份报告（03）中推断的客户端身份标识。

3. **不是配置文件**：`auth.json` 只有 `asaf` / `cline-pass` / `workbuddy` / `tokenharhur` 四个 provider（全 `type=api`），**没有 server 口令条目**；`opencode.settings` 仅 4 个 UI 键；`opencode.global.dat` 仅 6 个顶层键。均无 server 口令。

> 结论：口令是**运行时生成、仅存于进程内存与子进程环境块**的短生命周期秘密，不落盘。
> （Lead 用只读 PEB 读取法从 sidecar 环境变量取到过该值；本报告按要求不输出其值。）

---

## 2. client 启动本地 server 的确切方式

### 2.1 主进程日志原文

`%APPDATA%\ai.opencode.desktop\logs\20261016T034020\main.log`：

```
line 11: [2026-10-16 11:40:20.467] [info]            sidecar connection started { version: 'v1' }
line 12: [2026-10-16 11:40:20.482] [info]            spawning sidecar { url: 'http://127.0.0.1:55434' }
line 16: [2026-10-16 11:40:22.265] [info]            awaiting server ready
line 17: [2026-10-16 11:40:22.266] [info]            server ready { url: 'http://127.0.0.1:55434' }
```

`app.asar` 中对应的代码字面量（`rg -a -o` 命中）：

```
awaiting server ready
sidecar connection started", { version: SIDECAR_VERSION });
spawning sidecar", { url });
```

### 2.2 端口不是固定的 —— 每次启动随机

从 `...\ai.opencode.desktop\logs\*\main.log` 汇总的历史启动记录（同一台机器）：

| 日志目录 | 启动时间 | `spawning sidecar { url }` |
|---|---|---|
| `20261012T095536` | 2026-10-12 17:55:36 | `http://127.0.0.1:61170` |
| `20261012T101907` | 2026-10-12 18:19:07 | `http://127.0.0.1:61843` |
| `20261012T103530` | 2026-10-12 18:35:30 | `http://127.0.0.1:50062` |
| `20261012T190204` | 2026-10-13 03:02:05 | `http://127.0.0.1:65400` |
| `20261013T023707` | 2026-10-13 10:37:07 | `http://127.0.0.1:57230` |
| `20261013T235555` | 2026-10-14 07:55:55 | `http://127.0.0.1:53346` |
| `20261014T002532` | 2026-10-14 08:25:32 | `http://127.0.0.1:54498` |
| `20261015T140557` | 2026-10-15 22:05:58 | `http://127.0.0.1:49498` |
| `20261015T140629` | 2026-10-15 22:06:30 | `http://127.0.0.1:50933` |
| `20261016T012036` | 2026-10-16 09:20:36 | `http://127.0.0.1:57263` |
| `20261016T012051` | 2026-10-16 09:20:51 | `http://127.0.0.1:61245` |
| **`20261016T034020`** | **2026-10-16 11:40:20** | **`http://127.0.0.1:55434`（当前）** |

→ 12 次启动 12 个不同端口，全部落在 `49498–65400` 区间 ⇒ **主进程每次分配一个随机空闲端口**，并把 `url` 交给 renderer。

### 2.3 进程与套接字核对

```
TCP    127.0.0.1:55434        0.0.0.0:0              LISTENING       30128
TCP    127.0.0.1:51904        127.0.0.1:55434        ESTABLISHED     28624
TCP    127.0.0.1:55434        127.0.0.1:51904        ESTABLISHED     30128
```

- `30128` = NodeService utility（server 本体，唯一 LISTEN 者）
- `28624` = `--type=utility --utility-sub-type=network.mojom.NetworkService`（Chromium 网络服务，renderer 的 fetch 经它出网 → 即 renderer 通过 HTTP 调本地 server）
- 父进程均为 `11320`（主进程，`OpenCode.exe --updated`）

### 2.4 启动方式小结

```
OpenCode.exe (主进程, PID 11320)
  └─ utilityProcess.fork(sidecar.js)  →  --type=utility --utility-sub-type=node.mojom.NodeService (PID 30128)
       · 主进程随机选一个空闲端口（本次 55434）
       · 主进程生成随机口令，经 env 注入子进程：OPENCODE_SERVER_PASSWORD=<redacted>
       · 子进程 listen 127.0.0.1:<port>
       · 主进程等待健康检查：awaiting server ready → server ready { url }
       · 退出日志：utility.log: sidecar exited { code: 0 }
```

---

## 3. `opencode.db` 字段级样本（脱敏）

DB：`%USERPROFILE%\.local\share\opencode\opencode.db`（6GB，只读 SQL 查询）

### 3.1 表结构（`sqlite_master`）

`message`（14,910 行）：

```sql
CREATE TABLE `message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,      -- 全部业务字段都在这个 JSON 里
  CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
)
```

`part`（48,057 行）：`id / message_id / session_id / time_created / time_updated / data`（同样是 JSON blob）

`session`（67 行）：额外含**扁平化**的 `cost real`、`tokens_input`、`tokens_output`、`tokens_reasoning`、`tokens_cache_read`、`tokens_cache_write`、`model`、`agent`、`directory`、`project_id`、`workspace_id` 等列。

### 3.2 一条真实免费调用的完整 assistant message 记录

查询：

```sql
SELECT id, session_id, time_created, data FROM message
WHERE json_extract(data,'$.providerID')='opencode'
  AND json_extract(data,'$.role')='assistant'
ORDER BY time_created DESC LIMIT 1;
```

结果（**可复核 ID**：`msg_1431884f3001NWKLOEDddwF0Yl` / `ses_ebd0f492affeKMIjnAvQdf9CVV`）：

```json
{"parentID":"msg_142f0b6da001qojn4uYBWtRvsR","role":"assistant","mode":"general","agent":"general",
 "variant":"max","path":{"cwd":"D:\\Downloads\\抖音逆向","root":"D:\\Downloads\\抖音逆向"},
 "cost":0,
 "tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
 "modelID":"space-bunny-free","providerID":"opencode",
 "time":{"created":1792127042803}}
```

`time_created = 1792127042803` → **2026-10-16 13:04:02 本地**。

### 3.3 字段名清单（`message.data` 顶层键，providerID=opencode 的 assistant）

```
parentID, role, mode, agent, variant, path, cost, tokens, modelID, providerID, time,
finish, summary, error
```

- `modelID` / `providerID`：模型归因（免费判定依据）
- `cost`：**实数，免费模型恒为 `0`**
- `tokens`：`{input, output, reasoning, cache:{read, write}}`，另有 `total`
- `finish`：取值分布 `tool-calls`=5845、`stop`=3367、`length`=9、`unknown`=8、空=34
- `error`：**仅失败时出现**（见 §4）
- **无任何 key / auth / credential 字段**：DB 不保存凭证（`credential` 表 0 行、`account` 表 0 行、`control_account` 表 0 行）

### 3.4 带 token 计数的样本（同一免费通道，`cost:0`）

`part` 表 `type='step-finish'`（**可复核 ID**：`prt_14318c9c5001tkiHpYk04DI6Yd` / `msg_14318b535001yssJ0GFmL7qTi1`）：

```json
{"reason":"tool-calls","snapshot":"beec0ed9d56151bd605728465f45531e38ed3f08","type":"step-finish",
 "tokens":{"total":315389,"input":3366,"output":247,"reasoning":160,"cache":{"write":0,"read":311616}},
 "cost":0}
```

`message` 侧对应样本：

```
msg_1431861fa001i8rfg1VgOAuhXo | space-bunny-free            | cost=0 | {"total":310554,"input":9970,"output":240,"reasoning":1206,"cache":{"write":0,"read":299138}}
msg_143186c8a001o97QLjeRFlJXhu | deepseek-v4.1-flash-free    | cost=0 | {"output":0,"input":0,"reasoning":0,"cache":{"read":0,"write":0}}
```

### 3.5 DB 侧免费调用量级（截至取证时刻）

```sql
SELECT json_extract(data,'$.modelID') m, count(*), datetime(min(time_created)/1000,'unixepoch'),
       datetime(max(time_created)/1000,'unixepoch')
FROM message WHERE json_extract(data,'$.providerID')='opencode'
  AND json_extract(data,'$.role')='assistant' GROUP BY m ORDER BY 2 DESC;
```

| modelID | 条数 | 最早（UTC） | 最晚（UTC） |
|---|---|---|---|
| `mimo-v2.6-flash-free` | 6040 | 2026-10-12 19:15:49 | 2026-10-16 01:14:20 |
| `space-bunny-free` | 1630 | 2026-10-12 22:28:58 | 2026-10-16 05:04:02 |
| `deepseek-v4.1-flash-free` | 898 | 2026-10-15 14:06:48 | 2026-10-16 05:03:56 |
| `muse-spark-1.3-contributor-free` | 678 | 2026-10-12 09:56:52 | 2026-10-12 22:22:37 |
| `ling-3.1-flash-free` | 11 | 2026-10-12 22:18:22 | 2026-10-12 22:27:19 |
| `step-5-preview-free` | 2 | 2026-10-12 22:12:18 | 2026-10-12 22:14:13 |
| `longcat-2.5-preview-free` | 1 | 2026-10-12 22:15:14 | 2026-10-12 22:15:14 |

合计 **9,260** 条 assistant 消息（`providerID=opencode`，`role=assistant`），
`cost` 全为 **0**；成功 9,284 / 带 error 28（全库 assistant）。

---

## 4. DB 是否存储出站请求的 URL / headers / body？

> **⚠️ 修正 Lead 预填结论**：不是「未落库」。**失败路径上完整落库**，成功路径上不落。

证据：`message.data.error.data` 中保存了 `metadata.url`、完整 `responseHeaders` 与 `responseBody`。

### 4.1 出站 URL（每次失败都记录）

```
metadata.url = https://opencode.ai/inference/v1/chat/completions
```

### 4.2 完整请求-响应样本（原始，已脱敏 —— 其中无凭证字段）

```json
{"name":"APIError","data":{
  "message":"Upstream request failed: Endpoint is unavailable.",
  "statusCode":429,
  "isRetryable":true,
  "responseHeaders":{
    "cf-placement":"remote-IAD","cf-ray":"a499812dbc66b6a4-LAX","connection":"keep-alive",
    "content-length":"95","content-type":"application/json",
    "date":"Mon, 12 Oct 2026 22:22:43 GMT","server":"cloudflare",
    "x-opencode-log-id":"bd846f6b-a321-4251-ba16-582df82d83e7"},
  "responseBody":"{\"error\":{\"type\":\"server_error\",\"message\":\"Upstream request failed: Endpoint is unavailable.\"}}",
  "metadata":{"url":"https://opencode.ai/inference/v1/chat/completions"}}}
```

### 4.3 免费模型的 400 样本（暴露上游路由头）

```json
{"name":"APIError","data":{
  "message":"Upstream request failed: [invalid_request_error] invalid request",
  "statusCode":400,"isRetryable":false,
  "responseHeaders":{
    "cf-placement":"remote-IAD","cf-ray":"a4b444af2af55ecc-PDX","server":"cloudflare",
    "x-opencode-endpoint-id":"space-bunny.oai",
    "x-opencode-log-id":"89f7d586-b622-46fd-94bc-442ac9091d8f",
    "x-opencode-upstream-model-id":"space-bunny",
    "x-zen-model":"space-bunny-free"},
  "responseBody":"{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Upstream request failed: [invalid_request_error] invalid request\"}}",
  "metadata":{"url":"https://opencode.ai/inference/v1/chat/completions"}}}
```

**关键情报**：`x-zen-model: space-bunny-free`、`x-opencode-endpoint-id: space-bunny.oai` —— 证明免费模型经 `opencode.ai` 网关（Cloudflare）转发到 zen 上游。

### 4.4 DB 中 `error.data` 的全部取值分布（providerID=opencode）

| `error.name` / 摘要 | 条数 |
|---|---|
| `APIError` — `Cannot connect to API: Connect Timeout Error (attempted address: opencode.ai:443, timeout: 10000ms)`，`isRetryable:true` | 2 |
| `APIError` — `Cannot connect to API: other side closed`，`isRetryable:true` | 2 |
| `APIError` — `Upstream request failed: Endpoint is unavailable.`，`statusCode:429`，`isRetryable:true` | 2 |
| `APIError` — `Upstream request failed: [invalid_request_error] invalid request`，`statusCode:400`，`isRetryable:false` | 1 |
| `MessageAbortedError` — `Aborted` | 17 |
| `UnknownError` — `terminated` | 1 |

> **注意**：请求**体（prompt/body）不落库**；落库的是响应头/响应体/URL。请求侧只可从 `part` 表（`text` / `tool` / `file` 等 part）重建。

---

## 5. 可复现的非交互免费调用路径（命令模板）

> **只给模板，本报告未执行**（避免消耗用户免费额度）。模板经 Lead 在洁净室实例实测验证有效。

### 5.1 前置：取得端口与口令

```powershell
# 端口：从主进程日志读取（每次启动不同）
Select-String -Path "$env:APPDATA\ai.opencode.desktop\logs\*\main.log" `
  -Pattern "server ready" | Select-Object -Last 1
# → server ready { url: 'http://127.0.0.1:<PORT>' }

# 口令：位于 sidecar 进程环境变量 OPENCODE_SERVER_PASSWORD（只报位置，不打印值）
# 取法：只读 PEB 读进程环境块；本报告不提供脚本，以免口令被落盘。
```

### 5.2 调用模板（占位符化，Basic 口令不落盘）

```powershell
$port  = "<PORT>"                     # 例：55434（运行中实例）/ 19991（洁净室实例）
$user  = "opencode"                   # 固定用户名
$pass  = "<OPENCODE_SERVER_PASSWORD>" # 占位符，勿写入脚本文件
$auth  = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${user}:${pass}"))
$H     = @{ Authorization = $auth; "Content-Type" = "application/json" }

# ① 建会话
$ses = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/session" -Headers $H -Body "{}"
$id  = $ses.id                        # 形如 ses_xxxxxxxxxxxx

# ② 发起一次免费推理（会真实消耗免费额度）
$body = @{
  model = @{ providerID = "opencode"; modelID = "deepseek-v4.1-flash-free" }
  agent = "build"
  parts = @(@{ type = "text"; text = "reply with the single word: ok" })
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/session/$id/message" `
  -Headers $H -Body $body
# 预期：HTTP 200，返回 assistant 文本，tokens 计数，cost = 0
```

### 5.3 判定依据

| 依据 | 出处 |
|---|---|
| server 是标准 opencode HTTP server（含 `/session`、`/session/{id}/message`） | Lead 洁净室实测 `POST /session` → `ses_...`；`POST /session/{id}/message` → 200 |
| 鉴权为 HTTP Basic（用户名 `opencode`） | Lead 洁净室实测；口令来自 `OPENCODE_SERVER_PASSWORD` |
| 免费模型可走该通道且 `cost=0` | 本报告 §3.4（DB 侧 9,260 条 `cost:0`） |
| 无凭证 → 401 | Lead 实测 |
| 端口每次随机、需动态获取 | 本报告 §2.2（12 次启动 12 个端口） |

### 5.4 额度影响

- `providerID=opencode` + `-free` 模型：**计费 $0**（DB 中 9,260 条全为 `cost:0`），但**会真实消耗免费额度**——本机已在 `2026-09-14T14:33:59.021Z` 撞过一次并写入 `go_upsell_last_seen_at`（见报告 03 §5）。
- 同一实例还支持 `POST /session/{id}/shell`（Lead 实测 `status=completed`），可在引擎进程树内执行命令。
- 建议：复现验证请使用**隔离洁净室实例**（独立端口 + 独立 XDG 目录），不要打用户运行中的 `55434`。

---

## 6. Lead 已验证的洁净室复现路径

> 本节为 Lead 提供并已实测跑通的路径，非本 agent 执行。

```powershell
# 用 Electron 二进制当 Node 运行时，起一个完全隔离的 opencode 引擎
$env:ELECTRON_RUN_AS_NODE = "1"
& "%LOCALAPPDATA%\Programs\@opencode-aidesktop\OpenCode.exe" `
    05-引擎与运行时探针\engine_boot2.mjs 19991
```

- 隔离条件：独立 XDG 目录 `05-引擎与运行时探针\enginestate\`、**无 `OPENCODE_API_KEY`、无任何凭证**
- 启动结果：`LISTEN_OK http://127.0.0.1:19991/`
- 鉴权：自建实例可自设口令，同样使用 `authorization: Basic base64("opencode:<password>")`
- 实测调用链：
  - `POST /session` → `ses_...`
  - `POST /session/{id}/message`
    body `{model:{providerID:"opencode",modelID:"deepseek-v4.1-flash-free"},agent:"build",parts:[{type:"text",text:"..."}]}`
    → **HTTP 200**，返回文本，tokens 计数，`cost=0`
  - `POST /session/{id}/shell` → 在引擎进程树内执行命令，`status=completed`
- 捕获到的真实请求见 `10-POSITIVE-RESULT.md` 第 2 节。

> 结论：**匿名（`apiKey="public"`）在引擎内即可完成免费推理**——与报告 03 §3.4 的「客户端身份门禁」一致：裸 curl `opencode.ai` 被 403 `FreeTierError` 拒绝，但走本机引擎（带 `OPENCODE_CLIENT` 身份）则 200。

---

## 7. 免费调用成功链的时间线证据

### 7.1 最早期 / 最近期

| 维度 | 最早期 | 最近期 |
|---|---|---|
| **日志**（`opencode.log`，未被清理，覆盖最全） | `2026-09-14T11:23:28.292Z` | `2026-10-16T05:04:15.591Z` |
| **DB**（`message` 表，已被 prune，仅 67 session） | `2026-10-12 17:56:52` 本地 | `2026-10-16 13:04:02` 本地 |

日志末 3 条成功 stream 原文：

```
141348: timestamp=2026-10-16T05:04:03.341Z level=INFO run=d3e42f48 message=stream providerID=opencode modelID=space-bunny-free session.id=ses_ebd0f492affeKMIjnAvQdf9CVV small=false agent=general mode=subagent
141352: timestamp=2026-10-16T05:04:11.618Z level=INFO run=d3e42f48 message=stream providerID=opencode modelID=deepseek-v4.1-flash-free session.id=ses_ec7023cfeffeJCioqVt6MsOCJI small=false agent=build mode=primary
141358: timestamp=2026-10-16T05:04:15.591Z level=INFO run=d3e42f48 message=stream providerID=opencode modelID=space-bunny-free session.id=ses_ebd0f492affeKMIjnAvQdf9CVV small=false agent=general mode=subagent
```

### 7.2 重试机制在免费路径上确实生效（非 200 被救回）

**机制证据** —— 每一次失败的堆栈里都有重试帧：

```
at async _retryWithExponentialBackoff (file:///C:/.../app.asar/out/main/chunks/node-BBwF64dM.js:422227:12)
at async streamStep (.../node-BBwF64dM.js:426252:17)
```

且失败记录显式带 `"isRetryable":true`（429 / 连接超时 / other side closed）或 `false`（400 invalid_request）。

**救回证据** —— 两次 429 所在 session 之后仍持续产出成功消息：

```sql
-- 429 消息（可复核）
msg_13234b7ee001TENM6NX8pdvcgg | ses_ecdd00795fferb0oXHxWT1A6aU | 2026-10-13 06:21:18 | 429
msg_1323a3bf1001NkkebnsXlvBZlV | ses_ecdd00795fferb0oXHxWT1A6aU | 2026-10-13 06:27:19 | 429
-- 同 session 后续成功 assistant 消息
ses_ecdd00795fferb0oXHxWT1A6aU | 105 条 | 2026-10-13 06:18:22 → 2026-10-13 10:44:18
```

同 session 在 429 之后 4 小时内又产出 105 条无 error 的 assistant 消息 ⇒ 限流被退避重试/后续请求消化，未中断会话。

### 7.3 整体成功率

| 指标 | 值 | 出处 |
|---|---|---|
| 成功 assistant 消息（全库） | 9,284 | `message` 表 |
| 失败 assistant 消息（全库） | 28（0.30%） | `message` 表 |
| 日志成功 stream | 16,479 次 / 267 session | `opencode.log`（报告 03） |
| 日志失败率 | ≈0.36% | 报告 03 |

---

## 8. 原始证据索引

| 证据 | 位置 |
|---|---|
| sidecar 启动日志 | `%APPDATA%\ai.opencode.desktop\logs\20261016T034020\main.log` line 11–17 |
| 历史端口（12 次） | `%APPDATA%\ai.opencode.desktop\logs\*\main.log` line 12 |
| sidecar 退出 | `...\logs\*\utility.log` line 1 |
| 进程 CommandLine | `Get-CimInstance Win32_Process -Filter "Name like '%opencode%'"` |
| 监听套接字 | `netstat -ano \| findstr 55434` |
| `OPENCODE_SERVER_PASSWORD` 等变量名 | `app.asar`（`rg -a -o "OPENCODE_[A-Z_]+"`） |
| `spawning sidecar` 代码字面量 | `app.asar`（`rg -a -o "spawning sidecar.{0,120}"`） |
| message 表结构 | `opencode.db` → `sqlite_master` |
| 免费调用样本 | `opencode.db` → `message` / `part`（ID 见 §3.2、§3.4） |
| 出站 URL / headers / body | `opencode.db` → `message.data.error.data.{metadata.url,responseHeaders,responseBody}` |
| 重试帧 | `opencode.log`（`_retryWithExponentialBackoff`） |
| 洁净室复现 | Lead 实测；`10-POSITIVE-RESULT.md` §2 |

---

## 9. 边界与说明

- 本报告未执行任何推理请求、未重启/未杀进程、未修改任何文件。
- `OPENCODE_SERVER_PASSWORD` 的值未读取、未输出、未落盘。
- 运行中实例 `55434` 的端口与口令**随每次启动变化**，不可硬编码；复现脚本必须先动态取端口。
- DB 已被 prune（仅 67 session / 9,260 条 opencode assistant），故 §3.5 与 §7.1 的 DB 时间是**下界**；日志覆盖更早（2026-09-01 起）。
- §4 对 Lead 预填结论做了修正：出站 URL/headers/body **在失败路径上完整落库**（成功路径不落）。
- 免费额度的具体上限值**未在本机任何文件或日志中找到**（无 `quota` 数值、无 `free tier` 字样、无 `FreeTierError`）；可观测到的唯一额度事件是 `go_upsell_last_seen_at` 时间戳。
