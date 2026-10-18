/**
 * tools.mjs —— 网关侧工具执行（websearch / webfetch）
 *
 * 为什么要有这个：
 *   websearch / webfetch 这类工具**由客户端执行**，模型只负责发起调用。
 *   所以走反代时，客户端如果没配搜索 key、或被 DNS 拦了，工具就用不了。
 *   这里把这两个能力**下沉到网关**，客户端只要 POST 一下就能拿到结果，
 *   不用自己配 key、也不用关心本地 DNS。
 *
 * 关键设计：**用 DoH 自己解析真实 IP**
 *   本机 Clash Verge 开着 enhanced-mode: fake-ip，所有域名都解析成
 *   198.18.x.x。任何带 SSRF 防护的抓取工具都会拒绝。
 *   这里直接用 DoH（阿里 / DNSPub）拿真实 IP，再带着真实 IP 建 TLS 连接
 *   （SNI 仍是原域名），于是**不受本地 fake-ip 影响，也不受 hosts 污染**，
 *   所有站点都能抓，不需要维护白名单。
 */
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns/promises';
import { URL } from 'node:url';
import os from 'node:os';
import tls from 'node:tls';

/* ══════════════════════════════════════════════════ DoH 解析 */
const DOH_ENDPOINTS = [
  (n) => `https://223.5.5.5/resolve?name=${encodeURIComponent(n)}&type=A`,
  (n) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(n)}&type=A`,
  (n) => `https://1.1.1.1/dns-query?name=${encodeURIComponent(n)}&type=A`,
];

const IP_CACHE = new Map();          // host -> { ip, at }
const IP_TTL_MS = 10 * 60e3;

/** 判断是否公网 IP（抓取前的 SSRF 防护，仍要保留） */
export function isPublicIp(ip) {
  if (!ip) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
    if (p[0] >= 224) return false;
    return true;
  }
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    if (l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return false;
    return true;
  }
  return false;
}

/** 用 DoH 拿真实 IP（绕过本地 fake-ip）；失败才退回系统解析 */
export async function resolveReal(host) {
  const now = Date.now();
  const c = IP_CACHE.get(host);
  if (c && now - c.at < IP_TTL_MS) return c.ip;

  // 已经是 IP 就直接用
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host;

  for (const mk of DOH_ENDPOINTS) {
    try {
      const r = await fetch(mk(host), {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const ip = (j.Answer || []).find((a) => a.type === 1)?.data;
      if (ip && isPublicIp(ip)) {
        IP_CACHE.set(host, { ip, at: now });
        return ip;
      }
    } catch { /* 换下一个 */ }
  }
  // 退回系统解析（可能是 fake-ip，至少能试）
  try {
    const list = await dns.resolve4(host);
    if (list.length) {
      IP_CACHE.set(host, { ip: list[0], at: now });
      return list[0];
    }
  } catch { /* 忽略 */ }
  return null;
}

/* ══════════════════════════════════════════════════ 物理网卡绑定
 * Clash Verge 的 TUN 会劫持所有出站连接，导致「直接连真实 IP」时
 * TLS 握手中途被断（实测 Client network socket disconnected before
 * secure TLS connection was established）。绑定到物理网卡的源 IP
 * 可以强制走真实网卡，绕开 TUN —— 和节点池用 interface-name 是同一个思路。
 * 可用 OCGW_FETCH_LOCAL_ADDRESS 指定；设 none 关闭。
 */
let LOCAL_ADDR = null;
let LOCAL_ADDR_READY = false;
function localAddress() {
  if (LOCAL_ADDR_READY) return LOCAL_ADDR;
  LOCAL_ADDR_READY = true;
  const env = String(process.env.OCGW_FETCH_LOCAL_ADDRESS || '').trim();
  if (env === 'none' || env === '-') return (LOCAL_ADDR = null);
  if (env) return (LOCAL_ADDR = env);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        // 只排除 TUN 的 fake-ip 网段和回环；
        // 物理网卡通常是 192.168.x / 10.x / 172.16-31.x，这些必须保留
        if (/^198\.(18|19)\./.test(ni.address)) continue;
        if (/^127\./.test(ni.address)) continue;
        if (/^169\.254\./.test(ni.address)) continue;
        return (LOCAL_ADDR = ni.address);
      }
    }
  } catch { /* 忽略 */ }
  return (LOCAL_ADDR = null);
}

/* ══════════════════════════════════════════════════ 抓取 */
/** 带着「真实 IP + 原域名 SNI」发请求 */
function requestWithIp(targetUrl, { ip, method = 'GET', headers = {}, timeout = 30000, maxBytes = 8 * 1024 * 1024, body = null, noLocalBind = false }) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const opts = {
      method,
      host: ip || u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: { host: u.hostname, ...headers },
      timeout,
      ...(isHttps ? { servername: u.hostname } : {}),   // SNI 必须是原域名
    };
    const la = noLocalBind ? null : localAddress();
    if (la) opts.localAddress = la;                     // 绕开 Clash TUN
    const req = mod.request(opts, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > maxBytes) { req.destroy(new Error('响应体过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        finalUrl: targetUrl,
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`超时 ${timeout}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

/** 简单 HTML → 纯文本（够用，不引第三方依赖） */
export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n' + '#'.repeat(Number(n)) + ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
       .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return s.trim();
}

/** 提取标题 */
function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

/**
 * 抓一个网页。
 * @param {string} url
 * @param {{format?:'text'|'markdown'|'html', timeout?:number, maxBytes?:number}} opts
 */
export async function webFetch(url, opts = {}) {
  const { format = 'markdown', timeout = 30000, maxBytes = 8 * 1024 * 1024 } = opts;
  const t0 = Date.now();
  let u;
  try { u = new URL(url); } catch { throw new Error(`不是合法 URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http/https');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(u.hostname)) {
    throw new Error('拒绝访问内网地址');
  }

  const ip = await resolveReal(u.hostname);
  if (!ip) throw new Error(`域名解析失败: ${u.hostname}`);
  if (!isPublicIp(ip)) throw new Error(`解析到非公网 IP: ${u.hostname} -> ${ip}`);

  /* viaProxy：走本地 HTTP 代理的 CONNECT 隧道（用来抓被墙站点，比如 DDG） */
  if (opts.viaProxy) {
    const p = String(opts.viaProxy === true ? (process.env.OCGW_FETCH_PROXY || '127.0.0.1:7897') : opts.viaProxy);
    return await fetchViaConnect(url, { proxy: p, timeout, maxBytes, format, t0 });
  }

  const res = await requestWithIp(url, {
    ip,
    timeout,
    maxBytes,
    noLocalBind: !!opts.noLocalBind,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'accept-encoding': 'identity',
    },
  });

  // 跟随重定向（最多 5 跳）
  let cur = res;
  let hops = 0;
  while (cur.status >= 300 && cur.status < 400 && cur.headers.location && hops < 5) {
    hops++;
    const next = new URL(cur.headers.location, url).href;
    const nip = await resolveReal(new URL(next).hostname);
    cur = await requestWithIp(next, { ip: nip, timeout, maxBytes, headers: { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'identity' } });
  }

  const ct = String(cur.headers['content-type'] || '');
  const raw = cur.body.toString('utf8');
  const isHtml = /html|xml/i.test(ct) || /^\s*<(!doctype|html)/i.test(raw.slice(0, 200));

  let content;
  if (format === 'html' || !isHtml) content = raw;
  else content = htmlToText(raw);

  const MAX = Number(process.env.PANEL_FETCH_MAX_CHARS || 60000);
  const truncated = content.length > MAX;

  return {
    ok: cur.status >= 200 && cur.status < 300,
    status: cur.status,
    url,
    finalUrl: cur.finalUrl || url,
    ip,
    contentType: ct,
    title: isHtml ? htmlTitle(raw) : '',
    bytes: cur.body.length,
    chars: content.length,
    truncated,
    content: truncated ? content.slice(0, MAX) : content,
    ms: Date.now() - t0,
  };
}

/* ══════════════════════════════════════════════════ 搜索 */
/**
 * 搜索。没有搜索 API key 时退回 DuckDuckGo 的 HTML 端点（免 key）。
 * 可用 PANEL_SEARCH_PROVIDER=ddg|deepseek 指定。
 */
export async function webSearch(query, { numResults = 8, provider = null } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  const prov = provider || process.env.PANEL_SEARCH_PROVIDER || 'ddg';
  const t0 = Date.now();

  if (prov === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('没有 DEEPSEEK_API_KEY，无法用 deepseek 搜索');
    const r = await fetch('https://api.deepseek.com/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: q, max_results: numResults }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`搜索失败 HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return { ok: true, provider: 'deepseek', query: q, results: j.results || j.data || [], ms: Date.now() - t0 };
  }

  /* DuckDuckGo 在国内直连被墙，必须走本地代理（Clash Verge / 节点池）。
   * 先试直连，失败再走代理。 */  /* DuckDuckGo HTML 版：免 key，抓完解析结果块 */
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await webFetch(url, { format: 'html', timeout: 25000, noLocalBind: true });
  const html = res.content;

  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < numResults) {
    let link = m[1];
    // DDG 的跳转链接里带着真实地址
    const uddg = /[?&]uddg=([^&]+)/.exec(link);
    if (uddg) { try { link = decodeURIComponent(uddg[1]); } catch { /* 忽略 */ } }
    if (link.startsWith('//')) link = 'https:' + link;
    const title = htmlToText(m[2]).slice(0, 200);
    if (title && link.startsWith('http')) results.push({ title, url: link });
  }

  return { ok: true, provider: 'ddg', query: q, results, ms: Date.now() - t0, note: results.length ? undefined : '没解析到结果（DDG 页面结构可能变了）' };
}

/* ══════════════════════════════════════════════════ 走本地代理抓取
 * 用于访问被墙站点（DuckDuckGo 等）。用 HTTP CONNECT 建隧道后
 * 在隧道上做 TLS，SNI 仍是目标域名。
 */
async function fetchViaConnect(targetUrl, { proxy, timeout = 30000, maxBytes = 8 * 1024 * 1024, format = 'markdown', t0 = Date.now() }) {
  const u = new URL(targetUrl);
  const [ph, pp] = String(proxy).replace(/^https?:\/\//, '').split(':');
  const port = Number(pp) || 7897;

  const raw = await new Promise((resolve, reject) => {
    const req = http.request({ host: ph, port, method: 'CONNECT', path: `${u.hostname}:443`, timeout }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`代理 CONNECT 失败 HTTP ${res.statusCode}`)); return; }
      resolve(res.socket);
    });
    req.on('connect', (r, socket) => { if (r.statusCode === 200) resolve(socket); else reject(new Error(`代理 CONNECT ${r.statusCode}`)); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('代理连接超时')));
    req.end();
  });

  const body = await new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname, servername: u.hostname, method: 'GET',
      path: u.pathname + u.search,
      headers: { host: u.hostname, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', accept: 'text/html,*/*', 'accept-encoding': 'identity' },
      createConnection: () => tls.connect({ socket: raw, servername: u.hostname }),
      timeout,
    }, (res) => {
      const cs = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(new Error('响应过大')); return; } cs.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(cs) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.end();
  });

  const ct = String(body.headers['content-type'] || '');
  const txt = body.body.toString('utf8');
  const isHtml = /html|xml/i.test(ct) || /^\s*<(!doctype|html)/i.test(txt.slice(0, 200));
  let content = (format === 'html' || !isHtml) ? txt : htmlToText(txt);
  const MAX = Number(process.env.PANEL_FETCH_MAX_CHARS || 60000);
  const truncated = content.length > MAX;
  return {
    ok: body.status >= 200 && body.status < 300, status: body.status, url: targetUrl, finalUrl: targetUrl,
    ip: '(via proxy)', contentType: ct, title: isHtml ? htmlTitle(txt) : '',
    bytes: body.body.length, chars: content.length, truncated,
    content: truncated ? content.slice(0, MAX) : content, ms: Date.now() - t0, viaProxy: proxy,
  };
}
/* ══════════════════════════════════════════════════ 文件类工具
 * 全部限制在**一个工作目录**内（PANEL_TOOL_ROOT，默认 <panel.db 同目录>/workspace）。
 * 任何越界路径直接拒绝 —— 这几个工具能给客户端「文件访问能力」，
 * 但绝不能变成任意路径读写。
 */
import path from 'node:path';
import fs from 'node:fs';

export function workspaceRoot() {
  const root = process.env.PANEL_TOOL_ROOT
    || path.join(path.dirname(process.env.PANEL_DB || path.join(import.meta.dirname, 'panel.db')), 'workspace');
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* 忽略 */ }
  return path.resolve(root);
}

/** 把用户给的路径解析到工作目录内；越界抛错 */
export function resolveInWorkspace(p) {
  const root = workspaceRoot();
  const rel = String(p == null ? '' : p).trim();
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越界：只允许访问 ${root} 之下的文件`);
  }
  return abs;
}

/** 读文件（带行号可选） */
export function readFile(p, { offset = 0, limit = 2000 } = {}) {
  const abs = resolveInWorkspace(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name)).sort();
    return { ok: true, path: abs, type: 'directory', count: entries.length, entries: entries.slice(0, 500) };
  }
  if (st.size > Number(process.env.PANEL_TOOL_MAX_FILE || 4 * 1024 * 1024)) throw new Error('文件过大（>4MB）');
  const text = fs.readFileSync(abs, 'utf8');
  const all = text.split(/\r?\n/);
  const from = Math.max(0, Number(offset) || 0);
  const n = Math.max(1, Math.min(5000, Number(limit) || 2000));
  const slice = all.slice(from, from + n);
  return {
    ok: true, path: abs, type: 'file',
    totalLines: all.length, offset: from, returned: slice.length,
    truncated: from + slice.length < all.length,
    content: slice.join('\n'),
  };
}

/** 写文件（自动建目录，覆盖写） */
export function writeFile(p, content) {
  const abs = resolveInWorkspace(p);
  if (abs === workspaceRoot()) throw new Error('不能写工作目录本身');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = String(content == null ? '' : content);
  fs.writeFileSync(abs, body, 'utf8');
  return { ok: true, path: abs, bytes: Buffer.byteLength(body, 'utf8') };
}

/** 精确替换 */
export function editFile(p, { oldString, newString, replaceAll = false } = {}) {
  const abs = resolveInWorkspace(p);
  const text = fs.readFileSync(abs, 'utf8');
  if (!oldString) throw new Error('缺少 oldString');
  const count = text.split(oldString).length - 1;
  if (count === 0) throw new Error('没找到要替换的内容（oldString 不匹配）');
  if (count > 1 && !replaceAll) throw new Error(`匹配到 ${count} 处，请用 replaceAll:true 或提供更长的上下文`);
  const next = replaceAll ? text.split(oldString).join(String(newString ?? '')) : text.replace(oldString, () => String(newString ?? ''));
  fs.writeFileSync(abs, next, 'utf8');
  return { ok: true, path: abs, replaced: replaceAll ? count : 1, bytes: Buffer.byteLength(next, 'utf8') };
}

/** glob → 正则 */
function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c === '/' ? '/' : c;
  }
  return new RegExp('^' + re + '$', 'i');
}

/** 按模式找文件 */
export function globFiles(pattern, { dir = '' } = {}) {
  const base = resolveInWorkspace(dir || '.');
  const rx = globToRegExp(String(pattern || '*').replace(/\\/g, '/'));
  const root = workspaceRoot();
  const out = [];
  const MAX = Number(process.env.PANEL_TOOL_MAX_RESULTS || 200);
  const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-desktop', '.next', '__pycache__']);

  (function walk(d, depth) {
    if (out.length >= MAX || depth > 12) return;
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (out.length >= MAX) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(abs, depth + 1); continue; }
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (rx.test(rel) || rx.test(e.name)) {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* 忽略 */ }
        out.push({ path: abs, rel, size });
      }
    }
  })(base, 0);

  return { ok: true, pattern, base, count: out.length, truncated: out.length >= MAX, files: out };
}

/** 按正则搜文件内容 */
export function grepFiles(pattern, { dir = '', include = '', maxResults = 100 } = {}) {
  const base = resolveInWorkspace(dir || '.');
  let rx;
  try { rx = new RegExp(String(pattern || ''), 'i'); } catch { throw new Error(`正则不合法: ${pattern}`); }
  const incRx = include ? globToRegExp(String(include).replace(/\\/g, '/')) : null;
  const root = workspaceRoot();
  const MAX = Math.min(500, Number(maxResults) || 100);
  const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-desktop', '.next', '__pycache__']);
  const matches = [];

  (function walk(d, depth) {
    if (matches.length >= MAX || depth > 12) return;
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (matches.length >= MAX) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(abs, depth + 1); continue; }
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (incRx && !incRx.test(rel) && !incRx.test(e.name)) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > 2 * 1024 * 1024) continue;           // 跳过超大文件
      let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (text.includes('\u0000')) continue;             // 跳过二进制
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < MAX; i++) {
        if (rx.test(lines[i])) matches.push({ path: abs, rel, line: i + 1, text: lines[i].slice(0, 300) });
      }
    }
  })(base, 0);

  return { ok: true, pattern, base, include: include || null, count: matches.length, truncated: matches.length >= MAX, matches };
}