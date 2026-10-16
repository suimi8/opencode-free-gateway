#!/usr/bin/env node
/**
 * ocfree_client.mjs — OpenCode 免费层推理端点 · 高频生产客户端
 *
 * 传输层：默认直连；支持 HTTP(S) CONNECT 与 SOCKS5/SOCKS5H 代理，可配置多节点池，
 *         节点级健康检查 + 冷却 + 自动故障转移；每节点独立 keep-alive 连接池。
 * 可用性：连接预热 · 429 快速失败不空等 · 模型熔断与自动换模型 · 全熔断时等待额度重置 ·
 *         5xx/网络错误指数退避重试 · 全局 RPS 限速 · 优雅退出并打印汇总。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *   # 单次（流式打印）
 *   node ocfree_client.mjs --once -m longcat-2.5-preview-free --prompt "你好"
 *
 *   # 固定条数 + 高并发 + 多模型轮转
 *   node ocfree_client.mjs -n 500 -c 32 -m longcat-2.5-preview-free,nemotron-3-ultra-free
 *
 *   # 持续高频运行 1 小时（全模型耗尽时自动等待额度重置）
 *   node ocfree_client.mjs --duration 3600 -c 24 -m longcat-2.5-preview-free,nemotron-3-ultra-free
 *
 *   # 单代理
 *   node ocfree_client.mjs -n 100 -c 16 --proxy http://127.0.0.1:7897 -m longcat-2.5-preview-free
 *
 *   # 多代理池（轮转 + 故障转移），也可写成 @proxies.txt（每行一个）
 *   node ocfree_client.mjs -n 500 -c 32 \
 *     --proxy "http://127.0.0.1:7897,socks5://127.0.0.1:7897" -m longcat-2.5-preview-free
 *
 * ── 参数 ─────────────────────────────────────────────────────────────────
 *   -n, --total <N>        总请求数（默认 1；--duration 模式下忽略）
 *   -c, --concurrency <N>  并发数（默认 8）
 *   --duration <sec>       持续运行秒数（到点后优雅收尾并打印汇总）
 *   --rps <N>              全局每秒请求上限（默认不限）
 *   --prompt <text>        提示词（与 --prompts 二选一）
 *   --prompts <file>       提示词文件，每行一条，循环使用
 *   -m, --model <ids>      模型 id，逗号分隔可多模型轮转
 *   --max-tokens <N>       最大输出 token（默认 32000）
 *   --proxy <urls>         代理，逗号分隔多个；或 @file（每行一个）；默认直连
 *                          支持 http:// / https:// / socks5:// / socks5h:// [user:pass@]host:port
 *   --no-proxy             强制直连，忽略 HTTPS_PROXY/ALL_PROXY 环境变量
 *   --no-stream            非流式
 *   --no-wait              全部模型额度耗尽时不等待，直接收尾
 *   --template <file>      请求体模板（默认脚本同目录 body_template.json）
 *   --jsonl <file>         每条结果追加写入 JSONL
 *   --timeout <ms>         单请求超时（默认 180000）
 *   --retries <N>          重试次数（默认 3）
 *   --warmup <N>           预建连接数（默认 = 并发数；0 关闭）
 *   --proxy-cooldown <sec> 代理故障冷却秒数（默认 60）
 *   -v, --verbose          打印每条请求明细
 *
 * ── 已探明的服务端行为（本脚本据此设计）─────────────────────────────────
 *   · 门禁共 5 条（100+ 次单变量消融实测，见 04-门禁判别实验/verify_recipe*.mjs）：
 *       1) user-agent 匹配 ^opencode/v?<版本>（**大小写不敏感**）  否则 403
 *       2) UA 里的版本 **≥ 1.18.0**                              否则 **426**
 *       3) x-opencode-session = ses_ + 12hex + 14base62（**必需**）否则 403
 *       4) 12hex 段的低 12 位 ∈ [0xfc0,0xfff]（先看 session-id，无则看 session）否则 403
 *       5) body.stream === true + 完整 agent body                否则 403
 *     **可选**：x-opencode-session-id（可完全不要；给了就必须合法）、authorization、
 *     x-opencode-request / client / project。
 *   · 【已修正】额度不是「模型 × 天」独立计算，而是**全部免费模型共用同一个每日桶**：
 *     0 次调用的 big-pickle 与 6000 次调用的 mimo-v2.6-flash-free 会同时 429，
 *     retry-after 指向同一重置点 00:00 UTC（= 北京时间 08:00）。换出口 IP 也不刷新额度。
 *   · 因此多模型轮转**不能**放大总额度，只能提高单桶内的并发利用率；
 *     本脚本的模型级熔断与故障转移仍有用（避开单模型瞬时限流/地区门禁）。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = 'opencode.ai';
const PORT = 443;
const REQ_PATH = '/inference/v1/chat/completions';

/* ══════════════════════════════════════════════════════════════ CLI */
const argv = process.argv.slice(2);
const has = (...names) => names.some((n) => argv.includes(n));
function opt(def, ...names) {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i < 0) continue;
    const v = argv[i + 1];
    return v === undefined || (v.startsWith('-') && !/^-\d/.test(v)) ? true : v;
  }
  return def;
}
const numOpt = (def, ...names) => {
  const v = opt(def, ...names);
  const x = Number(v);
  return Number.isFinite(x) && v !== true ? x : def;
};

if (has('-h', '--help')) {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const a = src.indexOf('/**'), b = src.indexOf('*/');
  console.log(src.slice(a + 3, b).split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').replace(/^\s+|\s+$/g, ''));
  process.exit(0);
}

const CFG = {
  total: Math.max(1, numOpt(1, '-n', '--total')),
  concurrency: Math.max(1, numOpt(8, '-c', '--concurrency')),
  duration: Math.max(0, numOpt(0, '--duration')),
  rps: Math.max(0, numOpt(0, '--rps')),
  prompt: opt(null, '--prompt'),
  promptsFile: opt(null, '--prompts'),
  model: opt('deepseek-v4.1-flash-free', '-m', '--model'),
  maxTokens: numOpt(32000, '--max-tokens'),
  proxy: opt(null, '--proxy'),
  noProxy: has('--no-proxy'),
  stream: !has('--no-stream'),
  waitReset: !has('--no-wait'),
  template: opt(path.join(DIR, 'body_template.json'), '--template'),
  jsonl: opt(null, '--jsonl'),
  timeout: numOpt(180000, '--timeout'),
  retries: numOpt(3, '--retries'),
  warmup: numOpt(-1, '--warmup'),
  proxyCooldown: numOpt(60, '--proxy-cooldown'),
  verbose: has('-v', '--verbose'),
  once: has('--once'),
};
if (CFG.warmup < 0) CFG.warmup = CFG.concurrency;
CFG.models = String(CFG.model).split(',').map((s) => s.trim()).filter(Boolean);
if (!CFG.models.length) CFG.models = ['deepseek-v4.1-flash-free'];

/* ══════════════════════════════════════════════════════ 代理解析 */
function parseProxyUrl(raw) {
  const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const proto = u.protocol.replace(':', '');
  if (!['http', 'https', 'socks5', 'socks5h'].includes(proto)) throw new Error(`不支持的代理协议: ${proto}`);
  return {
    raw,
    protocol: proto,
    hostname: u.hostname,
    port: Number(u.port || (proto.startsWith('socks') ? 1080 : proto === 'https' ? 443 : 80)),
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
    auth: u.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : null,
  };
}
function resolveProxyList() {
  if (CFG.noProxy) return [];
  let spec = CFG.proxy;
  if (!spec) spec = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || null;
  if (!spec || spec === true) return [];
  const s = String(spec);
  if (s.startsWith('@')) {
    return fs.readFileSync(s.slice(1), 'utf8').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/* ── HTTP(S) CONNECT 隧道 ── */
function httpTunnel(p, timeout) {
  return new Promise((resolve, reject) => {
    const req = (p.protocol === 'https' ? https : http).request({
      host: p.hostname, port: p.port, method: 'CONNECT', path: `${HOST}:${PORT}`,
      headers: p.auth ? { 'proxy-authorization': p.auth } : {}, timeout,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`CONNECT ${res.statusCode}`)); }
      resolve(socket);
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('CONNECT timeout')));
    req.end();
  });
}

/* ── SOCKS5（RFC1928 + RFC1929 用户口令认证）── */
function socks5Tunnel(p, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: p.hostname, port: p.port });
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; sock.destroy(); reject(e); } };
    sock.setTimeout(timeout, () => fail(new Error('SOCKS5 timeout')));
    sock.once('error', fail);
    sock.once('close', () => fail(new Error('SOCKS5 closed early')));

    const sendConnect = () => {
      const h = Buffer.from(HOST, 'utf8');
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(PORT >> 8) & 0xff, PORT & 0xff])]));
    };
    const methods = p.username ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === 0xff) return fail(new Error('SOCKS5 无可用认证方式'));
        if (method === 0x02) {
          const u = Buffer.from(p.username || '', 'utf8');
          const pw = Buffer.from(p.password || '', 'utf8');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]));
          stage = 'auth';
          return;
        }
        stage = 'conn'; sendConnect();
      } else if (stage === 'auth') {
        if (buf.length < 2) return;
        const ok = buf[1] === 0x00;
        buf = buf.subarray(2);
        if (!ok) return fail(new Error('SOCKS5 认证失败'));
        stage = 'conn'; sendConnect();
      } else {
        if (buf.length < 4) return;
        const rep = buf[1];
        const atyp = buf[3];
        let need = 4;
        if (atyp === 0x01) need += 4;
        else if (atyp === 0x03) { if (buf.length < 5) return; need += 1 + buf[4]; }
        else if (atyp === 0x04) need += 16;
        else return fail(new Error(`SOCKS5 未知地址类型 ${atyp}`));
        need += 2;
        if (buf.length < need) return;
        if (rep !== 0x00) return fail(new Error(`SOCKS5 连接失败 code=${rep}`));
        settled = true;
        sock.setTimeout(0);
        sock.removeAllListeners('data');
        sock.removeAllListeners('close');
        resolve(sock);
      }
    });
  });
}

/* ── 代理池 ── */
const agentOpts = {
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: Math.max(16, CFG.concurrency * 2),
  maxFreeSockets: Math.max(16, CFG.concurrency),
  scheduling: 'lifo',
  timeout: 60000,
};

class ProxyAgent extends https.Agent {
  constructor(cfg) { super(agentOpts); this._cfg = cfg; }
  createConnection(_options, cb) {
    const p = this._cfg;
    const connect = p.protocol.startsWith('socks') ? socks5Tunnel(p, CFG.timeout) : httpTunnel(p, CFG.timeout);
    connect.then(
      (raw) => {
        const s = tls.connect({ socket: raw, servername: HOST, ALPNProtocols: ['http/1.1'] });
        s.once('secureConnect', () => { s.setNoDelay(true); cb(null, s); });
        s.once('error', (e) => cb(e));
      },
      (e) => cb(e),
    );
  }
}

class ProxyEntry {
  constructor(url) {
    this.url = url;
    this.cfg = parseProxyUrl(url);
    this.agent = new ProxyAgent(this.cfg);
    this.downUntil = 0;
    this.inflight = 0;
    this.ok = 0;
    this.fail = 0;
    this.lastError = null;
  }
  get healthy() { return Date.now() >= this.downUntil; }
}

class ProxyPool {
  constructor(urls) {
    if (urls.length) {
      this.entries = urls.map((u) => new ProxyEntry(u));
    } else {
      this.entries = [{
        url: '直连', cfg: null, agent: new https.Agent(agentOpts),
        downUntil: 0, inflight: 0, ok: 0, fail: 0, lastError: null,
      }];
    }
  }
  pick() {
    const now = Date.now();
    const healthy = this.entries.filter((e) => e.downUntil <= now);
    const pool = healthy.length ? healthy : this.entries;
    let best = pool[0];
    for (const e of pool) if (e.inflight < best.inflight) best = e;
    return best;
  }
  markDown(e, ms) {
    e.downUntil = Date.now() + ms;
    e.fail++;
    if (this.entries.filter((x) => x.downUntil <= Date.now()).length === 0) {
      console.error(`[proxy] 全部节点不可用，${Math.round(ms / 1000)}s 后重试`);
    }
  }
}
const POOL = new ProxyPool(resolveProxyList());

/* ══════════════════════════════════════════════════ session/message id */
const HEX = '0123456789abcdef';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const rnd = (n) => crypto.randomBytes(n);
function randFrom(alphabet, n) {
  const b = rnd(n);
  let o = '';
  for (let i = 0; i < n; i++) o += alphabet[b[i] % alphabet.length];
  return o;
}
/** ses_ + 12 hex（末三位 ∈ [0xfc0,0xfff]，真实客户端恒为 0xffe）+ 14 base62 */
const sessionId = () => `ses_${randFrom(HEX, 9)}${(0xfc0 + (rnd(1)[0] % 0x40)).toString(16).padStart(3, '0')}${randFrom(B62, 14)}`;
const messageId = () => `msg_${randFrom(HEX, 12)}${randFrom(B62, 14)}`;

/* ══════════════════════════════════════════════════════ 请求体模板 */
const TPL = JSON.parse(fs.readFileSync(CFG.template, 'utf8'));
const SYSTEM_MSG = (TPL.messages || []).find((m) => m.role === 'system') || { role: 'system', content: 'You are opencode.' };
function buildBody(prompt, model) {
  TPL.model = model;
  TPL.max_tokens = CFG.maxTokens;
  TPL.messages = [SYSTEM_MSG, { role: 'user', content: prompt }];
  if (CFG.stream) { TPL.stream = true; TPL.stream_options = { include_usage: true }; }
  else { TPL.stream = false; delete TPL.stream_options; }
  return JSON.stringify(TPL);
}
function buildHeaders(sid, mid) {
  return {
    authorization: 'Bearer public',
    'content-type': 'application/json',
    'user-agent': 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
    'x-opencode-client': 'desktop',
    'x-opencode-project': 'global',
    'x-opencode-request': mid,
    'x-opencode-session': sid,
    'x-opencode-session-id': sid,
  };
}

/* ══════════════════════════════════════════════════════════ 传输 */
// 持续模式的硬截止点：在途请求会在截止时被切断，保证 --duration 精度
let HARD_DEADLINE = Infinity;
function effTimeout() {
  return Math.max(500, Math.min(CFG.timeout, HARD_DEADLINE - Date.now()));
}

function post(entry, headers, body) {
  return new Promise((resolve, reject) => {
    const tmo = effTimeout();
    let done = false;
    // 硬性总时限：从请求发出即计时（响应头到达之前也必须生效，否则半开连接会挂住 worker）
    const timer = setTimeout(() => {
      if (!done) req.destroy(new Error(`hard timeout ${Math.round(tmo)}ms`));
    }, tmo);
    const clear = () => { done = true; clearTimeout(timer); };
    const req = https.request(
      { host: HOST, port: PORT, path: REQ_PATH, method: 'POST', headers, agent: entry.agent },
      (res) => {
        res.once('end', clear);
        res.once('close', clear);
        res.once('error', clear);
        resolve({ req, res });
      },
    );
    req.once('error', (e) => { clear(); reject(e); });
    req.once('close', clear);
    req.setTimeout(tmo, () => req.destroy(new Error(`timeout ${Math.round(tmo)}ms`)));
    req.end(body);
  });
}

async function consumeStream(res) {
  res.setEncoding('utf8');
  let buf = '', text = '', usage = null, firstByteAt = null;
  for await (const chunk of res) {
    if (firstByteAt === null) firstByteAt = performance.now();
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      const d = ev.choices?.[0]?.delta;
      if (d?.content) text += d.content;
      if (ev.usage) usage = ev.usage;
    }
  }
  return { text, usage, firstByteAt };
}
async function consumeJson(res) {
  let raw = '';
  res.setEncoding('utf8');
  for await (const c of res) raw += c;
  try { const j = JSON.parse(raw); return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? null, firstByteAt: null }; }
  catch { return { text: raw.slice(0, 300), usage: null, firstByteAt: null }; }
}

/* ════════════════════════════════════════════ 模型熔断与故障转移 */
const MODEL_STATE = new Map();
function modelStat(m) {
  let s = MODEL_STATE.get(m);
  if (!s) { s = { until: 0, ok: 0, fail: 0, last429: null }; MODEL_STATE.set(m, s); }
  return s;
}
const allModelsDown = () => CFG.models.every((m) => modelStat(m).until > Date.now());
function earliestReset() {
  const now = Date.now();
  const ups = CFG.models.map((m) => modelStat(m).until).filter((u) => u > now);
  return ups.length ? Math.min(...ups) : now;
}
function pickModel(seed) {
  const n = CFG.models.length, now = Date.now();
  for (let k = 0; k < n; k++) {
    const m = CFG.models[(seed + k) % n];
    if (modelStat(m).until <= now) return m;
  }
  let best = CFG.models[0], bu = Infinity;
  for (const m of CFG.models) { const u = modelStat(m).until; if (u < bu) { bu = u; best = m; } }
  return best;
}

/* ══════════════════════════════════════════════════════════ 限速器 */
let slot = 0;
async function rateLimit() {
  if (!CFG.rps) return;
  const interval = 1000 / CFG.rps;
  const now = Date.now();
  slot = Math.max(slot, now);
  const wait = slot - now;
  slot += interval;
  if (wait > 0) await sleep(wait);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════ 单次调用 */
async function callOnce(prompt, seed) {
  let lastErr = null, lastStatus = 0, lastModel = CFG.models[0];
  for (let attempt = 0; attempt <= CFG.retries; attempt++) {
    if (Date.now() >= HARD_DEADLINE) {
      return { ok: false, cut: true, status: 0, ms: 0, model: lastModel, proxy: '-', error: 'cut by --duration', attempts: attempt };
    }
    const model = pickModel(seed + attempt);
    lastModel = model;
    const entry = POOL.pick();
    entry.inflight++;
    const sid = sessionId();
    const t0 = performance.now();
    try {
      const { res } = await post(entry, buildHeaders(sid, messageId()), buildBody(prompt, model));
      if (res.statusCode === 200) {
        const out = CFG.stream ? await consumeStream(res) : await consumeJson(res);
        const dt = performance.now() - t0;
        entry.ok++; modelStat(model).ok++;
        return {
          ok: true, status: 200, ms: dt, model, proxy: entry.url,
          ttft: out.firstByteAt !== null ? out.firstByteAt - t0 : null,
          text: out.text, usage: out.usage, attempts: attempt + 1, session: sid,
        };
      }
      let errBody = '';
      res.setEncoding('utf8');
      for await (const c of res) errBody += c;
      const status = res.statusCode;
      lastStatus = status;
      lastErr = new Error(`HTTP ${status}: ${errBody.slice(0, 300)}`);

      if (status === 429) {                       // 该模型当日额度耗尽 → 熔断，立刻换模型
        const ra = Number(res.headers['retry-after']);
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3600000;
        modelStat(model).until = Date.now() + Math.min(wait, 24 * 3600 * 1000);
        modelStat(model).last429 = new Date(Date.now() + wait * 1000);
        modelStat(model).fail++;
        if (attempt === CFG.retries) break;
        continue;                                  // 不 sleep，直接故障转移
      }
      if (status === 403 || status === 400) {      // 形状/可用性问题，重试无意义
        modelStat(model).fail++;
        return { ok: false, status, ms: performance.now() - t0, model, proxy: entry.url, error: errBody.slice(0, 500), attempts: attempt + 1 };
      }
      if (status < 500) {
        modelStat(model).fail++;
        return { ok: false, status, ms: performance.now() - t0, model, proxy: entry.url, error: errBody.slice(0, 500), attempts: attempt + 1 };
      }
    } catch (e) {
      lastErr = e; lastStatus = 0;
      const msg = String(e.message || e);
      // 传输层失败 → 怀疑代理节点，冷却它（但若是我们自己按截止时间切断的，不算节点故障）
      if (Date.now() < HARD_DEADLINE && /CONNECT|SOCKS5|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timeout/i.test(msg)) {
        entry.lastError = msg;
        POOL.markDown(entry, CFG.proxyCooldown * 1000);
      }
      if (attempt === CFG.retries) {
        const cut = Date.now() >= HARD_DEADLINE;
        return { ok: false, cut, status: 0, ms: performance.now() - t0, model, proxy: entry.url, error: cut ? 'cut by --duration' : msg, attempts: attempt + 1 };
      }
    } finally {
      entry.inflight--;
    }
    await sleep(Math.min(30000, 2 ** attempt * 500 + Math.random() * 250));
  }
  return { ok: false, status: lastStatus, model: lastModel, error: String(lastErr?.message || lastErr), attempts: CFG.retries + 1 };
}

/* ══════════════════════════════════════════════════════ 连接预热 */
async function warmup() {
  const n = Math.max(0, CFG.warmup);
  if (!n) return;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: n }, (_, i) => {
    const entry = POOL.entries[i % POOL.entries.length];
    return new Promise((resolve) => {
      const req = https.request(
        { host: HOST, port: PORT, path: '/inference/v1/models', method: 'GET', agent: entry.agent, headers: { authorization: 'Bearer public', 'user-agent': 'opencode/1.19.2' } },
        (res) => { res.resume(); res.once('end', resolve); },
      );
      req.once('error', resolve);
      req.setTimeout(15000, () => { req.destroy(); resolve(); });
      req.end();
    });
  }));
  console.log(`  连接预热 ${n} 条 / ${POOL.entries.length} 个出口（${(performance.now() - t0).toFixed(0)} ms）`);
}

/* ══════════════════════════════════════════════════════════ 统计 */
function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0; }

function summary(results, wall, label = '结果') {
  const cut = results.filter((r) => r.cut);
  const counted = results.filter((r) => !r.cut);
  const ok = counted.filter((r) => r.ok);
  const bad = counted.filter((r) => !r.ok);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const ttfts = ok.map((r) => r.ttft).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const inTok = ok.reduce((s, r) => s + (r.usage?.prompt_tokens || 0), 0);
  const outTok = ok.reduce((s, r) => s + (r.usage?.completion_tokens || 0), 0);

  console.log(`\n────── ${label} ──────`);
  console.log(`成功      ${ok.length}/${counted.length}  (${counted.length ? ((ok.length / counted.length) * 100).toFixed(2) : '0.00'}%)`);
  if (cut.length) console.log(`截止切断  ${cut.length}  (--duration 到点，未计入成败)`);
  if (bad.length) {
    const kinds = {};
    for (const r of bad) {
      const k = r.status === 0 ? 'network' : `HTTP ${r.status}` + (/FreeTierError/.test(r.error || '') ? ' FreeTierError' : /rate/i.test(r.error || '') ? ' quota/rate' : '');
      kinds[k] = (kinds[k] || 0) + 1;
    }
    console.log(`失败      ${bad.length}  ${JSON.stringify(kinds)}`);
  }
  console.log(`总耗时    ${(wall / 1000).toFixed(2)} s   ·   吞吐 ${(counted.length / (wall / 1000)).toFixed(2)} req/s`);
  if (lat.length) console.log(`延迟      p50 ${pct(lat, 50).toFixed(0)}ms · p90 ${pct(lat, 90).toFixed(0)}ms · p99 ${pct(lat, 99).toFixed(0)}ms · max ${lat[lat.length - 1].toFixed(0)}ms`);
  if (ttfts.length) console.log(`首字      p50 ${pct(ttfts, 50).toFixed(0)}ms · p90 ${pct(ttfts, 90).toFixed(0)}ms`);
  if (outTok) console.log(`token     输入 ${inTok} · 输出 ${outTok} · 输出速率 ${(outTok / (wall / 1000)).toFixed(1)} tok/s`);
  if (CFG.models.length > 1) console.log('按模型    ' + [...MODEL_STATE.entries()].map(([m, s]) => `${m}: ${s.ok}✓/${s.fail}✗`).join('  '));
  if (POOL.entries.length > 1) console.log('按出口    ' + POOL.entries.map((e) => `${e.url}: ${e.ok}✓/${e.fail}✗${e.downUntil > Date.now() ? '(冷却中)' : ''}`).join('  '));
}

/* ══════════════════════════════════════════════════════════ main */
let STOP = false;
process.on('SIGINT', () => { STOP = true; console.log('\n收到中断，正在收尾…'); });

async function main() {
  let prompts;
  if (CFG.promptsFile) prompts = fs.readFileSync(CFG.promptsFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  else if (typeof CFG.prompt === 'string') prompts = [CFG.prompt];
  else prompts = ['Reply with exactly one word: PONG'];
  if (!prompts.length) prompts = ['hi'];

  const jsonl = CFG.jsonl ? fs.createWriteStream(CFG.jsonl, { flags: 'a' }) : null;
  const results = [];
  const t0 = performance.now();
  const startedAt = Date.now();
  let deadline = Infinity;
  let cursor = 0;

  if (!CFG.once) {
    console.log(`→ ${HOST}${REQ_PATH}`);
    console.log(`  模型 ${CFG.models.join(', ')}`);
    console.log(`  出口 ${POOL.entries.map((e) => e.url).join(', ')}`);
    console.log(`  并发 ${CFG.concurrency} · ${CFG.duration ? `持续 ${CFG.duration}s` : `请求 ${CFG.total}`} · ${CFG.stream ? '流式' : '非流式'}${CFG.rps ? ` · 限速 ${CFG.rps} req/s` : ''}`);
    await warmup();
  }
  if (CFG.duration) { deadline = Date.now() + CFG.duration * 1000; HARD_DEADLINE = deadline; }

  const progress = CFG.duration && !CFG.once
    ? setInterval(() => {
        const ok = results.filter((r) => r.ok).length;
        const el = (performance.now() - t0) / 1000;
        const dead = CFG.models.filter((m) => modelStat(m).until > Date.now());
        console.log(`  [${el.toFixed(0)}s] 完成 ${results.length} · 成功 ${ok} · ${(results.length / el).toFixed(2)} req/s${dead.length ? ` · 熔断 ${dead.length}/${CFG.models.length}` : ''}`);
      }, 10000)
    : null;

  async function worker(workerId) {
    while (!STOP) {
      const i = cursor++;
      if (CFG.duration) { if (Date.now() >= deadline) return; }
      else if (i >= CFG.total) return;

      // 全部模型额度耗尽
      if (allModelsDown()) {
        if (!CFG.waitReset) break;
        const reset = earliestReset();
        console.log(`  [额度] 全部模型耗尽，等待至 ${new Date(reset).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (北京) …`);
        while (!STOP && Date.now() < reset) {
          await sleep(Math.min(5000, Math.max(200, reset - Date.now())));
          if (CFG.duration && Date.now() >= deadline) break;
        }
        continue;
      }

      await rateLimit();
      const t1 = performance.now();
      const r = await callOnce(prompts[i % prompts.length], i + workerId);
      r.index = i;
      r.total = performance.now() - t1;
      results.push(r);
      if (jsonl) jsonl.write(JSON.stringify({ ...r, prompt: prompts[i % prompts.length] }) + '\n');

      if (CFG.once && r.ok) {
        process.stdout.write(r.text + '\n');
        if (r.usage) console.log(`[usage] prompt=${r.usage.prompt_tokens} completion=${r.usage.completion_tokens} total=${r.usage.total_tokens}`);
      } else if (CFG.once) {
        console.log(`[failed] HTTP ${r.status} ${r.error}`);
      } else if (CFG.verbose) {
        console.log(`  #${i} ${r.ok ? '200' : r.status} ${r.ms.toFixed(0)}ms${r.ttft ? ` ttft=${r.ttft.toFixed(0)}ms` : ''} 共${r.total.toFixed(0)}ms×${r.attempts} [${r.model}]${r.ok ? '' : ' :: ' + r.error.slice(0, 100)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CFG.concurrency }, (_, i) => worker(i)));
  const wall = performance.now() - t0;
  if (progress) clearInterval(progress);

  if (CFG.once) { jsonl?.end(); return; }
  summary(results, wall, CFG.duration ? `持续运行 ${(wall / 1000).toFixed(0)}s 汇总` : '结果');
  if (jsonl) { jsonl.end(); console.log(`明细      ${CFG.jsonl}`); }
  const dead = CFG.models.filter((m) => modelStat(m).until > Date.now());
  if (dead.length) {
    console.log(`额度耗尽  ${dead.join(', ')} → 最早 ${new Date(earliestReset()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (北京) 恢复`);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
