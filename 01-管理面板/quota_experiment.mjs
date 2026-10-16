/**
 * 免费层额度实验（决定性）
 *
 * 目的：判定「所有免费模型共用同一个每日额度桶」还是「每个模型各自一个桶」，
 *       并测出桶的大小（以 token 计）。
 *
 * 方法：
 *   Phase 0  等到下一个 00:00 UTC（额度重置点）之后 15 秒
 *   Phase 1  逐个探测全部免费模型，记录状态（期望：全部 200 = 干净起点）
 *   Phase 2  只对一个「牺牲模型」并发猛打，直到出现 429，记录累计消耗的 token / 请求数
 *   Phase 3  立刻再探测全部其它模型
 *             · 若它们也变 429  → 共用同一个桶，桶大小 ≈ Phase 2 的累计消耗
 *             · 若它们仍是 200  → 每模型独立桶
 *   Phase 4  写出 JSON + Markdown 报告
 *
 * 运行：node quota_experiment.mjs [--now]     （--now 跳过等待，立即执行）
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { request } from './upstream.mjs';

const PROXY = 'http://127.0.0.1:7897';
const BASE = 'https://opencode.ai/inference/v1/chat/completions';
const SACRIFICE = 'deepseek-v4.1-flash-free';      // 用来把桶打空的模型
const MODELS = [
  'deepseek-v4.1-flash-free', 'longcat-2.5-preview-free', 'space-bunny-free',
  'mimo-v2.6-flash-free', 'nemotron-3.5-super-vl-free', 'big-pickle',
  'nemotron-3.5-lightning-free', 'nemotron-3-ultra-free',
  'cat-jam-free', 'muse-spark-1.3-contributor-free',
];
const MAX_BURN_REQUESTS = 900;
const CONCURRENCY = 8;
const OUT_DIR = import.meta.dirname;

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rnd = (n, a) => { const b = crypto.randomBytes(n * 2); let o = ''; for (let i = 0; i < n; i++) o += a[b[i] % a.length]; return o; };
const newSid = () => 'ses_' + rnd(9, '0123456789abcdef') + 'ffe' + rnd(14, B62);
const newMsg = () => 'msg_' + rnd(12, '0123456789abcdef') + rnd(14, B62);

const TPL = JSON.parse(fs.readFileSync((import.meta.dirname + '/../02-直连客户端/body_template.json'), 'utf8'));
const SYS = TPL.messages.filter((m) => m.role === 'system');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function call(model, { maxTokens = 16, timeout = 90000 } = {}) {
  const s = newSid();
  const body = {
    ...TPL, model, max_tokens: maxTokens,
    messages: [...SYS, { role: 'user', content: 'Reply with exactly: PONG' }],
  };
  const t0 = Date.now();
  const { res } = await request({
    url: BASE, method: 'POST', proxy: PROXY, timeout,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
      'x-opencode-client': 'desktop',
      'x-opencode-project': 'global',
      'x-opencode-request': newMsg(),
      'x-opencode-session': s,
      'x-opencode-session-id': s,
    },
    body: JSON.stringify(body),
  });
  const text = await new Promise((r) => {
    let b = ''; res.setEncoding('utf8');
    res.on('data', (c) => { b += c; });
    res.on('end', () => r(b));
    res.on('error', () => r(b));
  });
  const ms = Date.now() - t0;
  let usage = null, errType = null, errMsg = null;
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t.startsWith('data:')) continue;
    const p = t.slice(5).trim(); if (p === '[DONE]') continue;
    try { const o = JSON.parse(p); if (o.usage) usage = o.usage; if (o.error) { errType = o.error.type; errMsg = o.error.message; } } catch {}
  }
  if (!usage && !errType) { try { const o = JSON.parse(text); if (o.error) { errType = o.error.type; errMsg = o.error.message; } } catch {} }
  return {
    status: res.statusCode, ms, usage, errType, errMsg,
    zen: res.headers['x-zen-model'] || null,
    endpoint: res.headers['x-opencode-endpoint-id'] || null,
    upstream: res.headers['x-opencode-upstream-model-id'] || null,
    retryAfter: Number(res.headers['retry-after'] || 0) || null,
    logId: res.headers['x-opencode-log-id'] || null,
  };
}

/** 单次探测，带重试（只重试网络错误，不重试 429/403） */
async function probe(model, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await call(model); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  return { status: 0, errType: 'NETWORK', errMsg: String(last && last.message), ms: 0, usage: null };
}

function probeAll(tag) {
  return (async () => {
    const rows = [];
    for (const m of MODELS) {
      const r = await probe(m);
      rows.push({ model: m, status: r.status, errType: r.errType, retryAfter: r.retryAfter, zen: r.zen, endpoint: r.endpoint, upstream: r.upstream, promptTokens: r.usage?.prompt_tokens || 0 });
      log(`  [${tag}] ${String(r.status).padEnd(4)} ${m.padEnd(34)} ${r.errType || ''} ${r.retryAfter ? 'retry-after=' + r.retryAfter : ''}`);
    }
    return rows;
  })();
}

function waitUntilNextUtcMidnight() {
  const now = Date.now();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() + 15000 - now; // 重置后 15 秒
}

async function main() {
  const skipWait = process.argv.includes('--now');
  if (!skipWait) {
    const waitMs = waitUntilNextUtcMidnight();
    log(`等待额度重置（${(waitMs / 3600000).toFixed(2)} 小时后，UTC 00:00:15）…`);
    await new Promise((r) => setTimeout(r, waitMs));
  } else {
    log('--now：跳过等待，立即执行');
  }

  const startedAt = new Date().toISOString();
  log('══ Phase 1：重置后全模型探测 ══');
  const phase1 = await probeAll('P1');

  log(`\n══ Phase 2：猛打牺牲模型 ${SACRIFICE} ══`);
  let burnedReq = 0, burnedPrompt = 0, burnedCompletion = 0;
  let firstLimit = null;
  let stop = false;

  const worker = async (id) => {
    while (!stop && burnedReq < MAX_BURN_REQUESTS) {
      let r;
      try { r = await call(SACRIFICE); } catch { await new Promise((x) => setTimeout(x, 500)); continue; }
      burnedReq++;
      if (r.usage) { burnedPrompt += r.usage.prompt_tokens || 0; burnedCompletion += r.usage.completion_tokens || 0; }
      if (r.status === 429 || r.errType === 'FreeUsageLimitError') {
        if (!firstLimit) { firstLimit = { at: new Date().toISOString(), afterRequests: burnedReq, afterPromptTokens: burnedPrompt, retryAfter: r.retryAfter, logId: r.logId }; log(`  ⛔ 第 ${burnedReq} 次请求触发 429，retry-after=${r.retryAfter}`); }
        stop = true; return;
      }
      if (r.status !== 200) { log(`  ⚠ ${r.status} ${r.errType || ''}`); }
      if (burnedReq % 25 === 0) log(`  已打 ${burnedReq} 次，累计 prompt ${burnedPrompt.toLocaleString()} tokens`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  log(`Phase 2 结束：${burnedReq} 次请求，prompt ${burnedPrompt.toLocaleString()} tokens，completion ${burnedCompletion.toLocaleString()} tokens`);

  log('\n══ Phase 3：立刻重测全部模型 ══');
  const phase3 = await probeAll('P3');

  /* ── 判定 ── */
  const others = phase3.filter((r) => r.model !== SACRIFICE);
  const othersLimited = others.filter((r) => r.status === 429);
  const othersOk = others.filter((r) => r.status === 200);
  const verdict = othersLimited.length > 0 && othersOk.length === 0
    ? '共用同一个额度桶（打空一个模型后，其它模型同时被限流）'
    : othersOk.length > 0 && othersLimited.length === 0
      ? '每模型独立额度桶（打空牺牲模型后，其它模型不受影响）'
      : `混合：${othersOk.length} 个仍可用 / ${othersLimited.length} 个被限流`;

  const report = { startedAt, finishedAt: new Date().toISOString(), sacrifice: SACRIFICE, concurrency: CONCURRENCY, phase1, phase2: { requests: burnedReq, promptTokens: burnedPrompt, completionTokens: burnedCompletion, firstLimit }, phase3, verdict };

  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`${OUT_DIR}/quota-experiment-${stamp}.json`, JSON.stringify(report, null, 2));
  const md = [
    `# 免费层额度实验报告 ${stamp}`,
    '',
    `- 开始：${startedAt}`,
    `- 结束：${report.finishedAt}`,
    `- 牺牲模型：\`${SACRIFICE}\`（并发 ${CONCURRENCY}）`,
    '',
    '## 判定',
    '',
    `**${verdict}**`,
    '',
    '## Phase 1 — 重置后各模型状态',
    '',
    '| 模型 | 状态 | 错误类型 | retry-after | x-zen-model |',
    '|---|---:|---|---:|---|',
    ...phase1.map((r) => `| ${r.model} | ${r.status} | ${r.errType || '-'} | ${r.retryAfter || '-'} | ${r.zen || '-'} |`),
    '',
    '## Phase 2 — 猛打牺牲模型',
    '',
    `- 请求次数：**${burnedReq}**`,
    `- 累计 prompt tokens：**${burnedPrompt.toLocaleString()}**`,
    `- 累计 completion tokens：**${burnedCompletion.toLocaleString()}**`,
    firstLimit ? `- 首次 429 出现在第 **${firstLimit.afterRequests}** 次请求，此时累计 prompt **${firstLimit.afterPromptTokens.toLocaleString()}** tokens，retry-after=${firstLimit.retryAfter}` : '- 未触发 429（未打空）',
    '',
    '## Phase 3 — 打空后各模型状态',
    '',
    '| 模型 | 状态 | 错误类型 | retry-after |',
    '|---|---:|---|---:|',
    ...phase3.map((r) => `| ${r.model} | ${r.status} | ${r.errType || '-'} | ${r.retryAfter || '-'} |`),
    '',
  ].join('\n');
  fs.writeFileSync(`${OUT_DIR}/quota-experiment-${stamp}.md`, md);

  log('\n══════ 判定 ══════');
  log(verdict);
  log(`报告：${OUT_DIR}/quota-experiment-${stamp}.md`);
}

main().catch((e) => { console.error('EXPERIMENT_FAIL', e); process.exit(1); });
