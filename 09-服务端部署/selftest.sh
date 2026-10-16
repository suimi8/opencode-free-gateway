#!/usr/bin/env bash
# OpenCode 免费层网关 —— Linux 服务端自检
#
#   bash selftest.sh [端口]              默认 18799
#   OCGW_CLEAR_PROXY=1 bash selftest.sh  先清空渠道代理（验证「直连能不能过门禁」）
#   OCGW_KEEP=1 bash selftest.sh         保留临时目录以便排查
#
# 设计要点：把面板**复制到 Linux 原生文件系统**再跑。这样
#   1) 不会动你真实的 panel.db
#   2) 避开 DrvFs/WSL 跨文件系统的 SQLite WAL 锁问题
#   3) 与「拷到服务器上跑」的真实场景一致
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${1:-18799}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ocgw-selftest-XXXXXX")"
PANEL="$WORK/panel"
PASS=0; FAIL=0; SRV=""

cleanup() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  if [ "${OCGW_KEEP:-0}" = "1" ]; then echo "  (临时目录保留: $WORK)"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

ok()  { printf '  [OK]   %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); }
sec() { printf '\n── %s\n' "$1"; }

# ── 解析 node（优先 NODE_EXE，其次 PATH，再次便携安装）────────
if [ -n "${NODE_EXE:-}" ] && [ -x "$NODE_EXE" ]; then NODE="$NODE_EXE"
elif command -v node >/dev/null 2>&1; then NODE="$(command -v node)"
elif [ -x "$HOME/node22/bin/node" ]; then NODE="$HOME/node22/bin/node"
else
  echo "[x] 找不到 node。请先跑: bash install-node.sh" >&2; exit 1
fi

printf 'OpenCode 免费层网关 · Linux 服务端自检\n'
printf '项目根 : %s\n' "$ROOT"
printf 'node   : %s (%s)\n' "$NODE" "$("$NODE" -v)"
printf '平台   : %s %s\n' "$(uname -s)" "$(uname -m)"
printf '临时区 : %s\n' "$WORK"

# ── 1. 运行时依赖 ───────────────────────────────────────────
sec '1/5 运行时依赖'
if "$NODE" -e 'const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(":memory:").exec("create table t(a)")' 2>/dev/null; then
  ok "node:sqlite 可用（Node $("$NODE" -v)）"
else
  bad "node:sqlite 不可用 —— 需要 Node ≥ 22.5"
fi
for c in curl grep find tar; do
  command -v "$c" >/dev/null 2>&1 && ok "系统工具 $c" || bad "缺少系统工具 $c"
done

# ── 2. 语法 + 平台无关性 ────────────────────────────────────
sec '2/5 代码检查'
js_bad=0; js_n=0
while IFS= read -r f; do
  js_n=$((js_n+1))
  "$NODE" --check "$f" >/dev/null 2>&1 || { js_bad=$((js_bad+1)); echo "         $f"; }
done < <(find "$ROOT" -type f \( -name '*.mjs' -o -name '*.js' \) \
         -not -path '*/08-上游源码快照/*' -not -path '*/99-解包产物与运行时残留/*')
[ "$js_bad" -eq 0 ] && ok "$js_n/$js_n 个 JS 文件语法通过" || bad "$js_bad/$js_n 个文件语法失败"

win_hits="$(grep -rlE 'process\.platform|taskkill|C:\\\\' --include='*.mjs' \
            "$ROOT/01-管理面板" "$ROOT/02-直连客户端" 2>/dev/null | wc -l)"
[ "$win_hits" -eq 0 ] && ok "面板与客户端无 Windows 专属写法" || bad "$win_hits 个文件含 Windows 专属写法"

if grep -rqE "path\.join|import\.meta\.dirname|__dirname" --include='*.mjs' "$ROOT/01-管理面板" \
   && ! grep -rqE "['\"][^'\"]*\\\\\\\\[^'\"]*['\"]" --include='*.mjs' "$ROOT/01-管理面板" 2>/dev/null; then
  ok "面板路径全部走 path.join（无硬拼反斜杠）"
else
  bad "面板存在硬拼反斜杠路径"
fi

# ── 3. 复制到原生文件系统 ───────────────────────────────────
# 注意：panel.db-wal / -shm 是数据库的一部分，**不能单独删**，
#       否则会丢掉还没 checkpoint 的数据（渠道/令牌可能全在里面）。
#       要拿一致性副本，正确做法是 SQLite 的 VACUUM INTO。
sec '3/5 部署副本'
mkdir -p "$PANEL"
find "$ROOT/01-管理面板" -mindepth 1 -maxdepth 1 \
  ! -name 'panel.db' ! -name 'panel.db-wal' ! -name 'panel.db-shm' \
  -exec cp -r {} "$PANEL/" \; || { bad "复制面板失败"; exit 1; }

SRCDB="$ROOT/01-管理面板/panel.db"
if [ -f "$SRCDB" ]; then
  if "$NODE" "$HERE/snapshot-db.mjs" "$SRCDB" "$PANEL/panel.db"; then
    ok "panel.db 已用 VACUUM INTO 做一致性快照（源库未改动）"
  else
    bad "VACUUM INTO 快照失败 —— 面板将以空库启动"
  fi
else
  ok "源目录无 panel.db（面板会新建空库）"
fi
ok "面板已复制到 $PANEL（$(du -sh "$PANEL" | cut -f1)）"

# ── 4. 启动 + API + 端到端上游调用 ──────────────────────────
sec '4/5 服务启动与真实上游调用'
PANEL_PORT="$PORT" PANEL_HOST=127.0.0.1 "$NODE" "$PANEL/server.mjs" >"$WORK/server.log" 2>&1 &
SRV=$!

up=0
for _ in $(seq 1 60); do
  sleep 0.25
  kill -0 "$SRV" 2>/dev/null || break
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/" -o /dev/null 2>/dev/null && { up=1; break; }
done

if [ "$up" -ne 1 ]; then
  bad "服务未在 15s 内监听 $PORT"
  sed 's/^/         /' "$WORK/server.log" | tail -25
else
  ok "服务已监听 http://127.0.0.1:$PORT/（Linux 原生路径）"
  OCGW_CLEAR_PROXY="${OCGW_CLEAR_PROXY:-0}" "$NODE" - "$PORT" <<'NODEEOF'
const port = process.argv[2];
const base = `http://127.0.0.1:${port}`;
let TOKEN = process.env.TEST_TOKEN || '';   // 不内置令牌；为空时下面自动创建
let pass = 0, fail = 0;
const ok  = (m) => { console.log('  [OK]   ' + m); pass++; };
const bad = (m) => { console.log('  [FAIL] ' + m); fail++; };

const lr = await fetch(base + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: process.env.PANEL_PASSWORD || 'admin123' }),
});
const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
const j = await lr.json();
j.ok ? ok('POST /api/login -> {"ok":true}') : bad('POST /api/login -> ' + JSON.stringify(j));

// 取测试令牌（公开仓库不内置任何凭据）
if (!TOKEN) {
  const tr = await fetch(base + '/api/tokens', { headers: { cookie } });
  const tj = await tr.json();
  let first = (tj.rows || []).find((x) => x.status === 1);
  if (!first) {
    const cr = await fetch(base + '/api/tokens', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'selftest', unlimited: true }),
    });
    first = await cr.json();
  }
  if (!first || !first.key) bad('无法取得测试令牌');
  else { TOKEN = first.key; ok('取得测试令牌 ' + TOKEN.slice(0, 8) + '…'); }
}

const api = async (p, opt) => (await fetch(base + p, { headers: { cookie, 'content-type': 'application/json' }, ...opt })).json();

for (const [p, label] of [['/api/channels','渠道'],['/api/tokens','令牌'],['/api/stats','统计']]) {
  try { const r = await api(p); ok(`GET ${p} -> ${r.rows ? r.rows.length + ' 条' : '正常'} (${label})`); }
  catch (e) { bad(`GET ${p} -> ${e.message}`); }
}

// 可选：清空渠道代理，验证「不带代理直连」也能过门禁
// updateChannel 用 `c.x ?? cur.x` 合并，所以只发 {proxy:''} 即可，不会动其它字段
if (process.env.OCGW_CLEAR_PROXY === '1') {
  try {
    const { rows } = await api('/api/channels');
    for (const ch of rows) {
      const r = await api('/api/channels/' + ch.id, { method: 'PUT', body: JSON.stringify({ proxy: '' }) });
      if (r && r.id) ok(`渠道 #${ch.id} 代理已清空（副本内）`);
      else bad(`渠道 #${ch.id} 清空代理失败: ${JSON.stringify(r).slice(0, 120)}`);
    }
  } catch (e) { bad('清空代理失败: ' + e.message); }
}

try {
  const r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + TOKEN } });
  const d = await r.json();
  ok(`GET /v1/models -> ${d.data.length} 个模型`);
} catch (e) { bad('GET /v1/models -> ' + e.message); }

try {
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', stream: false,
                           messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] }),
    signal: AbortSignal.timeout(150000),
  });
  const d = await r.json();
  const c = d.choices?.[0]?.message?.content ?? JSON.stringify(d).slice(0, 300);
  if (r.status === 200 && /PONG/i.test(c)) {
    ok(`POST /v1/chat/completions -> HTTP 200 model=${d.model} content="${c.trim()}" usage=${d.usage?.prompt_tokens}/${d.usage?.completion_tokens}/${d.usage?.total_tokens}`);
  } else {
    bad(`POST /v1/chat/completions -> HTTP ${r.status} ${c}`);
  }
} catch (e) { bad('POST /v1/chat/completions -> ' + e.message); }

process.exit(fail ? 1 : 0);
NODEEOF
  [ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
fi

kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; SRV=""

sec '5/5 结论'
printf '  通过 %d   失败 %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && { printf '  Linux 服务端可用 ✅\n'; exit 0; } || { printf '  存在失败项 ❌\n'; exit 1; }
