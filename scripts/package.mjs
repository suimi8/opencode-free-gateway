#!/usr/bin/env node
/**
 * scripts/package.mjs —— 打发布包（跨平台，无第三方依赖）
 *
 *   node scripts/package.mjs
 *
 * 产出（dist/）：
 *   opencode-free-gateway-<version>.tar.gz   所有平台
 *   opencode-free-gateway-<version>.zip      Windows / macOS / Linux（有 zip 就用）
 *   SHA256SUMS.txt                           校验和
 *
 * 打包内容 = 仓库里除 .git / dist / runtime / node_modules 之外的全部文件。
 * **不含**任何凭据、订阅、内核二进制 —— 与仓库内容一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = pkg.name;
const VER = pkg.version;
const DIST = path.join(ROOT, 'dist');
const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'ocgw-pkg-'));

const SKIP_DIR = new Set(['.git', 'dist', 'node_modules', 'runtime', '08-上游源码快照', '99-解包产物与运行时残留', 'tmp', 'temp']);
const SKIP_FILE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'subscriptions.json', '.secret', '.testkey']);
const SKIP_EXT = new Set(['.db', '.db-wal', '.db-shm', '.log', '.exe', '.zip', '.gz', '.tgz']);

const BASE = `${NAME}-${VER}`;
const STAGE_ROOT = path.join(STAGE, BASE);
fs.mkdirSync(STAGE_ROOT, { recursive: true });

let count = 0, bytes = 0;
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) copyTree(path.join(from, e.name), path.join(to, e.name)); continue; }
    if (SKIP_FILE.has(e.name)) continue;
    if (SKIP_EXT.has(path.extname(e.name))) continue;
    if (e.name.endsWith('-wal') || e.name.endsWith('-shm')) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    fs.copyFileSync(src, dst);
    const st = fs.statSync(src);
    count++; bytes += st.size;
  }
}
copyTree(ROOT, STAGE_ROOT);
console.log(`\n暂存 ${count} 个文件 (${(bytes / 1048576).toFixed(2)} MB) → ${STAGE_ROOT}`);

fs.mkdirSync(DIST, { recursive: true });
const tarGz = path.join(DIST, `${BASE}.tar.gz`);
const zip = path.join(DIST, `${BASE}.zip`);
const made = [];

/* tar.gz：所有平台都有 tar（Windows 10+ 自带 bsdtar）
 * ⚠️ 不能给 tar 绝对路径 —— Windows 的 bsdtar 会把 `D:\...` 里的 `D:` 当成远程主机名。
 *    解决办法：cwd 切到 dist，传相对文件名。 */
try {
  execFileSync('tar', ['-czf', `${BASE}.tar.gz`, '-C', STAGE, BASE],
    { cwd: DIST, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  made.push(tarGz);
  console.log(`  ✓ ${path.basename(tarGz)}  ${(fs.statSync(tarGz).size / 1048576).toFixed(2)} MB`);
} catch (e) {
  console.error(`  ✗ tar.gz 失败: ${String(e.stderr || e.message).slice(0, 200)}`);
}

/* zip：优先 zip 命令；Windows 用 PowerShell Compress-Archive */
const tryZip = () => {
  try {
    execFileSync('zip', ['-qr', zip, BASE], { cwd: STAGE, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    return true;
  } catch { return false; }
};
const tryCompressArchive = () => {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${STAGE_ROOT}' -DestinationPath '${zip}' -Force`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    return true;
  } catch { return false; }
};
if (tryZip() || tryCompressArchive()) {
  made.push(zip);
  console.log(`  ✓ ${path.basename(zip)}  ${(fs.statSync(zip).size / 1048576).toFixed(2)} MB`);
} else {
  console.log('  · 跳过 zip（本机没有 zip / Compress-Archive）');
}

/* SHA256 */
if (made.length) {
  const lines = made.map((f) => {
    const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    return `${h}  ${path.basename(f)}`;
  });
  const sums = path.join(DIST, 'SHA256SUMS.txt');
  fs.writeFileSync(sums, lines.join('\n') + '\n', 'utf8');
  console.log(`  ✓ SHA256SUMS.txt\n${lines.map((l) => '      ' + l).join('\n')}`);
}

try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(`\n完成 → ${DIST}`);
process.exit(made.length ? 0 : 1);
