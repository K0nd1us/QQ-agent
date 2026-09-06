// 远程价格表：从自托管 URL 拉取模型价格，按 id 覆盖内置表。
//
// 设计原则（按需求定死，勿改）：
//   1. 本地永远有一张表可用：内置表（代码里）+ 拉到的表落盘缓存，
//      服务器挂了、重启了、断网了都不影响查价
//   2. 定期拉取：启动时拉一次，之后每 24 小时重拉；失败过 3 小时再试
//   3. 对正常使用**零影响**：拉取全异步（不阻塞启动/请求），所有错误
//      都被吞进状态字段，这个模块的任何函数都不允许把异常抛给调用方
//
// 工作方式：
//   1. 启动时先应用磁盘缓存（上次拉到的表），再联网拉新
//   2. 之后每小时检查一次：成功表超过 24h 就重拉；上次失败超过 3h 就重试
//   3. 拉取失败不清表 —— 远程缓存 > 内置表，总有一张表可用
//
// 远程 JSON 格式（兼容四种外形，方便直接复用各种导出物）：
//   { "deepseek-v4-flash": { "in": 1.5, "out": 4.5, "cached": 0.05 } }   // 裸 map
//   { "prices": { ...同上... } }                                          // 带包裹
//   { "prices": [ { "id": "...", "in": 1.5, ... } ] }                     // 数组（listOfficialPrices 的产物）
//   [ { "id": "...", ... } ]                                              // 裸数组
// 条目字段：in/out 必填数字（元/百万 token），cached 可 null，
//           peak/image/note/src 可选，与内置表条目同构。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { setRemotePrices } from './model-prices.js';

const CACHE_FILE = path.join(DATA_DIR, 'price-feed-cache.json');
const FETCH_TIMEOUT_MS = 10000;
const SUCCESS_INTERVAL_MS = 24 * 3600 * 1000;        // 成功后 24h 再拉
const FAILURE_RETRY_MS = 3 * 3600 * 1000;            // 失败过 3 小时重试
const TICK_MS = 3600 * 1000;                         // 每小时检查一次是否该拉

const status = {
  url: '',
  enabled: false,
  source: 'builtin',      // 'remote' = 在线拉的 | 'cache' = 磁盘缓存 | 'builtin' = 内置表
  fetchedAt: 0,           // 上次拉取（尝试）时间
  ok: false,              // 上次拉取是否成功
  error: '',
  count: 0,               // 生效的远程条目数
  dropped: 0              // 校验被丢弃的条目数
};

let timer = null;

/** 校验并规范化一条价格条目；不合格返回 null。 */
function normEntry(v) {
  if (!v || typeof v !== 'object') return null;
  const i = Number(v.in), o = Number(v.out);
  // in/out 至少一个是有限数字（免费模型 0/0 合法；完全没有数字才是坏条目）
  if (!Number.isFinite(i) && !Number.isFinite(o)) return null;
  const e = {
    in: Number.isFinite(i) ? i : 0,
    out: Number.isFinite(o) ? o : 0,
    cached: v.cached == null ? null : (Number.isFinite(Number(v.cached)) ? Number(v.cached) : null)
  };
  if (v.peak && typeof v.peak === 'object') {
    const pi = Number(v.peak.in), po = Number(v.peak.out), pc = Number(v.peak.cached);
    e.peak = {
      in: Number.isFinite(pi) ? pi : e.in,
      out: Number.isFinite(po) ? po : e.out,
      cached: Number.isFinite(pc) ? pc : e.cached
    };
  }
  // 图片计费规则结构各异（capped/pixel/unknown），原样透传，由 imageTokens 解读
  if (v.image && typeof v.image === 'object') e.image = v.image;
  if (typeof v.note === 'string' && v.note) e.note = v.note;
  e.src = typeof v.src === 'string' && v.src ? v.src : 'remote';
  return e;
}

/**
 * 校验并规范化远程价格表的整个载荷。
 * @returns {{ prices: object, dropped: number } | null} 载荷完全不可用返回 null
 */
export function normalizePriceFeed(data) {
  if (!data || typeof data !== 'object') return null;

  // 四种外形 → 统一的 [id, entry] 列表
  let pairs = [];
  if (Array.isArray(data)) {
    pairs = data.map((x) => [x?.id, x]);
  } else if (Array.isArray(data.prices)) {
    pairs = data.prices.map((x) => [x?.id, x]);
  } else if (data.prices && typeof data.prices === 'object') {
    pairs = Object.entries(data.prices);
  } else {
    // 裸 map：排除明显的元数据键，避免把 {"updated": "..."} 当成模型
    pairs = Object.entries(data).filter(([k]) => !/^(updated|version|meta|comment)$/i.test(k));
  }

  const prices = {};
  let dropped = 0;
  for (const [id, v] of pairs) {
    const key = String(id ?? '').trim().toLowerCase();
    const e = normEntry(v);
    if (!key || !e) { dropped++; continue; }
    prices[key] = e;
  }
  if (!Object.keys(prices).length && dropped) return null;   // 全是垃圾 → 判失败
  return { prices, dropped };
}

/** 应用一张表：注入查价层 + 更新状态。 */
function applyPrices(prices, source) {
  setRemotePrices(prices);
  status.source = source;
  status.count = Object.keys(prices).length;
}

/** 启动时先吃磁盘缓存（URL 对得上才用）。 */
function applyDiskCache(url) {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data?.url !== url) return false;   // 缓存是另一个 URL 的，不能用
    const norm = normalizePriceFeed(data.prices);
    if (!norm) return false;
    applyPrices(norm.prices, 'cache');
    status.dropped = norm.dropped;
    return true;
  } catch {
    return false;
  }
}

function writeDiskCache(url, prices) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ url, fetchedAt: Date.now(), prices }), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* 缓存写不进去不影响使用 */ }
}

/**
 * 立即拉取一次远程价格表。
 * @param {string} url
 * @returns {Promise<object>} 最新状态
 */
export async function refreshPriceFeed(url) {
  url = String(url || '').trim();
  status.url = url;
  status.fetchedAt = Date.now();
  if (!url) {
    status.enabled = false;
    return priceFeedStatus();
  }
  status.enabled = true;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => { throw new Error('返回的不是合法 JSON'); });
    const norm = normalizePriceFeed(data);
    if (!norm) throw new Error('JSON 里没有可用的价格条目');
    applyPrices(norm.prices, 'remote');
    status.ok = true;
    status.error = '';
    status.dropped = norm.dropped;
    writeDiskCache(url, norm.prices);
  } catch (error) {
    status.ok = false;
    status.error = String(error?.cause?.message ?? error?.message ?? error);
    // 失败不清表：继续用远程缓存/内置表，下次重试
  }
  return priceFeedStatus();
}

/**
 * 初始化远程价格表：吃缓存 → 立即拉 → 起定时检查。
 * 幂等：URL 没变就什么都不做（配置保存时会再次调这里）。
 *
 * ⚠️ 所有不带 await 的调用都挂 .catch(() => {})：
 *    refreshPriceFeed 内部已全 catch，这里是第二道保险 ——
 *    这个模块绝不允许以任何方式影响主程序（未捕获的 rejection 也算）。
 */
export function initPriceFeed(url) {
  url = String(url || '').trim();
  if (timer) { clearInterval(timer); timer = null; }
  if (!url) {
    status.url = '';
    status.enabled = false;
    return;
  }
  if (status.url === url && status.enabled) return;   // 同 URL 已初始化过
  status.url = url;
  status.enabled = true;
  applyDiskCache(url);            // 先用缓存顶上，拉到新的再覆盖
  refreshPriceFeed(url).catch(() => {});   // 启动即拉（异步，不阻塞启动）
  timer = setInterval(() => {
    const age = Date.now() - (status.fetchedAt || 0);
    if (status.ok && age < SUCCESS_INTERVAL_MS) return;
    if (!status.ok && age < FAILURE_RETRY_MS) return;
    refreshPriceFeed(status.url).catch(() => {});
  }, TICK_MS);
  timer.unref?.();   // 别让定时器拖着进程不退出（测试/脚本场景）
}

/** 当前状态（给 /api/model-prices 与设置页展示）。 */
export function priceFeedStatus() {
  return { ...status };
}
