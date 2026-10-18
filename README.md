> ## ⚠️ 重要：节点池会让免费层判定为滥用
>
> **实测结论（2026-10-18）**：开启代理节点池后，模型请求经机场节点 IP 出去，
> 上游会返回 `OpenCode's free models aren't available from your current network
> because we've detected abusive traffic`（地区/滥用双重判定），**所有节点都失败**。
>
> 关掉节点池、让网关直连（走本机 Clash Verge 出口）后：**3/3 成功，1.2–2.6 秒**。
>
> ```bash
> PANEL_NODE_POOL=0 PANEL_MODEL_DISCOVERY=0 node 01-管理面板/server.mjs
> ```
>
> `PANEL_MODEL_DISCOVERY` 也必须关：它每 30 分钟把上游 85 个模型全探一遍，
> 会被判为异常流量。
# OpenCode 免费层网关

[![CI](https://github.com/suimi8/opencode-free-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/suimi8/opencode-free-gateway/actions/workflows/ci.yml)
[![Release](https://github.com/suimi8/opencode-free-gateway/actions/workflows/release.yml/badge.svg)](https://github.com/suimi8/opencode-free-gateway/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=white)](package.json)

对 **OpenCode Desktop 1.19.2**（Electron）免费模型调用链的完整逆向工程成果，以及在此之上做出来的
**可直接部署的本地网关**：OpenAI / Responses 双协议互转、上游 free 模型动态发现、代理节点池、管理面板。

> 结论一句话：**免费层的"只能在 OpenCode 内使用"是一道纯请求形状门禁，不含签名、证书或设备绑定。**
> 只要复刻 6 条请求形状条件，任意进程（无需 IDE、无需 Electron、无需登录、无需密钥）都能直接调用。

---

## 🖥️ 桌面应用（下载即用，三平台）

不想装 Node、不想开命令行？直接下安装包，**双击运行**：

| 平台 | 文件 | 说明 |
|---|---|---|
| **Windows** | `OpenCode-Free-Gateway-<版本>-win-x64.exe` | **单文件便携版**，双击即用，不安装、不写注册表 |
| **Linux** | `OpenCode-Free-Gateway-<版本>-linux-x64.AppImage` | 下载后 `chmod +x` 再双击；另有 `.deb` |
| **macOS** | `OpenCode-Free-Gateway-<版本>-mac-arm64.dmg` / `-x64.dmg` | Intel 与 Apple Silicon 各一份 |

全部在 [**Releases**](https://github.com/suimi8/opencode-free-gateway/releases) 页面。

**应用是什么样**：一个原生窗口（不是浏览器标签页），带托盘图标和菜单栏：

```
┌─ OpenCode 免费层网关 ────────────────────────┐
│  ┌────────┬──────────────────────────────┐  │
│  │ 概览    │   渠道 / 令牌 / 日志 / 统计    │  │
│  │ 渠道    │   模型动态发现 / 协议互转       │  │
│  │ 令牌    │   代理节点池（可选）            │  │
│  │ 日志    │                              │  │
│  └────────┴──────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

| 特性 | 说明 |
|---|---|
| 自动选端口 | 优先 8790，被占用就自动换一个空闲端口，不会和已在跑的面板冲突 |
| 单实例 | 重复双击只会把已有窗口叫到前面，不会起两个 |
| 托盘菜单 | 显示/隐藏窗口 · 在浏览器打开 · 打开数据目录 · 查看日志 · 退出 |
| 数据位置 | Windows `%APPDATA%\opencode-free-gateway` · macOS `~/Library/Application Support/opencode-free-gateway` · Linux `~/.config/opencode-free-gateway` |
| 服务隔离 | 面板跑在**子进程**里，它崩了不会带走窗口，并会弹窗给出日志尾部 |
| 完全自包含 | 代理内核也能在界面里一键装（「代理订阅」→「⬇ 一键安装内核」），装完不用开命令行 |
| 安全 | `contextIsolation` + `sandbox` 开启、`nodeIntegration` 关闭，外链一律交给系统浏览器 |

> **macOS 未签名**：首次打开请 **右键 → 打开**（或在「系统设置 → 隐私与安全性」里允许）。
> 没有 Apple 开发者证书，做不了公证，这是唯一的影响。

### 自己构建桌面应用

```bash
npm ci
npm run make-icon     # 可选：重新生成图标（需要 Python + Pillow）
npm run desktop       # 开发模式跑起来（Ctrl+Shift+I 开 DevTools）
npm run dist:win      # Windows  → 单文件便携 exe
npm run dist:linux    # Linux    → AppImage + deb
npm run dist:mac      # macOS    → dmg + zip（x64 / arm64）
```

> Electron 的原生包**最好在各自平台上打**（macOS 的 dmg 必须在 macOS 上构建）。
> CI 里用三个 runner 分别构建，见 [`.github/workflows/desktop.yml`](.github/workflows/desktop.yml)。

<details>
<summary>⚠️ 一个坑：<code>ELECTRON_RUN_AS_NODE</code>（排查用）</summary>

如果你从**已经设置了 `ELECTRON_RUN_AS_NODE=1` 的父进程**里启动 Electron，
它会退化成纯 Node 运行，于是出现这种莫名其妙的报错：

```
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
```

启动前把该环境变量清掉即可。普通用户双击 exe 不会遇到（他们的环境里没有这个变量）。

</details>

---

## 🚀 从源码运行

**唯一依赖是 Node.js ≥ 22.5**（用到内置的 `node:sqlite`）。**零第三方依赖**，不需要 `npm install`。

```bash
git clone https://github.com/suimi8/opencode-free-gateway.git
cd opencode-free-gateway

node --version                    # 需 >= 22.5
node 01-管理面板/server.mjs        # 启动面板
```

打开 **<http://127.0.0.1:8790/>** ，初始密码 `admin123`（**请立刻修改**）。

### ⚠️ 首次启动是**空的** —— 一切由你自己填

本项目**不内置任何渠道、模型清单、订阅或下载镜像**。新装的面板里没有上游地址、
没有模型名、没有节点 —— 因为那些值一旦是程序塞进去的，出了问题就很难分辨
「这是我自己配的」还是「程序替我配的」。

第一次用按顺序做三步：

| 步骤 | 在哪做 | 填什么 |
|---|---|---|
| **1. 加渠道** | 「渠道管理」→ ＋ 添加渠道 | 名称、上游地址（`…/chat/completions` 完整地址）、API Key、**模型列表** |
| **2. 拉模型** | 同一个弹窗点 **「⤓ 从上游拉取模型」** | 用你刚填的地址拉一次自动填入（也可以手打，每行一个） |
| **3. 建令牌** | 「令牌管理」→ ＋ 新建令牌 | 拿到 `sk-oc-…`，就能当 OpenAI 兼容端点用 |

> 上游地址和模型名参考本仓库的[分析报告](03-分析报告/) —— 那是**文档**不是预置配置，
> 需要你自己复制进面板。

然后在「令牌管理」里建一个令牌，就可以当 OpenAI 兼容端点用了：

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer sk-oc-你的令牌" \
  -H "Content-Type: application/json" \
  -d '{"model":"space-bunny-free","stream":false,
       "messages":[{"role":"user","content":"说句你好"}]}'
```

### 自检

```bash
node tests/unit.mjs      # 35 项：协议互转纯逻辑，无需网络
node tests/smoke.mjs     # 13 项：面板 HTTP 层，无需网络/凭据
node scripts/check-syntax.mjs   # 全量语法 + 凭据泄漏扫描
```

### 🐳 Docker 部署

镜像发布在 **ghcr.io**（linux/amd64 + linux/arm64），也可以自己构建。

**方式 A：compose（推荐）**

```bash
cd opencode-free-gateway

# 默认模式：只跑面板
PANEL_PASSWORD=换成你的密码 \
  docker compose -f 09-服务端部署/docker-compose.yml up -d --build

# 带代理节点池：额外起一个 mihomo sidecar，只有模型请求走它
mkdir -p 09-服务端部署/mihomo-config
cp 09-服务端部署/mihomo-docker.yaml.example 09-服务端部署/mihomo-config/config.yaml
# 编辑 config.yaml 填你自己的订阅
PANEL_PASSWORD=换成你的密码 PANEL_NODE_POOL=1 \
  docker compose -f 09-服务端部署/docker-compose.yml --profile pool up -d --build
```

> 宿主端口默认绑 `127.0.0.1:8790`。本机已有面板占着 8790 时，用
> `PANEL_PUBLISH=127.0.0.1:18791` 覆盖。

**方式 B：直接跑镜像**

```bash
docker run -d --name ocgw \
  -p 127.0.0.1:8790:8790 \
  -e PANEL_PASSWORD=换成你的密码 \
  -v ocgw-data:/app/data \
  ghcr.io/suimi8/opencode-free-gateway:latest
```

**方式 C：自己构建**

```bash
# ⚠️ 构建上下文必须是项目根（Dockerfile 要 COPY 上级目录，Docker 不允许 COPY ../）
docker build -f 09-服务端部署/Dockerfile -t opencode-free-gateway:latest .
```

| 容器要点 | 说明 |
|---|---|
| 数据持久化 | `VOLUME /app/data` —— `panel.db` 与 `pool.db`（含 `-wal`/`-shm`）一起落盘。**别只挂单个文件**，WAL 模式下会丢数据 |
| 健康检查 | 内置 `HEALTHCHECK`，用 node 内置 http 探 `GET /`，不依赖 curl |
| 运行用户 | 非 root（`node`，uid 1000）。用 bind mount 时记得 `chown 1000:1000` |
| 零依赖 | 不装任何 npm 包，没有 `npm install` 层 |
| 节点池 | 内核**不打进镜像**（GPL-3.0 + 61 MB），用 compose 的 `mihomo` sidecar；面板通过 `MIHOMO_CONTROLLER_HOST` / `MIHOMO_PROXY_HOST` 指挥它 |
| 网卡绑定 | 容器内自动关闭（`OCGW_NO_INTERFACE_BIND=1`）—— 容器网络已隔离，没有宿主 TUN 要绕过 |
| 公网暴露 | 默认只绑回环。面板 cookie 无 `Secure`、登录无速率限制，**公网前必须**加反代 + HTTPS + `limit_req` |

CI 每次都会**真构建镜像、真起容器**，验证健康检查 / 登录 / 模型列表 / **重启后数据仍在** / 镜像里没有凭据与内核。

### 可选：代理节点池

节点池让**只有模型请求**走你自己的机场节点（浏览器/系统代理完全不受影响）。
内核不入库，运行时下载（mihomo 为 GPL-3.0，与本项目 MIT 相互独立）：

```bash
PANEL_NODE_POOL=1 node 01-管理面板/server.mjs    # 启用节点池
```

然后打开面板 → **「代理订阅」** → 点 **「⬇ 一键安装内核」**：

从 GitHub 官方发布页下载 mihomo（Windows 约 24 MB → 解出 66 MB），
自动解压到数据目录、校验可执行、装完直接可用。

**本项目不预置任何第三方镜像** —— 默认只走 GitHub 官方直连。国内网络慢就自己填：
面板内核卡片里有「下载镜像」一栏（`{}` 代表原始 URL 的位置，每行一个），
或用环境变量：

```bash
MIHOMO_MIRROR='https://你的镜像前缀/{}' PANEL_NODE_POOL=1 node 01-管理面板/server.mjs
```

> 为什么不预置：那些反代站点随时可能失效、也可能被投毒，
> 流量经过谁的服务器应该由你自己决定。

不想让它下载？面板里有 **「使用已有内核」**，填 Clash Verge 自带
`verge-mihomo.exe` 的路径就行；命令行等价写法：

```bash
MIHOMO_BIN="C:\Program Files\Clash Verge\verge-mihomo.exe" node 10-代理节点管理/install-core.mjs
node 10-代理节点管理/install-core.mjs --check   # 只看装没装、什么版本
```

#### 🖱️ 订阅与节点都在面板里管理（不用改文件）

启动面板 → 左侧 **「代理订阅」**：

| 能做什么 | 怎么做 |
|---|---|
| **填订阅** | 「＋ 添加订阅」→ 起个名字（如 `airport-a`）+ 贴机场的 **Clash 订阅链接** |
| **改订阅** | 「编辑」→ 链接留空表示不修改（界面上永远只显示打码后的 URL，不回显 token） |
| **删订阅** | 「删除」→ 点「应用改动」生效 |
| **测订阅** | 「测试」→ 现场拉一次，报告 HTTP 状态、体积、能解析出多少节点 |
| **改完生效** | 「应用改动」→ 重渲染 `config.yaml` + 让运行中的内核重载 |
| **手加节点** | 节点区「＋ 手动添加节点」→ 填类型/地址/端口 + JSON 参数（订阅里没有的单个节点用这个） |
| **剔除节点** | 节点行「剔除」→ 永久排除（不删订阅，但不再进池子）；顶部「已剔除」处可「恢复」 |
| **搜索节点** | 按名称 / 来源 / 地址 / 类型搜；可勾选「显示被剔除 / 无效」 |
| **测速 / 轮换** | 「全池测速」「立即轮换」 |
| **装内核** | 「⬇ 一键安装内核」→ 自动下载解压校验，带实时进度条；或「使用已有内核」填现成路径 |

订阅配置文件现在落在**可写**的运行时目录：

```
10-代理节点管理/runtime/subscriptions.json
```

> 老版本放在程序目录 `10-代理节点管理/subscriptions.json`，启动时会**自动迁移**过来。
> 桌面版 / Docker 里程序目录只读，所以配置文件必须放运行时目录。

<details>
<summary>命令行等价操作（不想开面板时用）</summary>

```bash
node 10-代理节点管理/manage.mjs status     # 状态 / 当前出口 / 租约
node 10-代理节点管理/manage.mjs start      # 起内核
node 10-代理节点管理/manage.mjs stop       # 停内核
node 10-代理节点管理/manage.mjs rotate     # 立即轮换
node 10-代理节点管理/manage.mjs apply      # 重渲染配置并重载
```

手改 `runtime/subscriptions.json` 同样有效，改完跑一次 `apply`：

```jsonc
{
  "providers": [
    { "name": "airport-a", "url": "https://…/clash?token=xxx", "enabled": true }
  ],
  "manualProxies": [
    { "name": "我的节点", "type": "ss", "server": "1.2.3.4", "port": 8388,
      "cipher": "aes-128-gcm", "password": "xxx" }
  ],
  "excludedNodes": ["广告节点-1"],
  "_参数": { "mixedPort": 17897, "controllerPort": 19097, "groupName": "OCGW" }
}
```

</details>

### 配置备份与迁移

面板 → **「系统设置」** → 「配置备份 / 恢复」。

| 功能 | 说明 |
|---|---|
| **⬇ 导出配置** | 下载一份 JSON：渠道（含 API Key）、代理订阅（含链接里的 token）、手动节点、剔除清单、下载镜像、站点设置 |
| **⬇ 导出（含令牌明文）** | 额外带上 `sk-oc-…`，换机器后不用重新发令牌 |
| **恢复** | 选 JSON 文件导入；默认按**名字合并**，勾「整份替换」才会先清空 |
| **导入 Clash 配置** | 直接粘 `config.yaml`：`proxy-providers` → 订阅，`proxies` → 手动节点。支持「先预览」 |

**不会导出**：管理密码哈希、session 密钥、请求日志。

> 导出的文件含凭据，别往公开仓库放。仓库的 `.gitignore` 也拦不住你手动放进去的文件。

<details>
<summary>Clash 迁移能搬什么 / 不搬什么</summary>

会搬：

```yaml
proxy-providers:        # → 变成面板里的「订阅源」
  airport-a:
    url: https://…      #   只取 name + url，其余（interval/health-check 等）由本项目管理

proxies:                # → 变成面板里的「手动节点」
  - { name: 节点1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: x }
  - name: 节点2          #   流式 { … } 与块式两种写法都认
    type: vmess
    server: 5.6.7.8
    port: 443
    uuid: …
```

**不会搬**：`rules`、`proxy-groups`、`dns`、`tun` 等 —— 本项目只做「模型请求的出口」，
不接管你的系统代理。字段不全的节点（缺 `type`/`server`/`port`）会被跳过并计数。

</details>

### 打包

```bash
node scripts/package.mjs     # 产出 dist/*.tar.gz + *.zip + SHA256SUMS.txt
```

---

## 📦 本仓库不包含什么

这是公开仓库，**不包含**任何凭据或第三方内容：

| 排除项 | 原因 |
|---|---|
| `subscriptions.json`、`panel.db*`、`.secret`、`.testkey` | 你的订阅与面板凭据 |
| `10-代理节点管理/runtime/` | 订阅缓存（含节点凭据）、生成的配置、日志、节点池数据库 |
| mihomo / verge-mihomo 二进制 | GPL-3.0 且体积大；用 `install-core.mjs` 运行时从官方发布页下载 |
| `08-上游源码快照/` | 那是上游自己的仓库，重复分发无意义 |
| `99-解包产物与运行时残留/` | 第三方专有程序（app.asar 解包产物），不可再分发 |

`scripts/check-syntax.mjs` 会在 CI 里自动扫描凭据与本机路径泄漏，防止误提交。

---

## 目录

| 目录 | 内容 | 状态 |
|------|------|------|
| [`01-管理面板/`](01-管理面板/) | 类 new-api/sub2api 网关：渠道/令牌/日志/统计 + OpenAI & Responses 双协议 + 动态模型发现 | ✅ 已跑通 |
| [`02-直连客户端/`](02-直连客户端/) | 高频直连客户端（直连/代理池/SOCKS5/多模型熔断）+ 3 个诊断探针 | ✅ 已跑通 |
| [`03-分析报告/`](03-分析报告/) | 11 份分析报告（4 个子代理 + Lead 综合 + 正向结果） | ✅ |
| [`04-门禁判别实验/`](04-门禁判别实验/) | 门禁判据的回放/二分/隔离实验脚本（含 21 个变体） | ✅ |
| [`05-引擎与运行时探针/`](05-引擎与运行时探针/) | 隔离引擎启动、sidecar 环境读取、浏览器/Electron 指纹排除 | ✅ |
| [`06-源码审计脚本/`](06-源码审计脚本/) | 对引擎 bundle 的 grep/结构审计脚本 | ✅ |
| [`07-原始证据/`](07-原始证据/) | 捕获的请求形状、官方文档存档、模型清单导出（已脱敏） | ✅ |
| [`09-服务端部署/`](09-服务端部署/) | **Linux 服务器部署**：start/stop/status、systemd、Docker、nginx 反代、Linux 自检 | ✅ 已在 WSL 实测 |
| [`10-代理节点管理/`](10-代理节点管理/) | **代理节点池**：独立 mihomo 实例 + 订阅解析 + 24h 租约每日轮换 + 请求前连通性验证 | ✅ 76/79 节点可达 |
| [`desktop/`](desktop/) | **Electron 桌面外壳**：原生窗口 + 托盘 + 单实例 + 面板子进程管理 | ✅ 三平台 |
| [`build/`](build/) | 应用图标（`icon.png`，electron-builder 自动派生 .ico / .icns） | ✅ |
| [`tests/`](tests/) | CI 用的无凭据测试：协议互转单元测试 + 面板冒烟测试 | ✅ |
| [`scripts/`](scripts/) | `check-syntax.mjs`（语法+泄漏扫描）、`package.mjs`（跨平台打包）、`make-icon.py`（生成图标） | ✅ |
| [`.github/workflows/`](.github/workflows/) | CI：三平台 × Node 22/24 矩阵 + Docker 构建运行；Desktop：三平台打安装包；Release：自动发布 | ✅ |

> 每个功能目录都有自己的 `README.md`，说明里面每个文件是干什么的、怎么跑、依赖谁。
> 不确定从哪看起时，点进目录先读它的 README。

顶层文件：

| 文件 | 用途 |
|------|------|
| [`LICENSE`](LICENSE) | MIT |
| [`package.json`](package.json) | 项目元信息、`engines`、npm scripts、Electron 构建脚本 |
| [`electron-builder.yml`](electron-builder.yml) | 三平台安装包配置（`asar: false` 是必须的，原因见文件注释） |
| [NOTICE.md](NOTICE.md) | 附加声明：项目性质、第三方组件（mihomo GPL-3.0）、安全与合规提示 |
| [.gitignore](.gitignore) | 排除凭据、运行时状态、内核二进制、构建产物 |
| [`README.md`](README.md) | 本文件（总索引 + 结论 + 路径迁移对照） |
| [`一键自检.cmd`](一键自检.cmd) | **双击即可**跑完下面 6 项全量可用性自检（Windows） |
| [`自检全部.ps1`](自检全部.ps1) | 自检主脚本：结构 / JS 语法 / PS1 语法 / 失效路径 / 面板端到端 / 客户端直连 |

> `自检全部.ps1` 与 `01-管理面板/自检.ps1`、`09-服务端部署/selftest.sh` 的端到端项会**真实访问上游**
> （会消耗你的共享额度）。CI 里跑的是 `tests/` 下**不连上游**的无凭据测试。

---

## 一键自检（归集后是否还可用）

双击根目录的 `一键自检.cmd`，或：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\自检全部.ps1"
```

6 大类检查，**21 个断言**，退出码 0 = 全绿：

| # | 检查 | 说明 |
|---|------|------|
| 1 | 目录结构 | 9 个目录 + 14 个关键文件是否齐备 |
| 2 | JS 语法 | 对 64 个 `.mjs`/`.js` 跑 `node --check` |
| 2b | cwd 无关性 | 扫全部 JS，禁止裸相对路径读写文件（换工作目录就会崩） |
| 3 | PS1 语法 | 对 11 个 `.ps1` 走 PowerShell 官方 Parser |
| 4 | 失效路径 | 扫全部自有文件，确认没有残留旧绝对路径 |
| 4b | **硬编码路径守卫** | 自有文件里**不允许出现盘符绝对路径**（仅取证原件与迁移表例外） |
| 4c | **模板脱敏 + 结构** | 3 份模板：无真实用户名、字符数一致、agent 骨架完整（system/instructions + ≥12 tools + stream） |
| 5 | 管理面板 | 启临时实例（8799）跑 **13 项**：登录/渠道/令牌/统计/模型/chat 非流式/chat 流式/**responses（muse-spark）/responses 反例**，含**真实上游调用** |
| 6 | 直连客户端 | `ocfree_client.mjs --once` 真实调用并校验返回 |

> 第 5、6 项会真实访问上游接口，需要能联网（`-SkipUpstream` 可跳过第 6 项）。
> 第 5 项用独立端口 8799 起临时实例、跑完自动关闭，**不影响**你在 8790 上跑的面板。

---

## 硬编码路径清零

本项目**不含任何硬编码绝对路径**。三类处理方式：

### 1) 脚本 → 环境推导 / 自相对

| 原写法 | 现写法 |
|--------|--------|
| `C:\Users\<用户名>\.openagents\nodejs\node.exe` | 先 `$env:NODE_EXE` → PATH 上的 `node` → `%ProgramFiles%\nodejs\node.exe` → `%LOCALAPPDATA%\Programs\nodejs\node.exe` → `%USERPROFILE%\.openagents\nodejs\node.exe`，全找不到才报错 |
| `C:\Users\<用户名>\.local\share\opencode\opencode.db` | `os.homedir()` 推导 + `$OPENCODE_DB` 覆盖 |
| `C:\Users\<用户名>\.cache\opencode\models.json` | `os.homedir()` 推导 + `$OPENCODE_MODELS` 覆盖 |
| `C:\Users\<用户名>\.config\opencode\...`（候选清单） | `$env:USERPROFILE` / `$env:APPDATA` / `$env:SystemDrive` 推导 |
| 脚本读写同目录文件 | `import.meta.dirname` / `__dirname` / `$PSScriptRoot` / `%~dp0` |

### 2) 生产请求模板 → 等长脱敏

`01-管理面板\body_template.json` 与 `02-直连客户端\body_template.json` 的 system prompt 里，
`<env>` 工作目录与 `<available_skills>` 的 `<location>` **每次请求都会发给上游**，原本带着
真实用户名、技能清单和旧临时目录。现已按**等长替换**脱敏：

- `C:\Users\<用户名>\` → `C:\Users\user1\`（**等长替换**，保证 JSON 长度不变）
- 用户名 → `user1`（等长替换）

字符数**仍为 38,763**、字节数**仍为 39,185**，system prompt 仍是 12,988 字符 ——
门禁只看形状不看内容，**实测脱敏后 `POST /v1/chat/completions` 仍返回 HTTP 200**。

### 3) 文档 → 相对路径 / 环境变量

- 指向**本项目**的旧位置 → 改为相对项目根的路径（93 处，15 个文件）
- 指向**本机 OpenCode 安装/状态**（逆向对象）→ 改为 `%LOCALAPPDATA%\`、`%APPDATA%\`、`%USERPROFILE%\.local\` 等

### 刻意保留的例外（共 6 处，均有明确理由）

| 文件 | 保留内容 | 理由 |
|------|----------|------|
| [`04-门禁判别实验\captured_body.json`](04-门禁判别实验/captured_body.json) | 真实 `C:\Users\<用户名>\...` | **逐字取证原件**。它的价值就在于「原样」——脱敏了就不再是证据。生产代码不用它，用的是上面那份已脱敏的模板 |
| [`README.md`](README.md) 迁移对照表 | `C:\Users\<用户名>\ocfree-panel\` 等 | 这张表的**唯一作用**就是记录旧路径 |
| [`自检全部.ps1`](自检全部.ps1) | 扫描正则 / `<用户名>` 断言 | 检查器必须包含它要检测的字符串 |
| `03/07/99` 的 `README.md` | `%TEMP%\ocfree\...` | 迁移说明文字 |

> 用自检的第 4/4b/4c 项可随时复核：**操作性文件 0 处、文档 0 处非预期、模板已脱敏**。


---

## 快速开始

> **本文件所有路径都以项目根目录为基准**（即本 `README.md` 所在目录）。
> 脚本一律用 `node`（取 PATH 上的），也可设环境变量 `NODE_EXE` 指向特定 `node.exe`。

### 1) 管理面板（推荐入口）

双击 `01-管理面板\启动面板.cmd`，或：

```powershell
cd "01-管理面板"
node server.mjs
```

- 管理面板 <http://127.0.0.1:8790/>　初始密码 `admin123`
- OpenAI 兼容接口 `http://127.0.0.1:8790/v1/chat/completions`

### 2) 直连客户端（压测/脚本化）

```powershell
cd "02-直连客户端"
node ocfree_client.mjs --help
node ocfree_client.mjs --once "Reply PONG" -m deepseek-v4.1-flash-free
```

### 3) 验证探针

```powershell
node 02-直连客户端\quota_probe.mjs       # 各模型当前 200/429/403
node 02-直连客户端\ratelimit_probe.mjs   # 429 完整响应头
```

---

## 服务端部署（Linux）

**可以部署，已在 WSL Ubuntu 26.04 + Node 22.22.3 真机实测通过**（见 [`09-服务端部署/`](09-服务端部署/)）：
从 Linux 直连上游，`POST /v1/chat/completions` 返回 **HTTP 200 `PONG`**。

结论：**门禁与操作系统、出口 IP 无关**——它是纯请求形状校验，所以任何能出网的 Linux 机器都能跑。

```bash
# 1) 免 root 装便携 Node（≥22.5，因为用了内置的 node:sqlite）
cd "09-服务端部署"
bash install-node.sh

# 2) 起面板（默认 0.0.0.0:8790）
./start.sh --daemon && ./status.sh

# 3) Linux 版全量自检
OCGW_CLEAR_PROXY=1 bash selftest.sh
```

| 项目 | 说明 |
|------|------|
| 依赖 | **零 npm 依赖**——只用 Node 内置模块。**不需要 `npm install`** |
| Node 版本 | **≥ 22.5**（`node:sqlite` 是内置模块，但 22.5 才引入） |
| 平台无关性 | 全部 `path.join` / `import.meta.dirname`，无 `process.platform` 分支、无 `spawn`/`taskkill` |
| 监听 | `PANEL_HOST`（默认 `127.0.0.1`）/ `PANEL_PORT`（默认 `8790`）|
| 数据 | `panel.db`（SQLite WAL）。可用 **`PANEL_DB`** 指到别处（如 `/app/data/panel.db`），容器/systemd 部署不必再靠软链。**必须放 Linux 原生文件系统**，别放 `/mnt/*` 跨文件系统路径 |
| 备份 | 用 [`09-服务端部署/snapshot-db.mjs`](09-服务端部署/snapshot-db.mjs)（`VACUUM INTO`）。**不能只复制 `panel.db`**——`-wal` 是数据库的一部分 |
| 反代 | SSE 需要 `proxy_buffering off`，否则流式会攒着不发。示例见 `09-服务端部署/nginx.conf.example` |

### ⚠️ 部署前必须知道的 4 件事

1. **额度不会因为换服务器而变多**。免费额度是**所有免费模型共用的一个每日桶**，且换出口 IP 不刷新。
   服务器和你的桌面端共用同一个桶。
2. **部分模型有地区门禁**。`cat-jam-free` / `muse-spark-1.3-contributor-free` 曾返回 **403 RegionError**（地区不支持）。
   部署前先用 `quota_probe.mjs` 在那台服务器上确认哪些模型可用。
3. **默认密码是 `admin123`，登录接口没有速率限制**，session cookie 也**没有 `Secure` 标志**。
   公网部署必须：改密码 + 走 HTTPS 反代 + 在 nginx 层加 `limit_req`。**强烈建议只监听 `127.0.0.1` 再反代**。
4. **这套方案本质上很脆**：上游随时可以加签名/mTLS/设备绑定让它全部失效。别把它当生产依赖。

---

## 核心结论

### 门禁判据（6 条，150+ 次对照实验钉死）

> ⚠️ **2026-10-17 修正记录**（两轮，都在下面体现）：
> ① 早期写的「`x-opencode-session-id` 必需」**错了** —— 实测可以完全不要；
> ② 早期漏掉了 **UA 最低版本门禁**（违反返回 **426**，不是 403）；
> ③ 早期写的「body 必须是完整 38.7 KB agent 结构」**不准确** —— 见下方第 6 条。

| # | 判据 | 违反后果 |
|---|------|----------|
| 1 | `user-agent` 匹配 `^opencode/v?<版本>`，**大小写不敏感** | 形状不符 → **403** |
| 2 | UA 里的版本 **≥ 1.18.0**（`1.18.0`→200；`1.17.9`→426） | 版本过低 → **426** |
| 3 | `x-opencode-session` = `ses_` + 12 hex + 14 base62 | 缺失或形状错 → **403** |
| 4 | 12 hex 段的**低 12 位 ∈ `[0xfc0, 0xfff]`**（先看 `session-id`，没有才看 `session`） | 越界 → **403** |
| 5 | **`body.stream === true`** | 非流式 → **403** |
| 6 | **`tools` 里必须有一个 `function.name === "read"` 的工具（区分大小写）** | 否则 → **403** |

> ⚠️ **2026-10-17 第二次修正**：此前写的「body 必须是完整 agent 结构（system prompt 12.9 KB + 12 tools）」
> **不准确**。实测：**system prompt 的长度和内容都不校验**（200 字符也能过），
> 真正的硬要求只是——`tools` 里得有那个叫 `read` 的工具。详见下表。

### 门禁真正要什么（隔离实验）

| 变体（`stream: true`，UA/session 合法） | 结果 |
|---|---|
| 完整 agent body（38,763 字符，12 tools） | ✅ 200 |
| system **200 字符** + 12 个原始 tools | ✅ **200**（长度无关） |
| **只有 `read` 一个工具**（手搓、空参数） | ✅ **200**，body 仅 **348 字符** |
| system 原长 + `tools: []` | ❌ 403 |
| system 29,000 字符纯填充 + `tools: []` | ❌ 403（只堆长度没用） |
| 12 个工具里**去掉 `read`** | ❌ 403 |
| 12 个工具里去掉 `bash` / `write` / `edit` / `glob` / `grep` / `question` | ✅ 全部 200 |
| 只有 `bash` / 只有 `write` | ❌ 403 |
| 12 个「同一个工具」重复 / 12 个假名工具 | ❌ 403 |
| 真 `read` **改名成 `readx`** | ❌ 403 |
| 工具名写成 **`Read`**（大写） | ❌ 403 |

**结论：门禁 = UA 形状 + 版本 ≥1.18.0 + session 形状 + low12 区间 + `stream:true` + 一个名为 `read` 的工具。**

### 💰 由此得到一个 97% 的 token 优化

因为 system prompt 完全不必要，每次调用的固定开销可以从 **9,596 prompt tokens 降到 297**：

| 模式 | body 大小 | prompt tokens |
|------|----------|---------------|
| `full`（默认，完整 agent 结构） | 38,763 字符 | **9,596**（cached 9,472） |
| `minimal`（只发调用方的 messages + 一个 `read` 工具） | ~350 字符 | **297** |

两者都实测 200。开通方式：`PANEL_BODY_MODE=minimal`，或渠道 `extra.body_mode = "minimal"`。
网关场景**推荐 minimal**：既省共享每日额度，又不会用 opencode 的 system prompt 污染客户端的提示词。

与你的具体问题相关的补充：

**关于「是不是加个头就行」**：不是。最短可用形式是 **2 个请求头 + 一个带 `read` 工具的 body**。


**可选（实测可删）**：
- `x-opencode-session-id` —— **可以完全不要**；但一旦提供，就必须同时满足判据 3+4（塞垃圾 → 403）
- `authorization`（`Bearer public`）、`x-opencode-request`、`x-opencode-client`、`x-opencode-project`、`stream_options`

实测明细：

| 变体 | 结果 |
|------|------|
| 删 `x-opencode-session-id` | **200** —— 原来它不是必需的 |
| 删 `x-opencode-session` | 403 —— 这个才是必需的 |
| 删 `authorization` | **200** |
| 删 `request`/`client`/`project` 三个头 | **200** |
| `session-id` 塞垃圾字符串 | 403 —— 存在即校验 |
| `session-id` 与 `session` 都合法但**值不同** | **200** —— 不要求相等 |
| UA = 浏览器 Chrome/Edge 155 | 403 |
| UA = `xxopencode/1.19.2` | 403 —— 必须**以** `opencode/` 开头 |
| UA = `OpenCode/1.19.2 ai-sdk/x` | **200** —— 大小写不敏感 |
| UA = `opencode/1.18` | **200** —— 两段式按 `1.18.0` 解析 |
| UA = `opencode/v1.19.2` | **200** —— 允许 `v` 前缀 |
| UA = `opencode/1.2.3` | **426** —— 形状对但版本旧 |
| UA = `opencode/2`（单段） | 403 —— 版本解析不了，落回形状门禁 |
| body 砍成最小（无 system/tools） | 403 |

> **426 是个有用的信号**：它说明形状门禁已过、只是客户端版本被认为太旧。

### 最小可用请求（实测：2 个头 + 1 个工具）

很多人以为「加一个 opencode 头就行」——**不准确**。实测能过门禁的最简形式是
**2 个请求头 + 一个带 `read` 工具的小 body**（连 `content-type` 都可以省）：

```http
POST https://opencode.ai/inference/v1/chat/completions

user-agent: opencode/1.19.2
x-opencode-session: ses_ebcf32130ffe7wJ1T06CSp2AP5
```

```jsonc
// body：整份 348 字符，实测 200，prompt_tokens 仅 279
{
  "model": "deepseek-v4.1-flash-free",
  "stream": true,
  "messages": [{ "role": "user", "content": "你好" }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "read",                       // ← 门禁唯一真正要求的工具，名字必须正好是 read
      "description": "Read a file.",
      "parameters": { "type": "object", "properties": {} }
    }
  }]
}
```

换句话说：

| 必需 | 可删 |
|------|------|
| `user-agent`（版本 ≥ 1.18.0） | `authorization` |
| `x-opencode-session`（形状 + low12 正确） | `x-opencode-session-id` |
| `stream: true` | `content-type`、`x-opencode-request`、`x-opencode-client`、`x-opencode-project`、`stream_options` |
| **`tools` 里有一个 `name: "read"` 的工具** | opencode 的 system prompt、其余 11 个工具、body 的其余部分 |

复现：`node 04-门禁判别实验\verify_minimal.mjs`。

### ⚠️ 模型按协议绑定（2026-10-17 新增实测）

免费层的模型**不是**都挂在同一个协议上。用错协议会得到 **`400 Model does not support this protocol.`**
（注意：这是 400，不是门禁的 403，两者要分清）。

| 模型 | `/inference/v1/chat/completions` | `/inference/v1/responses` |
|------|:---:|:---:|
| `deepseek-v4.1-flash-free` | ✅ 200 | ❌ 400 |
| `space-bunny-free` | ✅ 200 | ❌ 400 |
| `longcat-2.5-preview-free` | ✅ 200 | — |
| **`muse-spark-1.3-contributor-free`** | ❌ 400 | ✅ **200** |

而且 **`/responses` 端点同样有那道形状门禁**，它要的 agent 结构是 Responses 格式：

| `/responses` 请求体 | 结果 |
|---|---|
| 精简 Responses body（`input` + 空 `tools`） | 403 FreeTierError |
| **完整 Responses agent body**（`instructions` = 12,988 字符 system prompt + 12 个**扁平** `tools`） | ✅ **200** |
| chat 格式 body（带 `max_tokens`） | 400 `unknown parameter max_tokens` |

### 典型故障：Codex + muse-spark 报 403

```
unexpected status 403 Forbidden: ... upstream_status: HTTP 403;
cause: OpenCode's free tier can only be used from within OpenCode.
url: http://127.0.0.1:15721/v1/responses
```

看起来像 `/responses` 的问题，其实**是 body 的问题**。实测链路：

```
Codex (wire_api="responses", model=muse-spark-...)
  → CC Switch 本地代理 127.0.0.1:15721
     → apiFormat = "openai_chat"  ⇒ 翻译成上游 /chat/completions
        → 翻译后的 body 只有几百字节，**没有 agent 结构** → 403 FreeTierError
        → 而且 muse-spark 根本不支持 chat 协议 → 就算 body 对了也只会 400
```

**两个独立的坑**：① body 缺 agent 结构；② 模型选错了协议。

**解法：让请求经 [`01-管理面板`](01-管理面板/) 中转** —— 面板会自动注入完整 agent 结构：

| 想用的模型 | 配法 |
|---|---|
| `deepseek-v4.1-flash-free` / `space-bunny-free` … | 指向面板的 `/v1/chat/completions`（CC Switch `apiFormat = openai_chat`） |
| `muse-spark-1.3-contributor-free` | 指向面板的 **`/v1/responses`**（CC Switch `apiFormat = openai_responses`，或 Codex 直连面板） |

面板为此新增了 **`POST /v1/responses`**（Responses 协议透传 + agent 结构注入），
已实测：Codex 形状的 `/responses` 请求 + `muse-spark-1.3-contributor-free` → **HTTP 200 SSE**。
详见 [`01-管理面板/README.md`](01-管理面板/README.md) 的「接 Codex / CC Switch」。

### 已排除的判别因素

出口 IP（与本地 shell 完全相同 · **换 Linux 服务器直连同样通过**）· 操作系统 · 进程环境 ·
Node/Electron 运行时与 BoringSSL · TLS/Chromium 指纹（Chrome 155 与 Edge 155 均 403）·
mTLS/客户端证书 · 自定义 undici dispatcher · 签名头 · 请求路径（`/inference/openai/v1` 同样 403）·
id 时间戳新鲜度 · system prompt 文案 · body 内字符串内容。

### 额度模型

- 按**自然日**计，`retry-after` 指向 **00:00 UTC = 北京时间 08:00**
- **所有免费模型共用同一个每日桶**（0 次调用的 `big-pickle` 与 6000 次调用的
  `mimo-v2.6-flash-free` 同时 429，`retry-after` 同一重置点）
- 换出口 IP 不刷新额度
- 每次调用固定开销 ≈ **9,500 input tokens**（完整 agent 结构所致）
- `cat-jam-free` / `muse-spark-1.3-contributor-free` → **403 RegionError**（地区门禁，本机出口在日本）

---

## 本次归集：路径迁移对照

所有文件从 `C:\Users\<用户名>\` 与 `%TEMP%` 迁入本目录，脚本内的绝对路径已改为**自相对路径**
（ESM 用 `import.meta.dirname`，CJS 用 `__dirname`，PowerShell 用 `$PSScriptRoot`），
因此整个目录可以整体搬移/改名/换盘符而无需再改脚本。

| 原位置 | 现位置 |
|--------|--------|
| `C:\Users\<用户名>\ocfree-panel\` | `01-管理面板\` |
| `C:\Users\<用户名>\ocfree-client\` | `02-直连客户端\` |
| `%TEMP%\ocfree\reports\` | `03-分析报告\` |
| `%TEMP%\ocfree\bisect*.mjs` `replay.mjs` `control.mjs` `prove_real.mjs` `sesids.mjs` `sweep.js` `ua_probe.js` `captured_body.json` | `04-门禁判别实验\` |
| `%TEMP%\ocfree\engine_boot*.mjs` `engine_shell*.ps1` `read_env.ps1` `sidecar_*.ps1` `provider_truth.ps1` `positive_test.ps1` `iso_engine_test.mjs` `*_probe.js` `catalog_live.js` | `05-引擎与运行时探针\` |
| `%TEMP%\ocfree\find_*.js` `dump_*.js` `db_success_check.js` `cfg_hunt*.ps1` | `06-源码审计脚本\` |
| `%TEMP%\ocfree\engine_http.jsonl` `raw\` `data\` | `07-原始证据\` |
| `%TEMP%\ocfree\repo\` `repo.tar.gz` | `08-上游源码快照\` |
| `%TEMP%\ocdesk\` `%TEMP%\ocfree\enginestate\` | `99-解包产物与运行时残留\` |

> **本表只用于「考古」**：左列是迁移前的旧位置，已全部不存在。
> `03-分析报告\*.md` 内部现已统一改写为**相对项目根**的路径，对照本表即可定位；
> 报告中指向**本机 OpenCode 安装/状态**的路径则改写为环境变量形式（`%LOCALAPPDATA%\`、`%USERPROFILE%\.local\` 等），
> 不含用户名。全项目**零硬编码绝对路径**（详见下方「硬编码路径清零」）。

---

## 归集后验证记录（2026-10-16 / 17）

最终一轮 `自检全部.ps1` 结果：**通过 20 / 失败 0 / 警告 0，退出码 0**。

| 检查项 | 结果 |
|--------|------|
| `node --check` 全量语法检查 | **64/64 通过** |
| PowerShell Parser 全量语法检查 | **11/11 通过** |
| JS 工作目录无关性（无裸相对路径） | **0 处** |
| 失效绝对路径扫描（123 个文件） | **0 处残留** |
| 操作性文件硬编码绝对路径 | **0 处** |
| 文档非预期绝对路径 | **0 处**（迁移表/取证引用已豁免） |
| 生产模板脱敏 + 长度一致性 | ✅ 3/3（chat ×2 各 38,763 字符；responses 38,594 字符） |
| **面板 `/v1/responses` + `muse-spark-1.3-contributor-free`（Codex 协议）** | ✅ **HTTP 200**，10 个 SSE 事件，含 `response.completed` |
| **面板 `/v1/responses` + chat-only 模型（反例）** | ✅ HTTP 400 `Model does not support this protocol`（符合协议绑定预期） |
| **Linux 服务端自检（WSL Ubuntu 26.04 + Node 22.22.3）** | ✅ **12/12 通过** |
| **Linux 直连上游端到端** | ✅ **HTTP 200 `PONG`**（清空代理直连） |
| `start.sh` → `status.sh` → 二次启动被拒 → `stop.sh` | ✅ 全链路实测通过 |
| 面板启动（临时端口 8799） | ✅ `GET /` HTTP 200 |
| 面板登录 `/api/login` | ✅ `{"ok":true}` |
| 面板渠道/令牌读取（DB 跨盘搬运完整） | ✅ 1 渠道 + 4 令牌 |
| 面板端到端 `POST /v1/chat/completions`（非流式） | ✅ **HTTP 200** `model=deepseek-v4.1-flash-free` `content="PONG"` `usage 9596/3/9599` |
| 面板端到端 `POST /v1/chat/completions`（**流式 SSE**） | ✅ HTTP 200，4 个分片 |
| 面板 `/v1/models` | ✅ 10 个模型 |
| 客户端直连 `--once` | ✅ 200 `PONG` |
| 客户端 HTTP CONNECT 代理 `--once` | ✅ 200 `PONG` |
| `06-源码审计脚本\find_plugin.js`（读 99 目录下 38 MB bundle） | ✅ 命中 |
| `02-直连客户端\quota_probe.mjs` | ✅ 正常探测 |
| 三个 `.cmd` 启动器 | ✅ UTF-8 无 BOM + CRLF（cmd.exe 必需） |


---

## 合规与风险提示

上游官方文档明确写着免费层"**can only be used from within OpenCode**"。
本目录能够打通，**唯一原因是该门禁只做请求头形状校验**——没有签名、没有客户端证书、没有设备绑定。
这意味着：

- 该方案**本质上很脆**：对方随时可以加真实证明（签名 / mTLS / 设备指纹）使其立即失效；
- 面板的 `authorization: Bearer public` 本就是官方给未登录客户端注入的匿名通道，
  但把这条通道开放给第三方进程使用，可能违反服务条款；
- 请自行评估使用范围，不要把面板暴露到公网（默认只监听 `127.0.0.1`）。

本目录仅作技术研究与学习用途。
