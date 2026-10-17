#!/usr/bin/env node
/**
 * manage.mjs —— 代理节点池命令行
 *
 *   node manage.mjs status            实例状态 + 当前节点 + 剩余租约
 *   node manage.mjs nodes [--all]     节点清单（默认只列有效节点）
 *   node manage.mjs test              全池测速（写回延迟，用于排序）
 *   node manage.mjs verify            验证当前节点连通性（真实隧道探测）
 *   node manage.mjs rotate [--force]  轮换到下一个可用节点
 *   node manage.mjs switch <名字>     手动切到指定节点（并验证）
 *   node manage.mjs events [n]        租约/轮换/失效事件
 *   node manage.mjs refresh           重新拉取订阅
 *   node manage.mjs start|stop        启停独立 mihomo 实例
 */
import * as M from './mihomo.mjs';
import * as P from './pool.mjs';

const cmd = (process.argv[2] || 'status').toLowerCase();
const args = process.argv.slice(3);
const has = (f) => args.includes(f);
const pad = (s, n) => String(s ?? '').padEnd(n);
const ms = (d) => (d == null ? '-' : `${d}ms`);
const ago = (t) => (t ? `${((Date.now() - t) / 60000).toFixed(1)} 分钟前` : '-');

switch (cmd) {
  case 'start': {
    console.log(JSON.stringify(await M.start(), null, 2));
    console.log('物理网卡:', M.detectInterface(), ' mixed-port:', M.params().mixedPort, ' 控制器:', M.params().controllerPort);
    break;
  }
  case 'stop': console.log(JSON.stringify(await M.stop(), null, 2)); break;

  /* 改完订阅 / 手加节点后让改动生效：重渲染 config.yaml + 内核重载 */
  case 'apply': console.log(JSON.stringify(await M.applyConfig(), null, 2)); break;

  case 'refresh': {
    const r = await M.refreshProviders();
    for (const x of r) console.log(`  ${x.ok ? 'OK  ' : 'FAIL'} ${pad(x.name, 20)} ${x.ok ? x.bytes + ' B' : x.error}`);
    const s = await P.syncNodes();
    console.log(`  节点同步: 共 ${s.total}，有效 ${s.valid}`);
    break;
  }

  case 'status': {
    const s = await P.state();
    console.log('=== 实例 ===');
    console.log(`  mihomo PID   : ${M.status().pid ?? '(未运行)'}`);
    console.log(`  物理网卡     : ${M.detectInterface()}  (出站绑它绕过 Clash Verge TUN)`);
    console.log(`  mixed-port   : ${M.params().mixedPort}   控制器: ${M.params().controllerPort}`);
    console.log(`  内核         : ${M.status().binary}`);
    console.log('=== 节点池 ===');
    console.log(`  总 ${s.counts.total}  有效 ${s.counts.valid}  已剔除 ${s.counts.rejected}  可用 ${s.counts.available}  租用中 ${s.counts.inUse}  失效 ${s.counts.dead}`);
    console.log(`  租约 ${s.leaseHours}h`);
    console.log('=== 当前节点 ===');
    if (s.active) {
      const a = s.active;
      console.log(`  ${a.name}`);
      console.log(`  来源 ${a.provider}  类型 ${a.type}  ${a.server}:${a.port}`);
      console.log(`  延迟 ${ms(a.delay)}  出口IP ${a.exitIp || '(未知)'}`);
      console.log(`  已用 ${a.ageH}h  剩余租约 ${a.remainH}h`);
      console.log(`  与 mihomo 选中项同步: ${s.inSync ? '✅' : `❌ (mihomo=${s.mihomoSelected})`}`);
    } else console.log('  (无租用中的节点，下次请求时自动选一个)');
    break;
  }

  case 'nodes': {
    await P.syncNodes();
    const rows = P.listNodes({ includeInvalid: has('--all') });
    console.log(`  ${pad('状态', 10)}${pad('延迟', 9)}${pad('来源', 18)}${pad('类型', 8)}${pad('地址', 34)}名字`);
    for (const r of rows) {
      const bad = r.valid ? '' : '  ← 剔除:' + (r.server ? `server=${r.server}` : '广告/占位');
      console.log(`  ${pad(r.status, 10)}${pad(ms(r.delay_ms), 9)}${pad(r.provider, 18)}${pad(r.type, 8)}${pad(`${r.server || '-'}:${r.port || '-'}`, 34)}${r.name.slice(0, 40)}${bad}`);
    }
    console.log(`  共 ${rows.length} 个`);
    break;
  }

  case 'test': {
    await P.syncNodes();
    console.log('  批量测速中（/group/delay，mihomo 内部并发）…');
    const r = await P.testAll();
    if (!r.batchOk) console.log('  ⚠ 批量端点失败:', r.error);
    const ok = r.results.filter((x) => x.ok);
    console.log(`  可达 ${r.reachable}/${r.results.length}`);
    for (const x of ok.slice(0, 20)) console.log(`    ${pad(ms(x.delay), 9)}${x.name.slice(0, 56)}`);
    break;
  }

  case 'verify': {
    const t0 = Date.now();
    const p = await M.probeTunnel({ timeout: Number(process.env.NODE_VERIFY_TIMEOUT || 9000) });
    const s = await P.state();
    console.log(`  当前节点: ${s.active ? s.active.name : '(无)'}`);
    console.log(`  探测结果: ${p.ok ? '✅ 连通' : '❌ 不通'}  HTTP ${p.status ?? '-'}  ${p.ms}ms  ${p.error || ''}`);
    console.log(`  耗时 ${Date.now() - t0}ms`);
    process.exit(p.ok ? 0 : 1);
    break;
  }

  case 'rotate': {
    const r = await P.ensureActive({ force: true });
    if (r.ok) {
      console.log(`  ✅ 已轮换到: ${r.node}  ${ms(r.delay)}  出口IP ${r.exitIp || '(未取到)'}`);
      console.log(`     原因: ${r.reason}  尝试 ${r.tried.length} 个`);
    } else {
      console.log(`  ❌ 轮换失败: ${r.reason}  尝试 ${r.tried.length} 个`);
      for (const t of r.tried) console.log(`     ${t.ok ? '✅' : '❌'} ${t.name.slice(0, 44)} ${t.error || ''}`);
      process.exit(1);
    }
    break;
  }

  case 'switch': {
    const name = args.filter((a) => !a.startsWith('--')).join(' ');
    if (!name) { console.error('用法: node manage.mjs switch <节点名>'); process.exit(2); }
    if (!P.getNode(name)) {
      const hit = P.listNodes().find((r) => r.name.includes(name));
      if (!hit) { console.error(`找不到节点: ${name}`); process.exit(2); }
      console.log(`  (模糊匹配到: ${hit.name})`);
      console.log(JSON.stringify(await P.switchAndVerify(hit.name), null, 2));
      break;
    }
    console.log(JSON.stringify(await P.switchAndVerify(name), null, 2));
    break;
  }

  case 'events': {
    const n = Number(args[0] || 30);
    for (const e of P.events(n)) {
      console.log(`  ${new Date(e.ts).toLocaleString('zh-CN')}  ${pad(e.kind, 10)}${pad((e.node || '').slice(0, 40), 42)}${e.detail || ''}`);
    }
    break;
  }

  default:
    console.log(`未知命令: ${cmd}\n`);
    console.log('用法: node manage.mjs <status|nodes|test|verify|rotate|switch|events|refresh|apply|start|stop> [选项]');
    process.exit(2);
}
