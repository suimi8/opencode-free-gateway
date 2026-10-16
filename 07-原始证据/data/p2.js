const fs=require("fs");
const path=require("path"), os=require("os");
// 不写死绝对路径：优先 $OPENCODE_MODELS，其次按 OpenCode 默认布局从用户目录推导
const MODELS = process.env.OPENCODE_MODELS || path.join(os.homedir(),".cache","opencode","models.json");
const j=JSON.parse(fs.readFileSync(MODELS,"utf8"));
for(const pid of ["opencode","opencode-go"]){
  const p=j[pid];
  const ms=Object.keys(p.models||{});
  console.log("=== "+pid+" models="+ms.length+" api="+p.api+" npm="+p.npm);
  for(const mid of ms){
    const m=p.models[mid];
    console.log(JSON.stringify({id:m.id,name:m.name,family:m.family,status:m.status,tool_call:m.tool_call,attachment:m.attachment,reasoning:m.reasoning,structured_output:m.structured_output,temperature:m.temperature,modalities:m.modalities,limit:m.limit,cost:m.cost,open_weights:m.open_weights,release_date:m.release_date,last_updated:m.last_updated,canonical:m.canonical_model_id}));
  }
}
