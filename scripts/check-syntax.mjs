#!/usr/bin/env node
/**
 * scripts/check-syntax.mjs —— 全量 JS 语法检查（跨平台，CI 用）
 *
 * 比在 CI 里写 shell 循环更可靠：Windows 的 pwsh / Linux 的 bash 引号规则不同，
 * 用 Node 统一处理，顺便把「有没有误提交凭据」也一起查了。
 *
 *   node scripts/check-syntax.mjs           语法 + 凭据扫描
 *   node scripts/check-syntax.mjs --syntax  只查语法
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONLY_SYNTAX = process.argv.includes('--syntax');

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'dist-desktop', 'runtime', '08-上游源码快照', '99-解包产物与运行时残留', 'tmp', 'temp']);
const exts = new Set(['.mjs', '.js', '.cjs']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); }
    else if (exts.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = walk(ROOT).sort();
console.log(`\n语法检查：${files.length} 个 JS 文件`);

let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  } catch (e) {
    bad++;
    console.log(`  [FAIL] ${path.relative(ROOT, f)}`);
    console.log('         ' + String(e.stderr || e.message).split('\n').slice(0, 3).join('\n         '));
  }
}
console.log(bad ? `  ${files.length - bad}/${files.length} 通过，${bad} 个失败` : `  ✅ ${files.length}/${files.length} 全部通过`);

/* ── 凭据泄漏扫描：防止把密钥误提交进公开仓库 ──
 * 每个模式带一个 allow 谓词，避免把「文档里的占位符」误报成泄漏。
 */
let leaked = 0;
const PATTERNS = [
  { re: /sk-oc-[A-Za-z0-9]{16,}/g, label: '面板令牌 sk-oc-…' },
  {
    re: /subscribe\?token=([A-Za-z0-9_-]+)/gi,
    label: '订阅链接 token',
    allow: (m) => /^(PUT|YOUR|EXAMPLE|TOKEN|xxx|placeholder)/i.test(m[1]),
  },
  {
    re: /C:\\Users\\([A-Za-z0-9_.-]+)\\/g,
    label: '本机用户路径',
    allow: (m) => /^(user1|user|username|you|your|test|runner|admin|public|default)$/i.test(m[1]),
  },
];
const SCAN_EXT = new Set(['.mjs', '.js', '.json', '.md', '.txt', '.yml', '.yaml', '.ps1', '.sh', '.cmd']);
const allowFiles = new Set(['LICENSE', 'package-lock.json']);

if (!ONLY_SYNTAX) {
  console.log('\n凭据泄漏扫描：');
  const scanFiles = (function w(d, out = []) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) w(p, out); }
      else if (SCAN_EXT.has(path.extname(e.name)) && !allowFiles.has(e.name)) out.push(p);
    }
    return out;
  })(ROOT);

  for (const f of scanFiles) {
    let t;
    try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (t.length > 4_000_000) continue;
    for (const { re, label, allow } of PATTERNS) {
      re.lastIndex = 0;
      const hits = [...t.matchAll(re)].filter((m) => !(allow && allow(m)));
      if (hits.length) {
        leaked++;
        console.log(`  [LEAK] ${path.relative(ROOT, f)}  →  ${label}  (${hits.length} 处)`);
        for (const h of hits.slice(0, 2)) console.log(`         ${String(h[0]).slice(0, 70)}`);
      }
    }
  }
  if (!leaked) console.log('  ✅ 未发现凭据 / 本机路径');
}

process.exit(bad || leaked ? 1 : 0);
