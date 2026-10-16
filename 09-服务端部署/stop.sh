#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# OpenCode 免费层网关 · 管理面板 Linux 服务端 —— 停止脚本
#
#   bash stop.sh
#
# 行为：按 ./panel.pid 找到进程 -> 先发 SIGTERM 优雅退出 ->
#       最多等 10 秒 -> 仍存活则 SIGKILL 强杀 -> 清理 PID 文件。
# 面板是 stateless HTTP 服务，SQLite 由 node:sqlite 自行管理句柄，
# SIGTERM 会让 Node 正常退出并关闭数据库（-wal 自动 checkpoint）。
# ══════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$HERE/panel.pid"
GRACE="${OCGW_STOP_GRACE:-10}"

if [ ! -f "$PID_FILE" ]; then
  echo "[!] 没有 PID 文件 ($PID_FILE) —— 面板可能未用 start.sh 启动，或已经停止。"
  echo "    检查残留进程: pgrep -af 'server\\.mjs'"
  echo "    用 systemd 托管时改用它: systemctl stop opencode-gateway"
  exit 0
fi

PID="$(tr -d ' \t\r\n' < "$PID_FILE" 2>/dev/null || true)"
if [ -z "$PID" ]; then
  echo "[!] PID 文件为空，直接删除: $PID_FILE"
  rm -f "$PID_FILE"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "[!] PID $PID 已不存在（进程早已退出），清理 PID 文件。"
  rm -f "$PID_FILE"
  exit 0
fi

# 防止 PID 复用：确认它确实是我们面板的进程
if ! tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q 'server\.mjs'; then
  echo "[!] PID $PID 存活但不是面板进程（PID 可能已被复用）。"
  echo "    为避免误杀，本脚本不发送任何信号，仅删除陈旧 PID 文件。"
  rm -f "$PID_FILE"
  exit 1
fi

echo "[*] 向 PID $PID 发送 SIGTERM（优雅停止）..."
kill -TERM "$PID" 2>/dev/null

waited=0
while kill -0 "$PID" 2>/dev/null; do
  if [ "$waited" -ge "$GRACE" ]; then
    echo "[!] ${GRACE}s 内未退出，发送 SIGKILL 强杀。"
    kill -KILL "$PID" 2>/dev/null
    sleep 1
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

if kill -0 "$PID" 2>/dev/null; then
  echo "[x] PID $PID 仍然存活（可能处于不可中断状态），请人工确认: ps -o pid,stat,cmd -p $PID" >&2
  exit 1
fi

rm -f "$PID_FILE"
echo "[+] 面板已停止 (PID $PID)，PID 文件已清理。"

# 顺手报告同名的游离进程，避免「以为停了其实还在」的误判
ORPHANS="$(pgrep -f 'node .*server\.mjs' 2>/dev/null | grep -v "^$PID$" || true)"
if [ -n "$ORPHANS" ]; then
  echo "[!] 检测到其它 server.mjs 进程仍在运行（可能是之前手工启动的）:"
  echo "$ORPHANS" | sed 's/^/      PID /'
  echo "    如需一并停止: kill ${ORPHANS//$'\n'/ }"
fi
