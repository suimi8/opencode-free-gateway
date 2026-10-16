# 04-门禁判别实验

100+ 次**对照实验**，把 403 `FreeTierError` 的触发条件钉死成 **5 条**请求形状条件。
所有脚本都以 [`captured_body.json`](captured_body.json) 为基准请求体。

> 结论汇总见 [`../03-分析报告/10-POSITIVE-RESULT.md`](../03-分析报告/10-POSITIVE-RESULT.md)，
> 完整推导见 [`../03-分析报告/01-core-free-gate.md`](../03-分析报告/01-core-free-gate.md)。

## 基准文件

| 文件 | 说明 |
|------|------|
| `captured_body.json` | **真实捕获的完整 agent 请求体**（38,763 字符 / 39,185 B）：system prompt ≈ 12.9 KB + 12 个 tools ≈ 25.3 KB。所有实验的起点，也是 `01`/`02` 两个目录里 `body_template.json` 的来源。 |

## 最终判定脚本（`verify_recipe*.mjs`，2026-10-17）

这 5 个是**结论脚本**，直接把「最小配方」跑出来。想要权威答案就跑它们，不用看前面的历史 bisect。

| 脚本 | 解决的问题 |
|------|-----------|
| `verify_recipe.mjs` | 第一轮：从可用基线出发，**每个变体只破坏一个条件**（10 个变体）。发现 `session-id` 可删 |
| `verify_recipe2.mjs` | 第二轮：`session-id` 是否完全不校验、low12 边界、UA 大小写（11 个变体）|
| `verify_recipe3.mjs` | 第三轮：隔离两个 session 头各自被校验什么（10 个变体）|
| `verify_recipe4.mjs` | 第四轮：修正边界归属 + UA 版本号 —— **发现 426 这第 5 个条件**（12 个变体）|
| `verify_recipe5.mjs` | 第五轮：钉死 UA 最低版本 **1.18.0** 这个边界（9 个变体）|
| `verify_minimal.mjs` | **压到最小**：实测只需 **2 个请求头**（`user-agent` + `x-opencode-session`），连 `content-type` 都能省；body 仍必须完整 |

## 历史二分脚本

| 脚本 | 解决的问题 |
|------|-----------|
| `replay.mjs` | 把捕获到的引擎请求**逐字重放**，先确认可复现的 200（V0 基线） |
| `control.mjs` | **关键对照**：门禁是否有状态？连续多次重放同一 V0 请求 |
| `prove_real.mjs` | 用「真实完整 8 头」从**普通 Node 进程**（不在引擎进程内）直接发请求 → 证明与进程无关 |
| `bisect.mjs` | 哪个 `x-opencode-*` 头是必需的？头的**值格式**重要吗？ |
| `bisect2.mjs` | 解开 2×2 矩阵：`x-opencode-*` 的值被真校验，还是 body 才是门禁？ |
| `bisect3.mjs` | 从可复现的 V0 出发，**一次只改一个变量**做二分 |
| `bisect4.mjs` | 钉住剩下两条：是 system prompt（body）还是 id 的精确格式？ |
| `bisect5.mjs` | id 的哪一段被校验：12 hex 时间戳前缀，还是随机尾巴？ |
| `bisect6.mjs` | 12 hex 前缀是**新鲜度**检查吗？在真实值附近探 delta |
| `bisect7.mjs` | 找 12 hex 前缀上的阈值 T |
| `bisect8.mjs` | 收窄时间戳的「新鲜窗口」 |
| `bisect9.mjs` | 对 12 hex 前缀的精确阈值 T 做**二分查找** |
| `bisect10.mjs` | 判决性实验：门禁是不是**字面上**就是 session-id 的低 12 位？ |
| `bisect11.mjs` | 钉边界，再用**伪造的 session id** 推导最小可用配方 |
| `bisect12.mjs` | 复核低 12 位范围边界与最小必需头集合 |
| `bisect13.mjs` | 钉精确阈值：`0xfd0` / `0xfdf` / `0xfe0` / `0xfe1` |
| `bisect14.mjs` | 精确二分低 12 位边界 |
| `sesids.mjs` | 反查 id 生成器：批量建 session，观察 12 hex 块的低位分布（发现恒为 `0xffe`） |
| `sweep.js` | 大范围变体扫描 |
| `ua_probe.js` | `user-agent` / 头形状变体，含长 channel UA 形式 |

## 用法

```powershell
cd "04-门禁判别实验"
node verify_recipe5.mjs        # 结论脚本：钉 UA 最低版本（最快得到权威答案）
node prove_real.mjs            # 历史脚本：普通进程复刻形状 → 200
node bisect14.mjs fe0 fe1      # 指定低 12 位边界值
```

> 全部脚本已改为**自相对路径**（`import.meta.dirname`），可从任意工作目录运行。
> ⚠️ 这些脚本会真实打到上游接口，会消耗**共享每日额度**，且会向对方留下请求记录。
> 请只在确有需要时运行（`verify_recipe5.mjs` 里有 6 个 200，约 6 万 tokens）。

## 5 条判据（最终结论）

| # | 判据 | 违反后果 |
|---|------|----------|
| 1 | `user-agent` 匹配 `^opencode/v?<版本>`，**大小写不敏感**，版本至少两段 | 403 |
| 2 | UA 里的版本 **≥ 1.18.0** | **426** |
| 3 | `x-opencode-session` = `ses_` + 12 hex + 14 base62（**必需**） | 403 |
| 4 | 12 hex 段低 12 位 ∈ `[0xfc0, 0xfff]`（先看 `session-id`，没有才看 `session`） | 403 |
| 5 | **`body.stream === true`** | 403 |
| 6 | **`tools` 里必须有一个 `function.name === "read"` 的工具（区分大小写）** | 403 |

**可删**：`authorization`、`x-opencode-request`、`x-opencode-client`、`x-opencode-project`、`stream_options`、
**`content-type`**、**opencode 的 system prompt**、**除 `read` 之外的 11 个工具**。
**`x-opencode-session-id` 可以完全不要**——但一旦提供就必须满足判据 3+4（塞垃圾 → 403）。

### 第 6 条是怎么挖出来的（隔离实验）

| 变体 | 结果 |
|---|---|
| 完整 agent body（38,763 字符 / 12 tools） | ✅ 200 |
| system **200 字符** + 12 个原始 tools | ✅ **200** ← system prompt 长度无关 |
| **只有 `read`**（手搓、空参数，body 348 字符） | ✅ **200** |
| `tools: []` / system 29,000 字符填充 + `tools: []` | ❌ 403 |
| 12 tools 去掉 **`read`** | ❌ 403 |
| 12 tools 去掉 `bash` / `write` / `edit` / `glob` / `grep` / `question` | ✅ 全部 200 |
| 只有 `bash` / 只有 `write` | ❌ 403 |
| 12 个同名工具重复 / 12 个假名工具 | ❌ 403 |
| 真 `read` 改名 `readx` | ❌ 403 |
| 工具名 `Read`（大写） | ❌ 403 |

**所以最小 body = `{model, stream:true, messages:[...], tools:[{...name:"read"...}]}`，实测 348 字符、279 prompt tokens。**

### 最小可用请求（实测 200）

```http
POST https://opencode.ai/inference/v1/chat/completions
user-agent: opencode/1.19.2
x-opencode-session: ses_ebcf32130ffe7wJ1T06CSp2AP5
```

```jsonc
{ "model": "deepseek-v4.1-flash-free", "stream": true,
  "messages": [{ "role": "user", "content": "Reply with exactly: PONG" }],
  "tools": [{ "type": "function", "function": { "name": "read", "description": "x",
              "parameters": { "type": "object", "properties": {} } } }] }
```

复现：`node verify_minimal.mjs`。

> ⚠️ **2026-10-17 修正记录**：早期文档写「4 条」，其中
> ① 误把 `x-opencode-session-id` 当成必需（实测删除后仍 200）；
> ② **漏了 UA 最低版本门禁**（返回 426，与形状门禁的 403 是两回事）。
> 两处都已在上面更正。
