# ══════════════════════════════════════════════════════════════════════
# OpenCode 免费层网关 · 管理面板 —— Dockerfile
#
# 构建上下文必须是【项目根目录】（Dockerfile 在 09-服务端部署/ 里，
# 而它要 COPY 上级目录，Docker 不允许 COPY ../，所以只能从根目录构建）：
#
#     docker build -f 09-服务端部署/Dockerfile -t opencode-free-gateway:latest .
#
# 或者在项目根用 compose：
#
#     docker compose -f 09-服务端部署/docker-compose.yml up -d
#
# 设计要点
#   * **零 npm 依赖** —— 只用 Node 内置模块（node:http/https/tls/sqlite/crypto），
#     没有需要安装的包，因此没有 npm install 层。
#   * node:22-bookworm-slim 自带 Node 22.x（>= 22.5），满足 node:sqlite 要求。
#   * 非 root 运行（基础镜像自带的 node 用户）。
#   * **目录结构必须保持** —— 01-管理面板/proxy-pool.mjs 用相对路径
#     `../10-代理节点管理/pool.mjs` 引用节点池，扁平化会直接崩。
#   * 数据库不烤进镜像：PANEL_DB / POOL_DB 指向卷，
#     panel.db(-wal/-shm)、pool.db 一起落盘。
#   * mihomo 内核**不打进镜像**（GPL-3.0 且 61 MB）。要节点池就用 compose 的
#     mihomo profile（官方镜像作 sidecar），见 docker-compose.yml。
# ══════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim

# 不装任何东西：健康检查用 node 内置 http（见下面 HEALTHCHECK），
# 省一个 curl 依赖层，镜像更小、攻击面更少。
WORKDIR /app

# ── 复制运行所需文件（保持目录结构）────────────────────────────────
COPY 01-管理面板/*.mjs            /app/01-管理面板/
COPY 01-管理面板/*.json           /app/01-管理面板/
COPY 01-管理面板/public/          /app/01-管理面板/public/

COPY 10-代理节点管理/*.mjs          /app/10-代理节点管理/
COPY 10-代理节点管理/*.yaml         /app/10-代理节点管理/
COPY 10-代理节点管理/*.json         /app/10-代理节点管理/

# 数据目录：panel.db 与节点池 pool.db 都落这里
RUN mkdir -p /app/data /app/10-代理节点管理/runtime \
 && chown -R node:node /app

USER node

ENV PANEL_HOST=0.0.0.0 \
    PANEL_PORT=8790 \
    PANEL_DB=/app/data/panel.db \
    POOL_DB=/app/data/pool.db \
    NODE_ENV=production \
    OCGW_NO_INTERFACE_BIND=1

# OCGW_NO_INTERFACE_BIND=1 的原因：容器网络本身已与宿主隔离，
# 没有宿主那种 Clash Verge TUN 需要绕过；在容器里绑 eth0 反而可能出问题。
# 详见 10-代理节点管理/README.md「出站必须绑定物理网卡」一节。

EXPOSE 8790

VOLUME ["/app/data"]

# 健康检查：GET / 期望 200。用 node 内置 http，不依赖外部命令。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PANEL_PORT||8790,path:'/',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/app/01-管理面板/server.mjs"]
