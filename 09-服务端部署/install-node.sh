#!/usr/bin/env bash
# 免 root 安装便携版 Node.js（解压到 $HOME，不改系统、不用 sudo）
# 用法:  bash install-node.sh [版本]      默认 v22 最新 LTS
set -euo pipefail

WANT="${1:-}"
DEST="${NODE_HOME:-$HOME/node22}"

if [ -x "$DEST/bin/node" ] && [ -z "$WANT" ]; then
  echo "[=] 已存在: $("$DEST/bin/node" -v)  ($DEST)"
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NARCH=x64 ;;
  aarch64|arm64) NARCH=arm64 ;;
  *) echo "[x] 不支持的架构: $ARCH" >&2; exit 1 ;;
esac

if [ -z "$WANT" ]; then
  echo "[*] 查询 nodejs.org 上最新的 v22.x ..."
  WANT="$(curl -fsSL --max-time 30 https://nodejs.org/dist/index.json \
          | grep -o '"version":"v22\.[0-9.]*"' | head -1 | cut -d'"' -f4)"
fi
[ -n "$WANT" ] || { echo "[x] 无法确定 Node 版本，请手动指定: bash install-node.sh v22.22.3" >&2; exit 1; }

PKG="node-${WANT}-linux-${NARCH}"
URL="https://nodejs.org/dist/${WANT}/${PKG}.tar.xz"
echo "[*] 下载 $URL"
curl -fsSL --max-time 600 -o /tmp/node.tar.xz "$URL"

echo "[*] 解压到 $DEST"
rm -rf "$DEST"; mkdir -p "$DEST"
tar -xJf /tmp/node.tar.xz -C "$DEST" --strip-components=1
rm -f /tmp/node.tar.xz

export PATH="$DEST/bin:$PATH"
echo "[+] node $(node -v)   npm $(npm -v)"
echo "[*] 校验 node:sqlite（管理面板依赖，需要 Node ≥ 22.5）"
node -e 'const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(":memory:").exec("create table t(a)"); console.log("[+] node:sqlite OK");'

cat <<EOF

完成。把下面这行加到 ~/.bashrc 以便长期使用：

    export PATH="$DEST/bin:\$PATH"

EOF
