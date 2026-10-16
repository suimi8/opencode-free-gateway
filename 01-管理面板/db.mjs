/**
 * db.mjs — SQLite 存储层（node:sqlite，零依赖）
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// 数据库位置：默认与脚本同目录的 panel.db。
// 部署到容器/systemd 时可用 PANEL_DB 指到数据卷，避免依赖符号链接：
//     PANEL_DB=/app/data/panel.db
// 注意：panel.db 是 WAL 模式，panel.db-wal / panel.db-shm 是数据库的一部分，
// 备份或迁移必须三者一起（推荐用 09-服务端部署/snapshot-db.mjs 的 VACUUM INTO）。
export const DB_PATH = process.env.PANEL_DB || path.join(DIR, 'panel.db');
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch { /* 目录已存在或无权限，交给 SQLite 报错 */ }

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL DEFAULT 'opencode',
  base_url        TEXT,
  api_key         TEXT,
  models          TEXT    NOT NULL DEFAULT '[]',
  proxy           TEXT    NOT NULL DEFAULT '',
  priority        INTEGER NOT NULL DEFAULT 0,
  status          INTEGER NOT NULL DEFAULT 1,
  disabled_until  INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  extra           TEXT    NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  key        TEXT    NOT NULL UNIQUE,
  quota      INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  unlimited  INTEGER NOT NULL DEFAULT 1,
  models     TEXT    NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL DEFAULT 0,
  status     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  token_id          INTEGER,
  token_name        TEXT,
  channel_id        INTEGER,
  channel_name      TEXT,
  model             TEXT,
  upstream_model    TEXT,
  proxy             TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  ttft_ms           INTEGER,
  status            INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 0,
  stream            INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  client_ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_model ON logs(model);
`);

/* ══════════════════════════════════════════════════ 设置 */
export function getSetting(key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

export function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${h}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const calc = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(calc, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function ensureDefaults() {
  // PANEL_PASSWORD / PANEL_SITE_NAME 只在**首次创建**时生效；之后请在面板里改
  if (!getSetting('admin_password')) setSetting('admin_password', hashPassword(process.env.PANEL_PASSWORD || 'admin123'));
  if (!getSetting('site_name')) setSetting('site_name', process.env.PANEL_SITE_NAME || 'OpenCode 免费层网关');
  if (!getSetting('session_secret')) setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  if (!getSetting('default_proxy')) setSetting('default_proxy', '');
  // 协议兼容表：由探测填充。免费层的模型**按协议绑定**，
  // 用错协议上游返回 400 `Model does not support this protocol.`
  db.exec(`CREATE TABLE IF NOT EXISTS model_protocols (
    model       TEXT PRIMARY KEY,
    protocols   TEXT NOT NULL,
    detail      TEXT,
    updated_at  INTEGER NOT NULL
  )`);

  // 首次运行**种子渠道**：保证 clone 下来直接就能用，不用手工配渠道。
  // 这里的模型清单只是初始值；开着动态发现时会自动跟上游增删。
  if (!db.prepare('SELECT COUNT(*) AS n FROM channels').get().n) {
    createChannel({
      name: 'OpenCode 免费层',
      type: 'opencode',
      base_url: 'https://opencode.ai/inference/v1/chat/completions',
      api_key: 'public',
      models: [
        'deepseek-v4.1-flash-free', 'longcat-2.5-preview-free', 'space-bunny-free',
        'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free', 'nemotron-3.5-super-vl-free',
        'big-pickle', 'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free',
        'beam-free', 'glm-5.3-flash-free',
      ],
      proxy: process.env.PANEL_DEFAULT_PROXY || '',
      priority: 100,
      status: 1,
      extra: {},
    });
  }
}

/* ══════════════════════════════════════════════════ 模型协议兼容
 * 存储形态（protocols 列里放 JSON）：
 *   { protocols:[...], notSupported:[...], unknown:[...], updatedAt }
 * 表里没有的模型 = 完全未知，调用方应放开（向后兼容）。
 *
 * 关键：**额度耗尽（429）不能当成「协议不支持」** —— 否则一次探测赶上额度用光，
 * 就会把本来可用的模型永久错标。所以只有明确的
 * `wrong-protocol` / `gate-403` / `region` 才算「确认不支持」，其余一律保留原判定。
 */
function normProtocols(v) {
  if (Array.isArray(v)) return { protocols: v, notSupported: [], unknown: [] };   // 兼容旧格式
  if (v && typeof v === 'object') {
    return {
      protocols: Array.isArray(v.protocols) ? v.protocols : [],
      notSupported: Array.isArray(v.notSupported) ? v.notSupported : [],
      unknown: Array.isArray(v.unknown) ? v.unknown : [],
    };
  }
  return { protocols: [], notSupported: [], unknown: [] };
}

export function getProtocolMap() {
  let rows = [];
  try { rows = db.prepare('SELECT model, protocols, updated_at FROM model_protocols').all(); } catch { return {}; }
  const out = {};
  for (const r of rows) {
    try {
      const n = normProtocols(JSON.parse(r.protocols));
      out[r.model] = { ...n, updatedAt: r.updated_at };
    } catch { /* 坏行忽略 */ }
  }
  return out;
}

const PROBE_CACHE = { map: null, at: 0 };
/** 带 1 秒缓存的取用（热路径 candidates() 会频繁调用） */
export function protocolMapCached() {
  const now = Date.now();
  if (!PROBE_CACHE.map || now - PROBE_CACHE.at > 1000) { PROBE_CACHE.map = getProtocolMap(); PROBE_CACHE.at = now; }
  return PROBE_CACHE.map;
}

/**
 * 把一次探测的两个裁决并入兼容表。
 * verdict ∈ ok | wrong-protocol | gate-403 | region | quota | error | other
 */
export function recordProbe(model, chatVerdict, respVerdict, detail = null) {
  const cur = normProtocols(getProtocolMap()[model] || null);
  const protocols = new Set(cur.protocols);
  const notSupported = new Set(cur.notSupported);
  const unknown = new Set(cur.unknown);

  for (const [proto, v] of [['chat', chatVerdict], ['responses', respVerdict]]) {
    if (v === 'ok') { protocols.add(proto); notSupported.delete(proto); unknown.delete(proto); }
    else if (v === 'wrong-protocol' || v === 'gate-403' || v === 'region') {
      notSupported.add(proto); protocols.delete(proto); unknown.delete(proto);
    } else {
      // quota / error / other：不确定。只有在原本也没有判定时才记 unknown，
      // 否则保留旧判定不变（这就是「429 不覆盖」的落点）。
      if (!protocols.has(proto) && !notSupported.has(proto)) unknown.add(proto);
    }
  }

  const payload = { protocols: [...protocols], notSupported: [...notSupported], unknown: [...unknown] };
  db.prepare(`INSERT INTO model_protocols(model,protocols,detail,updated_at) VALUES(?,?,?,?)
              ON CONFLICT(model) DO UPDATE SET protocols=excluded.protocols, detail=excluded.detail, updated_at=excluded.updated_at`)
    .run(model, JSON.stringify(payload), detail ? JSON.stringify(detail) : null, Date.now());
  PROBE_CACHE.map = null;
  return payload;
}

/**
 * 某个模型能否用于指定协议。
 *   true  —— 确认支持，或情况不明（放开，别误伤）
 *   false —— 确认不支持
 */
export function modelSupports(model, protocol) {
  const p = protocolMapCached()[model];
  if (!p) return true;                                    // 完全没探测过 → 放开
  if (p.protocols.includes(protocol)) return true;
  if (p.notSupported.includes(protocol)) return false;     // 确认不支持
  return true;                                            // unknown → 放开
}
/** 某个模型是否被**确认**不支持该协议（用于给出明确的协议错误） */
export function modelConfirmedUnsupported(model, protocol) {
  const p = protocolMapCached()[model];
  if (!p) return false;
  return !p.protocols.includes(protocol) && p.notSupported.includes(protocol);
}

/* ══════════════════════════════════════════════════ 渠道 */
const CH_COLS = 'id,name,type,base_url,api_key,models,proxy,priority,status,disabled_until,disabled_reason,extra,created_at';
export const listChannels = () => db.prepare(`SELECT ${CH_COLS} FROM channels ORDER BY priority DESC, id ASC`).all();
export const getChannel = (id) => db.prepare(`SELECT ${CH_COLS} FROM channels WHERE id = ?`).get(id);

export function createChannel(c) {
  const r = db.prepare(
    `INSERT INTO channels(name,type,base_url,api_key,models,proxy,priority,status,extra,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    c.name, c.type || 'opencode', c.base_url || '', c.api_key || '',
    JSON.stringify(c.models || []), c.proxy || '', c.priority ?? 0, c.status ?? 1,
    JSON.stringify(c.extra || {}), Date.now(),
  );
  return getChannel(Number(r.lastInsertRowid));
}
export function updateChannel(id, c) {
  const cur = getChannel(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE channels SET name=?,type=?,base_url=?,api_key=?,models=?,proxy=?,priority=?,status=?,extra=? WHERE id=?`,
  ).run(
    c.name ?? cur.name, c.type ?? cur.type, c.base_url ?? cur.base_url, c.api_key ?? cur.api_key,
    JSON.stringify(c.models ?? JSON.parse(cur.models || '[]')), c.proxy ?? cur.proxy,
    c.priority ?? cur.priority, c.status ?? cur.status,
    JSON.stringify(c.extra ?? JSON.parse(cur.extra || '{}')), id,
  );
  return getChannel(id);
}
export const deleteChannel = (id) => db.prepare('DELETE FROM channels WHERE id = ?').run(id);
export function markChannelDown(id, ms, reason) {
  db.prepare('UPDATE channels SET disabled_until=?, disabled_reason=? WHERE id=?').run(Date.now() + ms, String(reason || '').slice(0, 300), id);
}
export function clearChannelDown(id) {
  db.prepare('UPDATE channels SET disabled_until=0, disabled_reason=NULL WHERE id=?').run(id);
}

/* ══════════════════════════════════════════════════ 令牌 */
const TK_COLS = 'id,name,key,quota,used,unlimited,models,expires_at,status,created_at,last_used';
export const listTokens = () => db.prepare(`SELECT ${TK_COLS} FROM tokens ORDER BY id DESC`).all();
export const getToken = (id) => db.prepare(`SELECT ${TK_COLS} FROM tokens WHERE id = ?`).get(id);
export const getTokenByKey = (k) => db.prepare(`SELECT ${TK_COLS} FROM tokens WHERE key = ?`).get(k);

export function createToken(t) {
  const r = db.prepare(
    `INSERT INTO tokens(name,key,quota,unlimited,models,expires_at,status,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(t.name, t.key, t.quota ?? 0, t.unlimited ? 1 : 0, JSON.stringify(t.models || []), t.expires_at ?? 0, t.status ?? 1, Date.now());
  return getToken(Number(r.lastInsertRowid));
}
export function updateToken(id, t) {
  const cur = getToken(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE tokens SET name=?,quota=?,unlimited=?,models=?,expires_at=?,status=? WHERE id=?`,
  ).run(
    t.name ?? cur.name, t.quota ?? cur.quota, (t.unlimited ?? !!cur.unlimited) ? 1 : 0,
    JSON.stringify(t.models ?? JSON.parse(cur.models || '[]')), t.expires_at ?? cur.expires_at,
    t.status ?? cur.status, id,
  );
  return getToken(id);
}
export const deleteToken = (id) => db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
export function bumpToken(id) {
  db.prepare('UPDATE tokens SET used = used + 1, last_used = ? WHERE id = ?').run(Date.now(), id);
}
export function resetTokenUsage(id) {
  db.prepare('UPDATE tokens SET used = 0 WHERE id = ?').run(id);
}

/* ══════════════════════════════════════════════════ 日志 */
export function addLog(l) {
  db.prepare(
    `INSERT INTO logs(ts,token_id,token_name,channel_id,channel_name,model,upstream_model,proxy,
       prompt_tokens,completion_tokens,total_tokens,latency_ms,ttft_ms,status,ok,stream,error,client_ip)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    l.ts ?? Date.now(), l.token_id ?? null, l.token_name ?? null, l.channel_id ?? null, l.channel_name ?? null,
    l.model ?? null, l.upstream_model ?? null, l.proxy ?? null,
    l.prompt_tokens ?? 0, l.completion_tokens ?? 0, l.total_tokens ?? 0,
    l.latency_ms ?? 0, l.ttft_ms ?? null, l.status ?? 0, l.ok ? 1 : 0, l.stream ? 1 : 0,
    l.error ? String(l.error).slice(0, 1000) : null, l.client_ip ?? null,
  );
}
export function listLogs({ limit = 100, offset = 0, model, token_id, ok } = {}) {
  const w = [], p = [];
  if (model) { w.push('model = ?'); p.push(model); }
  if (token_id) { w.push('token_id = ?'); p.push(token_id); }
  if (ok === 0 || ok === 1) { w.push('ok = ?'); p.push(ok); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM logs ${where}`).get(...p).n;
  const rows = db.prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, limit, offset);
  return { total, rows };
}
export const clearLogs = () => db.prepare('DELETE FROM logs').run();

/* ══════════════════════════════════════════════════ 统计 */
export function stats(sinceMs = 0) {
  const s = db.prepare(
    `SELECT COUNT(*) n, SUM(ok) ok, SUM(total_tokens) tk, SUM(prompt_tokens) pt, SUM(completion_tokens) ct,
            AVG(latency_ms) avg_ms
     FROM logs WHERE ts >= ?`,
  ).get(sinceMs);
  const byModel = db.prepare(
    `SELECT model, COUNT(*) n, SUM(ok) ok, SUM(total_tokens) tk, AVG(latency_ms) avg_ms
     FROM logs WHERE ts >= ? GROUP BY model ORDER BY n DESC LIMIT 30`,
  ).all(sinceMs);
  const byChannel = db.prepare(
    `SELECT channel_name, COUNT(*) n, SUM(ok) ok, AVG(latency_ms) avg_ms
     FROM logs WHERE ts >= ? GROUP BY channel_name ORDER BY n DESC LIMIT 30`,
  ).all(sinceMs);
  const byDay = db.prepare(
    `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') d, COUNT(*) n, SUM(ok) ok, SUM(total_tokens) tk
     FROM logs WHERE ts >= ? GROUP BY d ORDER BY d DESC LIMIT 14`,
  ).all(sinceMs);
  const byToken = db.prepare(
    `SELECT token_name, COUNT(*) n, SUM(ok) ok, SUM(total_tokens) tk
     FROM logs WHERE ts >= ? GROUP BY token_name ORDER BY n DESC LIMIT 30`,
  ).all(sinceMs);
  const errors = db.prepare(
    `SELECT status, error, COUNT(*) n FROM logs WHERE ts >= ? AND ok = 0 GROUP BY status, substr(error,1,60) ORDER BY n DESC LIMIT 20`,
  ).all(sinceMs);
  return {
    total: s.n || 0, ok: s.ok || 0, tokens: s.tk || 0, promptTokens: s.pt || 0,
    completionTokens: s.ct || 0, avgMs: Math.round(s.avg_ms || 0),
    byModel, byChannel, byDay, byToken, errors,
  };
}
