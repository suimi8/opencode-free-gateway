/**
 * pool.mjs —— 代理节点池：每日轮换 / 24h 租约 / 可用性标记 / 请求前连通性验证
 *
 * 规则（按需求实现）：
 *   · 节点被启用后进入**租约期**，默认 24 小时（NODE_LEASE_MS 可改）
 *   · 租约期满 → 该节点**回到可用池**，同时切换到下一个可用节点
 *   · 租约期内的节点不再被选中，保证出口 IP 在 24h 内稳定
 *   · 连通性验证失败的节点标记 dead，冷却（默认 6h）后才重新参与
 *   · **每次模型请求前**都会验证当前节点；结果缓存（默认 120s）以免每次重测
 *   · 订阅里的广告/占位节点（server 为 0.0.0.0、名字像官网/续费/客服）**不入池**
 *
 * 状态存储：runtime/pool.db（独立于面板库）
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as M from './mihomo.mjs';

const DB_PATH = process.env.POOL_DB || path.join(M.RUNTIME, 'pool.db');

export const LEASE_MS = Number(process.env.NODE_LEASE_MS || 24 * 3600e3);      // 24h 租约
const DEAD_COOLDOWN_MS = Number(process.env.NODE_DEAD_MS || 6 * 3600e3);       // 失效冷却
const VERIFY_TTL_MS = Number(process.env.NODE_VERIFY_TTL_MS || 120e3);         // 验证结果缓存
const VERIFY_URL = process.env.NODE_VERIFY_URL || 'http://www.gstatic.com/generate_204';
const VERIFY_TIMEOUT = Number(process.env.NODE_VERIFY_TIMEOUT || 9000);
const TRY_LIMIT = Number(process.env.NODE_TRY_LIMIT || 8);
/**
 * 额度记忆窗口：某个节点在这个窗口内撞过上游 429，就把它排到候选末尾。
 * 窗口内的节点**不是被禁用**，只是不再优先 —— 池子有限，全禁掉就没得选了。
 */
const QUOTA_COOLDOWN_MS = Number(process.env.NODE_QUOTA_COOLDOWN_MS || 30 * 60e3);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`CREATE TABLE IF NOT EXISTS proxy_nodes (
  name          TEXT PRIMARY KEY,
  provider      TEXT,
  type          TEXT,
  server        TEXT,
  port          INTEGER,
  valid         INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'available',   -- available | in_use | dead
  leased_at     INTEGER NOT NULL DEFAULT 0,
  lease_until   INTEGER NOT NULL DEFAULT 0,
  last_ok_at    INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER NOT NULL DEFAULT 0,
  delay_ms      INTEGER,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  use_count     INTEGER NOT NULL DEFAULT 0,
  dead_until    INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  exit_ip       TEXT
)`);
// 兼容早先建的表
for (const [col, def] of [['server', 'TEXT'], ['port', 'INTEGER'], ['valid', 'INTEGER NOT NULL DEFAULT 1'], ['quota_fail_at', 'INTEGER NOT NULL DEFAULT 0']]) {
  try { db.exec(`ALTER TABLE proxy_nodes ADD COLUMN ${col} ${def}`); } catch { /* 已存在 */ }
}
db.exec(`CREATE TABLE IF NOT EXISTS pool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, node TEXT, detail TEXT
)`);
const ev = (kind, node, detail) => db.prepare('INSERT INTO pool_events(ts,kind,node,detail) VALUES(?,?,?,?)')
  .run(Date.now(), kind, node || null, detail ? String(detail).slice(0, 500) : null);

const all = () => db.prepare('SELECT * FROM proxy_nodes').all();
export const getNode = (name) => db.prepare('SELECT * FROM proxy_nodes WHERE name = ?').get(name);

/* ── 从 provider 文件同步节点清单（权威来源，含真实性判定）── */
export async function syncNodes() {
  const nodes = M.providerNodes();
  const upsert = db.prepare(`INSERT INTO proxy_nodes(name, provider, type, server, port, valid, status)
                             VALUES(?,?,?,?,?,?, 'available')
                             ON CONFLICT(name) DO UPDATE SET provider=excluded.provider, type=excluded.type,
                               server=excluded.server, port=excluded.port, valid=excluded.valid`);
  for (const n of nodes) upsert.run(n.name, n.provider, n.type, n.server, n.port, n.valid ? 1 : 0);
  const live = new Set(nodes.map((n) => n.name));
  for (const r of all()) if (!live.has(r.name)) db.prepare('DELETE FROM proxy_nodes WHERE name = ?').run(r.name);
  let now = null;
  try { now = (await M.groupNodes()).now; } catch { /* mihomo 没起也没关系 */ }
  return { total: nodes.length, valid: nodes.filter((n) => n.valid).length, now };
}

/* ── 延迟分档 ──
 * 优先用 300ms 以内的节点；如果这类节点不够用（都死了/都在租约里），
 * 才放宽到 400ms，再不够到 500ms，最后才用更慢的。
 * 档位可配：NODE_DELAY_TIERS=300,400,500
 */
const TIERS = String(process.env.NODE_DELAY_TIERS || '300,400,500')
  .split(',').map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0)
  .sort((a, b) => a - b);
export const delayTiers = TIERS;

/**
 * 延迟落在第几档（0 = 最快那一档）。
 * 未知延迟（没测过 / null）排到最后一档 —— 不能因为没数据就优先用。
 */
export function tierOf(delay) {
  const v = Number(delay);
  if (!Number.isFinite(v) || v <= 0) return TIERS.length;
  for (let i = 0; i < TIERS.length; i++) if (v <= TIERS[i]) return i;
  return TIERS.length;
}

/* 当前出口比最慢一档还慢、而池子里有更快档位时，主动升级（默认开） */
const SLOW_UPGRADE = String(process.env.NODE_SLOW_UPGRADE ?? '1') !== '0';
const SLOW_UPGRADE_COOLDOWN_MS = Number(process.env.NODE_SLOW_UPGRADE_COOLDOWN_MS || 10 * 60e3);
let LAST_UPGRADE_AT = 0;

/* ── 可用池 ── */
export function availableNodes(now = Date.now()) {
  return all().filter((r) => {
    if (!r.valid) return false;                                     // 广告/占位节点永不入池
    if (r.status === 'in_use') return r.lease_until <= now;          // 租约到期才回池
    if (r.status === 'dead') return r.dead_until <= now;            // 冷却结束才复活
    return true;
  }).sort((a, b) => {
    // ① 撞过额度 429 的排最后（换了出口也可能没用）
    const qa = (now - (a.quota_fail_at || 0)) < QUOTA_COOLDOWN_MS ? 1 : 0;
    const qb = (now - (b.quota_fail_at || 0)) < QUOTA_COOLDOWN_MS ? 1 : 0;
    if (qa !== qb) return qa - qb;
    // ② 延迟档位：<=300 的整批排在 <=400 前面，依此类推
    const ta = tierOf(a.delay_ms), tb = tierOf(b.delay_ms);
    if (ta !== tb) return ta - tb;
    // ③ 同档内：延迟低的优先，其次用得少的
    return ((a.delay_ms ?? 99999) + a.use_count * 50) - ((b.delay_ms ?? 99999) + b.use_count * 50);
  });
}

/** 额度（上游 429）记忆 ────────────────────────────────── */
/** 标记某个出口刚撞了上游额度限制 */
export function markQuotaFail(name) {
  if (!name) return;
  db.prepare('UPDATE proxy_nodes SET quota_fail_at=? WHERE name=?').run(Date.now(), name);
  ev('quota', name, '上游返回 429（额度耗尽），已记入额度记忆');
}
/** 清掉某个节点的额度记忆（重新可用） */
export function clearQuotaFail(name) {
  if (name) db.prepare('UPDATE proxy_nodes SET quota_fail_at=0 WHERE name=?').run(name);
}
/** 额度窗口内**没撞过** 429 的节点数 —— 为 0 就说明所有出口都被额度挡了 */
export function quotaFreshCount(now = Date.now()) {
  return all().filter((r) => r.valid && (now - (r.quota_fail_at || 0)) >= QUOTA_COOLDOWN_MS).length;
}
export const quotaCooldownMs = QUOTA_COOLDOWN_MS;

export function activeNode() {
  return db.prepare("SELECT * FROM proxy_nodes WHERE status='in_use' AND lease_until > ? ORDER BY leased_at DESC LIMIT 1").get(Date.now()) || null;
}

/** 租约到期的 in_use 节点回池 */
function releaseExpired(now = Date.now()) {
  const expired = db.prepare("SELECT * FROM proxy_nodes WHERE status='in_use' AND lease_until <= ?").all(now);
  for (const r of expired) {
    db.prepare("UPDATE proxy_nodes SET status='available' WHERE name=?").run(r.name);
    ev('release', r.name, `租约满 ${Math.round((now - r.leased_at) / 3600e3)}h，已回到可用池`);
  }
  return expired;
}

/**
 * 同一时刻只能有一个出口节点。
 * 轮换（强制轮换 / 故障转移）时，把**除新节点外**的 in_use 节点立刻放回可用池 ——
 * 否则停用的旧节点会一直挂着租约，池子里的可用数越来越少。
 */
function releaseOthers(keepName) {
  const others = db.prepare("SELECT * FROM proxy_nodes WHERE status='in_use' AND name <> ?").all(keepName);
  for (const r of others) {
    db.prepare("UPDATE proxy_nodes SET status='available' WHERE name=?").run(r.name);
    ev('release', r.name, '轮换后释放（同一时刻只保留一个出口节点）');
  }
  return others.map((r) => r.name);
}

function markDead(name, err) {
  db.prepare(`UPDATE proxy_nodes SET status='dead', fail_count=fail_count+1, dead_until=?,
              last_error=?, last_check_at=? WHERE name=?`)
    .run(Date.now() + DEAD_COOLDOWN_MS, String(err || '').slice(0, 300), Date.now(), name);
  ev('dead', name, err);
}
function recordOk(name, delay, checkOnly = false, exitIp = null) {
  const now = Date.now();
  if (checkOnly) {
    db.prepare('UPDATE proxy_nodes SET last_ok_at=?, last_check_at=?, delay_ms=?, fail_count=0, last_error=NULL WHERE name=?')
      .run(now, now, delay ?? null, name);
  } else {
    db.prepare(`UPDATE proxy_nodes SET status='in_use', leased_at=?, lease_until=?, last_ok_at=?, last_check_at=?,
                delay_ms=?, fail_count=0, use_count=use_count+1, last_error=NULL, exit_ip=? WHERE name=?`)
      .run(now, now + LEASE_MS, now, now, delay ?? null, exitIp, name);
  }
}

/* ── 切换 + 验证（真实隧道探测）── */
export async function switchAndVerify(name, { asLease = true } = {}) {
  await M.switchNode(name);
  const p = await M.probeTunnel({ url: VERIFY_URL, timeout: VERIFY_TIMEOUT });
  if (p.ok) {
    recordOk(name, p.ms, !asLease);
    if (asLease) releaseOthers(name);              // 手动切换也让旧节点立刻回池
    ev(asLease ? 'activate' : 'verify', name, `连通 HTTP ${p.status} ${p.ms}ms`);
    return { ok: true, node: name, delay: p.ms, status: p.status, tried: [{ name, ok: true, delay: p.ms }] };
  }
  markDead(name, p.error || `HTTP ${p.status}`);
  return { ok: false, node: name, error: p.error || `HTTP ${p.status}`, tried: [{ name, ok: false, error: p.error }] };
}

/**
 * 主入口：保证「现在有一个已验证可用的出口」，必要时轮换。
 *   force 强制轮换（忽略租约与缓存）
 * 返回 { ok, node, delay, rotated, reason, verified, tried }
 */
export async function ensureActive({ force = false, avoid = [] } = {}) {
  await M.ensureRunning();
  await syncNodes();
  const now = Date.now();
  // 记下轮换前的节点：轮换时**要排除它**，否则刚回池的快节点会被立刻重选，
  // 出口 IP 没变 —— 那就不是「每天切换代理节点」了。
  const before = activeNode();
  releaseExpired(now);

  let cur = activeNode();

  /* ⓪ 当前出口比最慢一档（默认 500ms）还慢，而池子里有更快档位的节点
   *    → 主动升级，别一直挂在 1300ms 的节点上。
   *    有冷却时间，避免在两档之间反复横跳。 */
  if (cur && !force && SLOW_UPGRADE && now - LAST_UPGRADE_AT > SLOW_UPGRADE_COOLDOWN_MS) {
    const curTier = tierOf(cur.delay_ms);
    if (curTier >= TIERS.length) {
      const better = availableNodes(now)
        .filter((n) => n.name !== cur.name && !avoid.includes(n.name) && tierOf(n.delay_ms) < curTier);
      if (better.length) {
        LAST_UPGRADE_AT = now;
        ev('upgrade', cur.name,
          `当前出口 ${cur.delay_ms ?? '?'}ms 超出最慢档 ${TIERS[TIERS.length - 1] ?? '?'}ms，升级到 ${better[0].name}（${better[0].delay_ms}ms）`);
        force = true;                       // 走下面的「挑新节点」流程
      }
    }
  }

  // ① 节点还在租约内：验证（带缓存）后直接用
  if (cur && !force) {
    if (now - cur.last_check_at < VERIFY_TTL_MS) {
      const g = await M.groupNodes().catch(() => ({ now: null }));
      if (g.now !== cur.name) await M.switchNode(cur.name).catch(() => {});
      return { ok: true, node: cur.name, delay: cur.delay_ms, rotated: false, reason: 'cached', verified: false };
    }
    const p = await M.probeTunnel({ url: VERIFY_URL, timeout: VERIFY_TIMEOUT });
    if (p.ok) {
      recordOk(cur.name, p.ms, true);
      const g = await M.groupNodes().catch(() => ({ now: null }));
      if (g.now !== cur.name) await M.switchNode(cur.name).catch(() => {});
      return { ok: true, node: cur.name, delay: p.ms, rotated: false, reason: 'verified', verified: true };
    }
    markDead(cur.name, p.error || `HTTP ${p.status}`);
    ev('rotate', cur.name, `验证失败轮换：${p.error || p.status}`);
    cur = null;
  }

  // ② 从可用池挑新节点，逐个验证（跳过真死节点、排除上一个与调用方指定要避开的）
  const skip = new Set([...(before && before.name ? [before.name] : []), ...avoid.filter(Boolean)]);
  let cands = availableNodes(now).filter((r) => !skip.has(r.name));
  if (!cands.length) cands = availableNodes(now);          // 池子被排空时不再排除
  const tried = [];
  for (let i = 0; i < Math.min(cands.length, TRY_LIMIT); i++) {
    const r = await switchAndVerify(cands[i].name, { asLease: true });
    tried.push(...r.tried);
    if (r.ok) {
      const released = releaseOthers(r.node);          // 同一时刻只留一个出口节点
      const ip = await fetchExitIp().catch(() => null);
      if (ip) db.prepare('UPDATE proxy_nodes SET exit_ip=? WHERE name=?').run(ip, r.node);
      return { ok: true, node: r.node, delay: r.delay, exitIp: ip, rotated: true, replaced: before ? before.name : null, released, reason: force ? 'forced' : 'lease-expired-or-failover', verified: true, tried };
    }
    if (Date.now() - now > 90e3) break;      // 总预算
  }
  return { ok: false, node: cur ? cur.name : null, reason: 'no-usable-node', tried };
}

/**
 * 上游额度耗尽（429）时切换出口节点。
 *
 * 逻辑：
 *   1. 把当前节点记入「额度记忆」，本次轮换避开它
 *   2. 若额度窗口内**已经没有没撞过 429 的节点**了 → 直接返回 ok:false，
 *      说明额度确实是所有出口共享的（实测结论），继续换只是白烧池子
 *   3. 否则强制轮换到一个新节点并验证连通
 *
 * 返回 { ok, node, exitIp, reason, freshLeft }
 */
export async function rotateForQuota({ avoid = [] } = {}) {
  const cur = activeNode();
  if (cur) markQuotaFail(cur.name);
  const freshLeft = quotaFreshCount() - (cur ? 1 : 0);
  if (freshLeft <= 0) {
    ev('quota-stop', cur ? cur.name : null, '所有出口都撞过 429 —— 额度是共享的，停止轮换（不再白烧节点池）');
    return { ok: false, reason: 'all-nodes-quota-hit', node: cur ? cur.name : null, freshLeft: 0 };
  }
  const r = await ensureActive({ force: true, avoid: [cur ? cur.name : null, ...avoid] });
  return { ...r, freshLeft: Math.max(0, freshLeft - 1) };
}

/** 当前状态（含剩余租约） */
export async function state() {
  await M.ensureRunning().catch(() => {});
  await syncNodes().catch(() => {});
  releaseExpired();
  const cur = activeNode();
  let live = null;
  try { live = (await M.groupNodes()).now; } catch { /* 忽略 */ }
  const rows = all();
  return {
    active: cur ? {
      name: cur.name, provider: cur.provider, type: cur.type, server: cur.server, port: cur.port,
      delay: cur.delay_ms, exitIp: cur.exit_ip,
      leasedAt: cur.leased_at, leaseUntil: cur.lease_until,
      ageH: cur.leased_at ? +((Date.now() - cur.leased_at) / 3600e3).toFixed(2) : null,
      remainH: cur.lease_until ? +((cur.lease_until - Date.now()) / 3600e3).toFixed(2) : null,
    } : null,
    mihomoSelected: live,
    inSync: !!(cur && live === cur.name),
    counts: {
      total: rows.length,
      valid: rows.filter((r) => r.valid).length,
      rejected: rows.filter((r) => !r.valid).length,
      available: availableNodes().length,
      inUse: rows.filter((r) => r.status === 'in_use').length,
      dead: rows.filter((r) => r.status === 'dead').length,
      // 额度窗口内撞过 429 的出口数 / 还没撞过的出口数
      quotaHit: rows.filter((r) => r.valid && (Date.now() - (r.quota_fail_at || 0)) < QUOTA_COOLDOWN_MS).length,
      quotaFresh: rows.filter((r) => r.valid && (Date.now() - (r.quota_fail_at || 0)) >= QUOTA_COOLDOWN_MS).length,
    },
    quotaCooldownMin: Math.round(QUOTA_COOLDOWN_MS / 60000),
    leaseHours: LEASE_MS / 3600e3,
  };
}

export function listNodes({ includeInvalid = true } = {}) {
  return all()
    .filter((r) => includeInvalid || r.valid)
    .sort((a, b) => {
      const rank = (x) => (x.status === 'in_use' ? 0 : x.status === 'available' ? 1 : 2);
      return rank(a) - rank(b) || (a.delay_ms ?? 99999) - (b.delay_ms ?? 99999);
    });
}
export const events = (limit = 50) => db.prepare('SELECT * FROM pool_events ORDER BY id DESC LIMIT ?').all(limit);

/**
 * 全池测速：先用 /group/{组}/delay 批量拿延迟（mihomo 内部并发，很快），
 * 再把结果写回库。这只影响排序，不改选中项。
 */
export async function testAll({ timeout = 5000 } = {}) {
  const g = await M.testGroupDelays({ timeout, url: VERIFY_URL });
  const valid = new Set(all().filter((r) => r.valid).map((r) => r.name));
  const out = [];
  for (const [name, delay] of Object.entries(g.delays || {})) {
    if (!valid.has(name)) continue;
    db.prepare('UPDATE proxy_nodes SET delay_ms=?, last_ok_at=?, last_check_at=?, fail_count=0, last_error=NULL WHERE name=?')
      .run(delay, Date.now(), Date.now(), name);
    out.push({ name, ok: true, delay });
  }
  const seen = new Set(out.map((x) => x.name));
  for (const r of all()) {
    if (!r.valid || seen.has(r.name)) continue;
    db.prepare('UPDATE proxy_nodes SET last_check_at=?, fail_count=fail_count+1, last_error=? WHERE name=?')
      .run(Date.now(), '批量测速未返回（超时或不可达）', r.name);
    out.push({ name: r.name, ok: false });
  }
  out.sort((a, b) => (a.ok === b.ok ? (a.delay ?? 1e9) - (b.delay ?? 1e9) : a.ok ? -1 : 1));
  return { batchOk: g.ok, error: g.error, results: out, reachable: out.filter((x) => x.ok).length };
}

/* ══════════════════════════════════════════════════ 经代理取出口 IP */
function httpGetViaProxy(url, proxyPort, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = M.proxyHost();        // Docker / compose 里是 sidecar 服务名
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    const done = (fn, v) => { clearTimeout(timer); fn(v); };
    if (u.protocol !== 'https:') {
      const req = http.request({ host, port: proxyPort, method: 'GET', path: url, headers: { host: u.host, 'user-agent': 'ocgw' } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => done(resolve, b));
      });
      req.on('error', (e) => done(reject, e));
      req.end();
      return;
    }
    const c = http.request({ host, port: proxyPort, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}` });
    c.on('connect', (_res, socket) => {
      const s = tls.connect({ socket, servername: u.hostname }, () => {
        s.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: ocgw\r\nConnection: close\r\n\r\n`);
      });
      let b = '';
      s.on('data', (d) => (b += d));
      s.on('end', () => done(resolve, b.split('\r\n\r\n').slice(1).join('\r\n\r\n')));
      s.on('error', (e) => done(reject, e));
    });
    c.on('error', (e) => done(reject, e));
    c.end();
  });
}

export async function fetchExitIp(url = 'https://api.ipify.org?format=json') {
  const { mixedPort } = M.params();
  const b = await httpGetViaProxy(url, mixedPort, 20000);
  const m = String(b).match(/"ip"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export { db, DB_PATH };
