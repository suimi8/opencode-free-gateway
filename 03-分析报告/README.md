# 03-分析报告

11 份报告，按「谁写的 / 解决什么问题」分层。**建议阅读顺序：先看 `10`，再看 `00`。**

> 📁 **路径说明**：本目录内所有路径均已改为**相对项目根目录**的形式
> （原 `%TEMP%\ocfree\...`、`%TEMP%\ocdesk\...` 已按迁移表映射到现位置）。
> 指向**本机 OpenCode 安装/状态**的路径已改写为环境变量形式
> （`%LOCALAPPDATA%\Programs\@opencode-aidesktop`、`%USERPROFILE%\.local\share\opencode\...` 等），
> 不含任何用户名。旧→新对照见 [`../README.md`](../README.md) 的迁移表。

## 先读这两份

| 报告 | 大小 | 说明 |
|------|------|------|
| [`10-POSITIVE-RESULT.md`](10-POSITIVE-RESULT.md) | 20 KB | **正向结果**：完整可复现的最小配方 + 逐字捕获的真实请求（§2）+ `body.stream===true` 补遗。**从这里开始** |
| [`00-SYNTHESIS.md`](00-SYNTHESIS.md) | 29 KB | Lead 综合：把 4 个子代理的结论收敛成一份完整结论 |

## 子代理报告（4 份，各自独立取证）

| 报告 | 大小 | 负责的角度 |
|------|------|-----------|
| [`01-core-free-gate.md`](01-core-free-gate.md) | 29 KB | **门禁核心**：403 `FreeTierError` 的 4 条判据怎么钉出来的（约 60 次对照实验） |
| [`02-ui-and-gating.md`](02-ui-and-gating.md) | 29 KB | **UI 与门禁**：客户端界面里免费模型怎么展示、怎么被 gate 住 |
| [`03-runtime-evidence.md`](03-runtime-evidence.md) | 36 KB | **运行时证据**：进程/环境/运行时/传输层指纹的排除过程 |
| [`04-external-docs.md`](04-external-docs.md) | 26 KB | **外部文档**：官方文档原话、免费层政策、模型清单来源 |

## 请求链与流量（3 份）

| 报告 | 大小 | 说明 |
|------|------|------|
| [`05-request-chain.md`](05-request-chain.md) | 30 KB | 一次免费调用从 UI 到上游的完整链路 |
| [`06-live-traffic.md`](06-live-traffic.md) | 14 KB | 实网流量分析（含 `x-zen-model`、`x-opencode-endpoint-id` 等响应头） |
| [`07-local-server-path.md`](07-local-server-path.md) | 23 KB | 本地引擎 HTTP 服务路径（`127.0.0.1:55434`，Basic 认证） |

## 上游鉴权（1 份，最大）

| 报告 | 大小 | 说明 |
|------|------|------|
| [`08-upstream-auth.md`](08-upstream-auth.md) | 60 KB | 上游鉴权与免费通道的完整分析：`Bearer public` 匿名通道、session 形状、额度模型 |
