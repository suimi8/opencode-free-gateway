/**
 * bridge.mjs — 协议互转层
 *
 * 上游的免费模型是**按协议绑定**的（2026-10-17 实测）：
 *   9 个只支持 /chat/completions，1 个（muse-spark）只支持 /responses。
 * 但客户端（Codex 用 responses；OpenAI SDK 用 chat）不该关心这件事。
 *
 * 本模块把「客户端协议」与「模型原生协议」解耦：
 *   客户端 chat      + 模型 responses → chat 请求转 responses，响应转回 chat
 *   客户端 responses + 模型 chat      → responses 请求转 chat，响应转回 responses
 *
 * 只做纯转换，不碰网络，便于单测。
 */

/* ══════════════════════════════════════════════════ 请求体互转 */

/** chat messages(嵌套 tools) → responses(input + 扁平 tools + instructions) */
export function chatToResponses(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).filter(Boolean);
  const callerInstr = typeof body.instructions === 'string' ? body.instructions : '';
  const instructions = [callerInstr, ...sys].filter(Boolean).join('\n\n');

  const input = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id || '', output: textOf(m.content) });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const text = textOf(m.content);
      if (text) input.push(msg('assistant', text, 'output_text'));
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          id: tc.id || `fc_${Math.random().toString(36).slice(2, 12)}`,
          call_id: tc.id || '',
          name: (tc.function && tc.function.name) || '',
          arguments: (tc.function && tc.function.arguments) || '{}',
        });
      }
      continue;
    }
    input.push(msg(m.role === 'assistant' ? 'assistant' : (m.role === 'developer' ? 'developer' : 'user'),
      textOf(m.content), m.role === 'assistant' ? 'output_text' : 'input_text'));
  }

  const out = { model: body.model, input, stream: true, store: false };
  if (instructions) out.instructions = instructions;
  if (Array.isArray(body.tools) && body.tools.length) out.tools = body.tools.map(chatToolToFlat).filter(Boolean);
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  const mo = body.max_output_tokens ?? body.max_tokens;
  if (mo) out.max_output_tokens = mo;
  return out;
}

/** responses(input + 扁平 tools + instructions) → chat messages(嵌套 tools) */
export function responsesToChat(body) {
  const msgs = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    msgs.push({ role: 'system', content: body.instructions });
  }
  /* Responses API 的 input 允许三种写法，都要认：
   *   1. 纯字符串                     {"input": "你好"}
   *   2. 字符串数组                   {"input": ["你好", "再说一遍"]}
   *   3. 结构化的 message 数组        {"input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}]}
   *
   * ⚠️ 只认数组会让第 1 种（也是**最常见**的写法）直接变成空 messages，
   *    上游报 "Empty input messages" 400 —— 实测踩过。
   */
  const input = Array.isArray(body.input)
    ? body.input
    : (typeof body.input === 'string' ? [body.input] : []);
  // 同一个 assistant 回合里的 function_call 要合成一条带 tool_calls 的 assistant 消息
  let pendingCalls = [];
  const flushCalls = () => {
    if (!pendingCalls.length) return;
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingCalls.map((c) => ({
        id: c.call_id || c.id, type: 'function',
        function: { name: c.name || '', arguments: c.arguments || '{}' },
      })),
    });
    pendingCalls = [];
  };

  for (const item of input) {
    if (typeof item === 'string') { flushCalls(); msgs.push({ role: 'user', content: item }); continue; }
    if (!item || typeof item !== 'object') continue;
    switch (item.type) {
      case 'message': {
        flushCalls();
        const role = item.role === 'assistant' ? 'assistant' : (item.role === 'system' ? 'system' : (item.role === 'developer' ? 'developer' : 'user'));
        msgs.push({ role, content: textOf(item.content) });
        break;
      }
      case 'function_call': pendingCalls.push(item); break;
      case 'function_call_output': {
        flushCalls();
        msgs.push({ role: 'tool', tool_call_id: item.call_id || '', content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
        break;
      }
      default: {
        // 其它 item（reasoning / item_reference 等）不转换，避免污染对话
        break;
      }
    }
  }
  flushCalls();

  const out = { model: body.model, messages: msgs, stream: !!body.stream };
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools.filter((t) => t && (t.type === 'function' || t.function)).map(flatToolToChat).filter(Boolean);
    if (tools.length) out.tools = tools;
  }
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  const mo = body.max_output_tokens;
  if (mo) out.max_tokens = mo;
  return out;
}

function msg(role, text, contentType) {
  return { type: 'message', role, content: [{ type: contentType, text }] };
}
function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      return p.text ?? p.content ?? '';
    }).join('');
  }
  if (typeof content === 'object') return content.text ?? '';
  return String(content);
}
function chatToolToFlat(t) {
  const f = t.function || t;
  if (!f || !f.name) return null;
  return { type: 'function', name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } };
}
function flatToolToChat(t) {
  const f = t.function || t;
  if (!f || !f.name) return null;
  return { type: 'function', function: { name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } } };
}

/* ══════════════════════════════════════════════════ SSE 互转 */

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

/**
 * 上游 chat SSE → 客户端 Responses SSE。
 * 返回一个「喂一行、吐若干行」的转换器（行必须是完整的 SSE 行，不含换行符）。
 */
export function makeChatToResponsesStream(model) {
  const responseId = rid('resp');
  const createdAt = Math.floor(Date.now() / 1000);
  const itemId = rid('msg');
  let started = false, text = '', usage = null, finish = null;
  const toolCalls = new Map();          // index -> { id, name, args }
  const emittedTools = new Set();
  const out = [];

  const baseResponse = (status) => ({
    id: responseId, object: 'response', created_at: createdAt, status,
    model, output: [], parallel_tool_calls: true, tool_choice: 'auto', tools: [],
  });
  const ev = (type, payload) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);

  const ensureStart = () => {
    if (started) return;
    started = true;
    ev('response.created', { response: baseResponse('in_progress') });
    ev('response.in_progress', { response: baseResponse('in_progress') });
  };
  const ensureTextItem = () => {
    if (emittedTools.has('__text__')) return;
    emittedTools.add('__text__');
    ev('response.output_item.added', {
      output_index: 0,
      item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    ev('response.content_part.added', {
      item_id: itemId, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  return {
    /** 喂一行上游 SSE；返回需要写给客户端的字符串（可能为空串） */
    push(line) {
      out.length = 0;
      const t = String(line).trim();
      if (!t.startsWith('data:')) return '';
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return '';
      let o;
      try { o = JSON.parse(payload); } catch { return ''; }
      const choice = o.choices && o.choices[0];
      if (o.usage) usage = o.usage;
      const delta = choice && choice.delta;
      ensureStart();
      if (delta) {
        if (typeof delta.content === 'string' && delta.content) {
          ensureTextItem();
          text += delta.content;
          ev('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: delta.content });
        }
        if (delta.reasoning_content) {
          // 推理内容以 reasoning summary 事件透出，Codex 会忽略未知事件
          ev('response.reasoning_summary_text.delta', { item_id: itemId, output_index: 0, summary_index: 0, delta: delta.reasoning_content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolCalls.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function && tc.function.name) cur.name += tc.function.name;
            if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
            toolCalls.set(idx, cur);
          }
        }
      }
      if (choice && choice.finish_reason) finish = choice.finish_reason;
      return out.join('');
    },

    /** 上游结束时调用；返回收尾事件 */
    end() {
      out.length = 0;
      ensureStart();
      const output = [];
      if (text) {
        ensureTextItem();
        ev('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text });
        ev('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
        const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
        ev('response.output_item.done', { output_index: 0, item });
        output.push(item);
      }
      let oi = output.length;
      for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        const cid = tc.id || rid('call');
        const item = { id: rid('fc'), type: 'function_call', status: 'completed', call_id: cid, name: tc.name, arguments: tc.args || '{}' };
        ev('response.output_item.added', { output_index: oi, item: { ...item, status: 'in_progress', arguments: '' } });
        ev('response.function_call_arguments.delta', { item_id: item.id, output_index: oi, delta: item.arguments });
        ev('response.function_call_arguments.done', { item_id: item.id, output_index: oi, arguments: item.arguments });
        ev('response.output_item.done', { output_index: oi, item });
        output.push(item);
        oi++;
      }
      const u = usage || {};
      const completed = {
        ...baseResponse('completed'),
        output,
        usage: {
          input_tokens: u.prompt_tokens ?? 0,
          output_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
          input_tokens_details: { cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? 0 },
          output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) ?? 0 },
        },
      };
      ev('response.completed', { response: completed });
      return { text, output, response: completed, sse: out.join('') };
    },

    /** 客户端要非流式时，直接给完整的 response 对象 */
    finalResponse() { return this.end().response; },
    get finished() { return finish; },
  };
}

/**
 * 上游 responses SSE → 客户端 chat SSE。
 * 喂一行，吐若干行（chat 格式）。
 */
export function makeResponsesToChatStream(model) {
  const id = rid('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false, usage = null, text = '', finish = null;
  const out = [];
  const chunk = (delta, extra = {}) => {
    const c = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null, ...extra }] };
    out.push(`data: ${JSON.stringify(c)}\n\n`);
  };

  return {
    push(line) {
      out.length = 0;
      const t = String(line).trim();
      // Responses SSE 有 event: 行和 data: 行；只处理 data
      if (!t.startsWith('data:')) return '';
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return '';
      let o;
      try { o = JSON.parse(payload); } catch { return ''; }
      switch (o.type) {
        case 'response.created':
        case 'response.in_progress':
          if (!sentRole) { sentRole = true; chunk({ role: 'assistant', content: '' }); }
          break;
        case 'response.output_text.delta':
          if (!sentRole) { sentRole = true; chunk({ role: 'assistant', content: '' }); }
          text += o.delta || '';
          chunk({ content: o.delta || '' });
          break;
        case 'response.reasoning_summary_text.delta':
          chunk({ reasoning_content: o.delta || '' });
          break;
        case 'response.function_call_arguments.delta':
          break;   // 工具调用按下面 completed 时整体给出
        case 'response.completed': {
          const r = o.response || {};
          usage = r.usage || usage;
          const items = Array.isArray(r.output) ? r.output : [];
          const calls = items.filter((x) => x.type === 'function_call');
          if (calls.length) {
            chunk({
              tool_calls: calls.map((c, i) => ({
                index: i, id: c.call_id || c.id, type: 'function',
                function: { name: c.name || '', arguments: c.arguments || '{}' },
              })),
            });
            finish = 'tool_calls';
          } else {
            finish = r.status === 'incomplete' ? 'length' : 'stop';
          }
          break;
        }
        default: break;
      }
      return out.join('');
    },
    end() {
      out.length = 0;
      if (!sentRole) { sentRole = true; chunk({ role: 'assistant', content: '' }); }
      const u = usage || {};
      const c = {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: finish || 'stop' }],
        usage: {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
        },
      };
      out.push(`data: ${JSON.stringify(c)}\n\n`);
      out.push('data: [DONE]\n\n');
      return out.join('');
    },
    get text() { return text; },
  };
}

/* ══════════════════════════════════════════════════ chat SSE 聚合（非流式客户端） */
export function aggregateChatSSE(text, model, requested) {
  const acc = { content: '', reasoning: '', toolCalls: new Map(), id: null, created: null, finish: null, usage: null };
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let o;
    try { o = JSON.parse(payload); } catch { continue; }
    if (o.id) acc.id = o.id;
    if (o.created) acc.created = o.created;
    if (o.usage) acc.usage = o.usage;
    const d = o.choices && o.choices[0] && o.choices[0].delta;
    const fr = o.choices && o.choices[0] && o.choices[0].finish_reason;
    if (fr) acc.finish = fr;
    if (!d) continue;
    if (typeof d.content === 'string') acc.content += d.content;
    if (typeof d.reasoning_content === 'string') acc.reasoning += d.reasoning_content;
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = acc.toolCalls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) cur.id = tc.id;
      if (tc.function && tc.function.name) cur.function.name += tc.function.name;
      if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
      acc.toolCalls.set(idx, cur);
    }
  }
  const message = { role: 'assistant', content: acc.content || null };
  if (acc.reasoning) message.reasoning_content = acc.reasoning;
  if (acc.toolCalls.size) message.tool_calls = [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const out = {
    id: acc.id || `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: acc.created || Math.floor(Date.now() / 1000),
    model: requested || model,
    choices: [{ index: 0, message, finish_reason: acc.finish || 'stop' }],
  };
  if (acc.usage) out.usage = acc.usage;
  return out;
}

/** responses 非流式：从 responses SSE 里取出最终的 response 对象 */
export function aggregateResponsesSSE(text) {
  let final = null;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let o;
    try { o = JSON.parse(payload); } catch { continue; }
    if (o.type === 'response.completed' && o.response) final = o.response;
    else if (o.response && o.response.status === 'completed') final = o.response;
  }
  return final ? withOutputText(final) : final;
}

/**
 * 补上 output_text 便捷字段。
 *
 * 严格按 OpenAI 的 HTTP 协议，/v1/responses 的正文里只有
 * `output: [{ type:'message', content:[{type:'output_text', text:'…'}] }]`；
 * `output_text` 是**官方 SDK 在客户端拼出来的**，不在响应体里。
 *
 * 但现实是很多第三方客户端 / 手写脚本直接读 `response.output_text`，
 * 拿不到就当「模型没输出」。所以这里服务端也拼一份 —— 有则不动，
 * 没有就用 output 里的 output_text 片段连起来。
 */
export function withOutputText(resp) {
  if (!resp || typeof resp !== 'object') return resp;
  if (typeof resp.output_text === 'string' && resp.output_text.length) return resp;
  const parts = [];
  for (const item of (Array.isArray(resp.output) ? resp.output : [])) {
    for (const c of (Array.isArray(item?.content) ? item.content : [])) {
      if (c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') parts.push(c.text);
    }
  }
  resp.output_text = parts.join('');
  return resp;
}
