/**
 * upstream.mjs — 上游渠道适配层
 *
 * 传输：直连 / HTTP(S) CONNECT / SOCKS5 / SOCKS5H，多节点池 + 健康冷却 + 最少在途选择
 * 渠道：opencode（免费层形状请求） / openai（通用 OpenAI 兼容）
 */
import http from 'node:http';
import * as SESS from './sessions.mjs';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bridge from './bridge.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.join(DIR, 'body_template.json');
// Responses API 用的模板（同一份 agent 结构的 Responses 格式表达：
// instructions = 完整 system prompt，tools = 扁平 Responses 格式）
export const TEMPLATE_RESPONSES_PATH = path.join(DIR, 'body_template_responses.json');

/* ══════════════════════════════════════════════════ 请求体模板 */
let TEMPLATE = null;
export function loadTemplate(force = false) {
  if (!TEMPLATE || force) TEMPLATE = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  return TEMPLATE;
}

let TEMPLATE_RESP = null;
export function loadTemplateResponses(force = false) {
  if (!TEMPLATE_RESP || force) TEMPLATE_RESP = JSON.parse(fs.readFileSync(TEMPLATE_RESPONSES_PATH, 'utf8'));
  return TEMPLATE_RESP;
}

export function templateInfo() {
  const t = loadTemplate();
  const sys = (t.messages || []).filter((m) => m.role === 'system');
  return {
    bytes: fs.statSync(TEMPLATE_PATH).size,
    systemChars: sys.reduce((s, m) => s + String(m.content || '').length, 0),
    tools: (t.tools || []).length,
    messages: (t.messages || []).length,
    model: t.model,
    max_tokens: t.max_tokens,
    responsesBytes: fs.existsSync(TEMPLATE_RESPONSES_PATH) ? fs.statSync(TEMPLATE_RESPONSES_PATH).size : 0,
  };
}

/* ══════════════════════════════════════════════════ 代理解析 */
export function parseProxyUrl(raw) {
  const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const proto = u.protocol.replace(':', '');
  if (!['http', 'https', 'socks5', 'socks5h'].includes(proto)) throw new Error(`不支持的代理协议: ${proto}`);
  return {
    raw, protocol: proto, hostname: u.hostname,
    port: Number(u.port || (proto.startsWith('socks') ? 1080 : proto === 'https' ? 443 : 80)),
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
    auth: u.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : null,
  };
}

function httpTunnel(p, target, timeout) {
  return new Promise((resolve, reject) => {
    const req = (p.protocol === 'https' ? https : http).request({
      host: p.hostname, port: p.port, method: 'CONNECT', path: target,
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

function socks5Tunnel(p, target, timeout) {
  const [host, portStr] = target.split(':');
  const port = Number(portStr);
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
      const h = Buffer.from(host, 'utf8');
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
    };
    const methods = p.username ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const method = buf[1]; buf = buf.subarray(2);
        if (method === 0xff) return fail(new Error('SOCKS5 无可用认证方式'));
        if (method === 0x02) {
          const u = Buffer.from(p.username || '', 'utf8');
          const pw = Buffer.from(p.password || '', 'utf8');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]));
          stage = 'auth'; return;
        }
        stage = 'conn'; sendConnect();
      } else if (stage === 'auth') {
        if (buf.length < 2) return;
        const ok = buf[1] === 0x00; buf = buf.subarray(2);
        if (!ok) return fail(new Error('SOCKS5 认证失败'));
        stage = 'conn'; sendConnect();
      } else {
        if (buf.length < 4) return;
        const rep = buf[1], atyp = buf[3];
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

class ProxyAgent extends https.Agent {
  constructor(cfg, hostname, timeout) {
    super({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64, maxFreeSockets: 32, scheduling: 'lifo', timeout: 60000 });
    this._cfg = cfg; this._host = hostname; this._timeout = timeout;
  }
  createConnection(_options, cb) {
    const p = this._cfg;
    const target = `${this._host}:443`;
    const connect = p.protocol.startsWith('socks') ? socks5Tunnel(p, target, this._timeout) : httpTunnel(p, target, this._timeout);
    connect.then(
      (raw) => {
        const s = tls.connect({ socket: raw, servername: this._host, ALPNProtocols: ['http/1.1'] });
        s.once('secureConnect', () => { s.setNoDelay(true); cb(null, s); });
        s.once('error', cb);
      },
      (e) => cb(e),
    );
  }
}

const directAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64, maxFreeSockets: 32, scheduling: 'lifo', timeout: 60000 });
const agentCache = new Map();
function getAgent(proxyRaw, hostname, timeout) {
  if (!proxyRaw) return directAgent;
  const key = `${proxyRaw}||${hostname}`;
  let a = agentCache.get(key);
  if (!a) { a = new ProxyAgent(parseProxyUrl(proxyRaw), hostname, timeout); agentCache.set(key, a); }
  return a;
}

/* ══════════════════════════════════════════════════ 代理健康状态 */
export const PROXY_STATE = new Map();
function proxyStat(raw) {
  let s = PROXY_STATE.get(raw);
  if (!s) { s = { url: raw, downUntil: 0, inflight: 0, ok: 0, fail: 0, lastError: null }; PROXY_STATE.set(raw, s); }
  return s;
}
export function pickProxy(spec) {
  const list = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return { raw: null, stat: proxyStat('__direct__') };
  const now = Date.now();
  const healthy = list.filter((u) => proxyStat(u).downUntil <= now);
  const pool = healthy.length ? healthy : list;
  let best = pool[0];
  for (const u of pool) if (proxyStat(u).inflight < proxyStat(best).inflight) best = u;
  return { raw: best, stat: proxyStat(best) };
}
export function markProxyDown(raw, ms, err) {
  if (!raw) return;
  const s = proxyStat(raw);
  s.downUntil = Date.now() + ms;
  s.fail++;
  s.lastError = err ? String(err).slice(0, 200) : s.lastError;
}
export function markProxyOk(raw) { if (raw) { const s = proxyStat(raw); s.ok++; s.lastError = null; } }

/* ══════════════════════════════════════════════════ id 生成 */
const HEX = '0123456789abcdef';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function randFrom(alphabet, n) {
  const b = crypto.randomBytes(n * 2);
  let o = '';
  for (let i = 0; i < n; i++) o += alphabet[b[i] % alphabet.length];
  return o;
}
const randHex = (n) => randFrom(HEX, n);
/** session 形状 id：12 hex，低 12 位 ∈ [0xfc0,0xfff]（真实客户端恒 0xffe）+ 14 位 base62 */
export const makeSessionId = () => `ses_${randHex(9)}ffe${randFrom(B62, 14)}`;
export const makeMsgId = () => `msg_${randHex(12)}${randFrom(B62, 14)}`;
export const makeTokenKey = () => `sk-oc-${randFrom(B62, 40)}`;

/* ── 免费层门禁的「read 工具」要求（2026-10-17 实测钉死）─────────────
 * 04-门禁判别实验 的隔离实验结论：门禁**不校验 system prompt 的长度或内容**
 * （200 字符也能过），真正的判据是：
 *
 *     tools 里必须存在一个 function.name === "read" 的工具（**区分大小写**）
 *
 *   · 只有 read 一个工具（手搓、空参数）      → 200，body 仅 348 字符，prompt_tokens 279
 *   · 只有 bash / 只有 write                  → 403
 *   · 12 个工具里去掉 read                     → 403
 *   · 去掉 bash / write / edit / glob / grep / question → 都仍然 200
 *   · 真 read 改名成 readx / 写成大写 Read     → 403
 *
 * 所以这里无条件保证出站请求带上它 —— 调用方把 tools 清空也不会 403。
 */
export const READ_TOOL_CHAT = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file from the local filesystem.',
    parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
  },
};
export const READ_TOOL_RESPONSES = {
  type: 'function',
  name: 'read',
  description: 'Read a file from the local filesystem.',
  parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
};

/** chat 格式：确保 tools 里有 name === 'read' */
export function ensureReadTool(tools) {
  const arr = Array.isArray(tools) ? tools : [];
  return arr.some((t) => t && t.function && t.function.name === 'read') ? arr : [...arr, READ_TOOL_CHAT];
}
/** responses 格式（扁平）：确保 tools 里有 name === 'read' */
export function ensureReadToolResponses(tools) {
  const arr = Array.isArray(tools) ? tools : [];
  return arr.some((t) => t && t.name === 'read') ? arr : [...arr, READ_TOOL_RESPONSES];
}

/** 按名字合并工具，去重（base 优先）。
 *  上游对重名工具会直接 400，所以调用方发来与模板同名的工具时必须跳过。 */
export function mergeTools(base, extra, flat = false) {
  const out = Array.isArray(base) ? [...base] : [];
  const seen = new Set(out.map((t) => (flat ? t && t.name : t && t.function && t.function.name)).filter(Boolean));
  for (const x of (Array.isArray(extra) ? extra : [])) {
    const n = flat ? x && x.name : x && x.function && x.function.name;
    if (n && seen.has(n)) continue;
    out.push(x);
    if (n) seen.add(n);
  }
  return out;
}

/* 请求体模式：
 *   full（默认）—— 完整 OpenCode agent 结构，≈9,600 prompt tokens/次，与真实客户端最接近
 *   minimal     —— 只发「调用方的 messages + 一个 read 工具」，≈280 prompt tokens/次（省 97%）
 * 两者都实测 200。可用 PANEL_BODY_MODE=minimal 或渠道 extra.body_mode 切换。
 * 网关场景推荐 minimal：既省共享每日额度，又不会用 opencode 的 system prompt 污染客户端的提示词。
 */
export function bodyMode(channel) {
  const m = (channel && channel.extra && channel.extra.body_mode) || process.env.PANEL_BODY_MODE || 'full';
  return m === 'minimal' ? 'minimal' : 'full';
}

/**
 * 工具注入模式。**这个直接决定「客户端能不能用工具」。**
 *
 * 背景：opencode 渠道的请求体模板里带着 OpenCode 自己的 12 个工具
 * （bash / edit / glob / grep / question / read / skill / task /
 *   todowrite / webfetch / websearch / write）。
 * 如果无条件把它们和客户端自己的工具合并，模型会看到 12 + N 个工具，
 * 于是很可能去调 read / bash / edit —— 而**客户端如果不是 OpenCode，
 * 根本不认识这些工具**，工具调用就失败（或客户端报「未知工具」）。
 *
 * 三种模式：
 *   client   （默认）客户端给了 tools 就**只用客户端的**（再补一个 read 满足门禁）；
 *            客户端没给才用模板的 → 非 OpenCode 客户端也能正常调工具
 *   merge    模板 + 客户端合并（旧行为，只有客户端就是 OpenCode 时才合适）
 *   template 只用模板的（调试用）
 *
 * 可用 PANEL_TOOL_MODE 或渠道 extra.tool_mode 覆盖。
 */
export function toolMode(channel) {
  const m = (channel && channel.extra && channel.extra.tool_mode) || process.env.PANEL_TOOL_MODE || 'client';
  return ['client', 'merge', 'template'].includes(m) ? m : 'client';
}

/* ══════════════════════════════════════════════════ 请求构造 */
export const UA_OPENCODE = 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24';

/* ── user-agent 门禁自检 ────────────────────────────────────────
 * 上游对 UA 有**两条**实测判据（见 04-门禁判别实验/verify_recipe4.mjs、verify_recipe5.mjs）：
 *   1) 必须匹配 ^opencode/v?<版本>（大小写不敏感，版本至少两段）—— 否则 403 FreeTierError
 *   2) 版本必须 ≥ 1.18.0 —— 否则返回 **426**（不是 403）
 * 渠道可以用 extra.ua 覆盖 UA。这里提前判出来，避免只看到一个莫名其妙的 426。
 */
export const MIN_OPENCODE_UA_VERSION = [1, 18, 0];

export function parseOpenCodeUaVersion(ua) {
  const m = /^\s*opencode\/v?(\d+(?:\.\d+)*)/i.exec(String(ua == null ? '' : ua));
  if (!m) return null;
  const parts = m[1].split('.').map(Number);
  // 单段版本（opencode/2）实测过不了版本门禁，会落回 403
  if (parts.length < 2) return null;
  return parts;
}

/** 返回 null = 没问题；否则返回人类可读的问题描述 */
export function checkOpenCodeUa(ua) {
  const v = parseOpenCodeUaVersion(ua);
  if (!v) {
    return 'user-agent 形状不符：必须以 opencode/<版本> 开头（大小写不敏感，版本至少两段，如 1.19.2）；'
         + '否则上游返回 403 FreeTierError。';
  }
  const [a = 0, b = 0, c = 0] = v;
  const [ma, mb, mc] = MIN_OPENCODE_UA_VERSION;
  const older = a < ma || (a === ma && (b < mb || (b === mb && c < mc)));
  if (older) {
    return `user-agent 版本 ${v.join('.')} 低于上游要求的 ${MIN_OPENCODE_UA_VERSION.join('.')}，`
         + `上游会返回 426。请改用「${UA_OPENCODE}」或更高版本。`;
  }
  return null;
}

const _uaWarned = new Set();

/* opencode 渠道的公共请求头（chat/completions 与 responses 共用） */
export function openCodeHeaders(channel) {
  /* session 来源：优先用会话池里配好的真实会话（配置文件 + 面板管理），
   * 池子空才退回随机生成 —— 随机的一定过不了门禁（实测 403），
   * 所以会在启动时自动从本机 OpenCode 导入，见 sessions.mjs。 */
  const sid = SESS.current() || makeSessionId();
  const ua = (channel.extra && channel.extra.ua) || UA_OPENCODE;
  const uaProblem = checkOpenCodeUa(ua);
  if (uaProblem && !_uaWarned.has(ua)) {
    _uaWarned.add(ua);
    console.warn(`[upstream] 渠道「${channel.name || channel.id}」自定义 UA 有问题：${uaProblem}`);
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${channel.api_key || 'public'}`,
    'user-agent': ua,
    'x-opencode-client': 'desktop',
    'x-opencode-project': 'global',
    'x-opencode-request': makeMsgId(),
    'x-opencode-session': sid,
    'x-opencode-session-id': sid,
  };
}

export function buildOpenCodeRequest(channel, req) {
  const t = loadTemplate();
  const sys = (t.messages || []).filter((m) => m.role === 'system');
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  const clientSys = msgs.filter((m) => m.role === 'system');
  const rest = msgs.filter((m) => m.role !== 'system');

  const minimal = bodyMode(channel) === 'minimal';
  const body = minimal ? {} : { ...t };
  body.model = req.model;
  body.max_tokens = req.max_tokens || t.max_tokens || 32000;
  // minimal 模式不注入 opencode 的 system prompt，只保留调用方自己的
  body.messages = minimal ? [...clientSys, ...rest] : [...sys, ...clientSys, ...rest];
  /* tools 组装：按 toolMode 决定注入多少。
   * 门禁硬要求 tools 里必须有 function.name === "read"，所以最后总要 ensureReadTool。
   * 上游对重名工具会 400，所以按名字去重。 */
  const tm = toolMode(channel);
  const clientTools = Array.isArray(req.tools) ? req.tools : [];
  let toolList;
  if (tm === 'template') {
    toolList = mergeTools(t.tools || [], []);
  } else if (tm === 'merge') {
    toolList = mergeTools(minimal ? [] : (t.tools || []), clientTools);
  } else {
    // client：客户端给了就只用客户端的；没给才退回模板
    toolList = clientTools.length ? mergeTools([], clientTools) : mergeTools(minimal ? [] : (t.tools || []), []);
  }
  body.tools = ensureReadTool(toolList);
  body.tool_choice = req.tool_choice || 'auto';
  body.stream = !!req.stream;
  if (req.stream) body.stream_options = { include_usage: true };
  else delete body.stream_options;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  /* 思考强度透传：客户端按目录里的 reasoning_efforts 传 low/medium/high */
  if (req.reasoning_effort !== undefined && req.reasoning_effort !== null) {
    body.reasoning_effort = req.reasoning_effort;
  }

  return {
    url: channel.base_url || 'https://opencode.ai/inference/v1/chat/completions',
    headers: openCodeHeaders(channel),
    body,
  };
}

/**
 * 把渠道的 base_url 推成 Responses 端点。
 * 渠道里通常填的是 `.../chat/completions`（面板 UI 的默认），
 * 这里换成 `.../responses`；填的是目录就补上 `/responses`。
 */
export function responsesUrl(channel) {
  const b = channel.base_url || 'https://opencode.ai/inference/v1/chat/completions';
  if (/\/chat\/completions\/?$/.test(b)) return b.replace(/\/chat\/completions\/?$/, '/responses');
  if (/\/responses\/?$/.test(b)) return b;
  return b.replace(/\/+$/, '') + '/responses';
}

/**
 * 构造 Responses API 请求（供 /v1/responses 用）。
 *
 * 为什么需要它：免费层门禁在 **两条协议上都要求完整 agent 结构**——
 * /chat/completions 要 system+tools 的 chat body，
 * /responses 要 `instructions`（完整 system prompt）+ 扁平 `tools`。
 * 而且**模型是按协议绑定的**：
 *   deepseek-v4.1-flash-free / space-bunny-free → 只支持 chat
 *   muse-spark-1.3-contributor-free            → 只支持 responses
 * 所以想用 muse-spark 就必须走这条路径。
 *
 * 实测：完整 Responses agent body + muse-spark → HTTP 200（SSE）。
 */
export function buildOpenCodeResponsesRequest(channel, req) {
  const t = loadTemplateResponses();
  const minimal = bodyMode(channel) === 'minimal';
  const body = minimal ? {} : { ...t };
  body.model = req.model;

  // instructions：full 模式用模板的（opencode system prompt）+ 调用方自己的；
  //               minimal 模式只用调用方自己的（门禁不校验它）
  const extraInstr = typeof req.instructions === 'string' && req.instructions.trim() ? req.instructions : '';
  if (minimal) {
    if (extraInstr) body.instructions = extraInstr;
  } else {
    body.instructions = extraInstr ? `${t.instructions}\n\n${extraInstr}` : t.instructions;
  }

  // input：优先用调用方的；若给的是 chat 格式 messages 则转成 Responses input
  let input = Array.isArray(req.input) ? req.input : null;
  if (!input && Array.isArray(req.messages)) {
    input = req.messages.filter((m) => m.role !== 'system').map((m) => ({
      type: 'message',
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string'
        ? [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }]
        : m.content,
    }));
  }
  if (input && input.length) body.input = input;
  else if (!minimal) delete body.input;

  // tools：保留模板的 12 个（门禁要 read 在里面），额外追加调用方合法的 function 工具
  const extraTools = (Array.isArray(req.tools) ? req.tools : []).filter((x) => {
    if (!x || typeof x !== 'object') return false;
    const name = x.name || (x.function && x.function.name);
    const params = x.parameters || (x.function && x.function.parameters);
    return (x.type === 'function' || x.function) && name && params;
  }).map((x) => ({
    type: 'function',
    name: x.name || x.function.name,
    description: x.description || x.function.description || '',
    parameters: x.parameters || x.function.parameters,
  }));
  /* tools 组装：和 chat 路径用同一套 toolMode 规则。
   * 旧行为（无条件合并模板 12 个工具）会让非 OpenCode 客户端拿到一堆
   * 它不认识的工具，模型去调 read/bash 就失败。 */
  const tm = toolMode(channel);
  const tmplTools = minimal ? [] : (t.tools || []);
  let baseTools, addTools;
  if (tm === 'template') {
    baseTools = tmplTools; addTools = [];
  } else if (tm === 'merge') {
    baseTools = tmplTools; addTools = extraTools;
  } else {
    // client：客户端给了就只用客户端的，没给才退回模板
    baseTools = extraTools.length ? [] : tmplTools;
    addTools = extraTools;
  }
  // 强制保证有 read（门禁硬要求，区分大小写），并按名字去重（上游对重名工具会 400）
  body.tools = ensureReadToolResponses(mergeTools(baseTools, addTools, true));

  body.tool_choice = req.tool_choice || 'auto';
  body.stream = true;            // 门禁要求；Responses 也必须流式
  body.store = false;
  // 注意：Responses API 不接受 max_tokens，只接受 max_output_tokens
  if (req.max_output_tokens) body.max_output_tokens = req.max_output_tokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  /* 思考强度：Responses 协议用 reasoning.effort */
  if (req.reasoning !== undefined) body.reasoning = req.reasoning;
  else if (req.reasoning_effort !== undefined && req.reasoning_effort !== null) {
    body.reasoning = { effort: req.reasoning_effort };
  }

  return { url: responsesUrl(channel), headers: openCodeHeaders(channel), body };
}


/**
 * 把渠道里填的 base_url 归一成「目录形式」，再拼目标端点。
 *
 * 为什么需要：面板输入框提示用户填**完整地址**（`.../v1/chat/completions`），
 * 但早期代码是无条件 `${base}/chat/completions`，于是拼成
 * `.../v1/chat/completions/chat/completions` —— 上游回 404/HTML，
 * 而且报错看起来像上游挂了，完全看不出是路径重复（实测踩过，查了很久）。
 *
 * 现在两种填法都接受：
 *   https://api.x.com/v1/chat/completions  -> 目录 https://api.x.com/v1
 *   https://api.x.com/v1/responses         -> 目录 https://api.x.com/v1
 *   https://api.x.com/v1                   -> 目录 https://api.x.com/v1
 *   https://api.x.com                      -> 目录 https://api.x.com
 */
const ENDPOINT_SUFFIX = /\/+(chat\/completions|responses|completions)\/?$/i;
export function baseUrlOf(channel) {
  const raw = String((channel && channel.base_url) || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(ENDPOINT_SUFFIX, '');
}

/** 拼出目标端点：target = 'chat' | 'responses'；已经是对应端点则原样保留 */
export function endpointUrl(channel, target, fallback) {
  const base = baseUrlOf(channel) || fallback;
  if (!base) return '';
  return base + '/' + (target === 'responses' ? 'responses' : 'chat/completions');
}

export function buildOpenAIRequest(channel, req) {
  const body = {
    model: req.model,
    messages: req.messages || [],
    stream: !!req.stream,
  };
  for (const k of ['max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'response_format', 'stream_options']) {
    if (req[k] !== undefined) body[k] = req[k];
  }
  if (req.stream && body.stream_options === undefined) body.stream_options = { include_usage: true };
  const headers = { 'content-type': 'application/json' };
  if (channel.api_key) headers.authorization = `Bearer ${channel.api_key}`;
  if (channel.extra && channel.extra.headers) Object.assign(headers, channel.extra.headers);
  return { url: endpointUrl(channel, 'chat', 'https://api.openai.com/v1'), headers, body };
}

export function buildRequest(channel, req) {
  return channel.type === 'openai' ? buildOpenAIRequest(channel, req) : buildOpenCodeRequest(channel, req);
}

/** Responses 协议的渠道路由：openai 渠道走原生 /responses，opencode 渠道注入 agent 结构 */
export function buildResponsesRequest(channel, req) {
  if (channel.type === 'openai') {
    const body = { ...req, model: req.model, stream: true, store: false };
    const headers = { 'content-type': 'application/json' };
    if (channel.api_key) headers.authorization = `Bearer ${channel.api_key}`;
    if (channel.extra && channel.extra.headers) Object.assign(headers, channel.extra.headers);
    return { url: endpointUrl(channel, 'responses', 'https://api.openai.com/v1'), headers, body };
  }
  return buildOpenCodeResponsesRequest(channel, req);
}

/**
 * 桥接请求：客户端协议与模型原生协议不一致时用。
 *
 *   target='responses' —— 客户端发的是 chat，模型只支持 responses（如 muse-spark）
 *   target='chat'      —— 客户端发的是 responses，模型只支持 chat（如 deepseek）
 *
 * 转换后**仍然**要满足门禁（tools 里要有 read），所以这里会补上。
 */
export function buildBridgedRequest(channel, req, target) {
  if (channel.type !== 'opencode') {
    // 通用 OpenAI 兼容渠道：直接换成目标端点，不做 opencode 特化
    const headers = { 'content-type': 'application/json' };
    if (channel.api_key) headers.authorization = `Bearer ${channel.api_key}`;
    if (channel.extra && channel.extra.headers) Object.assign(headers, channel.extra.headers);
    const url = endpointUrl(channel, target, 'https://api.openai.com/v1');
    if (target === 'responses') {
      return { url, headers, body: { ...bridge.chatToResponses(req), stream: true, store: false } };
    }
    return { url, headers, body: { ...bridge.responsesToChat(req), stream: true } };
  }

  if (target === 'responses') {
    const body = bridge.chatToResponses(req);
    body.stream = true;                       // 门禁要求
    body.store = false;
    if (body.tools) body.tools = ensureReadToolResponses(body.tools);
    else body.tools = [READ_TOOL_RESPONSES];
    return { url: responsesUrl(channel), headers: openCodeHeaders(channel), body };
  }

  const body = bridge.responsesToChat(req);
  body.stream = true;                          // 门禁要求
  body.tools = ensureReadTool(body.tools);     // 门禁要求 tools 里有 read
  return {
    url: channel.base_url || 'https://opencode.ai/inference/v1/chat/completions',
    headers: openCodeHeaders(channel),
    body,
  };
}

/* ══════════════════════════════════════════════════ 发起请求 */
/* ══════════════════════════════════════════════════ 并发闸门
 * 为什么需要：
 *   免费层上游对并发极其敏感 —— 实测 10 并发就全部 403
 *   （OpenCode's free models aren't available ... abusive traffic）。
 *   50 并发直接打崩：既触发上游封禁，又把网关自己的连接/内存打满。
 *
 * 做法：
 *   同时最多放行 PANEL_MAX_CONCURRENCY 个上游请求（默认 2），
 *   其余排队；排队超时（PANEL_QUEUE_TIMEOUT_MS，默认 120s）明确拒绝，
 *   而不是无脑并发把上游打死。
 */
/**
 * 每个渠道独立的并发上限。
 *   opencode 免费层：默认 2（上游对并发极敏感，10 并发就全 403）
 *   其它渠道（tokenharhur / workbuddy 等有配额的上游）：默认 32，可调
 * 渠道可以用 extra.max_concurrency 单独指定，0 表示不限。
 */
function limitFor(channel) {
  const extra = (channel && channel.extra) || {};
  if (extra.max_concurrency !== undefined && extra.max_concurrency !== null && extra.max_concurrency !== '') {
    const v = Number(extra.max_concurrency);
    if (Number.isFinite(v) && v >= 0) return v;          // 0 = 不限
  }
  const isFree = channel && channel.type === 'opencode';
  const envKey = isFree ? 'PANEL_MAX_CONCURRENCY_FREE' : 'PANEL_MAX_CONCURRENCY';
  const fallback = isFree ? 2 : 32;
  const v = Number(process.env[envKey] || fallback);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const QUEUE_TIMEOUT_MS = Math.max(1000, Number(process.env.PANEL_QUEUE_TIMEOUT_MS || 120000));

/* 每个渠道一个闸门：key = 渠道 id，没有 id 就用 type */
const GATES = new Map();
function gateOf(key, limit) {
  let g = GATES.get(key);
  if (!g || g.limit !== limit) {
    g = { limit, active: 0, waiters: [] };
    GATES.set(key, g);
  }
  return g;
}

export function gateStats() {
  const out = {};
  for (const [k, g] of GATES) out[k] = { active: g.active, queued: g.waiters.length, max: g.limit };
  return out;
}

function acquireSlot(g) {
  if (g.limit === 0) return Promise.resolve(() => {});          // 0 = 不限
  if (g.active < g.limit) {
    g.active++;
    return Promise.resolve(() => releaseSlot(g));
  }
  return new Promise((resolve, reject) => {
    const w = { resolve, reject, timer: null };
    w.timer = setTimeout(() => {
      const i = g.waiters.indexOf(w);
      if (i >= 0) g.waiters.splice(i, 1);
      const e = new Error('该渠道并发已满（上限 ' + g.limit + '），排队 ' + Math.round(QUEUE_TIMEOUT_MS / 1000) + 's 仍无空位。请降低并发或稍后重试。');
      e.code = 'QUEUE_TIMEOUT';
      reject(e);
    }, QUEUE_TIMEOUT_MS);
    if (typeof w.timer.unref === 'function') w.timer.unref();
    g.waiters.push(w);
  });
}

function releaseSlot(g) {
  const w = g.waiters.shift();
  if (w) {
    clearTimeout(w.timer);
    w.resolve(() => releaseSlot(g));      // 名额直接转交
  } else {
    g.active = Math.max(0, g.active - 1);
  }
}

/* 对外仍是 request()，内部先排队拿名额 */
export async function request(opts) {
  const ch = opts && opts.channel;
  const key = ch ? (ch.id != null ? 'ch:' + ch.id : 'type:' + ch.type) : 'default';
  const g = gateOf(key, limitFor(ch));
  const release = await acquireSlot(g);
  try {
    return await requestInner(opts);
  } finally {
    release();
  }
}

function requestInner({ url, headers, body, proxy, timeout = 300000, method = 'POST' }) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const { raw, stat } = pickProxy(proxy);
  const agent = isHttps ? getAgent(raw, u.hostname, Math.min(timeout, 60000)) : undefined;
  const mod = isHttps ? https : http;
  stat.inflight++;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; stat.inflight--; fn(arg); } };
    const req = mod.request({
      host: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method, headers,
      agent, servername: isHttps ? u.hostname : undefined,
    }, (res) => {
      done(resolve, { res, req, proxy: raw, t0: Date.now() });
    });
    req.once('error', (e) => {
      stat.lastError = String(e.message).slice(0, 200);
      if (/CONNECT|SOCKS5|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timeout|EPIPE|ENOTFOUND/i.test(String(e.message))) markProxyDown(raw, 60000, e.message);
      done(reject, e);
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`upstream timeout ${timeout}ms`)));
    // 必须一次性 end(payload)：先 write() 再 end() 会让 Node 走 Transfer-Encoding: chunked，
    // 而免费层门禁要求 Content-Length 的定长请求。
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    req.end(payload);
  });
}

/* ══════════════════════════════════════════════════ 渠道模型列表 */
export function channelModels(channel) {
  try {
    const m = JSON.parse(channel.models || '[]');
    return Array.isArray(m) ? m : [];
  } catch { return []; }
}

/** 探测渠道可用性（发一个最小但形状完整的请求，仅取 HTTP 状态）
 *  注意：opencode 免费层门禁要求 body.stream === true，所以探测也必须走流式。 */
/**
 * 探测某个模型支持哪个协议（chat / responses）。
 *
 * 用途：免费层的模型**按协议绑定**——用错协议上游返回
 * `400 Model does not support this protocol.`。
 * 探测用**最小 body**（只带一个 read 工具），每次成功约 300 prompt tokens，
 * 而不是完整 agent body 的 9,600。
 *
 * 走 `request()`，所以会使用渠道配置的代理，和真实调用同一条链路。
 */
export async function probeModelProtocol(channel, model, timeout = 90000) {
  const headers = openCodeHeaders(channel);
  const PING = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: PONG' }] }];
  const specs = {
    chat: {
      url: channel.base_url || 'https://opencode.ai/inference/v1/chat/completions',
      body: { model, stream: true, max_tokens: 16, tools: [READ_TOOL_CHAT], messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] },
    },
    responses: {
      url: responsesUrl(channel),
      body: { model, stream: true, store: false, tools: [READ_TOOL_RESPONSES], input: PING },
    },
  };

  const run = async (spec) => {
    try {
      const { res } = await request({ url: spec.url, headers, body: spec.body, proxy: channel.proxy, timeout });
      const text = await new Promise((r) => {
        let b = ''; res.setEncoding('utf8');
        res.on('data', (c) => { b += c; });
        res.on('end', () => r(b));
        res.on('error', () => r(b));
      });
      const msg = (text.match(/"message"\s*:\s*"([^"]{0,90})/)?.[1] ?? text.slice(0, 90)).replace(/\s+/g, ' ');
      let verdict = 'other';
      if (res.statusCode === 200) verdict = 'ok';
      else if (/does not support this protocol/i.test(msg)) verdict = 'wrong-protocol';
      else if (/free tier can only be used/i.test(msg)) verdict = 'gate-403';
      else if (res.statusCode === 429) verdict = 'quota';
      else if (/region/i.test(msg)) verdict = 'region';
      return { status: res.statusCode, verdict, note: msg };
    } catch (e) {
      return { status: 0, verdict: 'error', note: String((e && e.message) || e) };
    }
  };

  const chat = await run(specs.chat);
  const responses = await run(specs.responses);
  const protocols = [];
  if (chat.verdict === 'ok') protocols.push('chat');
  if (responses.verdict === 'ok') protocols.push('responses');
  return { protocols, detail: { chat, responses } };
}

export async function testChannel(channel, model) {
  const mdl = model || channelModels(channel)[0] || 'deepseek-v4.1-flash-free';
  // opencode 渠道先本地判一次 UA：配置错了会吃 403/426，不如直接告诉用户原因
  if ((channel.base_url || '').includes('opencode.ai') || channel.type === 'opencode') {
    const uaProblem = checkOpenCodeUa((channel.extra && channel.extra.ua) || UA_OPENCODE);
    if (uaProblem) return { ok: false, status: 0, ms: 0, model: mdl, body: uaProblem };
  }
  const { url, headers, body } = buildRequest(channel, {
    model: mdl, stream: true, max_tokens: 16,
    messages: [{ role: 'user', content: 'ping' }],
  });
  const t0 = Date.now();
  try {
    const { res } = await request({ url, headers, body, proxy: channel.proxy, timeout: 90000 });
    const text = await new Promise((resolve) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(b));
      res.on('error', () => resolve(b));
    });
    const ms = Date.now() - t0;
    if (res.statusCode !== 200) return { ok: false, status: res.statusCode, ms, model: mdl, body: text.slice(0, 600) };
    /* 流式响应：把 delta.content 拼出来作为可读回显 */
    let reply = '';
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const p = t.slice(5).trim();
      if (p === '[DONE]') continue;
      try { const o = JSON.parse(p); const c = o.choices?.[0]?.delta?.content; if (typeof c === 'string') reply += c; } catch {}
    }
    return { ok: true, status: 200, ms, model: mdl, body: reply ? `流式 OK，回显: ${reply.slice(0, 200)}` : text.slice(0, 600) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, model: mdl, body: String(e.message || e) };
  }
}
