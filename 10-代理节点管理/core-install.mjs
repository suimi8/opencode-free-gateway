/**
 * core-install.mjs —— mihomo 内核的「安装 / 状态 / 进度」
 *
 * 被两处使用：
 *   · install-core.mjs  （命令行）
 *   · 管理面板 /api/proxy-pool/core*（界面上的「一键安装内核」按钮）
 *
 * 为什么不把内核提交进仓库：
 *   mihomo 是 **GPL-3.0**，再分发要附带完整许可与源码获取方式；Windows 版还有 61 MB。
 *   运行时从官方发布页下载更干净，也保证用户拿到原版。本仓库的 MIT **不覆盖**该内核。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const REPO = 'MetaCubeX/mihomo';
const EXE = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';

/**
 * 下载镜像。
 *
 * ⚠️ **不内置任何镜像**：默认只走 GitHub 官方直连。
 * 国内网络需要加速时，由用户自己配置 —— 面板里有一栏「下载镜像」，
 * 或设环境变量 MIHOMO_MIRROR（多个用逗号/换行分隔）。
 * 每一项里 {} 会被替换成原始 URL；没写 {} 就当作前缀。
 *
 * 之所以不预置第三方反代：那些站点随时可能失效、可能被投毒，
 * 也不该由本项目的作者替用户决定流量经过谁的服务器。
 */
export function parseMirrors(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes('{}') ? s : s.replace(/\/?$/, '/') + '{}'));
}

/** 生效的镜像列表（不含直连那一次） */
export function effectiveMirrors(explicit) {
  if (Array.isArray(explicit)) return explicit.map((s) => String(s).trim()).filter(Boolean);
  return parseMirrors(process.env.MIHOMO_MIRROR);
}

/** GitHub 资产名里的平台标记，如 windows-amd64 / linux-arm64 / darwin-arm64 */
export function platformTag(plat = process.platform, arch = process.arch) {
  const p = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[plat];
  if (!p) throw new Error(`不支持的平台: ${plat}`);
  const a = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[arch];
  if (!a) throw new Error(`不支持的架构: ${arch}`);
  return `${p}-${a}`;
}

/** 内核文件应放的位置（跟运行时目录走，桌面版/Docker 里是可写的数据目录） */
export function corePath(runtime) {
  return path.join(runtime, EXE);
}

/** 已装内核的版本；没装返回 null */
export function haveCore(runtime) {
  const target = corePath(runtime);
  if (!fs.existsSync(target)) return null;
  try {
    const out = execFileSync(target, ['-v'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n')[0].trim();
  } catch { return '(存在但无法执行)'; }
}

/** 给界面用的状态 */
export function coreStatus(runtime) {
  const target = corePath(runtime);
  const version = haveCore(runtime);
  return {
    installed: !!version && !version.startsWith('('),
    mirrors: effectiveMirrors().join('\n'),
    version: version || null,
    path: target,
    exists: fs.existsSync(target),
    sizeBytes: fs.existsSync(target) ? fs.statSync(target).size : 0,
    platform: platformTag(),
    execPath: process.execPath,
  };
}

/* ══════════════════════════════════════════════════ 安装进度（供界面轮询） */
export const JOB = {
  running: false, phase: 'idle', message: '', pct: 0,
  ok: null, error: null, version: null, tag: null, bytes: 0, total: 0,
  startedAt: 0, finishedAt: 0, log: [],
};
function setJob(patch) {
  Object.assign(JOB, patch);
  if (JOB.running) JOB.pct = Math.max(0, Math.min(100, Math.round(JOB.pct)));
}
function pushLog(s) {
  JOB.log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
  if (JOB.log.length > 40) JOB.log.shift();
}

/**
 * 极简 ZIP 解压（纯 Node，只用内置 zlib）。
 *
 * 为什么不调 `tar -xf`：Windows 上 `tar` 可能解析到 Git 自带的 **GNU tar**，
 * 它根本不认 zip，报 "Command failed: tar -xf ..."。实测就是这样炸的。
 * 依赖外部工具也不适合桌面版（用户机器上未必有）。
 * mihomo 的 Windows 包只在 zip 里放一个 exe，所以支持 store / deflate 两种方式就够了。
 */
function unzipToDir(buf, dir) {
  const EOCD = 0x06054b50;
  // 从尾部往前找 End Of Central Directory（注释最长 65535）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const written = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/')) continue;              // 目录条目
    // 读本地头拿数据真正起始位置（extra 长度可能和中央目录不同）
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataOff, dataOff + compSize);
    let out;
    if (method === 0) out = raw;
    else if (method === 8) out = zlib.inflateRawSync(raw);
    else continue;                                          // 其它压缩方式跳过

    const flat = path.basename(name);                       // 防目录穿越，只取文件名
    if (!flat) continue;
    fs.writeFileSync(path.join(dir, flat), out);
    written.push(flat);
  }
  if (!written.length) throw new Error('zip 里没有可解出的文件');
  return written;
}

/** 带进度的下载：返回 Buffer，并通过 onProgress(已下载, 总大小) 回报 */
async function downloadWithProgress(url, { onProgress, timeoutMs = 600000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'ocgw-install-core' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length') || 0);
    const chunks = [];
    let got = 0;
    if (r.body) {
      for await (const c of r.body) {
        chunks.push(c);
        got += c.length;
        onProgress?.(got, total);
      }
    } else {
      const b = Buffer.from(await r.arrayBuffer());
      chunks.push(b);
      got = b.length;
      onProgress?.(got, total);
    }
    return { buf: Buffer.concat(chunks), total: total || got };
  } finally { clearTimeout(timer); }
}

/** 依次尝试各个镜像，第一个成功的就用 */
async function downloadAny(originalUrl, opts, mirrorList = []) {
  const list = ['', ...mirrorList];   // '' = 官方直连，永远排第一
  let lastErr = null;
  for (const m of list) {
    const url = m ? m.replace('{}', originalUrl) : originalUrl;
    try {
      pushLog(`下载 ${new URL(url).host}${m ? '（镜像）' : '（官方直连）'}`);
      const r = await downloadWithProgress(url, opts);
      if (r.buf.length < 1_000_000) throw new Error(`文件过小（${r.buf.length} B），可能被拦了`);
      return r;
    } catch (e) {
      lastErr = e;
      pushLog(`  ✗ ${String(e.message).slice(0, 80)}`);
    }
  }
  throw lastErr || new Error('所有下载地址都失败');
}

/** 取 release 元数据；API 失败时退回已知可用的 tag */
async function releaseInfo(tag, mirrorList = []) {
  const api = `https://api.github.com/repos/${REPO}/releases${tag ? `/tags/${tag}` : '/latest'}`;
  for (const m of ['', ...mirrorList]) {
    const url = m ? m.replace('{}', api) : api;
    try {
      const r = await fetch(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'ocgw-install-core', ...(m ? { 'x-forwarded-host': 'api.github.com' } : {}) },
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j && j.tag_name) return j;
      throw new Error('响应里没有 tag_name');
    } catch (e) { pushLog(`  取发布信息失败（${m || '直连'}）: ${String(e.message).slice(0, 60)}`); }
  }
  return null;
}

/**
 * 安装内核。会把进度写进导出的 JOB 对象，界面轮询 /api/proxy-pool/core 拿。
 * @returns {Promise<{ok:boolean, version?:string, tag?:string, bytes?:number, error?:string}>}
 */
export async function installCore({ runtime, tag = null, mirrors: mirrorInput = null } = {}) {
  if (JOB.running) return { ok: false, error: '已经在安装了', busy: true };
  setJob({ ...JOB, running: true, phase: 'resolve', message: '查询最新版本…', pct: 3, ok: null, error: null, log: [], startedAt: Date.now(), finishedAt: 0, bytes: 0, total: 0 });
  const target0 = runtime ? corePath(runtime) : null;   // 先算好；runtime 缺失时留空，由下面统一报错
  try {
    if (!runtime) throw new Error('缺少运行时目录');
    const target = target0;
    fs.mkdirSync(runtime, { recursive: true });

    /* 1) 版本（镜像也用于取 release 元数据） */
    const mirrorList = effectiveMirrors(mirrorInput);
    if (!mirrorList.length) pushLog('未配置镜像，只走官方直连（可在面板「代理订阅」页填下载镜像）');
    let rel = await releaseInfo(tag, mirrorList);
    let ver = rel?.tag_name || tag || null;
    let assets = rel?.assets || [];

    if (!assets.length) {
      // API 不可达：直接按「没有元数据」处理，让调用方提示手动装
      throw new Error('拿不到发布信息（GitHub API 不可达）。可以在命令行设 MIHOMO_MIRROR 后重试，或手动下载后放进 ' + runtime);
    }
    setJob({ phase: 'resolve', pct: 10, message: `找到版本 ${ver}`, tag: ver });
    pushLog(`版本 ${ver}`);

    /* 2) 选资产 */
    const plat = platformTag();
    const pick = assets.find((a) => a.name.includes(plat) && a.name.includes(ver) && !/compatible/i.test(a.name))
      || assets.find((a) => a.name.includes(plat) && !/compatible/i.test(a.name))
      || assets.find((a) => a.name.includes(plat));
    if (!pick) throw new Error(`这个版本没有 ${plat} 的构建（可用: ${assets.slice(0, 6).map((a) => a.name).join(', ')}）`);
    setJob({ phase: 'download', pct: 12, total: pick.size || 0, message: `下载 ${pick.name}（${(pick.size / 1048576).toFixed(1)} MB）` });
    pushLog(`资产 ${pick.name}`);

    /* 3) 下载（带进度 + 镜像回退） */
    const { buf } = await downloadAny(pick.browser_download_url, {
      onProgress: (got, total) => {
        const t = total || pick.size || 0;
        const pct = t ? 12 + (got / t) * 68 : 12 + Math.min(68, got / 2e5);
        setJob({ pct, bytes: got, total: t, message: `下载中 ${(got / 1048576).toFixed(1)}${t ? '/' + (t / 1048576).toFixed(1) : ''} MB` });
      },
    }, mirrorList);
    setJob({ pct: 82, message: '解压中…', bytes: buf.length });
    pushLog(`已下载 ${(buf.length / 1048576).toFixed(1)} MB`);

    /* 4) 解压 */
    const tmp = path.join(os.tmpdir(), `ocgw-core-${Date.now()}-${path.basename(pick.name)}`);
    fs.writeFileSync(tmp, buf);
    const extractDir = path.join(os.tmpdir(), `ocgw-core-x-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      if (pick.name.endsWith('.zip')) {
        // Windows 的发布包是 zip —— 用内置解压，不依赖系统 tar
        unzipToDir(buf, extractDir);
      } else if (pick.name.endsWith('.gz') && !pick.name.endsWith('.tar.gz')) {
        // Linux / macOS 的发布包是单个 .gz
        fs.writeFileSync(path.join(extractDir, EXE), zlib.gunzipSync(buf));
      } else {
        throw new Error(`不认识的压缩格式: ${pick.name}`);
      }
    } catch (e) {
      throw new Error(`解压失败: ${String(e.message).slice(0, 200)}（临时文件 ${tmp}）`);
    }

    /* 5) 找可执行文件（zip 里可能带一层目录） */
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
      const cand = fs.readdirSync(extractDir).find((f) => !f.endsWith('.txt') && !f.endsWith('.md'));
      if (cand) found = path.join(extractDir, cand);
    }
    if (!found) throw new Error('解压后找不到内核文件');

    /* 6) 落地 */
    setJob({ pct: 92, message: '写入并校验…' });
    fs.copyFileSync(found, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    for (const f of [tmp, extractDir]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* 忽略 */ } }

    const version = haveCore(runtime);
    if (!version || version.startsWith('(')) throw new Error('安装完成但内核无法执行，可能架构不匹配或被杀软拦截');

    pushLog(`✓ ${version}`);
    setJob({ running: false, phase: 'done', pct: 100, ok: true, version, tag: ver, message: `已安装 ${version}`, finishedAt: Date.now() });
    return { ok: true, version, tag: ver, bytes: buf.length, path: target };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    pushLog(`✗ ${msg}`);
    setJob({ running: false, phase: 'error', ok: false, error: msg, message: msg, finishedAt: Date.now(), pct: 0 });
    return { ok: false, error: msg };
  }
}
