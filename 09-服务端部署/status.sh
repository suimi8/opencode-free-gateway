#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# OpenCode 免费层网关 · 管理面板 Linux 服务端 —— 状态查看
#
#   bash status.sh
#
# 打印：PID / 进程是否存活 / 端口是否监听 / GET / 是否返回 200 / 最近 15 行日志。
# 只读操作，不改变任何状态。退出码 0 = 一切正常，1 = 有异常（便于监控调用）。
# ══════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$HERE/panel.pid"
LOG_FILE="$HERE/panel.log"

# 端口优先取环境变量，其次从 PID 文件对应进程的 /proc/<pid>/environ 里读，
# 最后回落到 8790。这样 status.sh 无需你手动指定 PANEL_PORT 也能看对端口。
: "${PANEL_PORT:=8790}"
PID_HINT=""
if [ -f "$PID_FILE" ]; then
  PID_HINT="$(tr -d ' \t\r\n' < "$PID_FILE" 2>/dev/null || true)"
fi
if [ -n "$PID_HINT" ] && [ -r "/proc/$PID_HINT/environ" ]; then
  ENV_PORT="$(tr '\0' '\n' < "/proc/$PID_HINT/environ" 2>/dev/null \
              | sed -n 's/^PANEL_PORT=//p' | tr -d '\r' || true)"
  [ -n "${ENV_PORT:-}" ] && PANEL_PORT="$ENV_PORT"
  ENV_HOST="$(tr '\0' '\n' < "/proc/$PID_HINT/environ" 2>/dev/null \
              | sed -n 's/^PANEL_HOST=//p' | tr -d '\r' || true)"
  [ -n "${ENV_HOST:-}" ] && PANEL_HOST="${PANEL_HOST:-$ENV_HOST}"
fi
: "${PANEL_HOST:=0.0.0.0}"

PROBE_HOST="$PANEL_HOST"
case "$PROBE_HOST" in
  0.0.0.0|'::'|'*') PROBE_HOST=127.0.0.1 ;;
esac

BAD=0
line() { printf '  %-12s %s\n' "$1" "$2"; }

echo "════════════════════════════════════════════════════════════"
echo " OpenCode 免费层网关 · 管理面板 状态"
echo "════════════════════════════════════════════════════════════"

# ── 1. PID 与存活 ───────────────────────────────────────────────────
PID=""
if [ -f "$PID_FILE" ]; then
  PID="$(tr -d ' \t\r\n' < "$PID_FILE" 2>/dev/null || true)"
fi

if [ -z "$PID" ]; then
  line "PID" "无 PID 文件（$PID_FILE 不存在或为空）"
  PID_DISPLAY="-"
  BAD=1
elif kill -0 "$PID" 2>/dev/null; then
  CMD="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | cut -c1-90 || echo '?')"
  UPTIME="$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ' || true)"
  RSS="$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ' || true)"
  [ -n "$RSS" ] && RSS="$((RSS / 1024)) MB" || RSS='?'
  line "PID" "$PID  (存活)"
  line "命令行" "$CMD"
  line "已运行" "${UPTIME:-?}    内存  ${RSS}"
  PID_DISPLAY="$PID"
else
  line "PID" "$PID  (进程已不存在 —— 陈旧 PID 文件)"
  PID_DISPLAY="$PID"
  BAD=1
fi

# ── 2. 端口监听 ─────────────────────────────────────────────────────
LISTEN=""
if command -v ss >/dev/null 2>&1; then
  LISTEN="$(ss -ltnp 2>/dev/null | grep -E "[:.]${PANEL_PORT}[[:space:]]" || true)"
elif command -v netstat >/dev/null 2>&1; then
  LISTEN="$(netstat -ltnp 2>/dev/null | grep -E "[:.]${PANEL_PORT}[[:space:]]" || true)"
fi

if [ -n "$LISTEN" ]; then
  line "端口" "$PANEL_PORT 已监听"
  echo "$LISTEN" | sed 's/^/               /'
  if [ -n "$PID_DISPLAY" ] && [ "$PID_DISPLAY" != "-" ]; then
    echo "$LISTEN" | grep -q "pid=$PID_DISPLAY" \
      && line "监听归属" "属于 PID $PID_DISPLAY ✔" \
      || line "监听归属" "监听者不是 PID $PID_DISPLAY（端口可能被别的进程占用）"
  fi
else
  if command -v ss >/dev/null 2>&1 || command -v netstat >/dev/null 2>&1; then
    line "端口" "$PANEL_PORT 未监听"
  else
    line "端口" "无法检测（缺少 ss / netstat）"
  fi
  BAD=1
fi

# ── 3. HTTP 健康检查（GET / 期望 200）───────────────────────────────
if command -v curl >/dev/null 2>&1; then
  RESP="$(curl -sS -o /dev/null --max-time 5 \
          -w '%{http_code} %{content_type} %{time_total}s' \
          "http://$PROBE_HOST:$PANEL_PORT/" 2>/dev/null || true)"
  CODE="${RESP%% *}"
  case "$CODE" in
    200) line "GET /" "HTTP 200  ($RESP)";;
    2*|3*) line "GET /" "HTTP $CODE  ($RESP)";;
    ""|000) line "GET /" "无响应（面板未监听或端口不对：$PROBE_HOST:$PANEL_PORT）"; BAD=1;;
    *)   line "GET /" "HTTP $CODE —— 非 200，面板可能异常"; BAD=1;;
  esac

  # 登录接口可达性（不发密码，只确认路由存在且不返回 5xx）
  LCODE="$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' \
           -X POST -H 'content-type: application/json' -d '{}' \
           "http://$PROBE_HOST:$PANEL_PORT/api/login" 2>/dev/null || true)"
  case "$LCODE" in
    4*) line "POST /api/login" "HTTP $LCODE（路由正常，空密码被拒 = 预期）";;
    2*) line "POST /api/login" "HTTP $LCODE（空密码竟然通过？请立即检查默认密码）";;
    ""|000) line "POST /api/login" "无响应";;
    *)  line "POST /api/login" "HTTP $LCODE";;
  esac
else
  line "GET /" "跳过（未安装 curl）"
fi

# ── 4. 最近 15 行日志 ───────────────────────────────────────────────
echo
echo "  ── 最近 15 行日志 ($LOG_FILE) ──"
if [ -f "$LOG_FILE" ]; then
  tail -n 15 "$LOG_FILE" | sed 's/^/  | /'
else
  echo "  | (没有日志文件；用 systemd 托管时请用: journalctl -u opencode-gateway -n 50)"
fi

echo "════════════════════════════════════════════════════════════"
if [ "$BAD" -eq 0 ]; then
  echo " 结论: 运行正常 ✔    面板地址 http://$PROBE_HOST:$PANEL_PORT/"
  exit 0
else
  echo " 结论: 存在异常 ✘    排查: tail -f \"$LOG_FILE\""
  exit 1
fi
