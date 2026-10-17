/**
 * server.mjs — OpenCode 免费层网关 · 管理面板 + OpenAI 兼容 API
 *
 *   http://127.0.0.1:8790/            管理面板
 *   http://127.0.0.1:8790/v1/...      OpenAI 兼容接口（Bearer <令牌>）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as DB from './db.mjs';
import * as UP from './upstream.mjs';
import * as BR from './bridge.mjs';
import * as POOL from './proxy-pool.mjs';
import * as REG from './model-registry.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PANEL_PORT || 8790);
const HOST = process.env.PANEL_HOST || '127.0.0.1';

DB.ensureDefaults();

/* ══════════════════════════════════════════════════ 模型冷却（内存态） */
const COOLDOWN = new Map();   // `${channelId}:${model}` -> untilMs
// 协议探测作业（异步：慢模型会把整轮拖到几分钟，同步返回必然让客户端超时）
let PROBE_JOB = { running: false, done: 0, total: 0, startedAt: 0, finishedAt: 0, results: [], summary: null };
const cdKey = (c, m) => `${c}:${m}`;
const inCooldown = (c, m) => (COOLDOWN.get(cdKey(c, m)) || 0) > Date.now();
function setCooldown(c, m, ms) { COOLDOWN.set(cdKey(c, m), Date.now() + ms); }
export function cooldownSnapshot() {
  const now = Date.now(), out = [];
  for (const [k, v] of COOLDOWN) if (v > now) out.push({ key: k, until: v, leftMs: v - now });
  return out.sort((a, b) => a.until - b.until);
}

/* ══════════════════════════════════════════════════ 会话 */
function sign(payload) {
  const secret = DB.getSetting('session_secret');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
function makeSession() {
  const p = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return `${p}.${sign(p)}`;
}
function checkSession(cookie) {
  if (!cookie) return false;
  const m = /ocp_session=([^;]+)/.exec(cookie);
  if (!m) return false;
  const [p, s] = m[1].split('.');
  if (!p || !s || sign(p) !== s) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

/* ══════════════════════════════════════════════════ 工具 */
const json = (res, code, obj, extra = {}) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, ...extra });
  res.end(b);
};
const err = (res, code, message, type = 'invalid_request_error') =>
  json(res, code, { error: { message, type, code } });

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const t = await readBody(req);
  if (!t) return {};
  try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { throw new Error('invalid JSON body'); }
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

/* ══════════════════════════════════════════════════ 渠道 / 模型路由 */
function enabledChannels() {
  const now = Date.now();
  return DB.listChannels().filter((c) => c.status === 1 && c.disabled_until <= now);
}
function allModels() {
  const proto = DB.getProtocolMap();
  const out = new Map();
  for (const c of DB.listChannels()) {
    for (const m of effectiveChannelModels(c)) {
      if (!out.has(m)) {
        const p = proto[m];
        out.set(m, {
          id: m,
          owned_by: c.type === 'openai' ? 'openai-compatible' : 'opencode-free',
          // 协议兼容性（由探测写入）。null = 完全没探测过。
          protocols: p ? p.protocols : null,
          notSupported: p ? p.notSupported : null,
          channels: [],
        });
      }
      out.get(m).channels.push({ id: c.id, name: c.name, status: c.status, cooldown: inCooldown(c.id, m) });
    }
  }
  return [...out.values()];
}

/**
 * 渠道**实际可用**的模型列表 = 手配的（剔除已下架且探测不可用的）+ 动态发现可用的。
 * 这样上游增删 free 模型时，下游列表会自动跟着变。
 */
function effectiveChannelModels(c) {
  const manual = UP.channelModels(c);
  if (!REG.enabled() || c.type !== 'opencode') return manual;
  const dyn = REG.usableModelIds();
  if (!dyn.length) return manual;                       // 还没探测过 → 退回手配
  const base = manual.filter((m) => {
    const r = REG.getModel(m);
    if (!r) return true;                                // 完全未知 → 保留
    return !!r.usable || !!r.in_upstream;               // 已下架且不可用 → 剔除
  });
  return [...new Set([...base, ...dyn])];
}
/**
 * 上游请求该走哪个代理。
 *   节点池开启（默认）→ 走池子实例的 mixed-port；
 *   关闭 → 用渠道里配的代理串（向后兼容旧行为）。
 */
function proxyOf(ch) {
  if (POOL.enabled()) return POOL.proxyUrl();
  return ch.proxy || DB.getSetting('default_proxy');
}
/**
 * 模型的**原生**协议。完全没探测过时按 chat 处理（10 个免费模型里 9 个是 chat）。
 */
function nativeProtocols(model) {
  const p = DB.getProtocolMap()[model];
  if (p) {
    if (p.protocols.includes('chat')) return ['chat'];
    if (p.protocols.includes('responses')) return ['responses'];
  }
  // 协议表里没有 → 用**动态发现**的探测结果（新发现的模型走这里）
  const r = REG.enabled() ? REG.getModel(model) : null;
  if (r && r.protocol) return [r.protocol];
  return ['chat'];                       // 都不可用/未知 → 先按 chat 试
}

/**
 * 客户端用 client 协议请求 model 时，该往哪个上游协议发。
 * 原生支持就直接发（不转换）；否则桥接到它的原生协议。
 *
 * 这就是「两种协议互相兼容」的开关：无论 CC Switch 配 openai_chat 还是
 * openai_responses，所有模型都能用 —— 不一致的那部分由 bridge.mjs 转。
 */
function bridgeTarget(model, client) {
  const nat = nativeProtocols(model);
  return nat.includes(client) ? client : nat[0];
}

/** 按行读上游 SSE，便于做协议转换 */
function forEachSseLine(up, onLine, onEnd, onError) {
  let buf = '';
  up.setEncoding('utf8');
  up.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  });
  up.on('end', () => { if (buf) onLine(buf); onEnd(); });
  up.on('error', onError);
}
const readAllOf = (up) => new Promise((r) => {
  let b = ''; up.setEncoding('utf8');
  up.on('data', (c) => { b += c; });
  up.on('end', () => r(b));
  up.on('error', () => r(b));
});

/**
 * 解析出候选 {channel, model} 列表（按优先级）。
 * requested = 'auto' 时展开所有渠道的全部模型（跳过冷却中的、跳过协议不兼容的）。
 * protocol: 'chat' | 'responses' —— 模型按协议绑定，用它筛掉用不了的
 */
function candidates(requested, tokenModels, protocol = null) {
  const allow = new Set(tokenModels && tokenModels.length ? tokenModels : []);
  const chs = enabledChannels();
  const out = [];
  if (requested === 'auto') {
    for (const c of chs) for (const m of effectiveChannelModels(c)) {
      if (allow.size && !allow.has(m)) continue;
      out.push({ ch: c, model: m });
    }
    // 有桥接后所有模型都能用；只是**原生支持当前协议**的优先，少一次转换
    if (protocol) {
      out.sort((a, b) => {
        const na = nativeProtocols(a.model).includes(protocol) ? 0 : 1;
        const nb = nativeProtocols(b.model).includes(protocol) ? 0 : 1;
        return na - nb;
      });
    }
  } else {
    for (const c of chs) for (const m of effectiveChannelModels(c)) {
      if (m === requested) out.push({ ch: c, model: m });
    }
    if (!out.length) {                                  // 未登记模型 → 交给第一个渠道透传
      for (const c of chs) out.push({ ch: c, model: requested });
    }
  }
  const now = Date.now();
  const live = out.filter((x) => !inCooldown(x.ch.id, x.model));
  return live.length ? live : out;
}

/**
 * 只有**两种协议都确认不可用**的模型才拦。单协议不匹配现在已经不是问题 ——
 * bridge.mjs 会在客户端协议与模型原生协议之间互转。
 */
function protocolMismatch(requested, protocol) {
  if (!requested || requested === 'auto') return null;
  const p = DB.getProtocolMap()[requested];
  if (!p) return null;
  if (p.protocols.length) return null;                       // 至少有一种协议可用 → 桥接能搞定
  if (!p.notSupported.includes(protocol)) return null;        // 情况不明 → 放行，让上游回答
  if (!(p.notSupported.includes('chat') && p.notSupported.includes('responses'))) return null;
  return { message: `模型 ${requested} 两种协议都不可用（探测结果：chat↔${p.notSupported.includes('chat') ? '不支持' : '未知'}，responses↔${p.notSupported.includes('responses') ? '不支持' : '未知'}）。` };
}

/* ══════════════════════════════════════════════════ OpenAI 兼容 API */
/** 把上游 SSE 流聚合成一个非流式 chat.completion（免费层门禁强制 body.stream=true） */
function aggregateSSE(up, requested, actualModel) {
  return new Promise((resolve) => {
    let buf = '';
    const acc = { id: null, created: null, content: '', reasoning: '', toolCalls: new Map(), finish: null, usage: null };
    const handleLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const p = t.slice(5).trim();
      if (p === '[DONE]') return;
      let o; try { o = JSON.parse(p); } catch { return; }
      if (o.id) acc.id = o.id;
      if (o.created) acc.created = o.created;
      if (o.usage) acc.usage = o.usage;
      const c = o.choices && o.choices[0];
      if (!c) return;
      if (c.finish_reason) acc.finish = c.finish_reason;
      const d = c.delta || {};
      if (typeof d.content === 'string') acc.content += d.content;
      if (typeof d.reasoning_content === 'string') acc.reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index === undefined ? 0 : tc.index;
          const cur = acc.toolCalls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function && tc.function.name) cur.function.name += tc.function.name;
          if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
          acc.toolCalls.set(idx, cur);
        }
      }
    };
    const finish = () => {
      const message = { role: 'assistant', content: acc.content || null };
      if (acc.reasoning) message.reasoning_content = acc.reasoning;
      if (acc.toolCalls.size) message.tool_calls = [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      const out = {
        id: acc.id || `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: acc.created || Math.floor(Date.now() / 1000),
        model: actualModel || requested,
        choices: [{ index: 0, message, finish_reason: acc.finish || 'stop' }],
      };
      if (acc.usage) out.usage = acc.usage;
      resolve(out);
    };
    up.setEncoding('utf8');
    up.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); handleLine(line); }
    });
    up.on('end', finish);
    up.on('error', finish);
  });
}

async function handleChat(req, res, body, auth) {
  const t0 = Date.now();
  const requested = body.model || 'auto';
  const isStream = !!body.stream;

  if (!body.messages || !Array.isArray(body.messages)) return err(res, 400, 'messages 必须是非空数组');
  if (auth.token && auth.token.models && JSON.parse(auth.token.models || '[]').length) {
    const allow = JSON.parse(auth.token.models);
    if (requested !== 'auto' && !allow.includes(requested)) {
      return err(res, 403, `令牌不允许使用模型 ${requested}`, 'permission_error');
    }
  }

  // 协议不匹配就提前给清楚的错误，别把上游的 400 原样丢回去
  const mm = protocolMismatch(requested, 'chat');
  if (mm) return err(res, 400, mm.message, 'protocol_error');

  /* 请求前：保证有一个已验证可用的代理出口（节点池）。租约满 24h 或验证失败会自动轮换。 */
  if (POOL.enabled()) {
    const pr = await POOL.ensureReady();
    if (!pr.ok) {
      return err(res, 503, `代理节点不可用：${pr.reason}${pr.tried && pr.tried.length ? `（已试 ${pr.tried.length} 个）` : ''}`, 'proxy_unavailable');
    }
  }
  const cands = candidates(requested, auth.token ? JSON.parse(auth.token.models || '[]') : [], 'chat');
  if (!cands.length) return err(res, 503, '没有可用渠道，请先在管理面板添加并启用渠道', 'service_unavailable');

  /* 额度耗尽也切换代理节点：换出口 IP 再试同一个候选。上限由 QUOTA_ROTATE_LIMIT 控制。 */
  const QUOTA_ROTATE_LIMIT = Number(process.env.QUOTA_ROTATE_LIMIT || 3);
  let quotaRotations = 0;
  const maxAttempts = Math.min(cands.length, Number(body.__max_attempts || 4));
  let last = { status: 503, body: 'no channel tried' };

  for (let i = 0; i < maxAttempts; i++) {
    const { ch, model } = cands[i];
    /* 关键：OpenCode 免费层的服务端门禁要求 body.stream === true，非流式会被判 FreeTierError(403)。
       因此 opencode 渠道一律上游走流式；客户端要非流式时在本地把 SSE 聚合成 chat.completion。 */
    const upstreamStream = ch.type === 'openai' ? isStream : true;
    /* 日志里记录真正用到的模型（auto 时展开后的），否则统计里全是 auto */
    const logModel = requested === 'auto' ? model : requested;
    /* 客户端是 chat 协议；模型原生可能是 responses（如 muse-spark）→ 桥过去 */
    const target = bridgeTarget(model, 'chat');
    let built;
    try {
      built = target === 'chat'
        ? UP.buildRequest(ch, { ...body, model, stream: upstreamStream })
        : UP.buildBridgedRequest(ch, { ...body, model }, 'responses');
    }
    catch (e) { last = { status: 500, body: String(e.message) }; continue; }

    let resp;
    try {
      resp = await UP.request({ url: built.url, headers: built.headers, body: built.body, proxy: proxyOf(ch), timeout: 300000 });
    } catch (e) {
      last = { status: 502, body: `上游连接失败: ${e.message}` };
      DB.addLog({ token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name, model: logModel, upstream_model: model, status: 502, ok: 0, stream: isStream, error: last.body, latency_ms: Date.now() - t0, client_ip: clientIp(req) });
      continue;
    }

    const { res: up } = resp;
    const status = up.statusCode;

    if (status !== 200) {
      const text = await new Promise((r) => { let b = ''; up.setEncoding('utf8'); up.on('data', (c) => (b += c)); up.on('end', () => r(b)); up.on('error', () => r(b)); });
      last = { status, body: text };
      if (status === 429) {
        const ra = Number(up.headers['retry-after']);
        const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 24 * 3600e3) : 3600e3;
        setCooldown(ch.id, model, ms);
        /* 额度耗尽也切换出口节点，然后**用新节点重试同一个候选**（i-- 让 for 的 i++ 抵消） */
        if (POOL.enabled() && quotaRotations < QUOTA_ROTATE_LIMIT) {
          quotaRotations++;
          const rot = await POOL.onQuotaExhausted(cands.slice(0, i).map((x) => x.model));
          DB.addLog({ token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name, model: logModel, upstream_model: model, proxy: resp.proxy, status, ok: 0, stream: isStream ? 1 : 0, error: rot.ok ? `额度429 -> 已切换出口到 ${rot.node}（第 ${quotaRotations} 次）` : `额度429 -> 不再切换：${rot.reason}`, latency_ms: Date.now() - t0, client_ip: clientIp(req) });
          if (rot.ok) { i--; continue; }
        }
        DB.addLog({ token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name, model: logModel, upstream_model: model, proxy: resp.proxy, status, ok: 0, stream: isStream, error: 'quota 429 (retry-after ' + (ra || '?') + 's)', latency_ms: Date.now() - t0, client_ip: clientIp(req) });
      } else if (status === 403 || status === 400) {
        setCooldown(ch.id, model, 600e3);
        DB.addLog({ token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name, model: logModel, upstream_model: model, proxy: resp.proxy, status, ok: 0, stream: isStream, error: text.slice(0, 300), latency_ms: Date.now() - t0, client_ip: clientIp(req) });
      } else {
        DB.addLog({ token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name, model: logModel, upstream_model: model, proxy: resp.proxy, status, ok: 0, stream: isStream, error: text.slice(0, 300), latency_ms: Date.now() - t0, client_ip: clientIp(req) });
      }
      continue;
    }

    /* ── 桥接分支：上游是 responses，客户端要 chat ── */
    if (target === 'responses') {
      UP.markProxyOk(resp.proxy);
      if (auth.token) DB.bumpToken(auth.token.id);
      const conv = BR.makeResponsesToChatStream(logModel);
      let firstByteAt = null;
      const done = (usage) => {
        const u = usage || {};
        DB.addLog({
          token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name,
          model: logModel, upstream_model: model, proxy: resp.proxy,
          prompt_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
          completion_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
          latency_ms: Date.now() - t0, ttft_ms: firstByteAt ? firstByteAt - t0 : null,
          status: 200, ok: 1, stream: isStream ? 1 : 0, client_ip: clientIp(req),
        });
      };

      if (isStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        let lastUsage = null;
        forEachSseLine(up,
          (line) => {
            if (firstByteAt === null) firstByteAt = Date.now();
            const o = conv.push(line);
            if (/\busage\b/.test(line)) { try { lastUsage = JSON.parse(line.slice(line.indexOf('data:') + 5)).response?.usage ?? lastUsage; } catch { /* 忽略 */ } }
            if (o) res.write(o);
          },
          () => { res.write(conv.end()); done(lastUsage); res.end(); },
          () => { res.write(conv.end()); done(lastUsage); res.end(); });
      } else {
        let all = '', lastUsage = null;
        forEachSseLine(up,
          (line) => {
            if (firstByteAt === null) firstByteAt = Date.now();
            all += conv.push(line);
          },
          () => {
            all += conv.end();
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(BR.aggregateChatSSE(all, model, requested === 'auto' ? model : requested)));
            done();
          },
          () => {
            all += conv.end();
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(BR.aggregateChatSSE(all, model, requested === 'auto' ? model : requested)));
            done();
          });
      }
      req.on('close', () => { try { up.destroy(); } catch { /* 已断 */ } });
      return;
    }

    /* ── 200：透传 ── */
    UP.markProxyOk(resp.proxy);
    if (auth.token) DB.bumpToken(auth.token.id);
    POOL.onModelSuccess();   // 成功就给当前出口清掉额度记忆

    if (!isStream && upstreamStream) {
      /* 客户端要非流式，但上游必须流式 → 本地聚合 */
      const obj = await aggregateSSE(up, requested, model);
      const u = obj.usage || {};
      DB.addLog({
        token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name,
        model: logModel, upstream_model: model, proxy: resp.proxy,
        prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0,
        latency_ms: Date.now() - t0, status: 200, ok: 1, stream: 0, client_ip: clientIp(req),
      });
      return json(res, 200, obj);
    }

    if (!isStream) {
      const text = await new Promise((r) => { let b = ''; up.setEncoding('utf8'); up.on('data', (c) => (b += c)); up.on('end', () => r(b)); up.on('error', () => r(b)); });
      let obj = null;
      try { obj = JSON.parse(text); } catch {}
      const u = obj?.usage || {};
      DB.addLog({
        token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name,
        model: logModel, upstream_model: model, proxy: resp.proxy,
        prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0,
        latency_ms: Date.now() - t0, status: 200, ok: 1, stream: 0, client_ip: clientIp(req),
      });
      if (obj) { obj.model = requested === 'auto' ? model : requested; return json(res, 200, obj); }
      return json(res, 502, { error: { message: '上游返回非 JSON', type: 'upstream_error' } });
    }

    /* 流式：逐行处理，重写 model、抓 usage */
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let buf = '', usage = null, firstByte = null, outTokens = 0;
    up.setEncoding('utf8');
    up.on('data', (chunk) => {
      if (firstByte === null) firstByte = Date.now();
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const t = line.trim();
        if (!t.startsWith('data:')) { if (t) res.write(line + '\n'); continue; }
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
        try {
          const o = JSON.parse(payload);
          if (o.model) o.model = requested === 'auto' ? model : requested;
          if (o.usage) usage = o.usage;
          const ch2 = o.choices?.[0]?.delta?.content;
          if (typeof ch2 === 'string') outTokens++;
          res.write(`data: ${JSON.stringify(o)}\n\n`);
        } catch { res.write(line + '\n'); }
      }
    });
    const finish = () => {
      const u = usage || {};
      DB.addLog({
        token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name,
        model: logModel, upstream_model: model, proxy: resp.proxy,
        prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || outTokens, total_tokens: u.total_tokens || 0,
        latency_ms: Date.now() - t0, ttft_ms: firstByte ? firstByte - t0 : null,
        status: 200, ok: 1, stream: 1, client_ip: clientIp(req),
      });
      res.end();
    };
    up.on('end', finish);
    up.on('error', (e) => {
      try { res.write(`data: ${JSON.stringify({ error: { message: String(e.message) } })}\n\n`); } catch {}
      finish();
    });
    req.on('close', () => { try { up.destroy(); } catch {} });
    return;
  }

  const msg = (() => { try { return JSON.parse(last.body)?.error?.message || last.body; } catch { return last.body; } })();
  return err(res, last.status === 429 ? 429 : last.status >= 400 ? last.status : 502, `所有候选渠道均失败：${String(msg).slice(0, 400)}`, last.status === 429 ? 'rate_limit_error' : 'upstream_error');
}

/* ══════════════════════════════════════════════════ /v1/responses
 *
 * 为什么需要这条路由：免费层的模型是**按协议绑定**的。
 *   · deepseek-v4.1-flash-free / space-bunny-free / longcat-* → 只支持 /chat/completions
 *   · muse-spark-1.3-contributor-free                          → 只支持 /responses
 * 用 Codex（wire_api = "responses"）+ muse-spark 时，必须让请求走 /responses，
 * 并且 body 里带上**完整 agent 结构**（instructions = 完整 system prompt + 扁平 tools），
 * 否则门禁判 403 FreeTierError。本函数就是做这件事。
 *
 * Responses → Responses 是同协议，所以 SSE 直接透传，不需要像 chat 那样聚合。
 */
async function handleResponses(req, res, body, auth) {
  const t0 = Date.now();
  const requested = body.model || 'auto';
  const wantStream = body.stream !== false;   // 默认流式

  if (!body.input && !body.messages) return err(res, 400, 'input 或 messages 必须有其一');

  if (auth.token && auth.token.models && JSON.parse(auth.token.models || '[]').length) {
    const allow = JSON.parse(auth.token.models);
    if (requested !== 'auto' && !allow.includes(requested)) {
      return err(res, 403, `令牌不允许使用模型 ${requested}`, 'permission_error');
    }
  }

  // 协议不匹配就提前给清楚的错误（muse-spark 只支持 responses；deepseek 等只支持 chat）
  const mm = protocolMismatch(requested, 'responses');
  if (mm) return err(res, 400, mm.message, 'protocol_error');

  /* 请求前：保证有一个已验证可用的代理出口（节点池）。租约满 24h 或验证失败会自动轮换。 */
  if (POOL.enabled()) {
    const pr = await POOL.ensureReady();
    if (!pr.ok) {
      return err(res, 503, `代理节点不可用：${pr.reason}${pr.tried && pr.tried.length ? `（已试 ${pr.tried.length} 个）` : ''}`, 'proxy_unavailable');
    }
  }
  const cands = candidates(requested, auth.token ? JSON.parse(auth.token.models || '[]') : [], 'responses');
  if (!cands.length) return err(res, 503, '没有可用渠道，请先在管理面板添加并启用渠道', 'service_unavailable');

  /* 额度耗尽也切换代理节点：换出口 IP 再试同一个候选。上限由 QUOTA_ROTATE_LIMIT 控制。 */
  const QUOTA_ROTATE_LIMIT = Number(process.env.QUOTA_ROTATE_LIMIT || 3);
  let quotaRotations = 0;
  const maxAttempts = Math.min(cands.length, Number(body.__max_attempts || 4));
  let last = { status: 503, body: 'no channel tried' };

  for (let i = 0; i < maxAttempts; i++) {
    const { ch, model } = cands[i];
    const logModel = requested === 'auto' ? model : requested;
    /* 客户端是 responses 协议；模型原生可能是 chat（9 个免费模型都是）→ 桥过去 */
    const target = bridgeTarget(model, 'responses');
    let built;
    try {
      built = target === 'responses'
        ? UP.buildResponsesRequest(ch, { ...body, model })
        : UP.buildBridgedRequest(ch, { ...body, model }, 'chat');
    }
    catch (e) { last = { status: 500, body: String(e.message) }; continue; }

    let resp;
    try {
      resp = await UP.request({
        url: built.url, headers: built.headers, body: built.body,
        proxy: proxyOf(ch), timeout: 300000,
      });
    } catch (e) {
      last = { status: 502, body: `上游连接失败: ${e.message}` };
      DB.addLog({ token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name, model: logModel, upstream_model: model, status: 502, ok: 0, stream: 1, error: last.body, latency_ms: Date.now() - t0, client_ip: clientIp(req) });
      continue;
    }

    const { res: up } = resp;
    const status = up.statusCode;

    if (status !== 200) {
      const text = await new Promise((r) => { let b = ''; up.setEncoding('utf8'); up.on('data', (c) => (b += c)); up.on('end', () => r(b)); up.on('error', () => r(b)); });
      last = { status, body: text };
      if (status === 429) {
        const ra = Number(up.headers['retry-after']);
        setCooldown(ch.id, model, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 24 * 3600e3) : 3600e3);
        if (POOL.enabled() && quotaRotations < QUOTA_ROTATE_LIMIT) {
          quotaRotations++;
          const rot = await POOL.onQuotaExhausted(cands.slice(0, i).map((x) => x.model));
          DB.addLog({ token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name, model: logModel, upstream_model: model, proxy: resp.proxy, status, ok: 0, stream: 1, error: rot.ok ? `额度429 -> 已切换出口到 ${rot.node}（第 ${quotaRotations} 次）` : `额度429 -> 不再切换：${rot.reason}`, latency_ms: Date.now() - t0, client_ip: clientIp(req) });
          if (rot.ok) { i--; continue; }
        }
      } else if (status === 403 || status === 400) {
        setCooldown(ch.id, model, 600e3);
      }
      DB.addLog({ token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name, model: logModel, upstream_model: model, proxy: resp.proxy, status, ok: 0, stream: 1, error: text.slice(0, 300), latency_ms: Date.now() - t0, client_ip: clientIp(req) });
      continue;
    }

    UP.markProxyOk(resp.proxy);
    if (auth.token) DB.bumpToken(auth.token.id);
    POOL.onModelSuccess();   // 成功就给当前出口清掉额度记忆

    /* ── 桥接分支：上游是 chat，客户端要 responses ── */
    if (target === 'chat') {
      const conv = BR.makeChatToResponsesStream(logModel);
      let firstByteAt = null;
      const done = (usage) => {
        const u = usage || {};
        DB.addLog({
          token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name,
          model: logModel, upstream_model: model, proxy: resp.proxy,
          prompt_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
          completion_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
          latency_ms: Date.now() - t0, ttft_ms: firstByteAt ? firstByteAt - t0 : null,
          status: 200, ok: 1, stream: wantStream ? 1 : 0, client_ip: clientIp(req),
        });
      };
      const emit = (fin) => {
        if (wantStream) { res.write(fin.sse); res.end(); }
        else { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(fin.response)); }
        done(fin.response && fin.response.usage);
      };
      if (wantStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
      }
      forEachSseLine(up,
        (line) => {
          if (firstByteAt === null) firstByteAt = Date.now();
          const o = conv.push(line);
          if (o && wantStream) res.write(o);
        },
        () => emit(conv.end()),
        () => emit(conv.end()));
      req.on('close', () => { try { up.destroy(); } catch { /* 已断 */ } });
      return;
    }

    let buf = '', usage = null, firstByte = null, finalObj = null;
    up.setEncoding('utf8');
    if (wantStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
    }
    up.on('data', (chunk) => {
      if (firstByte === null) firstByte = Date.now();
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const t = line.trim();
        if (wantStream) res.write(line + '\n');
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const o = JSON.parse(payload);
          if (o.type === 'response.completed' && o.response) { finalObj = o.response; usage = o.response.usage || usage; }
          else if (o.response && o.response.usage) usage = o.response.usage;
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    const finish = () => {
      const u = usage || {};
      const promptT = u.input_tokens ?? u.prompt_tokens ?? 0;
      const compT = u.output_tokens ?? u.completion_tokens ?? 0;
      DB.addLog({
        token_id: auth.token?.id, token_name: auth.token?.name, channel_id: ch.id, channel_name: ch.name,
        model: logModel, upstream_model: model, proxy: resp.proxy,
        prompt_tokens: promptT, completion_tokens: compT, total_tokens: u.total_tokens || (promptT + compT),
        latency_ms: Date.now() - t0, ttft_ms: firstByte ? firstByte - t0 : null,
        status: 200, ok: 1, stream: wantStream ? 1 : 0, client_ip: clientIp(req),
      });
      try {
        if (wantStream) res.end();
        else { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(finalObj || { error: { message: '上游未返回完整 response 对象' } })); }
      } catch { /* 连接已断 */ }
    };
    up.on('end', finish);
    up.on('error', () => finish());
    req.on('close', () => { try { up.destroy(); } catch {} });
    return;
  }

  const msg = (() => { try { return JSON.parse(last.body)?.error?.message || last.body; } catch { return last.body; } })();
  return err(res, last.status === 429 ? 429 : last.status >= 400 ? last.status : 502,
    `所有候选渠道均失败：${String(msg).slice(0, 400)}`,
    last.status === 429 ? 'rate_limit_error' : 'upstream_error');
}

/* ══════════════════════════════════════════════════ 路由 */
async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const cookie = req.headers.cookie || '';
  const admin = checkSession(cookie);

  /* ── 静态 ── */
  if (p === '/' || p === '/index.html' || p === '/admin') {
    const f = path.join(DIR, 'public', 'index.html');
    if (!fs.existsSync(f)) return err(res, 500, 'public/index.html 缺失');
    const b = fs.readFileSync(f);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
    return res.end(b);
  }

  /* ── 登录 ── */
  if (p === '/api/login' && req.method === 'POST') {
    const b = await readJson(req);
    if (!DB.verifyPassword(b.password, DB.getSetting('admin_password'))) {
      await new Promise((r) => setTimeout(r, 400));
      return err(res, 401, '密码错误', 'auth_error');
    }
    return json(res, 200, { ok: true }, { 'set-cookie': `ocp_session=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'set-cookie': 'ocp_session=; Path=/; Max-Age=0' });
  }
  if (p === '/api/me') return json(res, 200, { admin, site_name: DB.getSetting('site_name') });

  /* ── OpenAI 兼容（令牌鉴权） ── */
  if (p === '/v1/models' || p === '/v1/models/') {
    const auth = tokenAuth(req);
    if (auth.error) return err(res, auth.code, auth.error, 'auth_error');
    /* 合并「渠道手配」与「动态发现」—— 不能二选一。
     * 动态探测是**异步**的：启动 5 秒后才开始，第一轮跑完要几十秒。
     * 早期写法是「有动态结果就替换手配清单」，于是探测跑到一半时
     * /v1/models 只返回那几个已探测完的模型，列表被截断。 */
    const includeUnusable = u.searchParams.get('all') === '1';
    const rows = new Map();
    for (const m of allModels()) {
      rows.set(m.id, { id: m.id, owned_by: m.owned_by, protocols: m.protocols || null, available: true, status: 'configured' });
    }
    if (REG.enabled()) {
      for (const m of REG.downstreamModels({ includeUnusable: true })) {
        rows.set(m.id, { ...(rows.get(m.id) || {}), ...m });
      }
    }
    // 剔除「上游已下架且探测确认不可用」的；下架但仍可用的要留着（实测有这种）
    const gone = new Set(REG.enabled() ? REG.goneModelIds() : []);
    const data = [...rows.values()]
      .filter((m) => !gone.has(m.id) || m.available)
      .filter((m) => includeUnusable || m.available !== false)
      .map((m) => ({
      id: m.id,
      object: 'model',
      created: m.created || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'opencode-free',
      available: m.available !== undefined ? m.available : true,
      status: m.status || 'unknown',
      protocols: m.protocols || null,
      endpoints: m.protocols
        ? m.protocols.map((p) => (p === 'chat' ? '/v1/chat/completions' : '/v1/responses'))
        : null,
    }));
    return json(res, 200, { object: 'list', data });
  }
  if (p === '/v1/chat/completions' && req.method === 'POST') {
    const auth = tokenAuth(req);
    if (auth.error) return err(res, auth.code, auth.error, 'auth_error');
    let body;
    try { body = await readJson(req); } catch (e) { return err(res, 400, e.message); }
    try { return await handleChat(req, res, body, auth); }
    catch (e) { console.error('[chat]', e); if (!res.headersSent) return err(res, 500, String(e.message)); try { res.end(); } catch {} return; }
  }

  if ((p === '/v1/responses' || p === '/v1/responses/') && req.method === 'POST') {
    const auth = tokenAuth(req);
    if (auth.error) return err(res, auth.code, auth.error, 'auth_error');
    let body;
    try { body = await readJson(req); } catch (e) { return err(res, 400, e.message); }
    try { return await handleResponses(req, res, body, auth); }
    catch (e) { console.error('[responses]', e); if (!res.headersSent) return err(res, 500, String(e.message)); try { res.end(); } catch {} return; }
  }

  /* ── 管理 API ── */
  if (p.startsWith('/api/')) {
    if (!admin) return err(res, 401, '未登录', 'auth_error');

    if (p === '/api/stats') {
      const range = u.searchParams.get('range') || 'all';
      const since = range === '1d' ? Date.now() - 864e5 : range === '7d' ? Date.now() - 7 * 864e5 : range === '30d' ? Date.now() - 30 * 864e5 : 0;
      return json(res, 200, { ...DB.stats(since), range, channels: DB.listChannels().length, tokens: DB.listTokens().length, cooldowns: cooldownSnapshot() });
    }

    if (p === '/api/channels') {
      if (req.method === 'GET') return json(res, 200, { rows: DB.listChannels().map(publicChannel) });
      if (req.method === 'POST') { const b = await readJson(req); return json(res, 200, publicChannel(DB.createChannel(b))); }
    }
    let m;
    if ((m = /^\/api\/channels\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      if (req.method === 'GET') { const c = DB.getChannel(id); return c ? json(res, 200, publicChannel(c)) : err(res, 404, '渠道不存在'); }
      if (req.method === 'PUT') { const b = await readJson(req); const c = DB.updateChannel(id, b); return c ? json(res, 200, publicChannel(c)) : err(res, 404, '渠道不存在'); }
      if (req.method === 'DELETE') { DB.deleteChannel(id); return json(res, 200, { ok: true }); }
    }
    if ((m = /^\/api\/channels\/(\d+)\/test$/.exec(p)) && req.method === 'POST') {
      const c = DB.getChannel(Number(m[1]));
      if (!c) return err(res, 404, '渠道不存在');
      const b = await readJson(req).catch(() => ({}));
      const r = await UP.testChannel(c, b.model);
      if (r.ok) DB.clearChannelDown(c.id); else DB.markChannelDown(c.id, 60e3, `测试失败 HTTP ${r.status}`);
      return json(res, 200, r);
    }
    if ((m = /^\/api\/channels\/(\d+)\/toggle$/.exec(p)) && req.method === 'POST') {
      const c = DB.getChannel(Number(m[1]));
      if (!c) return err(res, 404, '渠道不存在');
      DB.updateChannel(c.id, { status: c.status ? 0 : 1 });
      if (!c.status) DB.clearChannelDown(c.id);
      return json(res, 200, publicChannel(DB.getChannel(c.id)));
    }

    if (p === '/api/tokens') {
      if (req.method === 'GET') return json(res, 200, { rows: DB.listTokens() });
      if (req.method === 'POST') {
        const b = await readJson(req);
        return json(res, 200, DB.createToken({ ...b, key: b.key || UP.makeTokenKey() }));
      }
    }
    if ((m = /^\/api\/tokens\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      if (req.method === 'PUT') { const b = await readJson(req); const t = DB.updateToken(id, b); return t ? json(res, 200, t) : err(res, 404, '令牌不存在'); }
      if (req.method === 'DELETE') { DB.deleteToken(id); return json(res, 200, { ok: true }); }
    }
    if ((m = /^\/api\/tokens\/(\d+)\/reset$/.exec(p)) && req.method === 'POST') { DB.resetTokenUsage(Number(m[1])); return json(res, 200, { ok: true }); }

    if (p === '/api/logs') {
      if (req.method === 'GET') {
        const q = u.searchParams;
        return json(res, 200, DB.listLogs({
          limit: Math.min(500, Number(q.get('limit') || 100)),
          offset: Number(q.get('offset') || 0),
          model: q.get('model') || undefined,
          token_id: q.get('token_id') ? Number(q.get('token_id')) : undefined,
          ok: q.get('ok') === null ? undefined : Number(q.get('ok')),
        }));
      }
      if (req.method === 'DELETE') { DB.clearLogs(); return json(res, 200, { ok: true }); }
    }

    if (p === '/api/models') return json(res, 200, { rows: allModels(), template: UP.templateInfo(), cooldowns: cooldownSnapshot() });

    /* ── 模型协议兼容 ──
     * 免费层的模型**按协议绑定**：deepseek 等只支持 chat/completions，
     * muse-spark 只支持 responses。用错协议上游返回 400。
     * GET  /api/protocols        读当前已知的兼容表
     * POST /api/protocols/probe  现场探测全部模型（会走渠道配置的代理，用最小 body 省额度）
     */
    /* ── 代理节点池 ──
     * 只影响模型请求的出口；系统代理 / TUN / 浏览器完全不受影响。
     */
    /* ── 上游 free 模型的动态发现 ── */
    if (p === '/api/models/catalog') {
      const st = REG.catalogState();
      return json(res, 200, st);
    }
    if (p === '/api/models/refresh' && req.method === 'POST') {
      const ch = enabledChannels()[0];
      try {
        const r = await REG.refreshCatalog({ probe: u.searchParams.get('probe') !== '0', ch });
        return json(res, 200, { ok: true, ...r });
      } catch (e) { return err(res, 502, `刷新失败: ${String(e.message).slice(0, 200)}`); }
    }
    if (p === '/api/models/enabled' && req.method === 'POST') {
      const id = u.searchParams.get('id');
      if (!id) return err(res, 400, '缺少 id');
      REG.setModelEnabled(id, u.searchParams.get('on') !== '0');
      return json(res, 200, { ok: true, id, enabled: u.searchParams.get('on') !== '0' });
    }
    /* ══════════ 代理订阅（增删改查）══════════
     * 这些接口直接读写运行时目录里的 subscriptions.json，
     * 面板里填的订阅立刻能生效，不用再手改文件。
     */
    if (p === '/api/proxy-pool/providers') {
      if (req.method === 'GET') {
        const subs = POOL.M.loadSubs();
        return json(res, 200, {
          rows: POOL.M.listProviders(),
          subsPath: POOL.M.SUBS_PATH,
          manualProxies: subs.manualProxies,
          excludedNodes: subs.excludedNodes,
          settings: subs._参数 || {},
        });
      }
      if (req.method === 'POST') {
        try { return json(res, 200, { ok: true, provider: POOL.M.upsertProvider(await readJson(req)) }); }
        catch (e) { return err(res, 400, String(e.message).slice(0, 200)); }
      }
      if (req.method === 'DELETE') {
        const name = u.searchParams.get('name');
        if (!name) return err(res, 400, '缺少 name');
        return json(res, 200, { ok: true, ...POOL.M.deleteProvider(name) });
      }
    }
    if (p === '/api/proxy-pool/providers/toggle' && req.method === 'POST') {
      const name = u.searchParams.get('name');
      try { return json(res, 200, { ok: true, provider: POOL.M.setProviderEnabled(name, u.searchParams.get('on') !== '0') }); }
      catch (e) { return err(res, 400, String(e.message).slice(0, 200)); }
    }
    /* 试拉一次订阅：能不能通、能解析出多少个节点 */
    if (p === '/api/proxy-pool/providers/test' && req.method === 'POST') {
      const name = u.searchParams.get('name');
      const rec = POOL.M.listProviders().find((x) => x.name === name);
      if (!rec) return err(res, 404, '订阅不存在');
      const t0 = Date.now();
      try {
        const r = await fetch(rec.url, { headers: { 'user-agent': 'clash-verge/v2.0.0' }, signal: AbortSignal.timeout(60000) });
        const txt = await r.text();
        // 粗略统计 proxies 段里的条目数（流式 + 块式都算）
        const nodes = (txt.match(/^\s*-\s*\{/gm) || []).length + (txt.match(/^\s*-\s*$/gm) || []).length + (txt.match(/^\s*-\s+name:/gm) || []).length;
        return json(res, 200, {
          ok: r.ok, status: r.status, bytes: txt.length, nodes,
          ms: Date.now() - t0,
          isClashYaml: /^proxies:/m.test(txt) || /^\s*proxy-groups:/m.test(txt),
          subInfo: r.headers.get('subscription-userinfo') || null,
        });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message).slice(0, 200), ms: Date.now() - t0 });
      }
    }
    /* 应用改动：重渲染配置 + 让运行中的实例重载 + 重新同步节点清单 */
    if (p === '/api/proxy-pool/apply' && req.method === 'POST') {
      try {
        const r = await POOL.M.applyConfig();
        let synced = null;
        try { synced = await POOL.P.syncNodes(); } catch { /* 内核没起时同步会失败，不算错 */ }
        return json(res, 200, { ok: true, ...r, synced });
      } catch (e) { return err(res, 500, `应用配置失败: ${String(e.message).slice(0, 200)}`); }
    }
    /* ══════════ 节点：手加 / 剔除 ══════════ */
    if (p === '/api/proxy-pool/nodes/manual') {
      if (req.method === 'POST') {
        try { return json(res, 200, { ok: true, proxy: POOL.M.addManualProxy(await readJson(req)) }); }
        catch (e) { return err(res, 400, String(e.message).slice(0, 200)); }
      }
      if (req.method === 'DELETE') {
        const name = u.searchParams.get('name');
        if (!name) return err(res, 400, '缺少 name');
        return json(res, 200, { ok: true, ...POOL.M.removeManualProxy(name) });
      }
    }
    if (p === '/api/proxy-pool/nodes/exclude' && req.method === 'POST') {
      const name = u.searchParams.get('name');
      if (!name) return err(res, 400, '缺少 name');
      const r = POOL.M.setNodeExcluded(name, u.searchParams.get('on') !== '0');
      POOL.M.IDX_CACHE.m = null;
      return json(res, 200, { ok: true, ...r });
    }
    if (p === '/api/proxy-pool' || p === '/api/proxy-pool/') {
      await POOL.resync().catch(() => {});
      const st = await POOL.state();
      return json(res, 200, { enabled: POOL.enabled(), proxy: POOL.proxyUrl(), instance: POOL.instance(), ...st });
    }
    if (p === '/api/proxy-pool/nodes') {
      const all = u.searchParams.get('all') === '1';
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      /* 以**节点定义**为准（provider 缓存 + 手加节点 + 剔除标记），
       * 再叠加池子里的运行状态（status / delay_ms / lease）。
       * 不能只读池子 DB —— 那要内核起来同步过才有数据，
       * 没起内核时界面上就看不到任何节点，连刚手加的也看不到。 */
      const defs = POOL.M.providerNodes();
      const stMap = new Map(POOL.P.listNodes({ includeInvalid: true }).map((r) => [r.name, r]));
      let rows = defs.map((d) => {
        const st = stMap.get(d.name) || {};
        return {
          ...st,
          name: d.name, provider: d.provider, type: d.type, server: d.server, port: d.port,
          manual: !!d.manual,
          valid: d.valid, invalidReason: d.reason,
          excluded: !!d.excluded,
          status: st.status || (d.valid ? 'available' : 'excluded'),
          delay_ms: st.delay_ms ?? null,
        };
      });
      if (!all) rows = rows.filter((r) => r.valid);
      if (q) {
        rows = rows.filter((r) => [r.name, r.provider, r.server, r.type]
          .some((v) => String(v || '').toLowerCase().includes(q)));
      }
      return json(res, 200, { rows, total: rows.length, excluded: POOL.M.loadSubs().excludedNodes });
    }
    if (p === '/api/proxy-pool/events') return json(res, 200, { rows: POOL.events(Number(u.searchParams.get('limit')) || 50) });
    if (p === '/api/proxy-pool/rotate' && req.method === 'POST') return json(res, 200, await POOL.rotate());
    if (p === '/api/proxy-pool/verify' && req.method === 'POST') return json(res, 200, await POOL.verifyNow());
    if (p === '/api/proxy-pool/test' && req.method === 'POST') return json(res, 200, await POOL.testAll());
    if (p === '/api/proxy-pool/refresh' && req.method === 'POST') return json(res, 200, { subs: await POOL.refreshSubs() });
    if (p === '/api/proxy-pool/instance' && req.method === 'POST') {
      const on = u.searchParams.get('on') !== '0';
      return json(res, 200, on ? await POOL.startInstance() : await POOL.stopInstance());
    }
    if (p === '/api/protocols' || p === '/api/protocols/') {
      const map = DB.getProtocolMap();
      const rows = allModels().map((m) => {
        const x = map[m.id];
        return {
          model: m.id,
          protocols: x ? x.protocols : null,
          notSupported: x ? x.notSupported : null,
          unknown: x ? x.unknown : null,
          updatedAt: x ? x.updatedAt : null,
        };
      });
      return json(res, 200, { rows });
    }
    if (p === '/api/protocols/probe') {
      // GET  → 查进度
      // POST → 启动（立刻返回，不阻塞；进度用 GET 轮询）
      // 为什么异步：慢模型（如 nemotron-3-ultra-free 曾要 44–303s）会把整轮探测拖到几分钟，
      // 同步返回必然让客户端（undici headersTimeout 默认 300s）断掉。
      const snap = () => ({
        running: PROBE_JOB.running, done: PROBE_JOB.done, total: PROBE_JOB.total,
        startedAt: PROBE_JOB.startedAt, finishedAt: PROBE_JOB.finishedAt,
        results: PROBE_JOB.results, summary: PROBE_JOB.summary,
      });
      if (req.method === 'GET') return json(res, 200, snap());
      if (req.method === 'POST') {
        if (PROBE_JOB.running) return json(res, 200, { ok: true, alreadyRunning: true, ...snap() });
        const models = [...new Set(DB.listChannels().filter((c) => c.status === 1).flatMap((c) => effectiveChannelModels(c)))];
        if (!models.length) return err(res, 400, '没有可用模型，请先配置渠道');
        const ch = enabledChannels()[0];
        if (!ch) return err(res, 400, '没有启用的渠道');
        PROBE_JOB = { running: true, done: 0, total: models.length, startedAt: Date.now(), finishedAt: 0, results: [], summary: null };
        const queue = [...models];
        const got = new Map();
        (async () => {
          const worker = async () => {
            while (queue.length) {
              const model = queue.shift();
              let r;
              try { r = await UP.probeModelProtocol(ch, model); }
              catch (e) { r = { protocols: [], detail: { chat: { status: 0, verdict: 'error', note: String(e && e.message) }, responses: { status: 0, verdict: 'error', note: String(e && e.message) } } }; }
              // 关键：429/网络错误不能当成「协议不支持」，recordProbe 内部会保留旧判定
              const rec = DB.recordProbe(model, r.detail.chat.verdict, r.detail.responses.verdict, r.detail);
              got.set(model, { model, protocols: rec.protocols, notSupported: rec.notSupported, unknown: rec.unknown, chat: r.detail.chat, responses: r.detail.responses });
              PROBE_JOB.done++;
              PROBE_JOB.results = models.map((m) => got.get(m)).filter(Boolean);
            }
          };
          try {
            await Promise.all(Array.from({ length: Math.min(4, models.length) }, worker));
            const out = PROBE_JOB.results;
            const pick = (f) => out.filter(f).map((x) => x.model);
            PROBE_JOB.summary = {
              onlyChat: pick((x) => x.protocols.join() === 'chat'),
              onlyResp: pick((x) => x.protocols.join() === 'responses'),
              both: pick((x) => x.protocols.length === 2),
              none: pick((x) => x.protocols.length === 0),
              inconclusive: pick((x) => x.unknown.length > 0),
            };
          } finally {
            PROBE_JOB.running = false;
            PROBE_JOB.finishedAt = Date.now();
          }
        })();
        return json(res, 200, { ok: true, started: true, total: models.length, hint: '用 GET /api/protocols/probe 轮询进度' });
      }
    }

    if (p === '/api/proxies') {
      const spec = String(DB.getSetting('default_proxy') || '');
      const list = spec.split(',').map((s) => s.trim()).filter(Boolean);
      const rows = list.map((x) => {
        const s = UP.PROXY_STATE.get(x) || { url: x, ok: 0, fail: 0, downUntil: 0, lastError: null, inflight: 0 };
        return { url: x, ok: s.ok, fail: s.fail, down: s.downUntil > Date.now(), downUntil: s.downUntil, lastError: s.lastError, inflight: s.inflight };
      });
      return json(res, 200, { default_proxy: spec, rows });
    }

    if (p === '/api/settings') {
      if (req.method === 'GET') {
        return json(res, 200, {
          site_name: DB.getSetting('site_name'),
          default_proxy: DB.getSetting('default_proxy'),
          template: UP.templateInfo(),
        });
      }
      if (req.method === 'POST') {
        const b = await readJson(req);
        if (b.site_name !== undefined) DB.setSetting('site_name', b.site_name);
        if (b.default_proxy !== undefined) DB.setSetting('default_proxy', b.default_proxy);
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/api/password' && req.method === 'POST') {
      const b = await readJson(req);
      if (!DB.verifyPassword(b.old, DB.getSetting('admin_password'))) return err(res, 401, '原密码错误');
      if (!b.new || String(b.new).length < 6) return err(res, 400, '新密码至少 6 位');
      DB.setSetting('admin_password', DB.hashPassword(b.new));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/cooldowns' && req.method === 'DELETE') { COOLDOWN.clear(); return json(res, 200, { ok: true }); }

    return err(res, 404, `未知接口 ${p}`);
  }

  return err(res, 404, 'Not Found');
}

function publicChannel(c) {
  return { ...c, models: JSON.parse(c.models || '[]'), extra: JSON.parse(c.extra || '{}'), down: c.disabled_until > Date.now() };
}

function tokenAuth(req) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-api-key'] || '').toString().trim();
  if (!key) return { error: '缺少 API 密钥（Authorization: Bearer <令牌>）', code: 401 };
  const t = DB.getTokenByKey(key);
  if (!t) return { error: '无效的 API 密钥', code: 401 };
  if (t.status !== 1) return { error: '该令牌已被禁用', code: 403 };
  if (t.expires_at && t.expires_at < Date.now()) return { error: '该令牌已过期', code: 403 };
  if (!t.unlimited && t.used >= t.quota) return { error: `该令牌额度已用尽（${t.used}/${t.quota}）`, code: 429 };
  return { token: t };
}

const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  handle(req, res).catch((e) => {
    console.error('[err]', e);
    if (!res.headersSent) err(res, 500, String(e.message || e));
    else try { res.end(); } catch {}
  });
});

POOL.startScheduler();
REG.startScheduler();
server.listen(PORT, HOST, () => {
  console.log(`\n  OpenCode 免费层网关已启动`);
  console.log(`  管理面板     http://${HOST}:${PORT}/`);
  console.log(`  Chat API     http://${HOST}:${PORT}/v1/chat/completions   (OpenAI 兼容，流式/非流式)`);
  console.log(`  Responses API http://${HOST}:${PORT}/v1/responses        (Codex 用；muse-spark 等只支持此协议)`);
  console.log(`  初始密码     ${DB.getSetting('admin_password') ? 'admin123（请尽快修改）' : '-'}\n`);
});
