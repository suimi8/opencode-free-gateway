// 探测每个免费模型支持哪个协议，并把结果写进面板数据库
//
//   node probe_protocols.mjs            探测并写库
//   node probe_protocols.mjs --dry      只打印，不写库
//
// 背景：免费层的模型是**按协议绑定**的（2026-10-17 实测）：
//   deepseek-v4.1-flash-free        → 只支持 /chat/completions
//   muse-spark-1.3-contributor-free → 只支持 /responses
// 用错协议上游返回 400 `Model does not support this protocol.`
//
// 探测用**最小 body**（只带一个 read 工具），每次成功约 300 prompt tokens，
// 而不是完整 agent body 的 9,600 —— 20 次探测总共也就几千 tokens。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DIR = import.meta.dirname;
const DRY = process.argv.includes('--dry');
const CHAT_URL = 'https://opencode.ai/inference/v1/chat/completions';
const RESP_URL = 'https://opencode.ai/inference/v1/responses';

/* ── 门禁所需的最小形状（详见 ../04-门禁判别实验/verify_gate_tools.mjs）── */
const UA = 'opencode/1.19.2';
const mkSession = () => {
  const HEX = '0123456789abcdef';
  const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const pick = (set, n) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');
  const low12 = (0xfc0 + Math.floor(Math.random() * 0x40)).toString(16).padStart(3, '0');
  return `ses_${pick(HEX, 9)}${low12}${pick(B62, 14)}`;
};
const READ_CHAT = {
  type: 'function',
  function: { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } },
};
const READ_RESP = { type: 'function', name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } };

const chatBody = (model) => JSON.stringify({
  model, stream: true, max_tokens: 16, tools: [READ_CHAT],
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
});
const respBody = (model) => JSON.stringify({
  model, stream: true, store: false, tools: [READ_RESP],
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: PONG' }] }],
});

async function probe(url, body) {
  const headers = { 'content-type': 'application/json', 'user-agent': UA, 'x-opencode-session': mkSession() };
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(90000) });
      const t = await r.text();
      if (r.status === 200) {
        // 确认真的是流式内容而不是空壳
        const ok = t.includes('data:') || t.includes('event:');
        return { status: 200, verdict: ok ? 'ok' : 'ok?', note: '' };
      }
      const msg = (t.match(/"message"\s*:\s*"([^"]{0,90})/)?.[1] ?? t.slice(0, 90)).replace(/\s+/g, ' ');
      let verdict = 'other';
      if (/does not support this protocol/i.test(msg)) verdict = 'wrong-protocol';
      else if (/free tier can only be used/i.test(msg)) verdict = 'gate-403';
      else if (r.status === 429 || /limit/i.test(msg)) verdict = 'quota';
      else if (/region/i.test(msg)) verdict = 'region';
      return { status: r.status, verdict, note: msg };
    } catch (e) {
      if (a === 3) return { status: 0, verdict: 'error', note: e.message };
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

/* ── 从面板库读模型清单 ── */
const DB_PATH = process.env.PANEL_DB || path.join(DIR, 'panel.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
const channels = db.prepare('SELECT id,name,models FROM channels WHERE status = 1').all();
const models = [];
for (const c of channels) {
  try { for (const m of JSON.parse(c.models || '[]')) if (!models.includes(m)) models.push(m); } catch { /* 忽略坏 JSON */ }
}
if (!models.length) { console.error('面板库里没有可用模型，先在「渠道管理」里配置。'); process.exit(1); }

console.log(`探测 ${models.length} 个模型 × 2 种协议 = ${models.length * 2} 次请求（最小 body）`);
console.log(`数据库: ${DB_PATH}\n`);
console.log('模型'.padEnd(34) + 'chat/completions'.padEnd(20) + 'responses');
console.log('─'.repeat(74));

const result = {};
for (const model of models) {
  const [chat, resp] = [await probe(CHAT_URL, chatBody(model)), await probe(RESP_URL, respBody(model))];
  const protos = [];
  if (chat.verdict === 'ok' || chat.verdict === 'ok?') protos.push('chat');
  if (resp.verdict === 'ok' || resp.verdict === 'ok?') protos.push('responses');
  result[model] = { protocols: protos, chat, resp, updatedAt: Date.now() };
  const fmt = (r) => `${r.status}${r.verdict === 'ok' ? '' : ' ' + r.verdict}`.padEnd(20);
  const tag = protos.length === 0 ? '  ← 两种协议都不可用' : (protos.length === 2 ? '  ← 两种都支持' : `  ← 仅 ${protos[0]}`);
  console.log(model.padEnd(34) + fmt(chat) + fmt(resp) + tag);
  await new Promise((r) => setTimeout(r, 300));
}

/* ── 汇总 ── */
const onlyChat = models.filter((m) => result[m].protocols.join() === 'chat');
const onlyResp = models.filter((m) => result[m].protocols.join() === 'responses');
const both = models.filter((m) => result[m].protocols.length === 2);
const none = models.filter((m) => result[m].protocols.length === 0);
console.log('\n══ 汇总 ══');
console.log(`  仅 chat      (${onlyChat.length}): ${onlyChat.join(', ') || '-'}`);
console.log(`  仅 responses (${onlyResp.length}): ${onlyResp.join(', ') || '-'}`);
console.log(`  两者都支持   (${both.length}): ${both.join(', ') || '-'}`);
console.log(`  都不可用     (${none.length}): ${none.join(', ') || '-'}`);

if (DRY) { console.log('\n(--dry：未写库)'); db.close(); process.exit(0); }

db.prepare(`CREATE TABLE IF NOT EXISTS model_protocols (
  model TEXT PRIMARY KEY, protocols TEXT NOT NULL, detail TEXT, updated_at INTEGER NOT NULL)`).run();

/* 并入旧判定：**429/网络错误绝不能当成「协议不支持」**，
   否则一次探测赶上额度用光就会把可用模型永久错标。
   只有明确的 wrong-protocol / gate-403 / region 才算「确认不支持」。 */
const norm = (v) => {
  if (Array.isArray(v)) return { protocols: v, notSupported: [], unknown: [] };
  if (v && typeof v === 'object') return {
    protocols: Array.isArray(v.protocols) ? v.protocols : [],
    notSupported: Array.isArray(v.notSupported) ? v.notSupported : [],
    unknown: Array.isArray(v.unknown) ? v.unknown : [],
  };
  return { protocols: [], notSupported: [], unknown: [] };
};
const prevRows = db.prepare('SELECT model, protocols FROM model_protocols').all();
const prev = Object.fromEntries(prevRows.map((r) => { try { return [r.model, norm(JSON.parse(r.protocols))]; } catch { return [r.model, norm(null)]; } }));

const up = db.prepare('INSERT INTO model_protocols(model,protocols,detail,updated_at) VALUES(?,?,?,?) ' +
  'ON CONFLICT(model) DO UPDATE SET protocols=excluded.protocols, detail=excluded.detail, updated_at=excluded.updated_at');
for (const m of models) {
  const cur = prev[m] || norm(null);
  const protocols = new Set(cur.protocols);
  const notSupported = new Set(cur.notSupported);
  const unknown = new Set(cur.unknown);
  for (const [proto, r] of [['chat', result[m].chat], ['responses', result[m].resp]]) {
    if (r.verdict === 'ok') { protocols.add(proto); notSupported.delete(proto); unknown.delete(proto); }
    else if (r.verdict === 'wrong-protocol' || r.verdict === 'gate-403' || r.verdict === 'region') {
      notSupported.add(proto); protocols.delete(proto); unknown.delete(proto);
    } else if (!protocols.has(proto) && !notSupported.has(proto)) { unknown.add(proto); }
  }
  up.run(m, JSON.stringify({ protocols: [...protocols], notSupported: [...notSupported], unknown: [...unknown] }),
    JSON.stringify({ chat: result[m].chat, resp: result[m].resp }), result[m].updatedAt);
  result[m].finalProtocols = [...protocols];
}
console.log(`\n[+] 已并入 model_protocols 表（${models.length} 行）`);
const incon = models.filter((m) => !result[m].finalProtocols.length);
if (incon.length) console.log(`    ⚠ 以下模型两种协议都没确认成功（可能是额度耗尽/网络问题，已保留旧判定）：${incon.join(', ')}`);
db.close();
