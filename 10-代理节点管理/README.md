## ⬇ 内核安装（两种方式，都支持）

**方式 A：面板里点**（推荐）

启动面板 → 左侧「代理订阅」→ 顶栏 **「⬇ 一键安装内核」**。
带实时进度条，国内网络自动回退镜像，装完自动可用。

**方式 B：命令行**

```bash
node install-core.mjs                 # 下最新版
node install-core.mjs --check         # 只看状态（未装退出码 1）
node install-core.mjs --tag v1.19.32  # 指定版本

# 走镜像（GitHub 直连慢/被墙时）
MIHOMO_MIRROR='https://ghproxy.net/{}' node install-core.mjs

# 用已有内核（比如 Clash Verge 自带的）
MIHOMO_BIN="C:\Program Files\Clash Verge\verge-mihomo.exe" node install-core.mjs

# 内核放哪也能改（桌面版/Docker 用这个把内核放进数据目录）
MIHOMO_RUNTIME=/app/data/mihomo node install-core.mjs
```

> 内核装在 `MIHOMO_RUNTIME`（默认本目录的 `runtime/`）。
> mihomo 是 **GPL-3.0**，与本仓库 MIT 相互独立，故不入库、运行时下载。

---
# 10 · 代理节点管理（独立 mihomo 实例 + 节点池）

把两个机场订阅变成**只有模型请求才走**的出口节点池：每日轮换、24h 租约、请求前连通性验证。
**你的浏览器、系统代理、Clash Verge 完全不受影响。**

---

## 为什么是「另起一个实例」而不是用你的 Clash Verge

| 原因 | 说明 |
|---|---|
| 控制器够不着 | 你的 Clash Verge 用的是 **named pipe** 控制器（`external-controller: ''`），TCP 端口没开，外部程序指挥不动 |
| 会串台 | 就算够得着，改它的节点会**连带改掉你浏览器的出口 IP** —— 你明确要求网页不走这些节点 |
| 独立实例 | 自己的配置 / 端口 / 订阅缓存 / 控制器，只本机可连（`allow-lan: false` + `bind-address: 127.0.0.1`） |

实测隔离性：浏览器出口 `154.7.183.73`（Clash Verge 的节点），节点池出口 `42.2.28.74`（池子节点）—— **两者无关**。

---

## 目录

| 文件 | 说明 |
|---|---|
| `subscriptions.json` | 订阅链接 + 端口/租约参数（含 token，勿外传） |
| `config.template.yaml` | mihomo 配置模板（DNS、出站网卡绑定等关键项） |
| `mihomo.mjs` | 内核生命周期 + 控制器 API + 订阅文件解析 + 真实隧道探测 |
| `pool.mjs` | **节点池**：24h 租约、可用/失效标记、每日轮换、验证缓存 |
| `manage.mjs` | 命令行：status / nodes / test / verify / rotate / switch / events / refresh |
| `runtime/` | mihomo.exe、生成的 config.yaml、订阅缓存、日志、`pool.db` |

---

## 快速使用

```powershell
cd "D:\source code\源码\opencode免费层逆向与网关\10-代理节点管理"

node manage.mjs start      # 启动独立实例
node manage.mjs test       # 全池测速（写回延迟，用于排序）
node manage.mjs status     # 看当前节点、延迟、出口 IP、剩余租约
node manage.mjs verify     # 真实隧道探测当前节点
node manage.mjs rotate     # 手动轮换到下一个可用节点
node manage.mjs nodes      # 节点清单（--all 含被剔除的）
node manage.mjs events 20  # 租约/轮换/失效事件
```

面板启动时会**自动拉起**这个实例并启动定时轮换器，一般不用手动跑。

---

## 三个必须踩过的坑（都已解决，改配置时别改回去）

### 1️⃣ 出站必须绑定物理网卡，否则全部节点 502

本机 Clash Verge 的 **TUN 是开着的**（`auto-route: true`），两条默认路由 metric 都是 0，
```powershell
192.168.1.1  metric=0  ifIndex=20  WLAN     ← 物理网卡
198.18.0.2   metric=0  ifIndex=3   Meta     ← Clash Verge TUN
```
Meta 抢到了流量 → 本实例的出站也被吞进 Clash Verge 的隧道 → **双层代理** →
`dial ... connect error: EOF / context deadline exceeded`，且**每个节点都精确卡在 5000ms 后 502**。

**解法**：`proxy-providers[].override.interface-name = "WLAN"`（`mihomo.mjs` 的 `detectInterface()` 自动探测）。
绑定后 **76/79 节点可达，最快 43ms**。

> 换网络（网线/WiFi）后网卡名会变，`detectInterface()` 会自动重探；也可以在
> `subscriptions.json` 的 `_参数.interfaceName` 里写死。

### 2️⃣ 必须有 `proxy-server-nameserver`

TUN 的 `dns-hijack: any:53` 让**系统 DNS 返回 fake-ip**（`198.18.x.x`）。
如果 mihomo 用 fake-ip 去连机场服务器，一样全挂。
配置里用了 **IP 字面量的 DoH**（`https://223.5.5.5/dns-query`）放在 `proxy-server-nameserver`，无需 bootstrap 也不会被污染。

### 3️⃣ 订阅里混着「广告占位节点」，必须剔除

机场会在 `proxies:` 里塞广告条目：

```yaml
- { name: '一元机场.asia', type: trojan, server: 0.0.0.0, port: 443, ... }   # server 是 0.0.0.0！
```

它们进池子只会浪费尝试次数（而且分组默认就可能选中它们 → 真实 dial 打到 `0.0.0.0:443`）。
`providerNodes()` 按 `server` 无效 + 名字像官网/续费/客服 剔除，**实测 83 个里剔掉 4 个**。

> 另一种坑：不同机场的订阅 YAML **写法不同** —— 有的是流式 `- { ... }`，
> 有的是块式 `-\n  name: ...`。只认一种会漏掉大半个池子（解析器两种都认）。

---

## 24h 租约规则（按需求实现）

```
节点被启用 ──► status=in_use，lease_until = now + 24h
                 │
                 ├── 租约期内：不再被选中，出口 IP 稳定；请求前只做连通性验证（缓存 120s）
                 │
                 └── 租约期满：status=available，**回到可用池**，同时切到下一个可用节点
                              且轮换时**排除刚释放的那个**，保证出口 IP 真的变了
```

- **验证失败** → `status=dead`，冷却 6h（`NODE_DEAD_MS`），不参与选取
- **同一时刻只有一个出口节点**：轮换时旧节点立刻回池（否则可用数会越用越少）
- **请求前必验证**：每次模型请求前探测 `generate_204`；结果缓存 120s（`NODE_VERIFY_TTL_MS`），失败立刻轮换
- 参数都可用环境变量改：`NODE_LEASE_MS` / `NODE_DEAD_MS` / `NODE_VERIFY_TTL_MS` / `NODE_VERIFY_URL` / `NODE_TRY_LIMIT`

实测（8 秒租约的隔离测试）：

```
① 初始        总 83  有效 79  可用 79  租用 0
② 首次选取    🇭🇰香港 01  1078ms  出口IP 157.254.20.4   租用1 可用78
③ 立刻再请求  rotated=false  reason=cached  8ms   同一节点 ✅（租约内 IP 不变）
④ 过 9 秒     租用 0  可用 79   ← 租约满，自动回池 ✅
⑤ 再请求      轮换到新节点（旧节点被排除）✅
```

---

## 💥 额度耗尽也会切换节点（429 → 换出口 IP 重试）

上游返回 **429（额度耗尽）** 时，面板会**换一个出口节点、用新 IP 重试同一个请求**：

```
一次模型请求的实际过程：
05:34:03  429  R-日本-SoftBank-G2      → 切到 R-日本-SoftBank-G1（先验证 220ms）
05:34:04  429  R-日本-SoftBank-G1      → 切到 🇯🇵日本 03（验证 377ms）
05:34:05  429  🇯🇵日本 03              → 切到 🇯🇵日本 05（验证 354ms）
05:34:07  429  → 到上限，把 429 返回给客户端
```

一次请求最多换 **3** 个出口（`QUOTA_ROTATE_LIMIT`），每次切换前都会**先验证新节点连通**。

### 额度记忆 + 防烧池护栏

每个节点记 `quota_fail_at`。某节点在窗口内撞过 429 就排到候选末尾（**不是禁用**，池子有限）。

**关键护栏**：如果额度窗口内**已经没有没撞过 429 的节点**了，就**停止轮换**并如实返回 429 ——
因为那说明额度是所有出口共享的（实测确认），继续换只是白烧节点池。

实测（隔离库）：

| 场景 | 结果 |
|---|---|
| 标记 3 个节点撞过 429 | 没撞过 76 → ✅ 仍能切换，切到 🇭🇰香港 04 |
| 标记**全部** 79 个 | 没撞过 0 → ✅ **正确停止** `all-nodes-quota-hit`，出口未变，租用中仍只有 1 个 |
| 窗口过期 | 没撞过恢复 79 → ✅ 又能切换 |

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `QUOTA_ROTATE_LIMIT` | `3` | 单次请求因 429 最多换几个出口 |
| `NODE_QUOTA_COOLDOWN_MS` | `1800000`（30 分） | 额度记忆窗口；窗口内撞过 429 的节点排到末尾 |

模型请求**成功**时会自动清掉当前节点的额度记忆（`onModelSuccess`）。

---

## 面板集成

`01-管理面板/proxy-pool.mjs` 是适配层：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `PANEL_NODE_POOL` | `1` | `0` 关闭节点池，退回渠道里手填的代理地址 |
| `PANEL_NODE_POOL_PROXY` | 池子 mixed-port | 直接指定出口代理串 |
| `NODE_POOL_CHECK_MS` | `900000` | 定时轮换器的检查间隔（15 分钟） |

**关键**：节点池只替换 `upstream.mjs` 那一次出站调用的代理参数，
**不碰系统代理、不碰 TUN、不碰其它任何进程**。

管理 API：

| 端点 | 说明 |
|---|---|
| `GET /api/proxy-pool` | 状态：当前节点、租约剩余、出口 IP、池子统计、是否与 mihomo 同步 |
| `GET /api/proxy-pool/nodes` | 节点清单（`?all=1` 含被剔除的） |
| `GET /api/proxy-pool/events` | 租约/轮换/失效事件 |
| `POST /api/proxy-pool/rotate` | 立即轮换 |
| `POST /api/proxy-pool/verify` | 真实隧道探测当前节点 |
| `POST /api/proxy-pool/test` | 全池测速 |
| `POST /api/proxy-pool/refresh` | 重拉订阅 |
| `POST /api/proxy-pool/instance?on=0\|1` | 启停独立实例 |

---

## 端口

| 用途 | 端口 |
|---|---|
| 本实例 mixed-port（HTTP + SOCKS5） | **17897** |
| 本实例控制器（带 secret） | **19097** |
| 你的 Clash Verge mixed-port | 7897（**未改动**） |

---

## 合规与风险

- 订阅链接含你的机场 token，`subscriptions.json` **不要外传/不要提交到公开仓库**
- 这些节点是你自己订阅的，用于让模型 API 请求换出口。请遵守机场与上游服务的使用条款
- 节点池只服务本机面板（`allow-lan: false`），不要暴露到公网
