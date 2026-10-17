#!/usr/bin/env node
/**
 * install-core.mjs —— 下载 mihomo 内核到运行时目录（命令行入口）
 *
 *   node install-core.mjs                    下载最新版
 *   node install-core.mjs --check            只看当前状态
 *   node install-core.mjs --tag v1.19.32     指定版本
 *   MIHOMO_MIRROR=https://ghproxy.net/{} node install-core.mjs    走镜像
 *   MIHOMO_BIN=/path/to/mihomo node install-core.mjs              用已有内核（如 Clash Verge 自带）
 *
 * 面板里也有同一个功能（「代理订阅」页 → 一键安装内核），逻辑共用 core-install.mjs。
 *
 * 为什么不把内核提交进仓库：
 *   mihomo 是 **GPL-3.0** 授权，再分发需附完整许可与源码获取方式，Windows 版还有 61 MB。
 *   运行时从官方发布页下载更干净，也保证用户拿到原版。本仓库的 MIT 许可**不覆盖**该内核。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as M from './mihomo.mjs';
import * as CORE from './core-install.mjs';

const RUNTIME = M.RUNTIME;                 // 支持 MIHOMO_RUNTIME 覆盖
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/* ── --check ── */
if (has('--check')) {
  const st = CORE.coreStatus(RUNTIME);
  console.log(`  内核路径 : ${st.path}`);
  console.log(`  状态     : ${st.installed ? '✅ ' + st.version : (st.exists ? '⚠ ' + st.version : '❌ 未安装')}`);
  console.log(`  平台     : ${st.platform}`);
  console.log(`  大小     : ${st.sizeBytes ? (st.sizeBytes / 1048576).toFixed(1) + ' MB' : '-'}`);
  if (process.env.MIHOMO_BIN) console.log(`  MIHOMO_BIN: ${process.env.MIHOMO_BIN}`);
  if (process.env.MIHOMO_MIRROR) console.log(`  MIHOMO_MIRROR: ${process.env.MIHOMO_MIRROR}`);
  process.exit(st.installed ? 0 : 1);
}

/* ── 用已有内核 ── */
if (process.env.MIHOMO_BIN) {
  const src = process.env.MIHOMO_BIN;
  if (!fs.existsSync(src)) { console.error(`MIHOMO_BIN 不存在: ${src}`); process.exit(2); }
  fs.mkdirSync(RUNTIME, { recursive: true });
  const target = CORE.corePath(RUNTIME);
  fs.copyFileSync(src, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  const st = CORE.coreStatus(RUNTIME);
  if (!st.installed) { console.error(`  ✗ 复制完成但无法执行: ${st.version}`); process.exit(2); }
  console.log(`  ✓ 已从 MIHOMO_BIN 复制: ${src}`);
  console.log(`  ${st.version}`);
  process.exit(0);
}

/* ── 下载 ── */
const tag = argOf('--tag');
console.log(`  平台 ${CORE.platformTag()} · 目标目录 ${RUNTIME}`);
const r = await CORE.installCore({ runtime: RUNTIME, tag });

if (!r.ok) {
  console.error(`  ✗ 安装失败: ${r.error}`);
  if (CORE.JOB.log.length) {
    console.error('  过程:');
    for (const l of CORE.JOB.log) console.error('    ' + l);
  }
  console.error('');
  console.error('  可以试试：');
  console.error('    1. 走镜像： MIHOMO_MIRROR=https://ghproxy.net/{} node install-core.mjs');
  console.error('    2. 用已有内核： MIHOMO_BIN="/path/to/verge-mihomo" node install-core.mjs');
  console.error(`    3. 手动下载后把 mihomo${process.platform === 'win32' ? '.exe' : ''} 放进 ${RUNTIME}`);
  process.exit(1);
}

console.log(`  ✓ 已安装到 ${r.path}`);
console.log(`  ${r.version}`);
console.log('');
console.log('  ⚠ mihomo 为 GPL-3.0 授权，与本仓库的 MIT 许可相互独立。');
console.log('     源码与许可: https://github.com/MetaCubeX/mihomo');
