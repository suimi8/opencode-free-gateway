# 05-引擎与运行时探针

用于回答一个问题的取证脚本集合：**403 到底是「请求形状」问题，还是「运行环境 / 传输层」问题？**
结论是前者——本目录的每个探针都排除了一个环境假设。

> 汇总见 [`../03-分析报告/03-runtime-evidence.md`](../03-分析报告/03-runtime-evidence.md)
> 与 [`../03-分析报告/05-request-chain.md`](../03-分析报告/05-request-chain.md)。

## 引擎启动 / 隔离实例

| 文件 | 说明 |
|------|------|
| `engine_boot.mjs` / `engine_boot.js` | 启动一个**完全隔离**的引擎实例（独立端口 + 独立 XDG 目录），用来观察免费层行为。⚠️ 会在本目录下创建 `enginestate\` 临时状态目录 |
| `engine_boot2.mjs` | 同上，但**带 fetch 日志**，用于捕获引擎真实的出站免费层请求（这是 `captured_body.json` 的来源） |
| `iso_engine_test.mjs` | 向隔离实例发匿名免费层调用，看是否成功（端口 `19991`，Basic `opencode:testpass`） |
| `engine_side_probe.js` | 从**引擎自己的 shell 内部**（sidecar 进程的子进程）发探针：门禁是关于进程/网络路径，还是关于进程内 HTTP 栈？ |
| `official_path.js` | 测试外部文档里找到的**官方路径**（`/inference/openai/v1/chat/completions` 等） |

## 传输层指纹排除

| 文件 | 说明 |
|------|------|
| `cdp_probe.js` | 用**真实 Chromium（BoringSSL）**传输栈发请求：如果 403 是 TLS 指纹导致，真 Chromium 就不该被拒 → 实测仍 403，排除 |
| `electron_probe.js` | 在 Electron 自己的 Node 运行时下（`ELECTRON_RUN_AS_NODE=1`）发请求 → 排除运行时假设 |
| `catalog_live.js` | 抓客户端真正使用的**线上模型目录**，检查 opencode provider 的 endpoint 配置 |

## 读用户本机引擎（只读）

| 文件 | 说明 |
|------|------|
| `read_env.ps1` | **读另一个进程的环境块**（同用户、只读，PEB walk），目的是取回用户自己那个正在运行的 OpenCode sidecar 的 `OPENCODE_SERVER_PASSWORD`。被下面几个脚本 `dot-source` 复用 |
| `sidecar_query.ps1` | 用取回的凭据查询**用户自己的**本地引擎：先只读（`/config`、`/provider`、`/app`、`/doc`） |
| `sidecar_schema.ps1` | 查看引擎 API schema 与 provider 列表，然后建一个一次性 session |
| `provider_truth.ps1` | 地面真值：把引擎**内存里**的 `opencode` provider 条目原样 dump 出来 |
| `engine_shell.ps1` / `engine_shell2.ps1` | 在引擎进程的 shell 上下文里执行命令（复用 `read_env.ps1` 的类型定义） |
| `positive_test.ps1` | **正向测试**：让用户本机的 OpenCode 引擎自己发一次免费层调用（建一次性 session → 发一句短 prompt → 删掉 session） |

## 用法

```powershell
cd "05-引擎与运行时探针"
node engine_boot2.mjs 19991      # 起隔离实例并记录 fetch
node iso_engine_test.mjs         # 探测该隔离实例
node cdp_probe.js                # Chromium 传输指纹对照
powershell -ExecutionPolicy Bypass -File .\sidecar_query.ps1   # 只读查询用户本机引擎
```

## 注意

- `read_env.ps1` 只**读**环境变量，不修改目标进程；这是同用户权限下的常规操作。
- `positive_test.ps1` 会在用户本机引擎上**创建一个 session 然后删除**，并在服务端留下一条真实调用记录。
- `engine_boot*.mjs` 会导入 [`../99-解包产物与运行时残留/`](../99-解包产物与运行时残留/) 里解包出的 38 MB 引擎 bundle；**该目录被删掉后这三个脚本就跑不了**（其余脚本不受影响）。
- 全部脚本已改为自相对路径（`import.meta.dirname` / `$PSScriptRoot`），可从任意工作目录运行。
