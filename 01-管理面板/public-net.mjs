/**
 * public-net.mjs —— 公网部署支持
 *
 * 解决部署到公网后的几个问题：
 *   1. 不知道自己对外是什么地址 → 自动探测公网 IP，并支持反向代理头
 *   2. 反代后面 HTTPS 但应用看不到 → 认 X-Forwarded-Proto
 *   3. Cookie 在 HTTPS 下应该带 Secure → 按实际协议自动加
 *   4. 客户端真实 IP → 认 X-Forwarded-For（已有，这里统一入口）
 */
import os from 'node:os';

/** 探测公网 IP 的服务（按顺序试，谁快用谁） */
const IP_SERVICES = [
  { url: 'https://api.ipify.org?format=json', pick: (j) => j.ip },
  { url: 'https://api.ip.sb/ip', pick: (t) => t.trim() },
  { url: 'https://ifconfig.me/ip', pick: (t) => t.trim() },
  { url: 'https://ipinfo.io/json', pick: (j) => j.ip },
];

let CACHE = { ip: null, at: 0, error: null };
const TTL_MS = 10 * 60e3;      // 10 分钟

/** 是否公网 IPv4 */
export function isPublicIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const p = ip.split('.').map(Number);
  if (p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return false;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
  if (p[0] === 169 && p[1] === 254) return false;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  if (p[0] === 192 && p[1] === 168) return false;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
  if (p[0] >= 224) return false;
  return true;
}

/** 探测公网 IP（带缓存；force 强制刷新） */
export async function detectPublicIp({ force = false } = {}) {
  if (!force && CACHE.ip && Date.now() - CACHE.at < TTL_MS) return CACHE;
  // 手动指定优先
  const env = String(process.env.PANEL_PUBLIC_IP || '').trim();
  if (env) {
    CACHE = { ip: env, at: Date.now(), error: null, source: 'env' };
    return CACHE;
  }
  let err = null;
  for (const svc of IP_SERVICES) {
    try {
      const r = await fetch(svc.url, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json, text/plain, */*' } });
      if (!r.ok) { err = `HTTP ${r.status}`; continue; }
      const ct = String(r.headers.get('content-type') || '');
      const raw = await r.text();
      let ip;
      try { ip = ct.includes('json') ? svc.pick(JSON.parse(raw)) : svc.pick(raw); } catch { ip = svc.pick(raw); }
      ip = String(ip || '').trim();
      if (isPublicIp(ip)) {
        CACHE = { ip, at: Date.now(), error: null, source: svc.url };
        return CACHE;
      }
      err = `返回的不是公网 IP: ${ip}`;
    } catch (e) { err = String(e.message || e); }
  }
  CACHE = { ...CACHE, error: err || '全部探测服务失败' };
  return CACHE;
}

/** 本机内网 IP（给「局域网也能访问」的提示用） */
export function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/** 从请求里判断真实协议（反代后面是 HTTPS 时应用只看到 HTTP） */
export function protoOf(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (xf === 'https' || xf === 'http') return xf;
  if (req.socket && req.socket.encrypted) return 'https';
  return 'http';
}

/** 从请求里判断对外 host（反代的 X-Forwarded-Host 优先） */
export function hostOf(req) {
  const xfh = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  if (xfh) return xfh;
  const h = String(req.headers.host || '').trim();
  if (h) return h;
  return '';
}

/**
 * 拼出当前请求对应的公网地址。
 * 优先级：PANEL_PUBLIC_URL > 请求头（反代）> 探测到的公网 IP + 端口 > localhost
 */
export async function publicUrlOf(req, port = process.env.PANEL_PORT || 8790) {
  const manual = String(process.env.PANEL_PUBLIC_URL || '').trim();
  if (manual) return manual.replace(/\/+$/, '');
  if (req) {
    const h = hostOf(req);
    // 只有 host 不是 localhost/内网时才认为是真正的对外地址
    if (h && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(h) && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) {
      return `${protoOf(req)}://${h}`;
    }
  }
  const d = await detectPublicIp();
  if (d.ip) return `http://${d.ip}:${port}`;
  return `http://localhost:${port}`;
}

/** Cookie 属性：HTTPS 下自动加 Secure */
export function cookieAttrs(req, { maxAge = 7 * 24 * 3600 } = {}) {
  const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (protoOf(req) === 'https') parts.push('Secure');
  if (maxAge > 0) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

/** 汇总一份网络信息（给面板显示） */
export async function info(req, port) {
  const d = await detectPublicIp();
  return {
    publicIp: d.ip,
    publicIpAt: d.at || null,
    publicIpSource: d.source || null,
    publicIpError: d.error || null,
    lanIps: lanIps(),
    proto: req ? protoOf(req) : null,
    host: req ? hostOf(req) : null,
    publicUrl: await publicUrlOf(req, port),
    behindProxy: req ? !!(req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']) : false,
    port: Number(port) || 8790,
  };
}
