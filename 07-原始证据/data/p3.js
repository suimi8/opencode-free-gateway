const fs=require("fs");
const path=require("path"), os=require("os");
// 不写死绝对路径：优先 $OPENCODE_MODELS，其次按 OpenCode 默认布局从用户目录推导
const MODELS = process.env.OPENCODE_MODELS || path.join(os.homedir(),".cache","opencode","models.json");
const j=JSON.parse(fs.readFileSync(MODELS,"utf8"));
for(const pid of ["opencode","opencode-go"]){
  const p=j[pid]; const ms=Object.entries(p.models||{});
  const isFree=m=>m.cost && (m.cost.input===0 && m.cost.output===0);
  const free=ms.filter(([k,m])=>isFree(m));
  const freeActive=free.filter(([k,m])=>m.status!=="deprecated");
  console.log(`=== ${pid}: total=${ms.length} free(cost0)=${free.length} freeActive=${freeActive.length}`);
  console.log("-- FREE ACTIVE --");
  for(const [k,m] of freeActive) console.log(`${m.id} | ctx=${m.limit.context} out=${m.limit.output} in=${m.limit.input||"-"} | cost=${JSON.stringify(m.cost)} | tool_call=${m.tool_call} attach=${m.attachment} reasoning=${m.reasoning} | status=${m.status||"active"} | updated=${m.last_updated}`);
  console.log("-- FREE DEPRECATED (count "+ (free.length-freeActive.length) +") --");
  for(const [k,m] of free.filter(([k,m])=>m.status==="deprecated")) console.log(`${m.id} | ctx=${m.limit.context} out=${m.limit.output} | tool_call=${m.tool_call}`);
  const paid=ms.filter(([k,m])=>!isFree(m));
  console.log("-- PAID (non-zero cost) count "+paid.length+" --");
  for(const [k,m] of paid) console.log(`${m.id} | ctx=${m.limit.context} out=${m.limit.output} | cost_in=${m.cost.input} cost_out=${m.cost.output} | tool_call=${m.tool_call}`);
}
