const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// 不写死绝对路径：优先 $OPENCODE_DB，其次按 OpenCode 的默认布局从用户目录推导
const DB = process.env.OPENCODE_DB
  || path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
if (!fs.existsSync(DB)) {
  console.error('找不到 OpenCode 数据库: ' + DB);
  console.error('请设置环境变量 OPENCODE_DB 指向 opencode.db 后重试。');
  process.exit(1);
}
console.log('db = ' + DB + '\n');
const db = new DatabaseSync(DB);
const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ ERR: String(e).slice(0, 200) }]; } };

console.log('=== probe session exists? ===');
console.log(JSON.stringify(q("SELECT id, json_extract(data,'$.title') title FROM session WHERE id='ses_ebd010471ffeln4CI1OocCuN9V'")));

console.log('\n=== probe session messages ===');
console.log(JSON.stringify(q("SELECT json_extract(data,'$.role') role, json_extract(data,'$.modelID') model, json_extract(data,'$.time.created') t, json_extract(data,'$.tokens.input') ti, json_extract(data,'$.tokens.output') to_, json_extract(data,'$.cost') cost, substr(json_extract(data,'$.error'),1,200) err FROM message WHERE json_extract(data,'$.sessionID')='ses_ebd010471ffeln4CI1OocCuN9V'"), null, 1));

console.log('\n=== last 25 assistant messages ===');
const rows = q("SELECT json_extract(data,'$.sessionID') sid, json_extract(data,'$.modelID') model, json_extract(data,'$.providerID') prov, json_extract(data,'$.time.created') t, json_extract(data,'$.tokens.input') ti, json_extract(data,'$.tokens.output') to_, json_extract(data,'$.cost') cost, substr(json_extract(data,'$.error'),1,300) err FROM message WHERE json_extract(data,'$.role')='assistant' ORDER BY json_extract(data,'$.time.created') DESC LIMIT 25");
for (const r of rows) console.log(`${r.t} ${r.prov}/${r.model} in=${r.ti} out=${r.to_} cost=${r.cost} err=${r.err ?? '-'}`);

console.log('\n=== assistant messages with error, by model (top 15) ===');
console.log(JSON.stringify(q("SELECT json_extract(data,'$.modelID') model, count(*) n FROM message WHERE json_extract(data,'$.role')='assistant' AND json_extract(data,'$.error') IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 15"), null, 1));

console.log('\n=== free-model assistant msgs with output>0 vs =0 (recent 7 days) ===');
console.log(JSON.stringify(q("SELECT json_extract(data,'$.modelID') model, sum(CASE WHEN json_extract(data,'$.tokens.output')>0 THEN 1 ELSE 0 END) ok, sum(CASE WHEN IFNULL(json_extract(data,'$.tokens.output'),0)=0 THEN 1 ELSE 0 END) zero, count(*) total FROM message WHERE json_extract(data,'$.role')='assistant' AND json_extract(data,'$.modelID') LIKE '%-free' AND json_extract(data,'$.time.created') > (strftime('%s','now')-7*86400)*1000 GROUP BY 1 ORDER BY total DESC LIMIT 15"), null, 1));
