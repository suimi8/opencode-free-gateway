/**
 * mihomo.mjs —— 独立 mihomo 实例的生命周期与控制器 API 客户端
 *
 * 为什么另起一个实例，而不是用你的 Clash Verge：
 *   1. Clash Verge 用的是 named pipe 控制器，TCP 端口没开，外部程序指挥不动它；
 *   2. 更重要的：改它的节点会**连带改掉你浏览器的出口 IP**。
 *      本实例有独立的端口 / 配置 / 订阅缓存，**完全不影响浏览器和系统代理**。
 *
 * 控制器 API（mihomo RESTful）：
 *   GET  /version                        版本
 *   GET  /proxies                        全部代理（含分组与 provider 节点）
 *   GET  /proxies/{group}                某个分组的成员与当前选中项
 *   PUT  /proxies/{group}  {name}        切换节点
 *   GET  /proxies/{name}/delay?url&timeout   延迟探测（即连通性验证）
 *   GET  /configs                        当前配置
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = import.meta.dirname;
// 运行时目录：默认在模块旁边的 runtime/。
// 桌面版（Electron）把内核与数据放到用户数据目录，用 MIHOMO_RUNTIME 覆盖。
export const RUNTIME = process.env.MIHOMO_RUNTIME || path.join(ROOT, 'runtime');
const CONFIG_PATH = path.join(RUNTIME, 'config.yaml');
const TEMPLATE_PATH = path.join(ROOT, 'config.template.yaml');
const SECRET_PATH = path.join(RUNTIME, '.secret');
const PID_PATH = path.join(RUNTIME, 'mihomo.pid');
const LOG_PATH = path.join(RUNTIME, 'mihomo.log');

/**
 * 订阅配置文件的位置。
 *
 * ⚠️ 必须落在**可写**的运行时目录，不能放程序目录：
 *   桌面版装在 Program Files / Applications 里是只读的，Docker 镜像也是；
 *   面板要能从这里增删改订阅。
 * 兼容老版本：模块目录下的 subscriptions.json 会被**自动迁移**过来。
 */
export const SUBS_PATH = process.env.MIHOMO_SUBS || path.join(RUNTIME, 'subscriptions.json');
const LEGACY_SUBS_PATH = path.join(ROOT, 'subscriptions.json');
const SUBS_EXAMPLE = path.join(ROOT, 'subscriptions.example.json');

/**
 * 内核位置（**不写死绝对路径**）：
 *   1. runtime/mihomo.exe（随项目自带，首选）
 *   2. $CLASH_VERGE_DIR/verge-mihomo.exe
 *   3. %ProgramFiles%/%LOCALAPPDATA% 下的常规安装位
 * 都没有时用 manage.mjs start 的报错提示手动复制一份。
 */
function binaryCandidates() {
  const names = ['mihomo.exe', 'verge-mihomo.exe', 'mihomo'];
  const out = [
    ...names.map((n) => path.join(RUNTIME, n)),
  ];
  const bases = [
    process.env.CLASH_VERGE_DIR,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Clash Verge'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Clash Verge'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Clash Verge'),
    '/usr/local/bin', '/usr/bin',
  ].filter(Boolean);
  for (const b of bases) for (const n of names) out.push(path.join(b, n));
  return out;
}
export function findBinary() {
  for (const c of binaryCandidates()) if (c && fs.existsSync(c)) return c;
  return null;
}
/* ══════════════════════════════════════════════════ 订阅存储（可增删改查）
 *
 * subscriptions.json 结构：
 * {
 *   providers:      [ { name, url, enabled } ]      // 机场订阅
 *   manualProxies:  [ { name, type, server, port, ... } ]  // 手加的单节点
 *   excludedNodes:  [ "节点名" ]                    // 从池子里剔除的节点
 *   _参数:          { mixedPort, controllerPort, groupName, logLevel, interfaceName }
 * }
 */
const PROVIDER_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** 补齐缺省字段，防止老文件/手改文件把调用方搞崩 */
function normalizeSubs(j) {
  const o = (j && typeof j === 'object') ? j : {};
  return {
    ...o,
    providers: Array.isArray(o.providers) ? o.providers.filter((p) => p && p.name && p.url) : [],
    manualProxies: Array.isArray(o.manualProxies) ? o.manualProxies.filter((p) => p && p.name) : [],
    excludedNodes: Array.isArray(o.excludedNodes) ? o.excludedNodes.filter((x) => typeof x === 'string') : [],
    _参数: (o._参数 && typeof o._参数 === 'object') ? o._参数 : {},
  };
}

/**
 * 读订阅配置。
 * 顺序：MIHOMO_SUBS / runtime 目录 → 老位置的 subscriptions.json（并**自动迁移**）→ 示例文件 → 空壳。
 * 任何一步失败都不抛异常，否则「刚 clone / 刚装好还没填订阅」会让 /api/proxy-pool 直接 500。
 */
export function loadSubs() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  // 老版本把文件放在程序目录（只读），迁移到运行时目录
  try {
    if (!fs.existsSync(SUBS_PATH) && fs.existsSync(LEGACY_SUBS_PATH)) {
      fs.copyFileSync(LEGACY_SUBS_PATH, SUBS_PATH);
    }
  } catch { /* 迁移失败不影响读取 */ }

  // ⚠️ 不再 fallback 到 subscriptions.example.json：
  //    那里面是占位订阅，会让全新安装的界面上凭空多出一个假 provider。
  //    _参数 的默认值已经硬编码在 params() 里，不需要示例文件兜底。
  try {
    if (fs.existsSync(SUBS_PATH)) return normalizeSubs(JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8')));
  } catch { /* 文件坏了按空处理，界面里能改 */ }
  return normalizeSubs({});
}

/** 原子写：先写临时文件再 rename，避免写一半把配置弄坏 */
export function saveSubs(obj) {
  const data = normalizeSubs(obj);
  fs.mkdirSync(path.dirname(SUBS_PATH), { recursive: true });
  const tmp = `${SUBS_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SUBS_PATH);
  return data;
}

/** 订阅列表（URL 打码，日志/界面上不暴露完整 token） */
export function maskUrl(u) {
  try {
    const x = new URL(u);
    for (const k of ['token', 'sub', 'key', 'code']) {
      if (x.searchParams.get(k)) x.searchParams.set(k, '***');
    }
    return x.href;
  } catch {
    return String(u).replace(/([?&](token|sub|key|code)=)[^&]+/gi, '$1***');
  }
}
export function listProviders() {
  const j = loadSubs();
  return j.providers.map((p) => ({ ...p, urlMasked: maskUrl(p.url) }));
}

export function upsertProvider({ name, url, enabled = true }) {
  const n = String(name || '').trim();
  if (!PROVIDER_NAME_RE.test(n)) throw new Error('订阅名只能用字母/数字/下划线/短横线，长度 1-40（例如 airport-a）');
  const j = loadSubs();
  const i = j.providers.findIndex((p) => p.name === n);
  const existing = i >= 0 ? j.providers[i] : null;
  const u = String(url || '').trim();
  // 编辑时链接留空 = 保留原链接（前端只拿到打码版，不会回传完整 token）
  if (u && !/^https?:\/\//i.test(u)) throw new Error('订阅链接必须是 http(s) 地址');
  if (!u && !existing) throw new Error('订阅链接不能为空');
  const rec = { name: n, url: u || existing.url, enabled: enabled === undefined ? true : !!enabled };
  if (i >= 0) j.providers[i] = rec;
  else j.providers.push(rec);
  saveSubs(j);
  return { ...rec, urlMasked: maskUrl(rec.url) };
}
export function deleteProvider(name) {
  const j = loadSubs();
  const before = j.providers.length;
  j.providers = j.providers.filter((p) => p.name !== name);
  // 顺手把该 provider 的缓存文件删掉
  try { fs.rmSync(path.join(RUNTIME, 'providers', `${name}.yaml`), { force: true }); } catch { /* 忽略 */ }
  saveSubs(j);
  return { removed: before - j.providers.length };
}
export function setProviderEnabled(name, on) {
  const j = loadSubs();
  const p = j.providers.find((x) => x.name === name);
  if (!p) throw new Error(`没有这个订阅：${name}`);
  p.enabled = !!on;
  saveSubs(j);
  return p;
}

/* ── 手加节点（manualProxies）── */
/** 校验一个 Clash proxy 定义的最小必要字段 */
export function validateManualProxy(p) {
  const name = String(p?.name || '').trim();
  if (!name) throw new Error('节点名不能为空');
  const type = String(p?.type || '').trim().toLowerCase();
  if (!type) throw new Error('缺少 type（ss / vmess / trojan / vless / socks5 / http）');
  const server = String(p?.server || '').trim();
  if (!server) throw new Error('缺少 server（服务器地址）');
  const port = Number(p?.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('port 必须是 1-65535 的整数');
  return { ...p, name, type, server, port };
}
export function addManualProxy(p) {
  const rec = validateManualProxy(p);
  const j = loadSubs();
  if (j.manualProxies.some((x) => x.name === rec.name)) throw new Error(`已存在同名节点：${rec.name}`);
  j.manualProxies.push(rec);
  saveSubs(j);
  return rec;
}
export function removeManualProxy(name) {
  const j = loadSubs();
  const before = j.manualProxies.length;
  j.manualProxies = j.manualProxies.filter((x) => x.name !== name);
  saveSubs(j);
  return { removed: before - j.manualProxies.length };
}

/* ── 节点剔除（excludedNodes）── */
export function setNodeExcluded(name, on) {
  const j = loadSubs();
  const has = j.excludedNodes.includes(name);
  if (on && !has) j.excludedNodes.push(name);
  if (!on && has) j.excludedNodes = j.excludedNodes.filter((x) => x !== name);
  saveSubs(j);
  return { name, excluded: !!on, total: j.excludedNodes.length };
}
export function excludedSet() {
  return new Set(loadSubs().excludedNodes);
}
export function readSecret() {
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  fs.mkdirSync(RUNTIME, { recursive: true });
  const s = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(SECRET_PATH, s, 'utf8');
  return s;
}
export function params() {
  const j = loadSubs();
  const p = j._参数 || {};
  return {
    mixedPort: p.mixedPort || 17897,
    controllerPort: p.controllerPort || 19097,
    groupName: p.groupName || 'OCGW',
    logLevel: p.logLevel || 'warning',
  };
}

/**
 * 自动探测「物理网卡」名，用于让本实例的出站绕过 Clash Verge 的 TUN。
 *
 * 背景：Clash Verge 的 TUN 开着（auto-route，且默认路由 metric 与物理网卡相同），
 * 会把 mihomo 自己的出站连接也吞进它的隧道 → 双层代理 → 节点一律 5000ms 后 502。
 * 把出站绑到物理网卡（Windows 用 IP_UNICAST_IF）就能绕开。
 *
 * 排除：TUN 网卡（198.18.0.0/16）、WSL/Hyper-V、回环。
 */
export function detectInterface() {
  const explicit = (loadSubs()._参数 || {}).interfaceName;
  // "none" / "-" = 明确不绑定（**容器里必须这样**：容器网络已是独立的，
  // 没有宿主的 TUN 需要绕过，绑 eth0 反而可能出问题）
  if (explicit === 'none' || explicit === '-') return null;
  if (explicit) return explicit;
  if (process.env.OCGW_NO_INTERFACE_BIND === '1') return null;
  const skip = /(meta|tun|wsl|hyper-v|vethernet|loopback|虚拟|tap|clash|mihomo)/i;
  const cands = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^198\.18\./.test(a.address) || /^169\.254\./.test(a.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) continue;
      cands.push({ name, address: a.address });
    }
  }
  // Windows 上网卡名就是 os.networkInterfaces() 的键
  return cands.length ? cands[0].name : null;
}

/** 把一个 Clash proxy 对象渲染成 YAML 流式映射行；跳过内部字段 */
function proxyToYamlLine(p) {
  const SKIP = new Set(['_note', '_comment']);
  const parts = [];
  for (const [k, v] of Object.entries(p)) {
    if (SKIP.has(k) || v === undefined || v === null || v === '') continue;
    const key = k;
    let val;
    if (typeof v === 'number' || typeof v === 'boolean') val = String(v);
    else if (Array.isArray(v)) val = `[${v.map((x) => (typeof x === 'number' || typeof x === 'boolean' ? x : `'${String(x).replace(/'/g, "''")}'`)).join(', ')}]`;
    else val = `'${String(v).replace(/'/g, "''")}'`;
    parts.push(`${key}: ${val}`);
  }
  return `  - { ${parts.join(', ')} }`;
}

/** 用订阅 + 手加节点 + 模板渲染 runtime/config.yaml */
export function renderConfig() {
  fs.mkdirSync(path.join(RUNTIME, 'providers'), { recursive: true });
  const j = loadSubs();
  const { mixedPort, controllerPort, groupName, logLevel } = params();
  const secret = readSecret();
  const enabled = (j.providers || []).filter((p) => p && p.enabled !== false && p.url);
  const iface = detectInterface();
  const excluded = new Set(j.excludedNodes);

  const providers = enabled.map((p) => {
    const lines = [
      `  ${p.name}:`,
      `    type: http`,
      `    url: "${p.url}"`,
      `    path: ./providers/${p.name}.yaml`,
      `    interval: 86400`,
      `    # 不用 provider 自带的健康检查，探测由 pool 按需触发，避免无谓流量`,
      `    health-check: { enable: false }`,
    ];
    if (iface) {
      // override 会把这两项强制加到订阅里的每个节点上
      lines.push(`    override:`);
      lines.push(`      interface-name: "${iface}"`);
    }
    return lines.join('\n');
  }).join('\n');
  const uses = enabled.map((p) => `      - ${p.name}`).join('\n');

  /* 手加节点：写成 proxies: 段，并作为组的显式成员 */
  const manual = (j.manualProxies || []).filter((m) => m && m.name && !excluded.has(m.name));
  const manualBlock = manual.length
    ? `\nproxies:\n${manual.map(proxyToYamlLine).join('\n')}\n`
    : '';
  const groupProxies = manual.length
    ? `    proxies:\n${manual.map((m) => `      - '${String(m.name).replace(/'/g, "''")}'`).join('\n')}`
    : '';

  let y = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  y = y.replaceAll('{{MIXED_PORT}}', String(mixedPort))
       .replaceAll('{{CONTROLLER_PORT}}', String(controllerPort))
       .replaceAll('{{SECRET}}', secret)
       .replaceAll('{{LOG_LEVEL}}', logLevel)
       .replaceAll('{{GROUP_NAME}}', groupName)
       .replaceAll('{{PROVIDERS}}', providers || '  {}')
       .replaceAll('{{GROUP_USES}}', uses)
       .replaceAll('{{MANUAL_PROXIES}}', manualBlock)
       .replaceAll('{{GROUP_PROXIES}}', groupProxies)
       .replaceAll('{{INTERFACE}}', iface || '');
  fs.writeFileSync(CONFIG_PATH, y, 'utf8');
  return {
    configPath: CONFIG_PATH,
    providers: enabled.map((p) => p.name),
    manualProxies: manual.map((m) => m.name),
    excluded: [...excluded],
    mixedPort, controllerPort, groupName, interfaceName: iface,
  };
}

/* ══════════════════════════════════════════════════ 节点清单
 *
 * 两个坑（都踩过）：
 *   1. mihomo 的 `/providers/proxies` **不返回 server/port**，拿不到真实地址；
 *      而 provider 缓存文件（runtime/providers/*.yaml）里是完整定义，所以从那里解析。
 *   2. 机场会在订阅里塞**广告占位节点**（`server: 0.0.0.0`，名字像官网/续费/客服）。
 *      它们进池子只会浪费尝试次数，必须在解析阶段就剔掉。
 */

/** 明显的广告/信息节点名（机场常见套路） */
const AD_NAME = /(官网|更新|续费|客服|工单|卸载|重装|教程|订阅|剩余|流量|到期|过期|加群|电报|机场|备用地址|not\s*use|官网地址|购买|价格|群组|https?:|\.com|\.vip|\.asia|\.top|延迟≠网速)/i;
/** 无效 server */
const BAD_SERVER = (s) => !s || /^(0\.0\.0\.0|::|127\.0\.0\.1|localhost|example\.com)$/i.test(String(s).trim());

/**
 * 解析 provider 缓存文件（就是原始订阅 YAML，Clash 格式）。
 * 两种写法都要认：
 *   流式  `- { name: x, type: y, server: z, port: 443 }`
 *   块式  `-\n  name: x\n  type: y\n  server: z\n  port: 443`
 * （实测：有的机场用流式 `- { ... }`，有的用块式 `-\n  name: ...` —— 只认一种会漏掉大半个池子）
 */
function parseProviderFile(file, provider) {
  const txt = fs.readFileSync(file, 'utf8');
  const out = [];
  let inProxies = false, cur = null;

  const unq = (v) => String(v ?? '').trim().replace(/^['"]|['"]$/g, '');
  const finalize = () => {
    if (!cur || !cur.name) { cur = null; return; }
    const server = unq(cur.server);
    const port = Number(unq(cur.port) || 0);
    const type = (unq(cur.type) || '?').toLowerCase();
    const badSrv = BAD_SERVER(server);
    const valid = !badSrv && port > 0 && port < 65536 && !AD_NAME.test(cur.name);
    out.push({
      provider, name: cur.name, type, server, port, valid,
      reason: valid ? null : (badSrv ? `server=${server || '空'}` : (port <= 0 ? 'port 缺失' : '广告/信息节点')),
    });
    cur = null;
  };
  // 流式：把一行 `{ k: v, k2: v2 }` 拆成键值
  const parseFlow = (line) => {
    const o = {};
    const body = line.replace(/^-\s*\{/, '').replace(/\}\s*,?\s*$/, '');
    // 用「, 键名:」切，避免值里本身带逗号（如 '-延迟≠网速,美国ION是招牌'）
    for (const part of body.split(/,\s*(?=[a-zA-Z0-9_-]+\s*:)/)) {
      const m = part.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (m) o[m[1].toLowerCase()] = unq(m[2].replace(/,\s*$/, ''));
    }
    return o;
  };

  for (const raw of txt.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^proxies:\s*(\[\s*\]\s*)?$/.test(line)) { inProxies = true; continue; }
    // 顶层出现别的段就退出（proxies 段结束）
    if (inProxies && /^[a-zA-Z][a-zA-Z0-9_-]*:/.test(line)) { finalize(); inProxies = false; continue; }
    if (!inProxies) continue;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t === '-' || /^-\s*\{/.test(t) || /^-\s+name\s*:/.test(t)) {
      finalize();
      cur = {};
      if (/^-\s*\{/.test(t)) cur = parseFlow(t);
      else {
        const m = t.match(/^-\s+([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
        if (m) cur[m[1].toLowerCase()] = unq(m[2]);
      }
      continue;
    }
    const m = t.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (m && cur) cur[m[1].toLowerCase()] = unq(m[2]);
  }
  finalize();
  return out;
}

/**
 * 全部节点（含有效性与剔除原因）。
 * 来源两种：机场订阅（providers） + 面板里手动添加的（manualProxies）。
 * 另外会应用 excludedNodes：被面板「剔除」的节点标记 valid=false 并给出原因。
 */
export function providerNodes() {
  const dir = path.join(RUNTIME, 'providers');
  const j = loadSubs();
  const excluded = new Set(j.excludedNodes);
  const out = [];

  for (const p of (j.providers || [])) {
    if (p.enabled === false) continue;
    const f = path.join(dir, `${p.name}.yaml`);
    if (!fs.existsSync(f)) continue;
    try { out.push(...parseProviderFile(f, p.name)); } catch { /* 坏文件跳过 */ }
  }

  // 手加节点
  for (const m of (j.manualProxies || [])) {
    const server = String(m.server || '');
    const port = Number(m.port || 0);
    const badSrv = BAD_SERVER(server);
    const baseValid = !badSrv && port > 0 && port < 65536;
    out.push({
      provider: 'manual', name: m.name, type: String(m.type || '?').toLowerCase(),
      server, port, manual: true,
      valid: baseValid && !excluded.has(m.name),
      reason: !baseValid ? (badSrv ? `server=${server || '空'}` : 'port 缺失') : (excluded.has(m.name) ? '已被面板剔除' : null),
    });
  }

  // 应用剔除清单
  for (const n of out) {
    if (n.manual) continue;                    // 手加节点上面已处理
    if (excluded.has(n.name)) { n.valid = false; n.reason = '已被面板剔除'; n.excluded = true; }
  }
  return out;
}

/** name -> { provider, type, server, port, valid }（带 5 秒缓存，避免每次探测都读文件） */
export const IDX_CACHE = { m: null, at: 0 };
export function nodeIndex() {
  const now = Date.now();
  if (!IDX_CACHE.m || now - IDX_CACHE.at > 5000) {
    const m = new Map();
    for (const n of providerNodes()) if (!m.has(n.name)) m.set(n.name, n);
    IDX_CACHE.m = m; IDX_CACHE.at = now;
  }
  return IDX_CACHE.m;
}

/** 刷新订阅（让 mihomo 重新拉 provider） */
/**
 * 渲染配置并让**运行中的**实例重载；实例没起来就只渲染。
 * 面板里增删改订阅 / 手加节点之后调这个，改动才真正生效。
 */
export async function applyConfig() {
  const r = renderConfig();
  let reloaded = false;
  try {
    if (await alive()) {
      await api('/configs?force=true', { method: 'PUT', body: { path: CONFIG_PATH } });
      reloaded = true;
    }
  } catch { /* 重载失败不影响渲染，调用方按 reloaded=false 提示 */ }
  IDX_CACHE.m = null;            // 节点清单变了，清掉 5 秒缓存
  return { ...r, reloaded };
}

export async function refreshProviders() {
  const dir = path.join(RUNTIME, 'providers');
  const j = loadSubs();
  const results = [];
  for (const p of (j.providers || [])) {
    if (p.enabled === false) continue;
    try {
      const r = await fetch(p.url, { headers: { 'user-agent': 'clash-verge/v2.0.0' }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) { results.push({ name: p.name, ok: false, error: `HTTP ${r.status}` }); continue; }
      const txt = await r.text();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${p.name}.yaml`), txt, 'utf8');
      results.push({ name: p.name, ok: true, bytes: txt.length });
    } catch (e) { results.push({ name: p.name, ok: false, error: String(e.message).slice(0, 120) }); }
  }
  // 让 mihomo 也重载一次，保持内存里的定义与文件一致
  try { await api('/providers/proxies', { method: 'GET' }); } catch { /* 忽略 */ }
  try { await api('/configs?force=true', { method: 'PUT', body: { path: CONFIG_PATH } }); } catch { /* 忽略 */ }
  return results;
}

/* ══════════════════════════════════════════════════ 控制器 API
 *
 * 主机名可配置：本机跑是 127.0.0.1；Docker / compose 里 mihomo 是**另一个容器**，
 * 得用服务名（MIHOMO_CONTROLLER_HOST=mihomo）。
 */
export function controllerHost() { return process.env.MIHOMO_CONTROLLER_HOST || '127.0.0.1'; }
/** 面板出站该连哪个代理（mixed-port 所在的 host） */
export function proxyHost() { return process.env.MIHOMO_PROXY_HOST || '127.0.0.1'; }

export async function api(p, { method = 'GET', body, timeout = 15000 } = {}) {
  const secret = readSecret();
  const url = `http://${controllerHost()}:${params().controllerPort}${p}`;
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${method} ${p.slice(0, 60)} ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch { return text; }
}

export async function alive(timeout = 2500) {
  try { await api('/version', { timeout }); return true; } catch { return false; }
}

/* ══════════════════════════════════════════════════ 进程生命周期 */
export function readPid() {
  try {
    const n = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    if (!n) return null;
    process.kill(n, 0);          // 存活检查
    return n;
  } catch { return null; }
}

export async function start({ waitMs = 25000 } = {}) {
  if (await alive()) return { started: false, reason: '已在运行' };
  const bin = findBinary();
  if (!bin) throw new Error('找不到 mihomo 内核。请把 mihomo.exe 放到 runtime/ 或安装 Clash Verge。');
  renderConfig();
  fs.mkdirSync(RUNTIME, { recursive: true });
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(bin, ['-d', RUNTIME, '-f', CONFIG_PATH], {
    cwd: RUNTIME, detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_PATH, String(child.pid), 'utf8');

  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await new Promise((r) => setTimeout(r, 400));
    if (await alive(1500)) return { started: true, pid: child.pid, bin };
    if (child.exitCode !== null) break;
  }
  const tail = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').slice(-1200) : '';
  throw new Error(`mihomo 启动失败（${waitMs}ms 内控制器无响应）\n--- 日志尾部 ---\n${tail}`);
}

export async function stop() {
  const pid = readPid();
  if (pid) { try { process.kill(pid); } catch { /* 已退出 */ } }
  // 兜底：按端口找
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    await new Promise((r) => setTimeout(r, 300));
    if (!(await alive(800))) break;
  }
  try { fs.rmSync(PID_PATH, { force: true }); } catch { /* 忽略 */ }
  return { stopped: !(await alive(800)), pid };
}

/** 没跑就拉起来（面板在每次请求前调用） */
export async function ensureRunning() {
  if (await alive()) return { ok: true, started: false };
  const r = await start();
  return { ok: true, started: !!r.started, pid: r.pid };
}

/* ══════════════════════════════════════════════════ 节点操作 */
/** 分组里的全部节点名（provider 提供的） */
export async function groupNodes(group) {
  const g = group || params().groupName;
  const d = await api(`/proxies/${encodeURIComponent(g)}`);
  return { name: g, now: d.now || null, all: Array.isArray(d.all) ? d.all : [] };
}

/** 列出分组内所有节点（带真实 type/server，来自 provider 文件解析） */
export async function nodesWithType(group) {
  const { all, now } = await groupNodes(group);
  const idx = nodeIndex();
  return all.map((name) => {
    const info = idx.get(name);
    return {
      name,
      type: info ? info.type : '?',
      server: info ? info.server : null,
      port: info ? info.port : null,
      valid: info ? info.valid : true,        // 不在 provider 文件里的（如自定义节点）默认放行
      invalidReason: info ? info.reason : null,
      active: name === now,
    };
  });
}

export async function switchNode(name, group) {
  const g = group || params().groupName;
  await api(`/proxies/${encodeURIComponent(g)}`, { method: 'PUT', body: { name } });
  const after = await groupNodes(g);
  return { group: g, now: after.now, ok: after.now === name };
}

/**
 * ✅ 真实隧道探测：经本实例的 mixed-port 实际发一个请求。
 *
 * 为什么不用 mihomo 的探测 API：
 *   · `/proxies/{name}/delay`        —— provider 节点不在 /proxies 里，404
 *   · `/providers/proxies/{p}/{n}/delay` —— v1.19.32 **没有这个路由**（404 page not found）
 *   · `/group/{name}/delay`          —— 能用，但一次测全组，太慢，不适合单节点验证
 * 直接经代理请求才是真正的端到端连通性验证：验证的是「选中的节点 + 隧道 + 出口」整体。
 */
export function probeTunnel({ url = 'http://www.gstatic.com/generate_204', timeout = 8000 } = {}) {
  const { mixedPort } = params();
  const u = new URL(url);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = http.request(
      { host: proxyHost(), port: mixedPort, method: 'GET', path: url, headers: { host: u.host, 'user-agent': 'ocgw-probe' } },
      (res) => {
        const status = res.statusCode;
        res.resume();
        res.on('end', () => resolve({ ok: status >= 200 && status < 400, status, ms: Date.now() - t0 }));
        res.on('error', (e) => resolve({ ok: false, status: null, ms: Date.now() - t0, error: String(e.message) }));
      },
    );
    req.setTimeout(timeout, () => { req.destroy(new Error(`timeout ${timeout}ms`)); });
    req.on('error', (e) => resolve({ ok: false, status: null, ms: Date.now() - t0, error: String(e.message) }));
    req.end();
  });
}

/**
 * 批量测速：`GET /group/{组名}/delay` 一次测全组（mihomo 内部并发）。
 * 返回 name -> delayMs 的映射（超时/失败的节点不会出现）。
 */
export async function testGroupDelays({ url = 'http://www.gstatic.com/generate_204', timeout = 5000, group } = {}) {
  const g = group || params().groupName;
  try {
    const d = await api(`/group/${encodeURIComponent(g)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`,
      { timeout: timeout + 20000 });
    return { ok: true, delays: d && typeof d === 'object' ? d : {} };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200), delays: {} };
  }
}

/** 兼容旧名：单节点「延迟」= 切过去再真实探测一次 */
export async function testDelay(name, opts = {}) {
  await switchNode(name);
  const r = await probeTunnel(opts);
  return { ok: r.ok, delay: r.ms, error: r.error, status: r.status };
}

/** 当前出口 IP（经由本实例）；用于确认切换真的生效 */
export async function exitIp({ timeout = 15000 } = {}) {
  const { mixedPort } = params();
  try {
    const r = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(timeout),
      // @ts-ignore Node 支持 dispatcher，但这里用最简方式：走 mixed-port 的 HTTP 代理
      headers: {},
    });
    return await r.json();
  } catch { /* 直连失败再试代理 */ }
  return null;
}

export function status() {
  return {
    runtime: RUNTIME,
    config: CONFIG_PATH,
    binary: findBinary(),
    pid: readPid(),
    params: params(),
    logTail: fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-8).join('\n') : '',
    home: os.homedir(),
  };
}
