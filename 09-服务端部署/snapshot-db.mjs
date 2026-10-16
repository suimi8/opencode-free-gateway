#!/usr/bin/env node
// panel.db 一致性快照 / 备份
//
//   node snapshot-db.mjs <源 panel.db> <目标路径>
//
// 为什么需要它：panel.db 是 WAL 模式，**未 checkpoint 的数据在 panel.db-wal 里**。
// 直接 cp panel.db（或删掉 -wal）会丢掉渠道/令牌/日志等最新数据，甚至拿到损坏的库。
// VACUUM INTO 由 SQLite 自己保证一致性，且**不会修改源库**。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法: node snapshot-db.mjs <源 panel.db> <目标路径>');
  process.exit(2);
}
if (!fs.existsSync(src)) {
  console.error(`源库不存在: ${src}`);
  process.exit(1);
}

const absDst = path.resolve(dst);
fs.mkdirSync(path.dirname(absDst), { recursive: true });
if (fs.existsSync(absDst)) fs.rmSync(absDst, { force: true });

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
// readOnly:true —— 明确声明不写源库（VACUUM INTO 只读源、写目标）
const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO ${q(absDst)}`);
db.close();

// 报告两个库的规模，便于确认快照不是空的
const count = (p) => {
  try {
    const d = new DatabaseSync(p, { readOnly: true });
    const t = (n) => { try { return d.prepare(`SELECT COUNT(*) c FROM ${n}`).get().c; } catch { return '-'; } };
    const r = { channels: t('channels'), tokens: t('tokens'), logs: t('logs'), settings: t('settings') };
    d.close();
    return r;
  } catch (e) { return { err: String(e).slice(0, 80) }; }
};
console.log(`[+] 快照完成  ${src}  ->  ${absDst}`);
console.log(`    源库   ${JSON.stringify(count(src))}`);
console.log(`    快照   ${JSON.stringify(count(absDst))}`);
