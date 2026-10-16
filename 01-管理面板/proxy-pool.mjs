/**
 * proxy-pool.mjs —— 面板 ↔ 代理节点池 的适配层
 *
 * 关键点：
 *   · 节点池只在**模型请求这一个出口**生效（面板的 upstream 调用），
 *     不碰系统代理、不碰 TUN、不碰浏览器 —— 你的网页访问走的是 Clash Verge，与本池无关。
 *   · 请求前会 ensureActive()：验证当前节点连通性；租约满 24h 或验证失败就自动轮换。
 *   · 并发去重：同时来 10 个模型请求，只做一次验证。
 *
 * 开关：PANEL_NODE_POOL=0 关闭（退回渠道里手填的代理地址）
 *       PANEL_NODE_POOL_PROXY 直接指定出口代理串（默认用池子实例的 mixed-port）
 */
import * as P from '../10-代理节点管理/pool.mjs';
import * as M from '../10-代理节点管理/mihomo.mjs';

export const enabled = () => String(process.env.PANEL_NODE_POOL ?? '1') !== '0';
/** 池子实例的代理地址（HTTP 代理，mixed-port 同时支持 HTTP 与 SOCKS5） */
export const proxyUrl = () => process.env.PANEL_NODE_POOL_PROXY || `http://127.0.0.1:${M.params().mixedPort}`;

let inflight = null;
/**
 * 保证「现在有一个已验证可用的出口」。
 * 返回 { ok, node, delay, exitIp, rotated, reason, tried }
 */
export function ensureReady() {
  if (!enabled()) return Promise.resolve({ ok: true, skipped: true, reason: 'node-pool-disabled' });
  if (!inflight) {
    inflight = P.ensureActive()
      .catch((e) => ({ ok: false, reason: String((e && e.message) || e) }))
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export const state = () => P.state();
export const listNodes = (o) => P.listNodes(o);
export const events = (n) => P.events(n);
export const rotate = () => P.ensureActive({ force: true });

/**
 * 上游额度耗尽（429）→ 切换出口节点，好让调用方换 IP 重试。
 * 所有出口都撞过 429 时返回 { ok:false, reason:'all-nodes-quota-hit' } —— 不再白烧节点池。
 */
export const onQuotaExhausted = (avoid = []) => P.rotateForQuota({ avoid });
/** 模型请求成功 → 清掉当前节点的额度记忆 */
export const onModelSuccess = () => { const a = P.activeNode(); if (a) P.clearQuotaFail(a.name); };
/** 额度窗口内还没撞过 429 的出口数 */
export const quotaFresh = () => P.quotaFreshCount();
export const verifyNow = () => M.probeTunnel({ timeout: Number(process.env.NODE_VERIFY_TIMEOUT || 9000) }).then((p) => ({ ...p }));
export const instance = () => ({ ...M.status(), interfaceName: M.detectInterface(), params: M.params() });
export const startInstance = () => M.start();
export const stopInstance = () => M.stop();
export const refreshSubs = async () => { const r = await M.refreshProviders(); await P.syncNodes(); return r; };
export const testAll = () => P.testAll();
export { P, M };

/**
 * 定时轮换器：即使没有模型请求，也会在租约到期后按计划切换节点。
 * 每 checkMs 检查一次；ensureActive() 内部会判断「租约是否到期 / 节点是否还通」，
 * 没到期就是零成本（读缓存）。
 */
let timer = null;
export function startScheduler({ checkMs = Number(process.env.NODE_POOL_CHECK_MS || 15 * 60e3) } = {}) {
  if (!enabled() || timer) return { running: false };
  const tick = async () => {
    try {
      const r = await ensureReady();
      if (r.rotated) console.log(`[节点池] 已轮换到 ${r.node}（${r.reason}）出口IP ${r.exitIp || '?'}`);
    } catch (e) { /* 下一轮再试 */ }
  };
  timer = setInterval(tick, checkMs);
  timer.unref?.();
  setTimeout(tick, 8000).unref?.();          // 启动 8 秒后先跑一次
  return { running: true, checkMs };
}
export function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

/** 把 mihomo 的选中项拉回租约持有者（幂等，供 GET 时保持界面准确） */
export async function resync() {
  const s = await P.state();
  if (s.active && !s.inSync) {
    await M.switchNode(s.active.name).catch(() => {});
    return { switched: true, to: s.active.name };
  }
  return { switched: false };
}
