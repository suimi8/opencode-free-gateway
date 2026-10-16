#!/usr/bin/env node
/**
 * install-core.mjs —— 下载 mihomo 内核到 runtime/
 *
 *   node install-core.mjs              下载最新版
 *   node install-core.mjs --check      只看当前状态
 *   node install-core.mjs --tag v1.19.32   指定版本
 *   MIHOMO_BIN=/path/to/mihomo node install-core.mjs   用已有内核（比如 Clash Verge 自带的）
 *
 * 为什么不把内核提交进仓库：
 *   mihomo 是 **GPL-3.0** 授权。再分发需要附带完整许可与源码获取方式，
 *   而且 Windows 版有 61 MB。运行时从官方发布页下载更干净，也保证用户拿到的是原版。
 *   本仓库的 MIT 许可**不覆盖**该内核，它由自身条款约束。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = import.meta.dirname;
const RUNTIME = path.join(ROOT, 'runtime');
const REPO = 'MetaCubeX/mihomo';
const EXE = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
const TARGET = path.join(RUNTIME, EXE);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

function platformTag() {
  const p = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  if (!p) throw new Error(`不支持的平台: ${process.platform}`);
  const a = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[process.arch];
  if (!a) throw new Error(`不支持的架构: ${process.arch}`);
  return `${p}-${a}`;
}

function haveCore() {
  if (!fs.existsSync(TARGET)) return null;
  try {
    const out = execFileSync(TARGET, ['-v'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n')[0].trim();
  } catch { return '(存在但无法执行)'; }
}

/* ── --check ── */
if (has('--check')) {
  const v = haveCore();
  console.log(`  内核路径 : ${TARGET}`);
  console.log(`  状态     : ${v ? '✅ ' + v : '❌ 未安装'}`);
  console.log(`  平台     : ${platformTag()}`);
  if (process.env.MIHOMO_BIN) console.log(`  MIHOMO_BIN: ${process.env.MIHOMO_BIN}`);
  process.exit(v ? 0 : 1);
}

/* ── 用已有内核 ── */
if (process.env.MIHOMO_BIN) {
  const src = process.env.MIHOMO_BIN;
  if (!fs.existsSync(src)) { console.error(`MIHOMO_BIN 不存在: ${src}`); process.exit(2); }
  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.copyFileSync(src, TARGET);
  if (process.platform !== 'win32') fs.chmodSync(TARGET, 0o755);
  console.log(`  ✓ 已从 MIHOMO_BIN 复制: ${src}`);
  console.log(`  ${haveCore()}`);
  process.exit(0);
}

const tag = argOf('--tag');
const tagPath = tag ? `/tags/${tag}` : '/latest';
const api = `https://api.github.com/repos/${REPO}/releases${tagPath}`;
console.log(`  查询 ${REPO}${tag ? ' ' + tag : ' 最新版'} …`);

const rel = await (await fetch(api, {
  headers: { accept: 'application/vnd.github+json', 'user-agent': 'ocgw-install-core' },
  signal: AbortSignal.timeout(45000),
})).json();
if (!rel || !rel.tag_name) { console.error('  取发布信息失败：', JSON.stringify(rel).slice(0, 200)); process.exit(3); }

const ver = rel.tag_name;
const plat = platformTag();
const assets = rel.assets || [];
// 优先精确匹配，其次任意同平台资产；排除 compatible（给老 CPU 的）与 go 版本后缀变体
const pick = assets.find((a) => a.name.includes(plat) && a.name.includes(ver) && !/compatible/i.test(a.name))
  || assets.find((a) => a.name.includes(plat) && !/compatible/i.test(a.name))
  || assets.find((a) => a.name.includes(plat));
if (!pick) {
  console.error(`  没有匹配 ${plat} 的资产。可用资产：`);
  for (const a of assets.slice(0, 25)) console.error('    ' + a.name);
  process.exit(4);
}

console.log(`  版本 ${ver} · 资产 ${pick.name} (${(pick.size / 1048576).toFixed(1)} MB)`);
const buf = Buffer.from(await (await fetch(pick.browser_download_url, {
  headers: { 'user-agent': 'ocgw-install-core' },
  signal: AbortSignal.timeout(300000),
})).arrayBuffer());
if (buf.length < 1_000_000) { console.error(`  下载过小（${buf.length} B），可能失败`); process.exit(5); }

fs.mkdirSync(RUNTIME, { recursive: true });
const tmp = path.join(os.tmpdir(), `ocgw-core-${Date.now()}-${path.basename(pick.name)}`);
fs.writeFileSync(tmp, buf);

// 解压：Windows 的 .zip 用 tar（Win10+ 自带 bsdtar），其余是 .gz
const extractDir = path.join(os.tmpdir(), `ocgw-core-x-${Date.now()}`);
fs.mkdirSync(extractDir, { recursive: true });
try {
  if (pick.name.endsWith('.gz') && !pick.name.endsWith('.tar.gz')) {
    const zlib = await import('node:zlib');
    fs.writeFileSync(path.join(extractDir, EXE), zlib.gunzipSync(buf));
  } else {
    execFileSync('tar', ['-xf', tmp, '-C', extractDir], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  }
} catch (e) {
  console.error(`  解压失败: ${String(e.message).slice(0, 200)}`);
  console.error(`  可手动解压 ${tmp} 并把 ${EXE} 放到 ${RUNTIME}`);
  process.exit(6);
}

// 找到解压出来的可执行文件（zip 里可能带目录）
let found = null;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/^mihomo(\.exe)?$/i.test(e.name) || /mihomo.*(amd64|arm64|armv7)/i.test(e.name)) found = found || p;
  }
};
walk(extractDir);
if (!found) {
  const flat = fs.readdirSync(extractDir);
  const cand = flat.find((f) => !f.endsWith('.txt') && !f.endsWith('.md'));
  if (cand) found = path.join(extractDir, cand);
}
if (!found) { console.error('  解压后找不到内核文件'); process.exit(7); }

fs.copyFileSync(found, TARGET);
if (process.platform !== 'win32') fs.chmodSync(TARGET, 0o755);
for (const f of [tmp, extractDir]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* 忽略 */ } }

const v = haveCore();
console.log(`  ✓ 已安装到 ${TARGET}`);
console.log(`  ${v}`);
console.log('');
console.log('  ⚠ mihomo 为 GPL-3.0 授权，与本仓库的 MIT 许可相互独立。');
console.log(`     源码与许可: https://github.com/${REPO}`);
