# ocfree-client — OpenCode 免费层高频客户端

直连 / 代理池 / 多模型轮转 / 模型级熔断，专为**高频持续调用**设计。

```
node ocfree_client.mjs --help
```

---

## 实测结果（本机，2026-10-16）

| 场景 | 结果 |
|---|---|
| 60s / 16 并发 / 2 出口 / 2 模型 | **165/165 成功（100%）**，2.65 req/s，输出 130 tok/s |
| 45s / 6 并发 / 2 出口 / 3 模型 | 14/14 成功，0 失败 |
| 单次直连 | 200 |
| 单次 `http://` CONNECT 代理 | 200 |
| 单次 `socks5://` 代理 | 200 |
| `@file` 代理列表（2 节点） | 4/4 成功，两节点各 2 |
| 持续模式时长精度 | 目标 45s → 实际 47.7s（在途请求到点即切） |

## 代理配置

默认**直连**。指定 `--proxy` 即走代理，支持多节点池：

```bash
# 单节点
--proxy http://127.0.0.1:7897
--proxy socks5://127.0.0.1:7897

# 多节点池（逗号分隔）—— 轮转 + 故障转移 + 独立连接池
--proxy "http://127.0.0.1:7897,socks5://127.0.0.1:7897"

# 从文件读（每行一个，可用 # 注释）
--proxy @proxies.txt
```

支持 `http://` `https://` `socks5://` `socks5h://`，可带认证：`socks5://user:pass@host:port`。

Clash Verge Rev 的 `mixed-port: 7897` 同时接受 HTTP CONNECT 与 SOCKS5，两种写法都可用；
`socks5h://` 表示由代理解析域名（推荐，避免 DNS 泄漏）。

## 常用命令

```bash
# 单次
node ocfree_client.mjs --once -m longcat-2.5-preview-free --prompt "你好"

# 固定条数 + 高并发 + 多模型轮转
node ocfree_client.mjs -n 500 -c 32 -m longcat-2.5-preview-free,deepseek-v4.1-flash-free

# 持续跑 1 小时，全模型耗尽时自动等到额度重置
node ocfree_client.mjs --duration 3600 -c 24 -m longcat-2.5-preview-free,deepseek-v4.1-flash-free

# 限速 5 req/s
node ocfree_client.mjs --duration 600 -c 8 --rps 5 -m longcat-2.5-preview-free

# 提示词文件（每行一条）+ 明细落盘
node ocfree_client.mjs -n 1000 -c 16 --prompts prompts.txt --jsonl out.jsonl -m longcat-2.5-preview-free
```

## 可用性机制

- **连接预热**：启动时按并发数预建 keep-alive 连接，跳过首请求握手开销
- **模型级熔断**：某模型返回 429 → 立刻标记为「当日耗尽」并切换到下一个模型，不空等
- **故障转移**：429 不计入重试惩罚，直接换模型重试
- **额度等待**：所有模型都耗尽时，读取 `retry-after` 精确等到重置时刻（默认开启，`--no-wait` 关闭）
- **代理节点健康**：传输层失败（CONNECT/SOCKS5/ECONNRESET/超时）→ 节点冷却 60s 并切走
- **硬性总时限**：`--timeout` 从请求发出即计时，防止上游半开连接挂死 worker
- **优雅收尾**：Ctrl-C 或 `--duration` 到点后打印完整汇总

## 额度模型（重要）

- 额度按 **自然日** 计算，`retry-after` 指向 **00:00 UTC = 北京时间 08:00**
- **所有免费模型共用同一个每日桶**（实测：本机调用次数为 0 的 `big-pickle`、
  `nemotron-3.5-super-vl-free` 与打了 6000 次的 `mimo-v2.6-flash-free` 同时 429，
  且 `retry-after` 指向同一重置点）。换出口 IP **不会**刷新额度。
- 因此 **多模型轮转** 的意义是：把请求摊到「还有余量的模型」上，而不是「成倍放大总量」——
  总量由共用桶决定。桶打满只能等次日 08:00（北京）。
- 不同模型状态不同：部分模型返回 429（额度耗尽），部分返回 **403**（地区门禁，与额度无关）
- 每次调用固定开销约 **9,500 input tokens**（必须携带完整 agent 结构 body，精简会被 403）

## 已知限制

- `nemotron-3-ultra-free` 上游极慢/易挂（实测单次 44s ~ 303s），不建议放进高频轮转
- 部分模型（如 `cat-jam-free`、`muse-spark-1.3-contributor-free`）稳定 403
- 脚本不读取 OpenCode IDE 的任何状态，可在 IDE 关闭时独立运行

## 附带的诊断脚本

| 脚本 | 用途 |
|---|---|
| `quota_probe.mjs` | 逐个模型探测当前是 200 / 429 / 403 |
| `ratelimit_probe.mjs` | 打印 429 的完整响应头（含 `retry-after`） |
| `window_probe.mjs` | 多次采样验证额度重置点语义 |

## 请求形状（脚本已内置）

```
POST https://opencode.ai/inference/v1/chat/completions
user-agent: opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24
x-opencode-client: desktop
x-opencode-project: global
x-opencode-request: msg_<...>
x-opencode-session: ses_<12 hex 末三位 ∈ [0xfc0,0xfff]><14 base62>
x-opencode-session-id: <同上，可选>
body: 完整 agent 结构（system prompt + tools + stream + stream_options.include_usage）
```

### 门禁 5 条（100+ 次单变量消融实测）

| # | 判据 | 违反后果 |
|---|------|----------|
| 1 | `user-agent` 匹配 `^opencode/v?<版本>`，**大小写不敏感** | 403 |
| 2 | UA 版本 **≥ 1.18.0** | **426**（不是 403） |
| 3 | `x-opencode-session` = `ses_` + 12 hex + 14 base62（**必需**） | 403 |
| 4 | 12 hex 段低 12 位 ∈ `[0xfc0, 0xfff]`（先看 `session-id`，无则看 `session`） | 403 |
| 5 | `body.stream === true` + 完整 agent body | 403 |

**可选**：`x-opencode-session-id`（可完全不要；给了就必须合法）、`authorization`（`Bearer public` 可省）、
`x-opencode-request` / `x-opencode-client` / `x-opencode-project`。

> ⚠️ **2026-10-17 修正**：早期版本把 `x-opencode-session-id` 写成必需——实测**可以完全删掉**；
> 同时漏掉了 UA 的 **1.18.0 最低版本**要求（那条违反时返回 **426**）。
> 复现脚本：[`../04-门禁判别实验/verify_recipe*.mjs`](../04-门禁判别实验/)。

