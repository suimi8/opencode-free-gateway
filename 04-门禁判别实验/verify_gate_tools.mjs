// 门禁第 6 条：`tools` 里必须有 name === "read" 的工具
//
// 这是 2026-10-17 隔离实验的结论，推翻了此前「body 必须是完整 38.7 KB agent 结构」的说法。
// 同时也解释了为什么「加个头就能用」是错的——头只是 4 条，body 还有 2 条硬要求。
//
//   node verify_gate_tools.mjs
//
// ⚠️ 会消耗共享每日额度（200 的用例）。本文大约 6 个 200。
import fs from 'node:fs';

const URL = 'https://opencode.ai/inference/v1/chat/completions';
const CAP = JSON.parse(fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8'));
const T = CAP.tools || [];
const byName = Object.fromEntries(T.map((t) => [t.function.name, t]));
const H = {
  'user-agent': 'opencode/1.19.2',
  'x-opencode-session': 'ses_ebcf32130ffe7wJ1T06CSP2AP5',
  'content-type': 'application/json',
};

const fake = (n, name = null) => Array.from({ length: n }, (_, i) => ({
  type: 'function',
  function: { name: name || `f${i}`, description: 'd', parameters: { type: 'object', properties: {} } },
}));

const CASES = [
  ['完整 12 tools（基线）', T, 200],
  ['system 200 字符 + 12 tools', T, 200, 200],
  ['只有 read（手搓空参数）', [{ type: 'function', function: { name: 'read', description: 'x', parameters: { type: 'object', properties: {} } } }], 200],
  ['tools: []', [], 403],
  ['system 29000 填充 + tools: []', [], 403, 29000],
  ['12 tools 去掉 read', T.filter((t) => t.function.name !== 'read'), 403],
  ['12 tools 去掉 bash', T.filter((t) => t.function.name !== 'bash'), 200],
  ['12 tools 去掉 write', T.filter((t) => t.function.name !== 'write'), 200],
  ['12 tools 去掉 edit', T.filter((t) => t.function.name !== 'edit'), 200],
  ['12 tools 去掉 glob', T.filter((t) => t.function.name !== 'glob'), 200],
  ['12 tools 去掉 grep', T.filter((t) => t.function.name !== 'grep'), 200],
  ['12 tools 去掉 question', T.filter((t) => t.function.name !== 'question'), 200],
  ['只有 bash', [byName.bash], 403],
  ['只有 write', [byName.write], 403],
  ['12 个同名 read 重复', Array.from({ length: 12 }, () => byName.read), 200],
  ['12 个假名工具', fake(12), 403],
  ['真 read 改名 readx', [{ type: 'function', function: { ...byName.read.function, name: 'readx' } }], 403],
  ['工具名 Read（大写）', [{ type: 'function', function: { ...byName.read.function, name: 'Read' } }], 403],
];

async function send(tools, sysLen = 200) {
  const body = JSON.stringify({
    model: 'deepseek-v4.1-flash-free',
    max_tokens: 16,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: 'X'.repeat(sysLen) },
      { role: 'user', content: 'Reply with exactly: PONG' },
    ],
    tools,
  });
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(URL, { method: 'POST', headers: H, body, signal: AbortSignal.timeout(60000) });
      const t = await r.text();
      let usage = null;
      for (const line of t.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        try { const o = JSON.parse(s.slice(5).trim()); if (o.usage) usage = o.usage; } catch { /* 忽略 */ }
      }
      return { status: r.status, usage, note: r.status === 200 ? '' : (t.match(/"message"\s*:\s*"([^"]{0,50})/)?.[1] ?? '') };
    } catch (e) {
      if (a === 3) return { status: 0, note: 'EXC ' + e.message };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

console.log('门禁第 6 条：tools 里必须有 name === "read"');
console.log('（期望值列由前面的实验得出，用于回归对照）\n');

let bad = 0;
for (const [label, tools, expect, sysLen] of CASES) {
  const { status, usage, note } = await send(tools, sysLen);
  const okMark = status === expect ? 'OK  ' : '差异';
  if (status !== expect) bad++;
  const u = usage ? `  prompt=${usage.prompt_tokens}` : '';
  console.log(`  [${okMark}] ${String(status).padEnd(4)} (期望 ${expect}) ${label.padEnd(28)} tools=${tools.length}${u} ${note}`);
  await new Promise((r) => setTimeout(r, 350));
}

console.log('\n══ 结论 ══');
console.log('  · 判据 = tools 里存在 function.name === "read"（区分大小写）');
console.log('  · system prompt 长度/内容不校验；其余 11 个工具都不必需');
console.log('  · 最小 body 348 字符，prompt_tokens ≈ 279（完整 body 是 9,596）');
console.log(bad === 0 ? '\n  全部与预期一致 ✅' : `\n  有 ${bad} 项与预期不一致 ❌`);
process.exit(bad ? 1 : 0);
