// 消息链接 → 媒体转发（确定性触发的"调度"部分）
//
// ── 为什么单独成模块 ──────────────────────────────────────────────────────
// 这段逻辑（候选链接提取、多提供者的"谁认领谁处理"协商、失败文案的发送时机）
// 是纯逻辑，不碰网络也不碰 QQ。留在 app.js 的闭包里就只能靠起整个应用才能验证；
// 抽出来后测试可以直接用假的 provider 驱动它，把每条分支都走一遍。
//
// ── 定位：核心只做"调度"，不认识任何平台 ───────────────────────────────────
// 核心不知道 B站/抖音 长什么样，只负责：
//   ① 从消息文本里挑出候选链接（粗提取，不判断平台）
//   ② 把每个链接喂给 `media.download` 能力的所有提供者
//   ③ 谁认领（不返回 skip）谁处理，认领后就不再问了
// 于是"新增一个平台"= 新插件再提供一个 media.download，核心零改动。

/** 单条消息最多处理几个链接：防止有人刷一屏链接把下载队列压满。 */
export const MAX_MEDIA_LINKS_PER_MESSAGE = 3;

/**
 * 从文本里挑候选链接。
 *
 * 带协议的 http(s) 全收；另外单独认不带协议的裸短链 —— 群友经常直接粘
 * `b23.tv/xxxx` 或 `v.douyin.com/xxxx`（分享文案里常把协议头吃掉）。
 *
 * ⚠️ 这里**不判断平台**。平台归属由提供者自己认（它手里才有精确解析器），
 * 否则核心就得维护"每个平台的链接长什么样"。
 */
export function extractCandidateUrls(text, max = MAX_MEDIA_LINKS_PER_MESSAGE) {
  const s = String(text || '');
  const found = [
    ...(s.match(/https?:\/\/[^\s"'<>，。！？）)】]+/gi) || []),
    ...(s.match(/(?:b23\.tv|v\.douyin\.com)\/[A-Za-z0-9_-]+/gi) || []).map((u) => `https://${u}`)
  ];
  const seen = new Set();
  const out = [];
  for (const raw of found) {
    // 归一化：去掉句末标点（中文语境里链接后面常紧跟句号）与尾部斜杠。
    // ⚠️ 尾部斜杠必须一并去掉：同一个链接会同时被上面的两条正则命中
    // （带协议的匹配保留 `/`，裸短链的匹配不含 `/`），不归一化就会出现
    // `https://v.douyin.com/xxx/` 和 `https://v.douyin.com/xxx` 两条，
    // 于是同一个视频被下载转发两次。
    const u = String(raw).replace(/[.,;:]+$/, '').replace(/\/+$/, '');
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= Math.max(1, Number(max) || MAX_MEDIA_LINKS_PER_MESSAGE)) break;
  }
  return out;
}

/**
 * 把候选链接依次交给提供者，谁认领谁处理。
 *
 * 失败处理的分工（刻意的）：
 *   · 普通失败只写日志 —— 自动触发的东西失败了不该往群里刷屏
 *   · 但提供者若给了 `friendly`，说明它认领了这条链接且失败对用户是有意义的
 *     （时长/体积超限之类），这时才提示一句
 *
 * @param {Array} urls              候选链接
 * @param {Array} providers         [{ skillId, fn }]，来自 getCapabilityProviders('media.download')
 * @param {object} ctx              { onebot, sender, kind, chatId }（会透传给 provider）
 * @param {Function} log
 * @returns {Promise<Array>} 每个链接的结果，便于测试与排障
 */
export async function dispatchMediaLinks({ urls, providers, ctx = {}, log = () => {} }) {
  const list = Array.isArray(urls) ? urls : [];
  const provs = Array.isArray(providers) ? providers : [];
  const outcomes = [];
  if (!list.length || !provs.length) return outcomes;

  const chatKey = `${ctx.kind}:${ctx.chatId}`;
  for (const url of list) {
    let settled = false;
    for (const p of provs) {
      let r = null;
      try {
        r = await p.fn({ url, ...ctx });
      } catch (error) {
        // provider 内部一般已 try/catch，这里再兜一层：一个提供者炸了不能连累别的
        log(`[media] ${p.skillId} 处理链接失败：${error?.message ?? error}`);
        continue;
      }
      if (!r || r.skip) continue;          // 不认领 → 把机会给下一个提供者

      settled = true;
      if (r.ok) {
        log(`[media] ${p.skillId} 已转发（${r.platform || '未知平台'}）：${r.title || url}`);
        outcomes.push({ url, skillId: p.skillId, status: 'handled', result: r });
        break;
      }

      log(`[media] ${p.skillId} 下载失败：${r.error || '未知原因'}`);
      outcomes.push({ url, skillId: p.skillId, status: 'failed', result: r });
      if (r.friendly) {
        try { await ctx.sender?.sendTextBatch?.(chatKey, [r.friendly]); } catch { /* 提示失败就算了 */ }
      }
      break;
    }
    if (!settled) outcomes.push({ url, status: 'skipped' });   // 没有任何提供者认领
  }
  return outcomes;
}
