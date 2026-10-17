/**
 * config-io.mjs —— 配置的导出 / 导入 / Clash 配置迁移
 *
 * 三个用途：
 *   1. 导出整个面板配置成一份 JSON（换机器、备份、版本管理）
 *   2. 导入这份 JSON（合并或整份替换）
 *   3. 直接导入一个 **Clash / Clash Meta 的 config.yaml**：
 *      把 proxy-providers 变成订阅、proxies 变成手动节点
 *
 * ⚠️ 导出的内容包含**凭据**（渠道 API Key、订阅链接里的 token、可选令牌），
 *    所以接口默认不导出令牌与密码哈希，且界面会明确警告。
 */
import path from 'node:path';
import * as DB from './db.mjs';

export const BUNDLE_KIND = 'opencode-free-gateway/config';
export const BUNDLE_VERSION = 1;

/* ══════════════════════════════════════════════════ 导出 */
/**
 * @param {object} opts
 * @param {boolean} opts.includeTokens 是否带上令牌明文（默认不带）
 * @param {object}  opts.subs          loadSubs() 的结果（订阅 + 手加节点 + 剔除）
 */
export function buildBundle({ subs = null, includeTokens = false } = {}) {
  const channels = DB.listChannels().map((c) => ({
    name: c.name,
    type: c.type,
    base_url: c.base_url,
    api_key: c.api_key,
    models: c.models,
    proxy: c.proxy,
    priority: c.priority,
    status: c.status,
    extra: c.extra || {},
  }));

  const bundle = {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    site: {
      site_name: DB.getSetting('site_name', '') || '',
      default_proxy: DB.getSetting('default_proxy', '') || '',
      mihomo_mirrors: DB.getSetting('mihomo_mirrors', '') || '',
    },
    channels,
    // 注意：不含 admin_password（那是哈希）、不含 session_secret、不含日志
  };

  if (includeTokens) {
    bundle.tokens = DB.listTokens().map((t) => ({
      name: t.name, key: t.key, quota: t.quota, used: t.used,
      unlimited: t.unlimited, models: t.models, expires_at: t.expires_at, status: t.status,
    }));
  }

  if (subs) {
    bundle.pool = {
      providers: (subs.providers || []).map((p) => ({ name: p.name, url: p.url, enabled: p.enabled !== false })),
      manualProxies: subs.manualProxies || [],
      excludedNodes: subs.excludedNodes || [],
    };
  }

  bundle._warning = '这份文件包含渠道 API Key 与订阅链接（可能含 token），请勿公开分享。';
  return bundle;
}

/* ══════════════════════════════════════════════════ 导入（JSON） */
/**
 * @param {object} bundle  导出的 bundle
 * @param {'merge'|'replace'} mode
 * @param {(s:object)=>void} saveSubs  写订阅的钩子（由调用方注入，避免循环依赖）
 */
export function applyBundle(bundle, { mode = 'merge', saveSubs = null, currentSubs = null } = {}) {
  if (!bundle || bundle.kind !== BUNDLE_KIND) {
    throw new Error('这不是本项目的配置文件（kind 不匹配）');
  }
  if (Number(bundle.version) > BUNDLE_VERSION) {
    throw new Error(`配置版本 ${bundle.version} 比当前程序支持的 ${BUNDLE_VERSION} 更新，请升级后再导入`);
  }
  const result = { mode, channels: 0, channelsSkipped: 0, tokens: 0, tokensSkipped: 0, providers: 0, manualProxies: 0, excluded: 0, site: 0 };

  /* ── 站点设置 ── */
  if (bundle.site && typeof bundle.site === 'object') {
    for (const k of ['site_name', 'default_proxy', 'mihomo_mirrors']) {
      if (typeof bundle.site[k] === 'string' && bundle.site[k] !== '') { DB.setSetting(k, bundle.site[k]); result.site++; }
    }
  }

  /* ── 渠道 ── */
  if (Array.isArray(bundle.channels)) {
    const existing = DB.listChannels();
    if (mode === 'replace') {
      for (const c of existing) DB.deleteChannel(c.id);
    }
    const byName = new Map(DB.listChannels().map((c) => [c.name, c]));
    for (const c of bundle.channels) {
      if (!c || !c.name) continue;
      const rec = {
        name: String(c.name).slice(0, 100),
        type: c.type === 'openai' ? 'openai' : 'opencode',
        base_url: c.base_url || '',
        api_key: c.api_key || '',
        models: Array.isArray(c.models) ? c.models : [],
        proxy: c.proxy || '',
        priority: Number(c.priority) || 0,
        status: c.status === 0 ? 0 : 1,
        extra: c.extra && typeof c.extra === 'object' ? c.extra : {},
      };
      const hit = byName.get(rec.name);
      if (hit) { DB.updateChannel(hit.id, rec); result.channels++; }
      else { DB.createChannel(rec); result.channels++; }
    }
  }

  /* ── 令牌（可选） ── */
  if (Array.isArray(bundle.tokens)) {
    const existingKeys = new Set(DB.listTokens().map((t) => t.key));
    for (const t of bundle.tokens) {
      if (!t || !t.key) continue;
      if (existingKeys.has(t.key)) { result.tokensSkipped++; continue; }
      DB.createToken({
        name: String(t.name || 'imported').slice(0, 60),
        key: t.key,
        quota: Number(t.quota) || 0,
        unlimited: t.unlimited ? 1 : 0,
        models: Array.isArray(t.models) ? t.models : [],
        expires_at: Number(t.expires_at) || 0,
        status: t.status === 0 ? 0 : 1,
      });
      // createToken 不写 used（正常新建时就是 0），导入要保留原用量
      if (Number(t.used) > 0) {
        try { DB.db.prepare('UPDATE tokens SET used=? WHERE key=?').run(Number(t.used), t.key); } catch { /* 忽略 */ }
      }
      result.tokens++;
    }
  }

  /* ── 代理池（订阅 / 手加节点 / 剔除） ── */
  if (bundle.pool && saveSubs) {
    const cur = currentSubs || { providers: [], manualProxies: [], excludedNodes: [], _参数: {} };
    const base = mode === 'replace'
      ? { ...cur, providers: [], manualProxies: [], excludedNodes: [] }
      : { ...cur, providers: [...(cur.providers || [])], manualProxies: [...(cur.manualProxies || [])], excludedNodes: [...(cur.excludedNodes || [])] };
    const pNames = new Set(base.providers.map((p) => p.name));
    for (const p of (bundle.pool.providers || [])) {
      if (!p || !p.name || !p.url) continue;
      const rec = { name: p.name, url: p.url, enabled: p.enabled !== false };
      if (pNames.has(p.name)) base.providers = base.providers.map((x) => (x.name === p.name ? rec : x));
      else base.providers.push(rec);
      pNames.add(p.name);
      result.providers++;
    }
    const mNames = new Set(base.manualProxies.map((m) => m.name));
    for (const m of (bundle.pool.manualProxies || [])) {
      if (!m || !m.name) continue;
      if (mNames.has(m.name)) base.manualProxies = base.manualProxies.map((x) => (x.name === m.name ? m : x));
      else base.manualProxies.push(m);
      mNames.add(m.name);
      result.manualProxies++;
    }
    if (Array.isArray(bundle.pool.excludedNodes)) {
      base.excludedNodes = [...new Set([...base.excludedNodes, ...bundle.pool.excludedNodes.filter((x) => typeof x === 'string')])];
      result.excluded = base.excludedNodes.length;
    }
    saveSubs(base);
  }
  return result;
}

/* ══════════════════════════════════════════════════ Clash config.yaml 解析 */

/** 取出某个顶层 key 下的所有行（到下一个顶层 key 为止） */
function topSection(lines, key) {
  const out = [];
  let on = false;
  for (const ln of lines) {
    if (!on) {
      if (new RegExp(`^${key}\\s*:`).test(ln)) on = true;
      continue;
    }
    if (ln.trim() === '' || /^\s*#/.test(ln)) { out.push(ln); continue; }
    if (/^\S/.test(ln)) break;                 // 下一个顶层 key
    out.push(ln);
  }
  return out;
}

const unq = (v) => {
  let s = String(v ?? '').trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
  return s;
};

/** 解析流式映射 `{ a: b, c: 'd, e' }` —— 逗号要做引号感知的切分 */
function parseFlowMap(body) {
  const out = {};
  const s = body.trim().replace(/^\{/, '').replace(/\}$/, '');
  let buf = '', quote = null;
  const parts = [];
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; buf += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === ',') { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i < 0) continue;
    out[unq(p.slice(0, i))] = unq(p.slice(i + 1));
  }
  return out;
}

/** 解析 proxies 段：流式 `- { ... }` 与块式 `-` + 缩进键值 都要认 */
export function parseClashProxies(lines) {
  const sec = topSection(lines, 'proxies');
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.name && cur.type) out.push(cur);
    cur = null;
  };
  for (const ln of sec) {
    const t = ln.trim();
    if (!t || t.startsWith('#')) continue;
    const flow = /^-\s*\{(.*)\}\s*$/.exec(t);
    if (flow) {
      flush();
      const m = parseFlowMap(flow[1]);
      if (m.name && m.type) out.push(m);
      continue;
    }
    if (/^-\s*$/.test(t)) { flush(); cur = {}; continue; }
    const inlineName = /^-\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(t);
    if (inlineName) { flush(); cur = {}; cur[inlineName[1]] = unq(inlineName[2]); continue; }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(t);
    if (kv && cur) { cur[kv[1]] = unq(kv[2]); continue; }
  }
  flush();
  return out;
}

/** 解析 proxy-providers 段 → [{ name, url }] */
export function parseClashProviders(lines) {
  const sec = topSection(lines, 'proxy-providers');
  const out = [];
  let cur = null;
  for (const ln of sec) {
    const t = ln.trim();
    if (!t || t.startsWith('#')) continue;
    // 顶层条目：两个空格缩进的 "name:"
    const m = /^([A-Za-z0-9_-]+)\s*:\s*$/.exec(t);
    if (m && /^\s{2}\S/.test(ln) && !/^\s{4}/.test(ln)) {
      if (cur && cur.name) out.push(cur);
      cur = { name: m[1] };
      continue;
    }
    const u = /^url\s*:\s*(.+)$/.exec(t);
    if (u && cur) cur.url = unq(u[1]);
  }
  if (cur && cur.name) out.push(cur);
  return out.filter((p) => p.name && /^https?:\/\//i.test(p.url || ''));
}

/**
 * 解析一整份 Clash 配置文本。
 * @returns {{ providers: Array<{name,url}>, proxies: Array<object>, stats: object }}
 */
export function parseClashConfig(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('内容为空');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasAny = /^proxies\s*:/m.test(text) || /^proxy-providers\s*:/m.test(text);
  if (!hasAny) throw new Error('这不像 Clash 配置：既没有 proxies: 也没有 proxy-providers: 段');

  const providers = parseClashProviders(lines);
  const rawProxies = parseClashProxies(lines);
  // 只保留能用的字段，去掉 Clash 内部键
  const SKIP = new Set(['_note', '_comment', 'dialer-proxy', 'interface-name', 'routing-mark']);
  const proxies = rawProxies.map((p) => {
    const o = {};
    for (const [k, v] of Object.entries(p)) {
      if (SKIP.has(k) || v === '') continue;
      o[k] = v;
    }
    if (o.port != null) o.port = Number(o.port) || 0;
    for (const k of ['udp', 'tls', 'skip-cert-verify', 'tfo', 'xudp']) {
      if (typeof o[k] === 'string') o[k] = /^(true|1|yes)$/i.test(o[k]);
    }
    return o;
  }).filter((p) => p.name && p.type && p.server && p.port > 0);

  return {
    providers,
    proxies,
    stats: { providers: providers.length, proxies: proxies.length, skippedProxies: rawProxies.length - proxies.length },
  };
}

/** 把 Clash 配置合并进订阅文件 */
export function mergeClashIntoSubs(parsed, currentSubs, saveSubs, { mode = 'merge' } = {}) {
  const cur = currentSubs || { providers: [], manualProxies: [], excludedNodes: [], _参数: {} };
  const base = mode === 'replace'
    ? { ...cur, providers: [], manualProxies: [] }
    : { ...cur, providers: [...(cur.providers || [])], manualProxies: [...(cur.manualProxies || [])], excludedNodes: [...(cur.excludedNodes || [])] };

  let addedProviders = 0, addedProxies = 0;
  const pn = new Set(base.providers.map((p) => p.name));
  for (const p of parsed.providers) {
    if (pn.has(p.name)) { base.providers = base.providers.map((x) => (x.name === p.name ? { ...x, url: p.url } : x)); }
    else { base.providers.push({ name: p.name, url: p.url, enabled: true }); }
    pn.add(p.name);
    addedProviders++;
  }
  const mn = new Set(base.manualProxies.map((m) => m.name));
  for (const p of parsed.proxies) {
    if (mn.has(p.name)) { base.manualProxies = base.manualProxies.map((x) => (x.name === p.name ? p : x)); }
    else base.manualProxies.push(p);
    mn.add(p.name);
    addedProxies++;
  }
  saveSubs(base);
  return { addedProviders, addedProxies, totalProviders: base.providers.length, totalManual: base.manualProxies.length };
}
