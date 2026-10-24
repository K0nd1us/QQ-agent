// 回复安全网：把"写在正文里、但没通过工具发出去"的成稿抢救成一条 send_message 调用。
//
// ── 这是给谁用的 ──────────────────────────────────────────────────────────
// 不遵守工具协议的模型（尤其是本地小模型）。它们有时把"要说的话"直接写在正文里，
// 而正文按设计不会发到 QQ —— 于是群友什么都收不到，用户看到的是"机器人不理我了"。
//
// ── 为什么抽成独立模块 ────────────────────────────────────────────────────
// 这段是整条链路上**最可能造成事故**的一环：判错了就是把内心戏发进群，
// 比"这轮不说话"严重得多。所以它必须能被测试用假的裁判直接驱动，
// 把"该发的发出去、不该发的坚决不发"逐条验证 —— 留在 orchestrator 的私有方法里
// 就只能起整个会话才能试。
//
// ── 硬约束 ────────────────────────────────────────────────────────────────
//   · 只搬**原句**：不生成、不改写、不润色、不"帮模型把话说完"
//   · 拿不准一律沉默：任何一级判定失败都往"不发"走
//   · 不自己发送：返回合成好的 tool_call，由核心走统一的发送链路
//     （限频/去重/分条/CQ 转义/存档/守卫都在那里，不另开旁路）

/**
 * 把候选正文抢救成一条 send_message 的 tool_call。
 *
 * 三级递进，一级比一级宽松：
 *   ① 正则否决（reply.is-planning-text）—— 计划腔/候选稿整段放弃
 *   ② reply.loose-send —— 正则级抽取，不花模型调用
 *   ③ reply.salvage-lines / reply.salvage —— 模型当裁判判"成品话 vs 内心戏"
 * 最后过一遍 reply.grounded-select：只保留确实出自已记录草稿、且没发过的原句。
 *
 * @param {string} text     模型写在本轮正文里的内容
 * @param {string} trigger  本轮收到的消息（裁判判断"这是不是对它的回复"要用）
 * @param {Array}  sent     本次运行已发出的记录（[{type, text}]），用于避免重复发
 * @param {object} api      裁判用的模型参数（{baseUrl, apiKey, model, provider}）
 * @param {Function} cap    取能力提供者的函数：(name) => fn | null
 * @param {Function} log
 * @returns {Promise<Array>} tool_call 数组；[] = 什么都别发
 */
export async function rescueUnsentReply({
  text, trigger = '', sent = [], api = null, cap = () => null, log = () => {}
} = {}) {
  const body = String(text || '').trim();
  if (!body) return [];
  const asMessages = (v) => (Array.isArray(v)
    ? v.filter((m) => typeof m === 'string' && String(m).trim())
    : []);

  // ① 计划腔/候选稿否决。
  // 模型在正文里比较几个备选说法时（"回一句…或者…→太长"），任何一句单独看都像成品，
  // 整段都不能发 —— 这正是 isReplyPlanningText 存在的理由。
  const planningFn = cap('reply.is-planning-text');
  if (planningFn) {
    try { if (planningFn({ text: body })?.planning) return []; } catch { /* 判不了就继续往下走 */ }
  }

  const alreadySent = (sent || []).filter((s) => s?.type === 'text').map((s) => String(s.text || ''));

  // ② 正则级抢救（便宜、不花模型调用）
  let messages = [];
  const looseFn = cap('reply.loose-send');
  if (looseFn) {
    try { messages = asMessages(looseFn({ text: body })?.messages); } catch { messages = []; }
  }

  // ③ 裁判级抢救。默认关闭，且只在②没捞到时才走（省一次模型调用）。
  if (!messages.length) {
    const linesFn = cap('reply.salvage-lines');
    if (linesFn) {
      try {
        const r = await linesFn({ text: body, trigger, alreadySent, api });
        if (r?.say) messages = asMessages(r.messages);
      } catch (error) { log(`salvage-lines 失败：${error?.message ?? error}`); }
    }
    if (!messages.length) {
      const salvageFn = cap('reply.salvage');
      if (salvageFn) {
        try {
          const r = await salvageFn({ text: body, trigger, api });
          if (r?.say) messages = asMessages(r.messages);
        } catch (error) { log(`salvage 失败：${error?.message ?? error}`); }
      }
    }
  }
  if (!messages.length) return [];

  // ④ 草稿溯源：确认这些句子确实出自模型自己写过的草稿、且没发过。
  // 开启后这是最后一道闸 —— 裁判选错句子时靠它拦住。
  const groundedFn = cap('reply.grounded-select');
  if (groundedFn) {
    try {
      const r = groundedFn({ proposed: messages, sent: sent.map((s) => ({ type: s?.type, text: s?.text })) });
      if (r?.enabled) messages = asMessages(r.picked);
    } catch { return []; }   // 筛不了就不发（保守侧）
  }
  if (!messages.length) return [];

  // 合成 tool_call 交给核心统一执行：这样限频、去重、分条、存档、before-tool 守卫
  // 一个都不会被绕开。id 带一个随机后缀，避免同一轮里两次抢救撞 id。
  return [{
    id: `rescue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name: 'send_message', arguments: JSON.stringify({ messages }) }
  }];
}
