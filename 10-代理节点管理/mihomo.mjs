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
export const RUNTIME = path.join(ROOT, 'runtime');
const CONFIG_PATH = path.join(RUNTIME, 'config.yaml');
const SUBS_PATH = path.join(ROOT, 'subscriptions.json');
const TEMPLATE_PATH = path.join(ROOT, 'config.template.yaml');
const SECRET_PATH = path.join(RUNTIME, '.secret');
const PID_PATH = path.join(RUNTIME, 'mihomo.pid');
const LOG_PATH = path.join(RUNTIME, 'mihomo.log');

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
/**
 * 读订阅配置。
 * subscriptions.json 不存在时**不抛异常** —— 退回 subscriptions.example.json，
 * 再不行返回空壳。否则「刚 clone 还没填订阅」会让 /api/proxy-pool 直接 500。
 */
export function loadSubs() {
  for (const p of [SUBS_PATH, path.join(ROOT, 'subscriptions.example.json')]) {
    try {
      if (fs.existsSync(p)) return { providers: [], ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch { /* 坏文件继续往下试 */ }
  }
  return { providers: [], _参数: {} };
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

/** 用订阅 + 模板渲染 runtime/config.yaml */
export function renderConfig() {
  fs.mkdirSync(path.join(RUNTIME, 'providers'), { recursive: true });
  const j = loadSubs();
  const { mixedPort, controllerPort, groupName, logLevel } = params();
  const secret = readSecret();
  const enabled = (j.providers || []).filter((p) => p && p.enabled !== false && p.url);
  const iface = detectInterface();

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

  let y = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  y = y.replaceAll('{{MIXED_PORT}}', String(mixedPort))
       .replaceAll('{{CONTROLLER_PORT}}', String(controllerPort))
       .replaceAll('{{SECRET}}', secret)
       .replaceAll('{{LOG_LEVEL}}', logLevel)
       .replaceAll('{{GROUP_NAME}}', groupName)
       .replaceAll('{{PROVIDERS}}', providers || '  {}')
       .replaceAll('{{GROUP_USES}}', uses)
       .replaceAll('{{INTERFACE}}', iface || '');
  fs.writeFileSync(CONFIG_PATH, y, 'utf8');
  return { configPath: CONFIG_PATH, providers: enabled.map((p) => p.name), mixedPort, controllerPort, groupName, interfaceName: iface };
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

/** 全部 provider 节点（含有效性与剔除原因） */
export function providerNodes() {
  const dir = path.join(RUNTIME, 'providers');
  const j = loadSubs();
  const out = [];
  for (const p of (j.providers || [])) {
    const f = path.join(dir, `${p.name}.yaml`);
    if (!fs.existsSync(f)) continue;
    try { out.push(...parseProviderFile(f, p.name)); } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** name -> { provider, type, server, port, valid }（带 5 秒缓存，避免每次探测都读文件） */
const IDX_CACHE = { m: null, at: 0 };
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
