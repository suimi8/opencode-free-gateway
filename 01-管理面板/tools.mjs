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
  if (!opts.noLocalBind && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(u.hostname)) {
    throw new Error('拒绝访问内网地址');
  }

  /* 两种连法：
   *   默认（绑物理网卡，直连）：必须用 DoH 解出**真实 IP**，
   *     因为本地 DNS 给的是 fake-ip，直连 fake-ip 走不通。
   *   noLocalBind（走 TUN）：反过来**不能**用真实 IP ——
   *     那样会绕过 mihomo 的域名分流规则，直接被墙。
   *     必须用域名让 mihomo 自己解析并按规则出站。
   */
  let ip;
  if (opts.noLocalBind) {
    ip = u.hostname;                    // 交给系统 DNS（mihomo fake-ip）+ TUN
  } else {
    ip = await resolveReal(u.hostname);
    if (!ip) throw new Error(`域名解析失败: ${u.hostname}`);
    if (!isPublicIp(ip)) throw new Error(`解析到非公网 IP: ${u.hostname} -> ${ip}`);
  }

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
  const prov = String(provider || process.env.PANEL_SEARCH_PROVIDER || 'ddg').toLowerCase();
  const t0 = Date.now();
  const n = Math.max(1, Math.min(30, Number(numResults) || 8));

  /* ── deepseek：需要 DEEPSEEK_API_KEY ── */
  if (prov === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('没有 DEEPSEEK_API_KEY，无法用 deepseek 搜索');
    const r = await fetch('https://api.deepseek.com/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: q, max_results: n }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`搜索失败 HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return { ok: true, provider: 'deepseek', query: q, results: j.results || j.data || [], ms: Date.now() - t0 };
  }

  /* ── Bing（默认）：国内可直连、免 key ──
   * cn.bing.com 有时会返回不含结果块的轻量页，所以两个域名都试一遍。 */
  if (prov === 'bing' || prov === 'ddg') {
    const engines = prov === 'ddg'
      ? [`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`]
      : [
          `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${n + 4}&setlang=zh-CN`,
          `https://cn.bing.com/search?q=${encodeURIComponent(q)}&count=${n + 4}`,
        ];

    let lastErr = null;
    for (const url of engines) {
      try {
        const res = await webFetch(url, { format: 'html', timeout: 25000, noLocalBind: prov === 'ddg' });
        const html = res.content;
        const results = prov === 'ddg' ? parseDdg(html, n) : parseBing(html, n);
        if (results.length) {
          return { ok: true, provider: prov, query: q, results, ms: Date.now() - t0, engine: url.split('/')[2] };
        }
        lastErr = new Error(`${url.split('/')[2]} 没解析到结果`);
      } catch (e) { lastErr = e; }
    }
    return { ok: true, provider: prov, query: q, results: [], ms: Date.now() - t0, note: String(lastErr && lastErr.message || '没有结果').slice(0, 200) };
  }

  throw new Error(`未知搜索源: ${prov}（支持 bing / ddg / deepseek）`);
}

/* ── Bing 结果解析 ── */
function parseBing(html, n) {
  const out = [];
  const seen = new Set();
  const blocks = String(html).split(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>/i).slice(1);
  for (const b of blocks) {
    if (out.length >= n) break;
    const m = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/i.exec(b);
    if (!m) continue;
    let url = m[1].replace(/&amp;/g, '&');
    /* Bing 的结果链接是 ck/a 跳转，真实地址在 u=a1<base64url> 里 */
    const uParam = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(url);
    if (uParam) {
      try {
        let b = uParam[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        url = Buffer.from(b, 'base64').toString('utf8');
      } catch { /* 解码失败就跳过 */ }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (/^https?:\/\/([a-z0-9-]+\.)?bing\.com|bing\.net|microsoft\.com|msn\.com|go\.microsoft/i.test(url)) continue;
    if (seen.has(url)) continue;
    const title = htmlToText(m[2]).slice(0, 200);
    if (!title) continue;
    // 摘要：b_caption 里的 <p>
    const cap = /<p[^>]*>([\s\S]{0,600}?)<\/p>/i.exec(b);
    const snippet = cap ? htmlToText(cap[1]).slice(0, 300) : '';
    seen.add(url);
    out.push({ title, url, snippet });
  }
  return out;
}

/* ── DuckDuckGo 结果解析 ── */
function parseDdg(html, n) {
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html))) && out.length < n) {
    let link = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(link);
    if (uddg) { try { link = decodeURIComponent(uddg[1]); } catch { /* 忽略 */ } }
    if (link.startsWith('//')) link = 'https:' + link;
    const title = htmlToText(m[2]).slice(0, 200);
    if (title && link.startsWith('http')) out.push({ title, url: link, snippet: '' });
  }
  return out;
}