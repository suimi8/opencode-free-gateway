const fs=require("fs");
const path=require("path"), os=require("os");
// 不写死绝对路径：优先 $OPENCODE_MODELS，其次按 OpenCode 默认布局从用户目录推导
const MODELS = process.env.OPENCODE_MODELS || path.join(os.homedir(),".cache","opencode","models.json");
const j=JSON.parse(fs.readFileSync(MODELS,"utf8"));
const p=j.opencode;
const {models, ...rest}=p;
console.log("=== opencode provider (minus models) ===");
console.log(JSON.stringify(rest,null,2));
const keys=Object.keys(models);
console.log("model count:",keys.length);
const free=keys.filter(k=>models[k].cost&&models[k].cost.input===0);
console.log("=== free model raw entries (first 4) ===");
for(const k of free.slice(0,4)){ console.log(k,"=>",JSON.stringify(models[k])); }
console.log("=== longcat-2.5-preview-free ===");
console.log(JSON.stringify(models["longcat-2.5-preview-free"],null,2));
const pg=j["opencode-go"];
const {models:m2, ...rest2}=pg;
console.log("=== opencode-go provider (minus models) ===");
console.log(JSON.stringify(rest2,null,2));
console.log("=== go longcat-2.5-preview-free ===");
console.log(JSON.stringify(m2["longcat-2.5-preview-free"],null,2));
