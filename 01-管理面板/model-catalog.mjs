/**
 * model-catalog.mjs —— 统一模型目录
 *
 * 两个数据源合并：
 *   1. 上游 https://opencode.ai/inference/v1/models
 *      → 权威的「当前有哪些模型」（只有 id，没有元数据）
 *   2. https://models.dev/api.json 里的 opencode 提供商
 *      → 每个模型的上下文长度、输出上限、是否支持思考/工具/图片
 *
 * 注意：**只拉列表，不逐个探测**。
 * 之前每 30 分钟把 85 个模型各发一次 chat 请求，被上游判为异常流量。
 * 这里总共只有 2 个 HTTP 请求（列表 + 元数据），频率也很低，是安全的。
 */
import fs from 'node:fs';
import path from 'node:path';

const UPSTREAM_MODELS = 'https://opencode.ai/inference/v1/models';
const MODELS_DEV = 'https://models.dev/api.json';

/** 思考强度：统一成这三个档，客户端不用管上游各自怎么叫 */
export const REASONING_EFFORTS = ['low', 'medium', 'high'];

/** 目录文件位置（和 panel.db 同目录） */
export function catalogPath() {
  const db = process.env.PANEL_DB || path.join(process.cwd(), 'panel.db');
  return path.join(path.dirname(db), 'model-catalog.json');
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(catalogPath(), 'utf8')); } catch { return null; }
}

function writeCache(obj) {
  const p = catalogPath();
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}

/** 拉上游当前模型 id 列表 */
async function fetchUpstreamIds() {
  const r = await fetch(UPSTREAM_MODELS, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`上游模型列表 HTTP ${r.status}`);
  const j = await r.json();
  return (j.data || []).map((m) => m.id).filter(Boolean);
}

/** 拉 models.dev 里 opencode 提供商的元数据 */
async function fetchMetadata() {
  const r = await fetch(MODELS_DEV, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`models.dev HTTP ${r.status}`);
  const j = await r.json();
  const oc = j.opencode || j['opencode-zen'] || null;
  if (!oc || !oc.models) return {};
  const out = {};
  for (const [id, m] of Object.entries(oc.models)) {
    const lim = m.limit || {};
    out[id] = {
      context: lim.context ?? null,
      input: lim.input ?? lim.context ?? null,
      output: lim.output ?? null,
      reasoning: !!m.reasoning,
      tools: m.tool_call !== false,
      vision: !!m.attachment,
      name: m.name || id,
    };
  }
  return out;
}

/**
 * 刷新目录。两个请求，很快。
 * @returns {Promise<{ok:boolean, count:number, at:number, error?:string}>}
 */
export async function refresh() {
  let ids = [];
  let meta = {};
  let err = null;

  try { ids = await fetchUpstreamIds(); } catch (e) { err = String(e.message || e); }
  try { meta = await fetchMetadata(); } catch (e) { err = (err ? err + '; ' : '') + String(e.message || e); }

  const prev = readCache();
  // 上游列表拉失败就沿用旧列表，别把目录清空
  if (!ids.length && prev && Array.isArray(prev.models)) {
    ids = prev.models.map((m) => m.id);
  }
  if (!ids.length) return { ok: false, count: 0, at: Date.now(), error: err || '两个数据源都失败' };

  const models = ids.map((id) => {
    const m = meta[id] || {};
    return {
      id,
      object: 'model',
      owned_by: 'opencode',
      context_length: m.context ?? null,
      max_input_tokens: m.input ?? null,
      max_output_tokens: m.output ?? null,
      supports_reasoning: !!m.reasoning,
      reasoning_efforts: m.reasoning ? REASONING_EFFORTS.slice() : [],
      supports_tools: m.tools !== false,
      supports_vision: !!m.vision,
      display_name: m.name || id,
    };
  });

  const doc = {
    at: Date.now(),
    source: { upstream: UPSTREAM_MODELS, metadata: MODELS_DEV },
    total: models.length,
    models,
  };
  const saved = writeCache(doc);
  return { ok: true, count: models.length, at: doc.at, saved, error: err || undefined };
}

/** 读目录（没有就返回空结构，不抛错） */
export function list() {
  const c = readCache();
  if (!c || !Array.isArray(c.models)) return { at: null, total: 0, models: [] };
  return c;
}

/** 按 id 查单个模型 */
export function get(id) {
  const c = list();
  return c.models.find((m) => m.id === id) || null;
}

/** 给 /v1/models 用的精简结构（OpenAI 兼容 + 扩展字段） */
export function openAiList() {
  const c = list();
  return c.models.map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor((c.at || Date.now()) / 1000),
    owned_by: m.owned_by,
    // 扩展字段（OpenAI 客户端会忽略，但自己的客户端能用）
    context_length: m.context_length,
    max_output_tokens: m.max_output_tokens,
    supports_reasoning: m.supports_reasoning,
    reasoning_efforts: m.reasoning_efforts,
    supports_tools: m.supports_tools,
    supports_vision: m.supports_vision,
  }));
}

/** 目录里所有 free 模型的 id（给渠道自动同步用） */
export function freeModelIds() {
  return list().models.map((m) => m.id).filter((x) => x.includes('free'));
}
