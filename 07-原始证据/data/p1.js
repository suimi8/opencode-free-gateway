const fs=require("fs");
const path=require("path"), os=require("os");
// 不写死绝对路径：优先 $OPENCODE_MODELS，其次按 OpenCode 默认布局从用户目录推导
const MODELS = process.env.OPENCODE_MODELS || path.join(os.homedir(),".cache","opencode","models.json");
const p=MODELS;
const j=JSON.parse(fs.readFileSync(p,"utf8"));
const keys=Object.keys(j);
console.log("TOPLEVEL_KEYS",JSON.stringify(keys));
for(const k of keys){
  if(/opencode/i.test(k)) console.log("MATCH_PROVIDER_KEY",k,JSON.stringify({id:j[k].id,name:j[k].name,npm:j[k].npm,api:j[k].api,env:j[k].env,doc:j[k].doc}));
}
console.log("ALL_PROVIDER_IDS",JSON.stringify(keys));
