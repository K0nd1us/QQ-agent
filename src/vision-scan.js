// 模型图片输入能力探测（vision scan）。
// 做法：对目录里的每个模型发一条带 1×1 测试图的最小 chat 请求，看网关接不接受 image_url 内容。
// 判定标准（业界通行做法）：OpenAI 兼容网关对纯文本模型通常会直接 4xx 拒绝图片内容，
// 接受（HTTP 200 且有 choices）即视为支持看图。与图片无关的失败（密钥、模型名、网络）记为
// unknown，不武断下结论。
// 结果持久化在 config.modelVision["providerId|||model"]，运行时用它门控看图工具。
import { getConfig, updateConfig } from './config.js';
import { builtinVisionResults } from './model-vision-docs.js';

// 1×1 像素 PNG（70 字节），足够让视觉模型"看到点什么"，也不会浪费 token。
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** 读取已保存的探测结果（含未检测的模型不存在条目）。 */
export function visionResults() {
  return getConfig().modelVision || {};
}

/** 查询某个模型（providerId|||modelId）的探测结论：'vision' | 'no-vision' | 'unknown' | undefined。 */
export function modelVisionVerdict(providerId, modelId) {
  const key = `${providerId || ''}|||${modelId || ''}`;
  return getConfig().modelVision?.[key]?.verdict;
}

/** 查询某个模型的图片输入结论：优先已持久化结论，其次内置官方资料表。 */
export function modelImageVerdict(providerId, modelId) {
  const saved = modelVisionVerdict(providerId, modelId);
  if (saved === 'vision' || saved === 'no-vision') return saved;
  const doc = builtinVisionResults([{ id: providerId, models: [modelId] }]);
  return doc[`${providerId || ''}|||${modelId || ''}`]?.verdict ?? saved;
}

/**
 * 探测单个模型。返回 { verdict, note, httpStatus, latencyMs }。
 * verdict: 'vision' 接受图片内容；'no-vision' 明确拒绝图片内容；'unknown' 无法判定。
 */
export async function detectModelVision({ baseUrl, apiKey, model }, timeoutMs = 25000) {
  const started = Date.now();
  const base = { verdict: 'unknown', note: '', httpStatus: null, latencyMs: null };
  if (!baseUrl || !model) return { ...base, note: '缺端点地址或模型名' };

  let res;
  try {
    res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这张图片里是什么？用一句不超过十个字的话回答。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } }
          ]
        }],
        max_tokens: 24,
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ...base, note: error?.name === 'TimeoutError' ? '探测请求超时' : `网络错误：${error?.message ?? error}` };
  }
  const latencyMs = Date.now() - started;
  const body = await res.json().catch(() => ({}));
  const errText = String(body?.error?.message ?? body?.message ?? body?.detail?.error?.message ?? '');

  if (res.ok && Array.isArray(body?.choices) && body.choices.length > 0) {
    const reply = String(body.choices[0]?.message?.content ?? '').trim();
    return { verdict: 'vision', note: reply ? `接受图片并回复：「${reply.slice(0, 30)}」` : '接受图片内容', httpStatus: res.status, latencyMs };
  }

  const looksImageRelated = /image|图片|multimodal|multi-modal|visual|vision|modality|图像|看图|多模态/i.test(errText);
  const looksAuthOrModel = /unauthorized|api key|forbidden|quota|billing|余额|权限|密钥|not found|does not exist|不存在|无可用渠道|no available channel/i.test(errText);

  if (looksAuthOrModel && !looksImageRelated) {
    return { verdict: 'unknown', note: `无法判定：${errText.slice(0, 80) || `HTTP ${res.status}`}`, httpStatus: res.status, latencyMs };
  }
  if ([400, 404, 422, 415].includes(res.status)) {
    // 4xx 且不像鉴权/模型名问题 → 视为网关拒绝该请求形态（典型：文本模型拒图片）
    return { verdict: 'no-vision', note: `HTTP ${res.status}${errText ? `：${errText.slice(0, 80)}` : ''}`, httpStatus: res.status, latencyMs };
  }
  return { verdict: 'unknown', note: `HTTP ${res.status}${errText ? `：${errText.slice(0, 80)}` : ''}`, httpStatus: res.status, latencyMs };
}

/**
 * 扫描目录（providerId 过滤可选）。并发受控，结果逐个写进 config 并通过 emit 汇报进度。
 * 返回 { total, results }。
 */
export async function scanModelsVision({ providers, emit = null, limit = 3, timeoutMs = 25000, onlyProviderIds = null } = {}) {
  const tasks = [];
  for (const p of providers || []) {
    if (onlyProviderIds && !onlyProviderIds.includes(p.id)) continue;
    if (!p.baseURL || !p.apiKey) continue; // 缺端点/密钥的提供商无从探测
    for (const model of p.models || []) {
      tasks.push({ providerId: p.id, model, baseURL: p.baseURL, apiKey: p.apiKey });
    }
  }
  const total = tasks.length;
  let done = 0;

  // 结果先在内存累积，扫描结束（或每满 5 条 / 每 2 秒）统一写一次盘。
  // 原先每个模型都调一次 updateConfig → 每次 deepMerge + structuredClone 全量配置
  // + fs.writeFileSync 同步落盘。扫 50 个模型 = 50 次全量序列化 + 50 次阻塞写盘，
  // 扫描期间主线程被 I/O 拖住，中途崩溃还会留下半写状态。
  const pending = new Map();
  const flushPending = () => {
    if (!pending.size) return;
    const patch = {};
    for (const [key, v] of pending) patch[key] = v;
    pending.clear();
    updateConfig({ modelVision: patch });
  };
  const flushTimer = setInterval(flushPending, 2000);

  const runTask = async (task) => {
    const key = `${task.providerId}|||${task.model}`;
    const r = await detectModelVision({ baseUrl: task.baseURL, apiKey: task.apiKey, model: task.model }, timeoutMs);
        pending.set(key, {
          providerId: task.providerId,
          model: task.model,
          verdict: r.verdict,
          note: r.note,
          httpStatus: r.httpStatus,
          latencyMs: r.latencyMs,
          source: 'probe',
          checkedAt: Date.now()
        });
        if (pending.size >= 5) flushPending();
    done += 1;
    emit?.('vision-scan', { key, providerId: task.providerId, model: task.model, verdict: r.verdict, done, total });
  };

  // 简单并发池
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length || 1)) }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      await runTask(task).catch((error) => {
        done += 1;
        emit?.('vision-scan', { key: `${task.providerId}|||${task.model}`, providerId: task.providerId, model: task.model, verdict: 'unknown', done, total, error: String(error?.message ?? error) });
      });
    }
  });
  await Promise.all(workers);
  clearInterval(flushTimer);
  flushPending();   // 收尾：剩余结果一次写盘，确保不丢
  return { total, results: { ...builtinVisionResults(providers || []), ...visionResults() } };
}
