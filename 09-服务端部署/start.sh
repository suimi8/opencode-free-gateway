#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# OpenCode 免费层网关 · 管理面板 Linux 服务端 —— 启动脚本
#
#   前台启动（直接占用当前终端，Ctrl-C 停止）:
#       bash start.sh
#   后台启动（写 PID + 日志，等端口就绪后返回）:
#       bash start.sh --daemon
#
# 环境变量（全部可选，见同目录 .env.example）:
#   PANEL_HOST   监听地址，本脚本默认 0.0.0.0（面板自身的默认是 127.0.0.1）
#   PANEL_PORT   监听端口，默认 8790
#   NODE_EXE     指定 node 可执行文件绝对路径（优先级最高）
#   OCGW_READY_TIMEOUT  就绪等待秒数，默认 30
#
# 本脚本不依赖 jq / python / npm，只用 bash + coreutils + curl/grep。
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PANEL_DIR="$ROOT/01-管理面板"

# ── 默认值（可被调用方环境变量覆盖）────────────────────────────────
: "${PANEL_HOST:=0.0.0.0}"
: "${PANEL_PORT:=8790}"
: "${OCGW_READY_TIMEOUT:=30}"
export PANEL_HOST PANEL_PORT

PID_FILE="$HERE/panel.pid"
LOG_FILE="$HERE/panel.log"

DAEMON=0
for arg in "$@"; do
  case "$arg" in
    --daemon|-d) DAEMON=1 ;;
    -h|--help)
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "[x] 未知参数: $arg（支持: --daemon / --help）" >&2
      exit 2 ;;
  esac
done

die() { echo "[x] $*" >&2; exit 1; }
info() { printf '[*] %s\n' "$*"; }
ok() { printf '[+] %s\n' "$*"; }

# ── 1. 解析 node 可执行文件 ─────────────────────────────────────────
# 刻意逐行判断、每个展开都加引号：$PATH 不展开、不依赖 which/type 的输出拼接，
# 这样即使路径里含空格、括号、中文也不会被拆成多个词。
NODE=""
if [ -n "${NODE_EXE:-}" ] && [ -x "${NODE_EXE}" ]; then
  NODE="$NODE_EXE"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [ -x "$HOME/node22/bin/node" ]; then
  NODE="$HOME/node22/bin/node"
fi

if [ -z "$NODE" ]; then
  cat >&2 <<'EOF'
[x] 找不到可用的 node。请按下面顺序处理：

    1) 免 root 便携安装（推荐，装到 $HOME/node22）:
           bash install-node.sh
       装完后再执行本脚本，或先 export NODE_EXE="$HOME/node22/bin/node"

    2) 系统包管理器安装（需要 root）:
           apt-get update && apt-get install -y nodejs     # 需要 >= 22.5

    3) 任意位置已有 node，直接指定:
           NODE_EXE=/opt/node/bin/node bash start.sh --daemon

    注意：管理面板依赖内置模块 node:sqlite，要求 Node >= 22.5，
          用 `node -v` 确认版本，低于 22.5 会启动即报错。
EOF
  exit 1
fi

# ── 2. 校验运行时前提（面板目录 / node:sqlite）──────────────────────
[ -f "$PANEL_DIR/server.mjs" ] || die "找不到面板入口: $PANEL_DIR/server.mjs（请确认脚本位于 09-服务端部署/ 内）"

NODE_VER="$("$NODE" -v 2>/dev/null || echo '?')"
if ! "$NODE" -e 'const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(":memory:").exec("create table t(a)")' >/dev/null 2>&1; then
  die "node:sqlite 不可用（当前 $NODE_VER）。管理面板需要 Node >= 22.5，请升级后重试。"
fi

# ── 3. 重复启动保护（PID 文件 + kill -0 探活）───────────────────────
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(tr -d ' \t\r\n' < "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    # 再确认这个 PID 真的是面板进程，避免 PID 被别的程序复用后误判
    if tr '\0' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null | grep -q 'server\.mjs'; then
      echo "[x] 面板已在运行 (PID $OLD_PID)。要重启请先执行: bash stop.sh" >&2
      exit 1
    fi
    echo "[!] PID 文件里的 $OLD_PID 存活但不是面板进程，按陈旧 PID 文件处理" >&2
  else
    info "清理陈旧的 PID 文件（进程 $OLD_PID 已不存在）"
  fi
  rm -f "$PID_FILE"
fi

# 端口占用预检：只警告不拦截（ss/netstat 的输出格式在不同发行版上有差异，
# 误判时直接拒绝启动反而更糟）。真正的失败判定交给后面的就绪探测。
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -qE "[:.]${PANEL_PORT}[[:space:]]"; then
    echo "[!] 警告: 端口 $PANEL_PORT 似乎已被监听。若启动失败请换 PANEL_PORT 或先释放端口。" >&2
    ss -ltnp 2>/dev/null | grep -E "[:.]${PANEL_PORT}[[:space:]]" | sed 's/^/    /' >&2
  fi
fi

# ── 4. 就绪探测函数 ─────────────────────────────────────────────────
# 用 curl 取 HTTP 状态码；没有 curl 时退化为纯 TCP 连通性检查（bash 内建 /dev/tcp）。
PROBE_HOST="$PANEL_HOST"
case "$PROBE_HOST" in
  0.0.0.0|'::'|'*') PROBE_HOST=127.0.0.1 ;;   # 通配监听 -> 从本机回环探测
esac

wait_ready() {
  local pid="$1" i deadline=$(( $(date +%s) + OCGW_READY_TIMEOUT )) code
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[x] 进程 $pid 在就绪前已退出，最近日志：" >&2
      tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/    /' >&2 || true
      return 1
    fi
    if command -v curl >/dev/null 2>&1; then
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
              "http://$PROBE_HOST:$PANEL_PORT/" 2>/dev/null || true)"
      case "$code" in 2*|3*) return 0 ;; esac
    else
      if (exec 3<>"/dev/tcp/$PROBE_HOST/$PANEL_PORT") 2>/dev/null; then
        exec 3<&- 2>/dev/null || true
        return 0
      fi
    fi
    sleep 0.3
  done
  echo "[x] 等待 ${OCGW_READY_TIMEOUT}s 仍未就绪（http://$PROBE_HOST:$PANEL_PORT/）" >&2
  tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/    /' >&2 || true
  return 1
}

echo "════════════════════════════════════════════════════════════"
echo " OpenCode 免费层网关 · 管理面板"
echo "   node      : $NODE ($NODE_VER)"
echo "   面板目录  : $PANEL_DIR"
echo "   监听      : $PANEL_HOST:$PANEL_PORT"
echo "   模式      : $([ "$DAEMON" -eq 1 ] && echo 后台 || echo 前台)"
echo "════════════════════════════════════════════════════════════"

cd "$PANEL_DIR"

# ── 5a. 前台启动 ────────────────────────────────────────────────────
if [ "$DAEMON" -eq 0 ]; then
  info "前台运行中，Ctrl-C 停止。日志直接输出到当前终端。"
  exec "$NODE" server.mjs
fi

# ── 5b. 后台启动 ────────────────────────────────────────────────────
# 用 setsid 脱离当前会话：脚本退出后不会因为终端关闭（SIGHUP）把面板带走。
if command -v setsid >/dev/null 2>&1; then
  setsid "$NODE" server.mjs >>"$LOG_FILE" 2>&1 < /dev/null &
else
  nohup "$NODE" server.mjs >>"$LOG_FILE" 2>&1 < /dev/null &
fi
PID=$!
echo "$PID" > "$PID_FILE"
info "已后台启动，PID $PID（日志: $LOG_FILE）"

if wait_ready "$PID"; then
  ok "面板就绪: http://$PANEL_HOST:$PANEL_PORT/"
  ok "PID 文件: $PID_FILE    日志: $LOG_FILE"
  echo
  echo "    健康检查 : curl -i http://127.0.0.1:$PANEL_PORT/"
  echo "    查看状态 : bash status.sh"
  echo "    停止服务 : bash stop.sh"
  if [ "$PANEL_HOST" = "0.0.0.0" ]; then
    echo
    echo "    [!] 当前监听 0.0.0.0，管理面板对网络可达。生产环境强烈建议："
    echo "        PANEL_HOST=127.0.0.1 bash start.sh --daemon   然后由 nginx 反代 + HTTPS。"
  fi
else
  echo "[x] 启动失败，保留 PID 文件以便排查；确认后执行: bash stop.sh" >&2
  exit 1
fi
