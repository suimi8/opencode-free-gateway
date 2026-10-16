const fs=require("fs");
const path=require("path"), os=require("os");
// 不写死绝对路径：优先 $OPENCODE_MODELS，其次按 OpenCode 默认布局从用户目录推导
const MODELS = process.env.OPENCODE_MODELS || path.join(os.homedir(),".cache","opencode","models.json");
const p=MODELS;
const j=JSON.parse(fs.readFileSync(p,"utf8"));
for(const id of ["opencode","opencode-go"]){
  const e=j[id];
  if(!e){console.log(id+": MISSING");continue;}
  const {models,...rest}=e;
  console.log("=== "+id+" ===");
  console.log(JSON.stringify(rest,null,2));
  console.log("model count:",Object.keys(models||{}).length);
}
console.log("ALL PROVIDER IDS:",Object.keys(j).join(", "));
