// 在一张价格表里匹配模型（供前端用本地数据算，不依赖接口往返）。
//
// ⚠️ 这是 src/model-prices.js 里 matchPriceTable 的浏览器镜像。
//    后端在用量统计/成本核算时用同一份逻辑（经 EFFECTIVE_PRICES 合并表），
//    前端这份只对 /api/model-prices 下发的 prices 数组做本地匹配。
//    两边匹配规则必须保持一致：精确 → 去 provider 前缀 → 最长前缀。

/**
 * 在价格表（数组，元素含 id 字段）里匹配模型。
 * @param {string} modelId 模型 id（可带 provider 前缀，如 z-ai/glm-5.3）
 * @param {Array} table 价格表数组
 * @returns {object|null} 命中条目（含 id/in/out/cached/peak/image/src 等），未命中返回 null
 */
export function matchPriceTable(modelId, table) {
  const raw = String(modelId || '').trim();
  if (!raw) return null;
  const id = raw.toLowerCase();
  const list = table || [];

  const exact = list.find((x) => String(x.id).toLowerCase() === id);
  if (exact) return exact;

  // 去 provider 前缀后再试（z-ai/glm-5.3 → glm-5.3）
  if (id.includes('/')) {
    const bare = id.split('/').pop();
    const hit = list.find((x) => String(x.id).toLowerCase() === bare);
    if (hit) return hit;
  }

  // 前缀匹配：取最长的那条，避免 gpt-5 命中 gpt-5.6
  let best = null;
  for (const x of list) {
    const xid = String(x.id).toLowerCase();
    if (id.startsWith(xid) && (!best || xid.length > String(best.id).length)) best = x;
  }
  return best;
}
