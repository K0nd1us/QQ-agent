// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
// ⚠️ L15 备注（2026-09-19）：主搜索的裸 fetch 属"管理员自伤面"而非远程可利用面
//    （URL 来自本机配置，不经模型/群友控制）。这里维持普通 fetch 的原因：
//    safe-fetch 会拒绝解析到内网的地址，而"搜索接口部署在自家内网/反代后"是
//    合法配置。真正的远程输入（模型传进来的 query）已由 sanitizeQuery 清洗。
import { getConfig } from './config.js';
import { safeFetch } from './safe-fetch.js';

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * 简化查询：去掉搜索口语与时间词，留下真正要搜的内容。
 * 例："帮我搜一下 今日 AI 新闻" → "AI 新闻"
 */
export function simplifyQuery(query) {
  return String(query ?? '')
    .replace(/(帮我|麻烦|请)?\s*(搜一下|搜索一下|搜索|搜搜|查一下|查询一下|查询|找一下|找找|搜|查)/g, ' ')
    .replace(/(今日|今天|昨日|昨天|明天|明日|最新|最近|近期)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 提取关键词：拉丁词按词取；中文按相邻二元词（bigram）滑窗取。
 * 用于搜索引擎结果的相关性打分/重排。
 */
export function queryKeywords(query) {
  const s = String(query ?? '');
  const latin = s.match(/[A-Za-z][A-Za-z0-9_.-]*/g) || [];
  const bigrams = [];
  for (const run of s.match(/[一-鿿]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2));
  }
  return { latin, bigrams };
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bing 结果页解析（b_algo 结果块）。
 * bingSearch（主搜索）与自定义 bing 类型共用这一份 —— 之前两处各写一遍，
 * 单边改解析规则另一边悄悄漂移（原 bingSearchWithUrl 的注释甚至已与实现脱节）。
 * 返回 [{ title, url, snippet }]，失败抛错（页面改版/非 200）。
 */
async function fetchBingoResults(searchUrl, query, maxResults) {
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  return parseBingResults(html, maxResults);
}

/** 从 Bing HTML 里解析 b_algo 块（纯函数，测试可直接驱动）。 */
export function parseBingResults(html, maxResults = 6) {
  const results = [];
  for (const block of String(html ?? '').split('<li class="b_algo"').slice(1)) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 搜索（解析 b_algo 结果块）。searchUrl 可在配置中替换（测试/换引擎）。 */
export async function bingSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const results = await fetchBingoResults(searchUrl, sanitizeQuery(query), maxResults);
  if (!results.length) throw new Error('搜索没有解析到结果（引擎页面结构可能已改版）');
  return { query, results };
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */
export async function webSearch(query) {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'bing').toLowerCase();
  if (provider === 'deepseek') return deepSeekSearch(clean);
  if (provider === 'zhipu') return zhipuSearch(clean);
  if (provider === 'bocha') return bochaSearch(clean);
  if (provider === 'baidu') return baiduSearch(clean);
  if (provider === 'metaso') return metasoSearch(clean);
  // 自定义：'custom'（旧单槽位）或 'custom:<id>'（设置页添加的多个之一）
  if (provider === 'custom' || provider.startsWith('custom:')) {
    return customSearch(clean, provider);
  }
  return bingSearch(clean);
}

/**
 * DeepSeek 服务端原生搜索（Responses API，web_search 工具）。
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/responses_api
 * 说明：搜索在 DeepSeek 服务端完成并注入上下文，客户端能拿到的是模型基于
 * 搜索结果生成的最终回答；URL/标题/摘要为黑盒，拿不到结构化来源。适合
 * “只要能搜到并总结”的场景；需要引用列表时请用 Bing / 其他搜索 API。
 */
export async function deepSeekSearch(query) {
  const cfg = getConfig().webSearch?.deepseek ?? {};
  const apiKey = String(cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DeepSeek 搜索需要 API Key（设置里填，或环境变量 DEEPSEEK_API_KEY）');
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com/responses').replace(/\/+$/, '');
  const model = String(cfg.model || 'deepseek-v4-flash');

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: `请联网搜索并回答（用中文，简洁、只给结论和关键信息）：${query}`,
      tools: [{ type: 'web_search' }],
      stream: false
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 60000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek 搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('DeepSeek 搜索返回了无法解析的 JSON'); });
  const outputText = String(data?.output_text ?? '').trim();
  if (!outputText) {
    // 兼容不同字段位置
    const alt = data?.output?.find?.((item) => item?.type === 'message' && item?.content?.length)
      ?.content?.map((c) => c?.text ?? '').join('') ?? '';
    if (!alt) throw new Error('DeepSeek 搜索没有返回文本（可能是模型不支持 web_search 工具）');
    return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: alt }] };
  }
  return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: outputText }] };
}

/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。
 * browseLocked：浏览锁定开启时必须传 true —— safeFetch 会逐跳校验
 * （含重定向目标）是否在白名单内。web_fetch 工具曾经漏传这个参数，
 * 锁定开启时模型照样能抓任意站点，白名单形同虚设。 */
export async function webFetch(url, { browseLocked = false } = {}) {
  const result = await safeFetch(url, { browseLocked });
  return result;
}

/** 智谱 Web Search API（结构化结果：标题/链接/摘要/网站名/日期）。 */
export async function zhipuSearch(query) {
  const cfg = getConfig().webSearch?.zhipu ?? {};
  const apiKey = String(cfg.apiKey || process.env.ZHIPU_API_KEY || '').trim();
  if (!apiKey) throw new Error('智谱搜索需要 API Key（设置里填，或环境变量 ZHIPU_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/web_search').replace(/\/+$/, '');
  const engine = String(cfg.engine || 'search_std');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ search_engine: engine, search_query: query, count }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`智谱搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('智谱搜索返回了无法解析的 JSON'); });
  const arr = Array.isArray(data?.search_result) ? data.search_result : [];
  const results = arr
    .filter((r) => r?.link || r?.url)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.link ?? r.url ?? ''),
      snippet: String(r.content ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('智谱搜索没有返回有效结果（检查 API Key 或搜索引擎编码）');
  return { query, results };
}

/** 博查 Web Search API（国内中文优化，网页结果在 data.webPages.value）。 */
export async function bochaSearch(query) {
  const cfg = getConfig().webSearch?.bocha ?? {};
  const apiKey = String(cfg.apiKey || process.env.BOCHA_API_KEY || '').trim();
  if (!apiKey) throw new Error('博查搜索需要 API Key（设置里填，或环境变量 BOCHA_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://api.bochaai.com/v1/web-search').replace(/\/+$/, '');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query, count, freshness: 'noLimit', summary: false }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`博查搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('博查搜索返回了无法解析的 JSON'); });
  if (data?.code && Number(data.code) !== 200) {
    throw new Error(`博查搜索 API 错误（code ${data.code}）：${data.message || data.msg || '未知'}`);
  }
  const arr = Array.isArray(data?.data?.webPages?.value) ? data.data.webPages.value : [];
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.name ?? r.title ?? '').trim() || '（无标题）',
      url: String(r.url ?? ''),
      snippet: String(r.snippet ?? r.summary ?? r.content ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('博查搜索没有返回网页结果');
  return { query, results };
}

/** 百度千帆 AI Search（web_search，返回 references）。 */
export async function baiduSearch(query) {
  const cfg = getConfig().webSearch?.baidu ?? {};
  const apiKey = String(cfg.apiKey || process.env.BAIDU_SEARCH_API_KEY || '').trim();
  if (!apiKey) throw new Error('百度搜索需要 API Key（设置里填，或环境变量 BAIDU_SEARCH_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://qianfan.baidubce.com/v2/ai_search/web_search').replace(/\/+$/, '');
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: query }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: topK }]
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`百度搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('百度搜索返回了无法解析的 JSON'); });
  if (data?.error_code && Number(data.error_code) !== 0) {
    throw new Error(`百度搜索 API 错误（code ${data.error_code}）：${data.error_msg || data.message || '未知'}`);
  }
  const arr = Array.isArray(data?.references) ? data.references : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('百度搜索没有返回有效结果');
  return { query, results };
}

/** 秘塔 AI 搜索（metaso.cn，每天 100 次免费）。 */
export async function metasoSearch(query) {
  const cfg = getConfig().webSearch?.metaso ?? {};
  const apiKey = String(cfg.apiKey || process.env.METASO_API_KEY || '').trim();
  const endpoint = String(cfg.baseUrl || 'https://metaso.cn/api/open/v1/search').replace(/\/+$/, '');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ query, top_k: Math.min(10, Math.max(1, Number(cfg.count) || 6)) }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`秘塔搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('秘塔搜索返回了无法解析的 JSON'); });
  const arr = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.sources) ? data.sources
    : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('秘塔搜索没有返回有效结果（可能已用完免费额度或接口地址需要更新）');
  return { query, results };
}

/**
 * 解析自定义搜索配置。
 * providerId 形如 'custom:abc123' 时从 webSearch.providers 数组里取对应项；
 * 否则退回旧的单槽位 webSearch.custom（兼容早期配置）。
 */
function resolveCustomConfig(providerId = null) {
  const ws = getConfig().webSearch ?? {};
  if (providerId && String(providerId).startsWith('custom:')) {
    const id = String(providerId).slice('custom:'.length);
    const found = (Array.isArray(ws.providers) ? ws.providers : []).find((p) => String(p?.id) === id);
    if (found) return found;
    // 列表里找不到 → 回退单槽位，避免配置丢失后完全搜不了
  }
  return ws.custom ?? {};
}

/**
 * 用户自定义的搜索服务（provider = 'custom' 或 'custom:<id>'）。
 *
 * 两种类型：
 *   - 'openai'：POST 一个 JSON 搜索接口。为兼容各家实现，会尝试多种常见请求体字段
 *     （query / q / messages）与响应结构（results / data / sources / references / webPages）。
 *     适合 SearXNG、Tavily、自建聚合搜索等。
 *   - 'bing'：GET 一个搜索页并用 b_algo 块解析（兼容 Bing 结果格式的引擎，如部分 SearXNG 实例）。
 */
export async function customSearch(query, providerId = null) {
  const cfg = resolveCustomConfig(providerId);
  const type = String(cfg.type || 'openai').toLowerCase();

  if (type === 'bing') {
    return bingSearchWithUrl(query, String(cfg.baseUrl || ''));
  }

  const endpoint = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('自定义搜索未配置接口地址（设置 → 模型 API → 搜索提供方 → 自定义）');
  const apiKey = String(cfg.apiKey || '').trim();
  const model = String(cfg.model || '').trim();
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  // 兼容多种请求体：优先 query / q，带 model 时额外附上 messages（Responses API 风格）
  const body = { query, q: query, top_k: topK, count: topK };
  if (model) {
    body.model = model;
    body.messages = [{ role: 'user', content: query }];
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`自定义搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('自定义搜索返回了无法解析的 JSON'); });

  // 兜住各家字段名
  const arr = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.sources) ? data.sources
    : Array.isArray(data?.references) ? data.references
    : Array.isArray(data?.webPages?.value) ? data.webPages.value
    : Array.isArray(data) ? data
    : [];

  const results = arr
    .filter((r) => r && (r.url || r.link))
    .map((r) => ({
      title: String(r.title ?? r.name ?? r.headline ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? r.body ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) {
    throw new Error('自定义搜索没有返回可识别的结果（请检查接口返回是否包含 results/data/sources 等数组，或改用 bing 类型抓页面）');
  }
  return { query, results };
}

/** 用指定 URL 跑一次 Bing 结果解析（供自定义 bing 类型复用，与主搜索共用同一实现）。 */
async function bingSearchWithUrl(query, searchUrl) {
  const cfg = getConfig().webSearch ?? {};
  const url = String(searchUrl || cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const results = await fetchBingoResults(url, query, maxResults)
    .catch((error) => { throw new Error(`自定义搜索（bing 类型）：${error?.message ?? error}`); });
  if (!results.length) throw new Error('自定义搜索（bing 类型）没有解析到结果，请确认该引擎返回 b_algo 结构');
  return { query, results };
}

// ══════════════════════════════════════════════════════════════════════════
// 图片搜索与站内搜索（供 send_image / search_images 工具使用）
// ══════════════════════════════════════════════════════════════════════════
//
// 为什么单独一组函数，而不是复用 webSearch：
//   webSearch 返回的是**网页链接**，模型拿到后往往"再抓一次页面、再从中挑图"，
//   多两轮工具调用。发图场景需要的是**图片直链**，直接给它，省一轮。
//
// 注意：这两个解析器依赖搜索引擎的 HTML 结构，**页面改版就会失效**。
// 所以失败时抛错而不是返回空数组 —— 让调用方知道"是解析坏了"而不是"没结果"。

/**
 * 站内搜索：把 `{query}` 模板替换成 URL 编码的关键词。
 *
 * 配合 browseLock 使用：锁定站点 + 站内搜索模板 = "机器人只能在这几个站里搜"。
 * 模板里没有 `{query}` 时按 Bing 的 `?q=` 约定兜底（而不是静默拼错 URL）。
 *
 * @param {string} template 形如 'https://example.com/search?q={query}'
 * @param {string} query 关键词
 * @returns {string} 完整 URL
 */
export function buildSiteSearchUrl(template, query) {
  const tpl = String(template ?? '').trim();
  if (!tpl) throw new Error('站内搜索模板为空');
  const q = String(query ?? '').trim();
  if (tpl.includes('{query}')) return tpl.replaceAll('{query}', encodeURIComponent(q));
  // 兼容 %s 写法（部分搜索站用这个占位）
  if (tpl.includes('%s')) return tpl.replaceAll('%s', encodeURIComponent(q));
  // 没有占位符：按是否已有 query string 决定拼 ?q= 还是 &q=
  return tpl + (tpl.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(q);
}

/** 从 HTML 里提取图片直链。相对路径补成绝对、去重、按出现顺序。 */
export function extractImageUrls(html, baseUrl = '', max = 10) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return;
    // 接受：绝对 http(s)、协议相对 //、根相对 /、普通相对（a.jpg / images/a.png）、data:
    // 普通相对路径必须有 baseUrl 才能补全，否则没有意义
    const isBareRelative = !/^https?:\/\//i.test(s) && !s.startsWith('//') && !s.startsWith('/') && !s.startsWith('data:');
    if (isBareRelative && !baseUrl) return;
    let abs = s;
    try {
      abs = s.startsWith('//') ? new URL(`https:${s}`).toString() : new URL(s, baseUrl || undefined).toString();
    } catch { return; }
    if (!/^https?:/i.test(abs)) return;          // 丢掉 data: 之类
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  // ① 各种懒加载属性优先（它们的优先级通常高于 src 里的占位图）
  for (const m of String(html ?? '').matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'srcset', 'src']) {
      const mm = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i'));
      if (!mm) continue;
      // srcset 是 "url 1x, url2 2x" 形式，只取第一个 URL
      push(String(mm[1]).split(',')[0].trim().split(/\s+/)[0]);
      if (out.length >= max) return out;
    }
    if (out.length >= max) break;
  }
  if (out.length < max) {
    for (const m of String(html ?? '').matchAll(/["'](https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^"'\s]*)?)["']/gi)) {
      push(m[1]);
      if (out.length >= max) break;
    }
  }
  return out.slice(0, Math.max(1, Number(max) || 10));
}

/** 从 HTML 里提炼可读正文（去标签、压空白），供 attachPageContents 之类的场景用。 */
export function extractPageDigest(html, _baseUrl = '', { maxChars = 6000, maxLinks = 24 } = {}) {
  const raw = String(html ?? '');
  // 先干掉 script/style/nav 这些纯噪音，否则正文里会混进一堆 JS
  const cleaned = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decodeHtml(cleaned.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const links = [];
  for (const m of cleaned.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= maxLinks) break;
    const href = String(m[1]).trim();
    if (!/^https?:\/\//i.test(href)) continue;
    const label = decodeHtml(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (label) links.push({ title: label.slice(0, 80), url: href });
  }
  const cap = Math.max(200, Number(maxChars) || 6000);
  return { text: text.length > cap ? `${text.slice(0, cap)}…（已截断）` : text, links, images: extractImageUrls(cleaned, _baseUrl, 10) };
}

// ── 图片搜索 ──────────────────────────────────────────────────────────────

/**
 * Bing 图片搜索。
 *
 * 做法：请求图片搜索页，从结果块里捞 `murl`（媒体直链）与 `turl`（缩略图）。
 * Bing 把这两者塞在 `m="{\"murl\":\"...\",\"turl\":\"...\"}"` 这样的 JSON 属性里。
 * 解析失败就抛错（页面改版了），由调用方决定降级。
 */
export async function bingImageSearch(query, { limit = 8, browseLocked = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const url = `https://cn.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`;
  // 图搜是"搜索阶段"，也必须受浏览锁定约束，否则锁定只挡下载不挡搜索，链条断一环
  const { body } = await safeFetch(url, { browseLocked });
  const html = String(body ?? '');
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/m="([^"]+)"/g)) {
    const raw = decodeHtml(m[1]).replace(/&quot;/g, '"');
    let url2 = '';
    try {
      const j = JSON.parse(raw);
      url2 = String(j.murl || j.mediaurl || '').trim();
    } catch {
      // 属性里偶尔不是合法 JSON（被截断），用正则兜一次
      const mm = raw.match(/"murl"\s*:\s*"([^"]+)"/);
      url2 = mm ? mm[1] : '';
    }
    if (!/^https?:\/\//i.test(url2) || seen.has(url2)) continue;
    seen.add(url2);
    out.push({ title: q, url: url2 });
    if (out.length >= Math.max(1, Number(limit) || 8)) break;
  }
  if (!out.length) throw new Error('Bing 图片搜索没解析到结果（页面结构可能已改版）');
  return out;
}

/** 百度图片搜索。百度把直链放在 `objURL`（近年版改成 `thumbURL`/`middleURL`，都能兜）。 */
export async function baiduImageSearch(query, { limit = 8, browseLocked = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const url = `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(q)}`;
  const { body } = await safeFetch(url, { browseLocked });
  const html = String(body ?? '');
  const out = [];
  const seen = new Set();
  for (const key of ['objURL', 'middleURL', 'thumbURL', 'hoverURL']) {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g');
    for (const m of html.matchAll(re)) {
      const u = decodeHtml(m[1]).replace(/\\\//g, '/');
      if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
      seen.add(u);
      out.push({ title: q, url: u });
      if (out.length >= Math.max(1, Number(limit) || 8)) break;
    }
    if (out.length >= Math.max(1, Number(limit) || 8)) break;
  }
  if (!out.length) throw new Error('百度图片搜索没解析到结果（页面结构可能已改版）');
  return out;
}

/**
 * 图片搜索入口：按配置的搜索 provider 选源，失败自动换另一个。
 *
 * 为什么"自动换源"很重要：这两家的 HTML 结构都随时可能改版，
 * 只押一个源的话，改版当天功能就整个不可用。
 */
export async function searchImages(query, { limit = 8, browseLocked = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const n = Math.max(1, Math.min(12, Number(limit) || 8));
  const errors = [];
  // 顺序：百度在前（中文关键词命中率更好），Bing 兜底
  for (const fn of [baiduImageSearch, bingImageSearch]) {
    try {
      const list = await fn(q, { limit: n, browseLocked });
      if (list.length) return list;
    } catch (error) {
      errors.push(`${fn.name}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`图片搜索全部失败 —— ${errors.join('；')}`);
}

