# ══════════════════════════════════════════════════════════════════════
# OpenCode 免费层网关 · 管理面板 —— Dockerfile
#
# ⚠️ 构建上下文必须是【项目根目录】，因为 01-管理面板/ 在 09-服务端部署/ 的
#    上一级。Docker 不允许 COPY ../xxx（越界上下文），所以：
#
#        cd "<项目根>"            # 即含 01-管理面板/ 与 09-服务端部署/ 的那层
#        docker build -f 09-服务端部署/Dockerfile -t opencode-gateway:latest .
#
#    如果 Dockerfile 放在 09-服务端部署/ 里却在该目录执行 docker build .，
#    会报 "COPY failed: 01-管理面板: not found"，这是预期行为。
#
# 设计要点：
#   * 零 npm 依赖 —— 面板只用 Node 内置模块（node:http / node:https /
#     node:tls / node:sqlite / node:crypto），**没有 package.json，
#     绝对不需要 npm install**。基础镜像自带的 npm 也不会被调用。
#   * node:22-bookworm-slim 自带 Node 22.x（>= 22.5），满足 node:sqlite 要求。
#   * 非 root 运行（uid/gid 10001）。
#   * VOLUME /app/data 用于持久化 panel.db（原因见下方注释）。
# ══════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim

# 面板不装任何依赖；只补一个 curl 给 HEALTHCHECK 用（slim 镜像自带 bash）。
# 若想彻底不装包，可删掉这行并把 HEALTHCHECK 换成下面的 node -e 版本。
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只拷面板本体：server.mjs / db.mjs / upstream.mjs / body_template.json / public/
# 显式排除数据库文件 —— panel.db / -wal / -shm 属于**运行时数据**，
# 不能烤进镜像（否则每次重建都会覆盖线上数据，而且 -wal 里可能有未 checkpoint
# 的数据，单独打包 panel.db 本身就是不安全做法）。
COPY 01-管理面板/server.mjs           /app/server.mjs
COPY 01-管理面板/db.mjs               /app/db.mjs
COPY 01-管理面板/upstream.mjs         /app/upstream.mjs
COPY 01-管理面板/body_template.json   /app/body_template.json
COPY 01-管理面板/public/              /app/public/

# 数据目录：panel.db(-wal/-shm) 落在这里，通过 VOLUME 持久化。
# 为什么必须挂卷：容器不挂卷时数据库写在容器的可写层里，`docker rm` / 重建镜像
# 就会把渠道配置、令牌、调用日志全部丢掉；挂卷后数据跟着卷走，升级镜像不影响数据。
RUN mkdir -p /app/data \
 && chown -R node:node /app

# 用基础镜像自带的非 root 用户 node（uid 1000）。若要固定 uid 便于宿主挂载，
# 可改成:  RUN groupadd -g 10001 ocgw && useradd -u 10001 -g ocgw -M -s /usr/sbin/nologin ocgw
USER node

# PANEL_DB 是面板原生支持的环境变量（见 01-管理面板/db.mjs）：
# 面板默认按 import.meta.dirname 找 panel.db，设了 PANEL_DB 就用它。
# 这样数据直接落在卷里，**不需要符号链接之类的技巧**。
# 注意：panel.db 是 WAL 模式，-wal / -shm 会生成在同一个目录（即 /app/data），
# 所以挂载的是【目录】而不是单个文件。
ENV PANEL_HOST=0.0.0.0 \
    PANEL_PORT=8790 \
    PANEL_DB=/app/data/panel.db \
    NODE_ENV=production

EXPOSE 8790

VOLUME ["/app/data"]

# 容器内直接监听 0.0.0.0；对外暴露端口由 compose 的 ports 控制。
# 生产建议只绑回环（127.0.0.1:8790:8790）由宿主机 nginx 反代 + HTTPS，
# 因为面板 cookie 无 Secure 且登录接口无速率限制。

# 健康检查：GET / 期望 200（管理面板 HTML）。
# 这里用 node 内置 http，不依赖 curl（两者都装了，但 node 一定在）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PANEL_PORT||8790,path:'/',timeout:4000},r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "/app/server.mjs"]
