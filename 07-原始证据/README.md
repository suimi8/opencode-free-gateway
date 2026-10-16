# 07-原始证据

**未经加工的原始抓取物**。内容保持抓取当时的原样，但**路径已全部改为自相对形式**
（`data\p*.js` / `q*.js` 里的 `models.json` 改为从 `os.homedir()` 推导 + `$OPENCODE_MODELS` 覆盖）。

## 顶层

| 文件 | 说明 |
|------|------|
| `engine_http.jsonl` | 引擎出站 HTTP 的 JSONL 抓取。⚠️ **只有 2 条记录（393 B）**，被后续一次运行截断了。**权威的逐字捕获请求体在** [`../03-分析报告/10-POSITIVE-RESULT.md`](../03-分析报告/10-POSITIVE-RESULT.md) **§2**，以及 [`../04-门禁判别实验/captured_body.json`](../04-门禁判别实验/captured_body.json) |

## `raw/` — 官方站点与 API 的抓取存档（49 个文件）

| 分组 | 文件 | 说明 |
|------|------|------|
| 官方文档页面 | `01.html`–`11.html` + 对应 `.txt` | 文档页 HTML 与其纯文本版 |
| 线上实时页面 | `live_*.html` / `live_*.txt` | `opencode.ai` 的 console / models / go / api / v2 各页面的实时抓取 |
| 文档源码（MDX） | `mdx_console_*.txt`、`mdx_models_mdx.txt` | 文档站的 MDX 源文本——免费层「只能在 OpenCode 内使用」的原话出处 |
| 模型清单 JSON | `free_models.json`、`go_models.json`、`tree.json` | 免费模型清单 / Go 套餐清单 / 目录树 |
| 仓库元数据 | `repo_anomalyco_opencode.json`、`repo_sst_opencode.json` | 上游仓库 API 响应（含仓库搬迁 `sst` → `anomalyco` 的证据） |
| 其它 | `21.html`–`24.html` | 追加抓取的页面 |

## `data/` — 导出的结构化数据与一次性探针

| 文件 | 说明 |
|------|------|
| `opencode-models.txt` | 线上模型目录导出（68,784 B） |
| `free-summary.txt` | 免费层相关条目摘要（13,539 B） |
| `p1.js`–`p3.js`、`q5.js`、`q6.js` | 一次性探针脚本（当时用来快速验证某个假设） |

## 注意

- 这些是**证据**，不是可运行的工具。需要跑实验请用 [`../04-门禁判别实验/`](../04-门禁判别实验/)。
- 文件里出现的 `%TEMP%\ocfree\...`、`%TEMP%\ocdesk\...` 是**抓取当时**的路径，已随归集失效；
  现位置见 [`../README.md`](../README.md)。
