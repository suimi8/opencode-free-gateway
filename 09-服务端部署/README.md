# 09-服务端部署

把管理面板部署到 **Linux 服务器**。核心结论先讲：

> ✅ **可以部署。已在 WSL Ubuntu 26.04 + Node v22.22.3 真机实测通过**——
> 从 Linux 直连上游 `POST /v1/chat/completions` 返回 **HTTP 200 `PONG`**。
>
> 原因是免费层门禁是**纯请求形状校验**（2 个请求头 + 完整 body），
> 与操作系统、出口 IP、进程环境都无关。

---

## 1. 三条部署路径

| 路径 | 适合 | 入口 |
|------|------|------|
| **A. 裸机 + start.sh** | 想最快跑起来、自己管进程 | `install-node.sh` → `start.sh --daemon` |
| **B. systemd** | 生产、要开机自启与自动重启 | `opencode-gateway.service` |
| **C. Docker** | 想隔离环境、不装 Node | `docker-compose.yml` |

### A. 裸机（推荐先走这条验证）

```bash
cd 09-服务端部署

# 1) 免 root 装便携 Node（解压到 $HOME/node22，不动系统、不用 sudo）
bash install-node.sh

# 2) 起面板（默认 0.0.0.0:8790），跑完 status 确认
./start.sh --daemon
./status.sh

# 3) 全量自检（Linux 版，会做一次真实上游调用）
OCGW_CLEAR_PROXY=1 bash selftest.sh

# 4) 不用了
./stop.sh
```

`start.sh` 的 node 解析顺序：`$NODE_EXE` → PATH 上的 `node` → `$HOME/node22/bin/node`。
三级都找不到会给出明确指引。

### B. systemd

```bash
sudo cp opencode-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-gateway
systemctl status opencode-gateway
```

⚠️ 单元文件里的 `User=ocgw`、Node 路径、工作目录都要按你的环境改。
**注意取舍**：若 Node 装在 `$HOME` 下，`ProtectHome=read-only` 会让 Node 不可读——
要么把 Node 装到 `/opt/node`（推荐，单元文件里有写法），要么放宽该项。

### C. Docker

Docker 的构建上下文必须是**项目根目录**（因为 `01-管理面板/` 在 `09-服务端部署/` 的上一级，
Docker 不允许 `COPY ../`）：

```bash
cd "<项目根>"          # 含 01-管理面板/ 与 09-服务端部署/ 的那层
docker build -f 09-服务端部署/Dockerfile -t opencode-gateway:latest .

# 或直接用 compose
docker compose -f 09-服务端部署/docker-compose.yml up -d --build
```

---

## 2. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PANEL_HOST` | `127.0.0.1`（面板自身）；`start.sh` 里默认 `0.0.0.0` | 监听地址 |
| `PANEL_PORT` | `8790` | 监听端口 |
| `PANEL_DB` | 与 `server.mjs` 同目录的 `panel.db` | 数据库位置。容器/数据盘部署时指到这里，**不需要符号链接** |
| `NODE_EXE` | 自动三级查找 | 仅 `start.sh`/`status.sh`/`selftest.sh` 读取 |
| `OCGW_READY_TIMEOUT` | `30` | `start.sh --daemon` 等待就绪秒数 |
| `OCGW_STOP_GRACE` | `10` | `stop.sh` SIGTERM 后等待秒数 |
| `OCGW_CLEAR_PROXY` | `0` | `selftest.sh` 是否先清空渠道代理（验证直连） |
| `OCGW_KEEP` | `0` | `selftest.sh` 是否保留临时目录 |

完整注释见 [`.env.example`](.env.example)。

---

## 3. 目录内文件

| 文件 | 用途 |
|------|------|
| [`install-node.sh`](install-node.sh) | 免 root 安装便携 Node 到 `$HOME/node22`，并校验 `node:sqlite` |
| [`start.sh`](start.sh) | 启动面板（`--daemon` 后台 + PID/日志 + 等就绪 + 重复启动拒绝） |
| [`stop.sh`](stop.sh) | 按 PID 文件优雅停止（TERM → 10s → KILL），校验 cmdline 防 PID 复用误杀 |
| [`status.sh`](status.sh) | PID/存活/内存、端口监听与归属、`GET /` 状态、登录路由探活、日志尾部 |
| [`selftest.sh`](selftest.sh) | **Linux 全量自检**：依赖 → 语法 → 平台无关性 → 启动 → API → **真实上游调用** |
| [`snapshot-db.mjs`](snapshot-db.mjs) | `panel.db` 一致性快照（`VACUUM INTO`），**备份唯一正确做法** |
| [`opencode-gateway.service`](opencode-gateway.service) | systemd 单元（含加固与两种 Node 安装位置的取舍说明） |
| [`Dockerfile`](Dockerfile) | `node:22-bookworm-slim`、零 npm、非 root、`VOLUME /app/data`、HEALTHCHECK |
| [`docker-compose.yml`](docker-compose.yml) | 命名卷、端口默认绑回环、`restart: unless-stopped`、日志轮转 |
| [`nginx.conf.example`](nginx.conf.example) | HTTPS + HTTP 跳转、SSE 三件套、`limit_req` 防爆破、安全响应头 |
| [`.env.example`](.env.example) | 环境变量模板，逐项中文注释 |

---

## 4. 部署前提与约束

| 项目 | 要求 |
|------|------|
| **Node** | **≥ 22.5**（面板用内置模块 `node:sqlite`，该模块 22.5 才引入）。实测 v22.22.3 |
| **npm 依赖** | **零依赖**——只用 Node 内置模块。**不需要也不应该 `npm install`**（没有 `package.json`） |
| **平台无关性** | 全部走 `path.join` / `import.meta.dirname`；无 `process.platform` 分支、无 `spawn`、无 `taskkill`。已由 `selftest.sh` 每轮静态校验 |
| **出网** | 需要能访问 `https://opencode.ai`（443）。若服务器要走代理，配在**渠道**的 proxy 字段里 |
| **文件系统** | `panel.db` 必须放 **Linux 原生文件系统**（ext4/xfs）。WSL 的 `/mnt/*`（DrvFs）能跑但 SQLite 锁语义不可靠，生产别这么干 |
| **时区** | 面板内部按 UTC 计算额度重置点，与系统时区无关；日志时间是本地时间，compose 里给了 `TZ` |

---

## 5. 数据库与备份

`panel.db` 是 **SQLite WAL 模式**，`panel.db-wal` / `panel.db-shm` 是数据库的**组成部分**：

- ❌ **不能只 `cp panel.db`**——最新写入可能还在 `-wal` 里，会丢数据
- ❌ **不能单独删 `-wal` / `-shm`**——那是破坏性操作
- ✅ **要挂卷就挂目录**（`-wal` 会生成在真实文件旁）
- ✅ **要备份就用** [`snapshot-db.mjs`](snapshot-db.mjs)：

```bash
node snapshot-db.mjs /var/lib/ocgw/panel.db ./backup-$(date +%F).db
```

它内部用 `VACUUM INTO`——由 SQLite 保证一致性，且**不修改源库**。

> 已实测：经符号链接打开数据库时，`-wal`/`-shm` 会落在**真实文件旁边**（即卷里）。
> 但既然面板支持 `PANEL_DB`，就别用软链了。

---

## 6. ⚠️ 上线前必须知道的 5 件事

1. **额度不会因为换服务器而变多**。免费额度是**所有免费模型共用的一个每日桶**，
   且**换出口 IP 不刷新**。服务器和你的桌面端共用同一个桶，北京时间 08:00 重置。
2. **部分模型有地区门禁**。`cat-jam-free` / `muse-spark-1.3-contributor-free` 曾返回 **403 RegionError**。
   部署到目标服务器后，**先用 `02-直连客户端/quota_probe.mjs` 在那台机器上探一遍**哪些模型可用。
3. **安全三件事**（当前实现的客观事实）：
   - 默认管理员密码是 `admin123` —— **必须改**
   - 登录接口**没有速率限制** —— 公网入口必须在 nginx 层加 `limit_req`（示例已给）
   - session cookie 只有 `HttpOnly; SameSite=Lax`，**没有 `Secure`** —— 必须走 HTTPS
   - **强烈建议**：`PANEL_HOST=127.0.0.1` + nginx 反代 + HTTPS，不要把面板直接暴露公网
4. **反向代理必须关缓冲**，否则 SSE 流式会攒着不发：
   nginx 需要 `proxy_buffering off; proxy_cache off; proxy_read_timeout 600s;`
5. **这套方案本质上很脆**：上游随时可以加签名 / mTLS / 设备绑定让它全部失效。
   别把它当生产依赖，也别在上面挂敏感业务。

---

## 7. 本次验证到什么程度（诚实边界）

| 项目 | 状态 |
|------|------|
| Linux 启动 + 管理 API + `/v1/models` | ✅ WSL Ubuntu 26.04 实测通过 |
| **Linux 直连上游端到端** | ✅ `POST /v1/chat/completions` → **HTTP 200 `PONG`**（清空代理直连） |
| `selftest.sh` 全量 | ✅ **12/12 通过** |
| `start.sh --daemon` → `status.sh` → 二次启动被拒 → `stop.sh` → 停止后 `status` | ✅ 全链路实测通过 |
| 所有 `.sh` 的 `bash -n` | ✅ 通过 |
| 全部文件换行/编码 | ✅ LF、UTF-8 无 BOM |
| **`docker build`** | ⚠️ **未实跑**（本机 Docker daemon 未运行）。Dockerfile 仅做静态校验 |
| **`nginx -t`** | ⚠️ **未实跑**（WSL 无 nginx 且无免密 sudo）。nginx 示例仅做结构校验 |

> `nginx.conf.example` 有个容易踩的坑：`limit_req_zone` 属于 `http{}` 上下文，
> 放进 `conf.d/*.conf` 会直接 `nginx -t` 失败。示例里已写成两步：
> 「第 1 步把 zone 块粘进 `nginx.conf` 的 `http{}`，第 2 步只粘 `server` 块」。

---

## 8. 快速排错

| 现象 | 原因与处理 |
|------|-----------|
| `找不到 node` | 跑 `bash install-node.sh`，或 `export NODE_EXE=/path/to/node` |
| `node:sqlite 不可用` | Node < 22.5。升级 Node |
| 面板起来了但调用失败 `ECONNREFUSED 127.0.0.1:xxxx` | 渠道里配的代理在服务器上不可达。**渠道的 `127.0.0.1` 指的是服务器自己**，不是你的 PC |
| 上游回 **426** | UA 里的版本 < 1.18.0。面板默认 `opencode/1.19.2` 是合规的；若自定义过 UA，改回来。面板「测试渠道」现在会直接提示这个原因 |
| 上游回 **403 FreeTierError** | 请求形状不对。检查是不是自定义 UA 把 `opencode/` 前缀弄丢了 |
| 流式没反应/一次性吐出 | 反代没关缓冲。见第 6 节第 4 条 |
| 数据"丢了" | 多半是只挂了 `panel.db` 单文件而没挂目录，导致 `-wal` 留在容器层。改成挂目录 |
