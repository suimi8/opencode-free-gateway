/**
 * model-registry.mjs —— 上游 free 模型的动态发现与下游模型列表的动态更新
 *
 * 两件事：
 *   1. **发现**：`GET https://opencode.ai/inference/v1/models` 拿到权威清单（实测**无需任何门禁头**）。
 *      上游会随时增删模型 —— 实测一次就发现新增了 4 个 free 模型、
 *      同时面板里配的 `nemotron-3-ultra-free` / `cat-jam-free` 已经下线。
 *   2. **探测**：对每个 free 候选发一个**最小 body** 的真实请求，判定它到底能不能用。
 *
 * 为什么额度耗尽也能探测：HTTP 状态码本身就能区分
 *   200 → 可用         429 → **存在且免费层可用，只是额度耗尽**（算可用）
 *   404 → 已下线        400 `does not support this protocol` → 存在，换另一个协议再试
 *   401/403 → 需要付费/被拒绝
 *
 * 下游 `GET /v1/models` 只返回「上游存在 + 判定可用」的 free 模型。
 */
import * as DB from './db.mjs';
import * as UP from './upstream.mjs';

const CATALOG_URL = process.env.MODEL_CATALOG_URL || 'https://opencode.ai/inference/v1/models';
const UA = 'opencode/1.19.2';

export const enabled = () => String(process.env.PANEL_MODEL_DISCOVERY ?? '1') !== '0';
const REFRESH_MS = Number(process.env.MODEL_REFRESH_MS || 30 * 60e3);
const PROBE_TIMEOUT = Number(process.env.MODEL_PROBE_TIMEOUT || 45000);

DB.db.exec(`CREATE TABLE IF NOT EXISTS model_catalog (
  id             TEXT PRIMARY KEY,
  in_upstream    INTEGER NOT NULL DEFAULT 0,   -- 是否出现在上游 /models 里
  is_free        INTEGER NOT NULL DEFAULT 0,   -- 判定为 free 候选
  usable         INTEGER NOT NULL DEFAULT 0,   -- 探测判定可用（含额度耗尽）
  status         TEXT NOT NULL DEFAULT 'unknown',
  protocol       TEXT,                          -- chat | responses | null
  last_seen_at   INTEGER NOT NULL DEFAULT 0,   -- 最后一次出现在上游清单
  last_probe_at  INTEGER NOT NULL DEFAULT 0,
  http_status    INTEGER,
  delay_ms       INTEGER,
  detail         TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1    -- 是否允许暴露给下游
)`);

const all = () => DB.db.prepare('SELECT * FROM model_catalog ORDER BY usable DESC, is_free DESC, id').all();
export const getModel = (id) => DB.db.prepare('SELECT * FROM model_catalog WHERE id = ?').get(id);

/** free 候选：名字以 -free 结尾，或上游 owned_by 标记，或面板渠道里手配的 */
function isFreeCandidate(id, extra = []) {
  if (extra.includes(id)) return true;
  return /-free$/i.test(id) || /free$/i.test(id) || id === 'big-pickle';   // big-pickle 实测也是免费层
}

/* ══════════════════════════════════════════════════ 发现 */
export async function fetchUpstreamModels({ proxy } = {}) {
  const r = await UP.request({
    url: CATALOG_URL,
    method: 'GET',                     // ⚠️ UP.request 默认是 POST，这里必须显式 GET（否则 404）
    headers: { 'user-agent': UA, accept: 'application/json' },
    body: undefined,
    proxy: proxy || undefined,
    timeout: 25000,
  });
  const text = await new Promise((res) => {
    let b = ''; r.res.setEncoding('utf8');
    r.res.on('data', (c) => { b += c; });
    r.res.on('end', () => res(b));
    r.res.on('error', () => res(b));
  });
  if (r.res.statusCode !== 200) throw new Error(`上游模型清单 HTTP ${r.res.statusCode}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  const data = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
  return data.map((m) => ({ id: String(m.id || m.name || ''), owned_by: m.owned_by || '', created: m.created || 0 })).filter((m) => m.id);
}

/* ══════════════════════════════════════════════════ 探测 */
const READ_TOOL = (flat) => (flat
  ? { type: 'function', name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } }
  : { type: 'function', function: { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } } });

function mkSession() {
  const HEX = '0123456789abcdef', B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const pick = (s, n) => Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
  return `ses_${pick(HEX, 9)}${(0xfc0 + Math.floor(Math.random() * 0x40)).toString(16).padStart(3, '0')}${pick(B62, 14)}`;
}

/** 最小 body（只带一个 read 工具）——探测用，成功也才 ~300 prompt tokens */
const chatBody = (model) => JSON.stringify({
  model, stream: true, max_tokens: 8,
  messages: [{ role: 'user', content: 'hi' }], tools: [READ_TOOL(false)],
});
const respBody = (model) => JSON.stringify({
  model, stream: true, store: false,
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  tools: [READ_TOOL(true)],
});

function classify(status, text) {
  const msg = (String(text).match(/"message"\s*:\s*"([^"]{0,120})/)?.[1] ?? String(text).slice(0, 120)).replace(/\s+/g, ' ');
  if (status === 200) return { status: 'available', usable: true, reason: '探测成功' };
  if (status === 429) return { status: 'quota', usable: true, reason: '额度耗尽（模型存在且免费层可用）' };
  if (/does not support this protocol/i.test(msg)) return { status: 'wrong-protocol', usable: false, reason: msg };
  if (status === 404) return { status: 'not-found', usable: false, reason: msg || '模型不存在' };
  if (/free tier can only be used/i.test(msg)) return { status: 'gate', usable: false, reason: msg };
  if (/region/i.test(msg)) return { status: 'region', usable: false, reason: msg };
  if (status === 401 || status === 402) return { status: 'paid', usable: false, reason: msg || '需要付费/额度' };
  if (status === 403) return { status: 'forbidden', usable: false, reason: msg || '被拒绝' };
  if (status === 400) return { status: 'bad-request', usable: false, reason: msg };
  return { status: 'error', usable: false, reason: msg || `HTTP ${status}` };
}

async function probeOne(ch, model) {
  const base = (ch && ch.base_url) || 'https://opencode.ai/inference/v1/chat/completions';
  const chatUrl = /chat\/completions/.test(base) ? base : `${base.replace(/\/+$/, '')}/chat/completions`;
  const respUrl = chatUrl.replace(/\/chat\/completions.*$/, '/responses');
  const headers = { 'content-type': 'application/json', 'user-agent': UA, 'x-opencode-session': mkSession() };

  const send = async (url, body) => {
    const t0 = Date.now();
    const r = await UP.request({ url, headers, body: JSON.parse(body), proxy: ch ? ch.proxy : undefined, timeout: PROBE_TIMEOUT });
    const text = await new Promise((res) => {
      let b = ''; r.res.setEncoding('utf8');
      r.res.on('data', (c) => { b += c; });
      r.res.on('end', () => res(b));
      r.res.on('error', () => res(b));
    });
    return { status: r.res.statusCode, text, ms: Date.now() - t0 };
  };

  try {
    let r = await send(chatUrl, chatBody(model));
    let c = classify(r.status, r.text);
    if (c.status === 'wrong-protocol') {
      // 换 responses 协议再试（muse-spark 这类）
      const r2 = await send(respUrl, respBody(model));
      const c2 = classify(r2.status, r2.text);
      if (c2.usable || c2.status !== 'wrong-protocol') {
        return { ...c2, protocol: c2.usable ? 'responses' : null, http: r2.status, ms: r2.ms };
      }
      return { ...c, protocol: null, http: r.status, ms: r.ms };
    }
    return { ...c, protocol: c.usable ? 'chat' : null, http: r.status, ms: r.ms };
  } catch (e) {
    return { status: 'error', usable: false, protocol: null, reason: String(e.message).slice(0, 160), http: 0, ms: 0 };
  }
}

/* ══════════════════════════════════════════════════ 刷新 */
/**
 * 拉上游清单 + 探测 free 候选。
 *   probe=false  只更新清单，不探测
 */
export async function refreshCatalog({ probe = true, ch = null, concurrency = 4 } = {}) {
  const list = await fetchUpstreamModels({ proxy: ch ? ch.proxy : undefined });
  const now = Date.now();
  const upIds = new Set(list.map((m) => m.id));

  // 面板渠道里手配的模型也算 free 候选（可能上游清单里没有但确实能用）
  const channelModels = [...new Set(DB.listChannels().filter((c) => c.status === 1).flatMap((c) => UP.channelModels(c)))];

  const up = DB.db.prepare(`INSERT INTO model_catalog(id, in_upstream, is_free, last_seen_at) VALUES(?,?,?,?)
                            ON CONFLICT(id) DO UPDATE SET in_upstream=excluded.in_upstream,
                              is_free=MAX(model_catalog.is_free, excluded.is_free), last_seen_at=excluded.last_seen_at`);
  for (const m of list) up.run(m.id, 1, isFreeCandidate(m.id, channelModels) ? 1 : 0, now);
  // 上游没了的手配模型也要登记（in_upstream=0），否则无法标记下架
  for (const id of channelModels) if (!upIds.has(id)) up.run(id, 0, 1, 0);

  // 上游清单里消失的 → 标记下架
  const gone = DB.db.prepare('UPDATE model_catalog SET in_upstream = 0 WHERE id NOT IN (' +
    (list.length ? list.map(() => '?').join(',') : "''") + ')').run(...list.map((m) => m.id));

  const result = { upstreamTotal: list.length, freeCandidates: [], probed: [], gone: gone.changes };
  if (!probe) return result;

  const cands = DB.db.prepare('SELECT id, is_free, in_upstream FROM model_catalog WHERE is_free = 1').all();
  result.freeCandidates = cands.map((c) => c.id);

  const target = ch || DB.listChannels().find((c) => c.status === 1) || null;
  const queue = [...cands];
  const setRes = DB.db.prepare(`UPDATE model_catalog SET usable=?, status=?, protocol=?, last_probe_at=?,
                                http_status=?, delay_ms=?, detail=? WHERE id=?`);
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      const r = await probeOne(target, c.id);
      setRes.run(r.usable ? 1 : 0, r.status, r.protocol || null, Date.now(), r.http || null, r.ms || null, r.reason || null, c.id);
      // 探测出确定协议就同步到 model_protocols，让路由/协议表与注册表一致
      if (r.usable && r.protocol) {
        try {
          DB.recordProbe(c.id,
            r.protocol === 'chat' ? 'ok' : 'wrong-protocol',
            r.protocol === 'responses' ? 'ok' : 'wrong-protocol',
            { source: 'model-registry', http: r.http });
        } catch { /* 忽略 */ }
      }
      result.probed.push({ id: c.id, status: r.status, usable: r.usable, protocol: r.protocol, http: r.http, ms: r.ms, reason: r.reason });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cands.length || 1) }, worker));
  DB.setSetting('model_catalog_refreshed_at', String(Date.now()));
  return result;
}

/* ══════════════════════════════════════════════════ 读取 */
/**
 * 下游/路由应当使用的模型 id。
 *
 * ⚠️ 以**探测结果**为准，不要求出现在上游清单里 —— 实测 `cat-jam-free`
 * 探测 200 可用，但 `/inference/v1/models` 里根本没有它。
 * 上游清单只用来*发现*新模型，可用性一律看探测。
 */
export function usableModelIds() {
  return DB.db.prepare('SELECT id FROM model_catalog WHERE usable = 1 AND enabled = 1').all().map((r) => r.id);
}
/** 上游已下线（清单里没有）的模型 id */
export function goneModelIds() {
  return DB.db.prepare('SELECT id FROM model_catalog WHERE in_upstream = 0').all().map((r) => r.id);
}
export function catalogState() {
  const rows = all();
  const last = Number(DB.getSetting('model_catalog_refreshed_at') || 0);
  return {
    enabled: enabled(),
    refreshMs: REFRESH_MS,
    lastRefreshAt: last || null,
    lastRefreshAgoMin: last ? +((Date.now() - last) / 60000).toFixed(1) : null,
    upstreamTotal: rows.filter((r) => r.in_upstream).length,
    freeCandidates: rows.filter((r) => r.is_free).length,
    usable: rows.filter((r) => r.usable && r.in_upstream).length,
    gone: rows.filter((r) => !r.in_upstream).length,
    rows,
  };
}
/** 供 /v1/models 用：把动态结果映射成 OpenAI 格式（默认只给可用的） */
export function downstreamModels({ includeUnusable = false } = {}) {
  const proto = DB.getProtocolMap();
  const where = includeUnusable
    ? 'is_free = 1 AND enabled = 1'
    : 'is_free = 1 AND enabled = 1 AND usable = 1';
  return DB.db.prepare(`SELECT * FROM model_catalog WHERE ${where} ORDER BY usable DESC, id`).all()
    .map((r) => {
      const p = proto[r.id];
      return {
        id: r.id,
        object: 'model',
        created: Math.floor((r.last_seen_at || r.last_probe_at || Date.now()) / 1000),
        owned_by: 'opencode-free',
        available: !!r.usable,
        status: r.status,
        in_upstream: !!r.in_upstream,
        protocols: r.protocol ? [r.protocol] : (p ? p.protocols : null),
      };
    });
}
export function setModelEnabled(id, on) {
  DB.db.prepare('UPDATE model_catalog SET enabled=? WHERE id=?').run(on ? 1 : 0, id);
}

/* ══════════════════════════════════════════════════ 定时刷新 */
let timer = null;
export function startScheduler({ intervalMs = REFRESH_MS } = {}) {
  if (!enabled() || timer) return { running: false };
  const tick = async () => {
    try {
      const r = await refreshCatalog({ probe: true });
      const ok = r.probed.filter((x) => x.usable).length;
      console.log(`[模型发现] 上游 ${r.upstreamTotal} 个，free 候选 ${r.freeCandidates.length} 个，可用 ${ok} 个，下架 ${r.gone} 个`);
    } catch (e) { console.log(`[模型发现] 刷新失败: ${String(e.message).slice(0, 140)}`); }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();      // 启动后 5 秒先跑一次
  return { running: true, intervalMs };
}
export function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }
