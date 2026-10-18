/**
 * sessions.mjs —— OpenCode 会话池（免费层门禁用）
 *
 * 背景（2026-10 实测）：
 *   上游要求 `x-opencode-session` 是**真实存在过的会话**。格式正确但从未
 *   出现过的 id 一律 403 FreeTierError；而历史上任何一个真实会话都能用，
 *   不分新旧、不限次数（实测 9 月的会话照样 200）。
 *
 * 所以这里维护一个会话池：
 *   · 首次运行自动从本机 OpenCode 存储里**导入**现有会话（开箱即用）
 *   · 也可以手动添加 / 删除 / 指定当前使用哪个
 *   · 全部存进配置文件，重启不丢
 *
 * 配置文件位置：与 panel.db 同目录（桌面版/Docker 里都是可写的数据目录）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PANEL_DIR = import.meta.dirname;

/**
 * 配置文件路径：跟着 panel.db 走，保证在可写的数据目录里。
 *
 * 注意是**函数**不是常量 —— 常量会在 import 时固化，
 * 而调用方（server.mjs / 测试）可能在那之后才设置 PANEL_DB。
 */
export function configPath() {
  return path.join(
    path.dirname(process.env.PANEL_DB || path.join(PANEL_DIR, 'panel.db')),
    'opencode-sessions.json',
  );
}

/** session id 格式：ses_ + 12 hex（低 12 位 ∈ [0xfc0,0xfff]）+ 14 base62 */
const ID_RE = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

export function isValidSession(id) {
  const s = String(id || '').trim();
  if (!ID_RE.test(s)) return false;
  const lo = parseInt(s.slice(10, 16), 16) & 0xfff;
  return lo >= 0xfc0 && lo <= 0xfff;
}

/** 会话 id 里能读出的信息（低 12 位等），用于排错 */
export function describe(id) {
  const s = String(id || '').trim();
  if (!ID_RE.test(s)) return { valid: false, reason: '格式不对（应为 ses_ + 12hex + 14base62）' };
  const lo = parseInt(s.slice(10, 16), 16) & 0xfff;
  if (lo < 0xfc0) return { valid: false, reason: `低 12 位 0x${lo.toString(16)} 不在 [0xfc0,0xfff]` };
  return { valid: true, low12: lo };
}

/* ══════════════════════════════════════════════════ 存取 */
const EMPTY = { version: 1, active: '', sessions: [], _说明: '' };

let CACHE = null;

export function load() {
  if (CACHE) return CACHE;
  try {
    if (fs.existsSync(configPath())) {
      const j = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
      CACHE = normalize(j);
      return CACHE;
    }
  } catch { /* 坏文件按空处理，下面会重建 */ }
  CACHE = normalize(EMPTY);
  return CACHE;
}

function normalize(j) {
  const o = (j && typeof j === 'object') ? j : {};
  const rows = Array.isArray(o.sessions) ? o.sessions : [];
  const seen = new Set();
  const sessions = [];
  for (const r of rows) {
    const id = String((r && r.id) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sessions.push({
      id,
      note: String((r && r.note) || ''),
      source: String((r && r.source) || 'manual'),
      addedAt: Number((r && r.addedAt) || Date.now()),
      lastOkAt: Number((r && r.lastOkAt) || 0),
      lastFailAt: Number((r && r.lastFailAt) || 0),
      failCount: Number((r && r.failCount) || 0),
    });
  }
  let active = String(o.active || '').trim();
  if (!active || !seen.has(active)) active = sessions.length ? sessions[0].id : '';
  return {
    version: 1,
    active,
    sessions,
    _说明: 'OpenCode 会话池。上游要求 x-opencode-session 是真实存在过的会话。可以在面板里增删，或直接改这个文件。',
  };
}

export function save() {
  const data = load();
  try {
    const cp = configPath();
    fs.mkdirSync(path.dirname(cp), { recursive: true });
    const tmp = `${cp}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, cp);
  } catch { /* 写失败不影响内存里的用法 */ }
  return data;
}

/* ══════════════════════════════════════════════════ 增删改查 */
export function list() {
  const d = load();
  return d.sessions.map((s) => ({ ...s, active: s.id === d.active, ...describe(s.id) }));
}

export function current() {
  const d = load();
  if (!d.active) return '';
  return d.sessions.some((s) => s.id === d.active) ? d.active : (d.sessions[0]?.id || '');
}

export function add(id, { note = '', source = 'manual' } = {}) {
  const sid = String(id || '').trim();
  const chk = describe(sid);
  if (!chk.valid) throw new Error(`无效的 session：${chk.reason}`);
  const d = load();
  if (d.sessions.some((s) => s.id === sid)) return { added: false, duplicate: true, id: sid };
  d.sessions.push({ id: sid, note: String(note || ''), source, addedAt: Date.now(), lastOkAt: 0, lastFailAt: 0, failCount: 0 });
  if (!d.active) d.active = sid;
  save();
  return { added: true, id: sid };
}

export function remove(id) {
  const d = load();
  const before = d.sessions.length;
  d.sessions = d.sessions.filter((s) => s.id !== id);
  if (d.active === id) d.active = d.sessions[0]?.id || '';
  save();
  return { removed: before - d.sessions.length };
}

export function setActive(id) {
  const d = load();
  if (!d.sessions.some((s) => s.id === id)) throw new Error('这个 session 不在池子里');
  d.active = id;
  save();
  return { active: id };
}

/** 标记一次请求结果，供轮换时优先挑健康的 */
export function markOk(id) {
  const d = load();
  const s = d.sessions.find((x) => x.id === id);
  if (!s) return;
  s.lastOkAt = Date.now();
  s.failCount = 0;
  save();
}
export function markFail(id) {
  const d = load();
  const s = d.sessions.find((x) => x.id === id);
  if (!s) return;
  s.lastFailAt = Date.now();
  s.failCount = (s.failCount || 0) + 1;
  save();
}

/**
 * 换一个：优先挑「从没失败过 / 失败次数少 / 最近成功过」的，避开 justFailed。
 * 返回新的 active id；池子空了返回 ''。
 */
export function rotate(justFailed = '') {
  const d = load();
  if (d.sessions.length <= 1) return current();
  const ranked = [...d.sessions]
    .filter((s) => s.id !== justFailed)
    .sort((a, b) => (a.failCount - b.failCount) || (b.lastOkAt - a.lastOkAt));
  if (!ranked.length) return current();
  d.active = ranked[0].id;
  save();
  return d.active;
}

/* ══════════════════════════════════════════════════ 从本机 OpenCode 导入 */
/** OpenCode 可能的存储位置（按平台） */
function openCodeDirs() {
  const home = os.homedir();
  return [
    process.env.OPENCODE_STORAGE,
    path.join(home, '.local', 'share', 'opencode', 'storage'),
    path.join(home, '.local', 'share', 'opencode'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'ai.opencode.desktop'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'opencode'),
    path.join(home, '.config', 'opencode'),
  ].filter(Boolean);
}

/**
 * 扫本机 OpenCode 存储，找出所有出现过的 session id。
 * 只读文件名与文本里的 ses_ 模式，不碰会话内容。
 * @returns {{ found: string[], scanned: string[] }}
 */
export function scanLocalSessions({ max = 200 } = {}) {
  const found = new Map();          // id -> 最近修改时间
  const scanned = [];
  const ID_IN_TEXT = /ses_[0-9a-f]{12}[A-Za-z0-9]{14}/g;

  for (const dir of openCodeDirs()) {
    if (!fs.existsSync(dir)) continue;
    scanned.push(dir);
    let files = [];
    try {
      files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath || e.path || dir, e.name));
    } catch { continue; }

    for (const f of files) {
      // 1) 文件名本身就是 session id（session_diff / plugin 之类）
      const m = path.basename(f).match(ID_IN_TEXT);
      if (m) {
        for (const id of m) {
          if (!isValidSession(id)) continue;
          let t = 0;
          try { t = fs.statSync(f).mtimeMs; } catch { /* 忽略 */ }
          if (!found.has(id) || t > found.get(id)) found.set(id, t);
        }
        continue;
      }
      // 2) 文件内容里出现的（只扫小文件，避免读几 MB）
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.size > 2_000_000) continue;
      if (!/\.(json|dat|log|jsonl|txt)$/i.test(f)) continue;
      let txt = '';
      try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const id of (txt.match(ID_IN_TEXT) || [])) {
        if (!isValidSession(id)) continue;
        if (!found.has(id) || st.mtimeMs > found.get(id)) found.set(id, st.mtimeMs);
      }
    }
    if (found.size >= max) break;
  }

  const sorted = [...found.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return { found: sorted.slice(0, max), scanned };
}

/**
 * 首次运行（池子为空）时自动导入本机会话。
 * 已导入过就不动，避免每次启动都重复扫盘。
 */
export function autoImportIfEmpty({ max = 40 } = {}) {
  const d = load();
  if (d.sessions.length > 0) return { imported: 0, reason: '池子已有会话，跳过' };
  const { found, scanned } = scanLocalSessions({ max });
  if (!found.length) return { imported: 0, reason: '本机没找到 OpenCode 会话', scanned };
  for (const id of found) {
    d.sessions.push({ id, note: '自动导入', source: 'auto', addedAt: Date.now(), lastOkAt: 0, lastFailAt: 0, failCount: 0 });
  }
  d.active = found[0];
  save();
  return { imported: found.length, active: d.active, scanned };
}

/** 手动触发导入（面板上的「扫描本机」按钮） */
export function importFromLocal({ max = 40 } = {}) {
  const d = load();
  const { found, scanned } = scanLocalSessions({ max });
  const have = new Set(d.sessions.map((s) => s.id));
  let added = 0;
  for (const id of found) {
    if (have.has(id)) continue;
    d.sessions.push({ id, note: '扫描导入', source: 'scan', addedAt: Date.now(), lastOkAt: 0, lastFailAt: 0, failCount: 0 });
    have.add(id);
    added++;
  }
  if (!d.active && d.sessions.length) d.active = d.sessions[0].id;
  save();
  return { added, total: d.sessions.length, found: found.length, scanned };
}
