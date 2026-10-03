// 提示词锚点（前缀缓存深化）单元测试：
// 用 README 式的 ABCDEFGHIJ 例子逐轮驱动 buildUserPrompt，验证——
//   1. 首轮建立锚点（reset：滑窗全量成为锚点，追加预算从这之后起算）
//   2. 后续轮**字节前缀不变**（【已读信息】原样复用），新内容进【新已读信息】，
//      已读部分可超过 historyCount（锚点 + 追加 ≤ 锚点 + maxExtraRead）
//   3. 追加超过 maxExtraRead → 整体重置回标准滑窗
//   4. 新群友加入**不再**导致重置（2026-10-03 走 B：【记忆】已挪到【已读信息】
//      之后，不进前缀；【新加入成员】段随之作废）
//   5. 锚点头滚出存档窗口（隔太久没触发）→ 重置
//   6. 关闭开关 → 永远标准结构，锚点状态不写入
//   7. **缓存杀手回归**：两轮之间写一条记忆 + 换一批表情，稳定前缀必须逐字节一致
// 纯离线：隔离数据目录 + MemoryStore/ChatStore 真实例。
//
// ⚠️ 2026-09-26 修：第一版实现拿"滑动截尾后的窗口头部"比对锚点 —— 滑动必然
// 滚出锚点头 → 永远 reset，实际效果 = 滑动固定窗口（用户实测报告）。修复后
// 锚定轮不受 historyCount 截尾：锚点条目从全量已读池补齐，追加预算封顶总量。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-anchor-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildUserPrompt, resolvePromptAnchor } = await import('../src/prompt.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '测试机';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.sticker.enabled = false;   // 关掉表情包，减少无关段落
cfg.store.contextTier = 4;
cfg.store.historyCount = 5;    // 滑窗 5 条
cfg.store.promptAnchor = { enabled: true, maxExtraRead: 2 };   // 追加预算 2
setRuntimeConfig(cfg);

const store = new ChatStore(0);
const memory = new MemoryStore();
const CHAT = 'group:123';

// 成员记忆：甲乙两人各一条（丙不发消息但记忆里有 —— 不该进前缀）
memory.append(CHAT, 'memberImpression', '甲的印象', { userId: 'uA', target: '甲' });
memory.append(CHAT, 'memberImpression', '乙的印象', { userId: 'uB', target: '乙' });
memory.append(CHAT, 'memberImpression', '丙的印象', { userId: 'uC', target: '丙' });

let mid = 1000;
let ts = Date.now() - 100000;
function pushRead(senderId, senderName, text) {
  const e = store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId, senderName, text });
  store.markEntryRead(CHAT, e.id);
  return e;
}
function pushUnread(senderId, senderName, text) {
  return store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId, senderName, text });
}

// 一次"运行"：trigger = 未读触发批；返回用户提示与会话（含锚点状态）
function runOnce(triggerEntries, prevAnchor, opts = {}) {
  const session = {};
  const up = buildUserPrompt({
    chatKey: CHAT, kind: 'group', chatId: '123', chatName: '测试群',
    triggerEntries, store, memory, stickerEntries: opts.stickerEntries || [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    contextLimit: cfg.store.historyCount,
    promptAnchor: { prev: prevAnchor },
    session
  });
  return { up, session };
}
// 前缀 = 【已读信息】这一整段（2026-10-03 走 B 后，稳定前缀里只剩它）。
// 锚定轮的【新已读信息】属于追加部分（在缓存前缀之后），比较时剥掉。
// ⚠️ 用完整段头定位：引导说明正文里引用了"【已读信息】【记忆】"字样，
// 浅 indexOf 会提前命中正文行。
const prefixOf = (up) => {
  const s = up.indexOf('【已读信息】以下是');
  const eExtra = up.indexOf('【新已读信息】以下是');
  const eMem = up.indexOf('【记忆】\n');
  const e = eExtra >= 0 ? eExtra : eMem;
  assert.ok(s >= 0 && e > s, '段落定位失败（缺已读信息 / 新已读信息 / 记忆段）');
  return up.slice(s, e).replace(/\n+$/, '\n');   // 段间空行数不参与比较
};
const hasMsg = (up, x) => up.includes(`：${x}`);

// 聊天记录 A~F（甲乙交替，均已读）
'ABCDEF'.split('').forEach((t, i) => pushRead(i % 2 ? 'uB' : 'uA', i % 2 ? '乙' : '甲', t));

// ═══ 轮 1：甲发 G（触发）。已读窗口 BCDEF（5 条滑窗）═══
const G = pushUnread('uA', '甲', 'G');
const r1 = runOnce([G], null);
assert.equal(r1.session.promptAnchorMode, 'reset', '首轮应为 reset（建立锚点）');
assert.ok(r1.up.includes('【已读信息】'), '首轮应有已读信息段');
assert.ok(!r1.up.includes('【新已读信息】以下是'), '首轮不应有新已读信息段');
assert.ok(['B','C','D','E','F'].every((x) => hasMsg(r1.up, x)) && !hasMsg(r1.up, 'A'), '首轮滑窗 = BCDEF（historyCount=5）');
// 锚点 = 本轮滑窗全部 5 条（BCDEF）—— 下一轮锚定复用它们，追加预算从 F 之后起算
assert.equal(r1.session.promptAnchorState.readIds.length, 5, '锚点 = 全部滑窗条目');
const anchor1 = r1.session.promptAnchorState;
const prefix1 = prefixOf(r1.up);

// ═══ 轮 2：乙发 H（紧接触发，G 已沉淀为已读）═══
const H = pushUnread('uB', '乙', 'H');
const r2 = runOnce([H], anchor1);
assert.equal(r2.session.promptAnchorMode, 'anchored', '连续触发第二轮应锚定（核心场景）');
// 【已读信息】= 锚点 BCDEF 原样（5 条，不受 historyCount 截尾）。
// ⚠️ 完整段头定位（'【已读信息】以下是'）—— 引导说明正文里有裸的
// 【已读信息】字样，浅 indexOf 会切到正文行上。
const readSec2 = r2.up.slice(r2.up.indexOf('【已读信息】以下是'), r2.up.indexOf('【新已读信息】以下是'));
assert.ok(['B','C','D','E','F'].every((x) => hasMsg(readSec2, x)), '锚定轮已读信息 = 锚点 BCDEF');
assert.ok(!hasMsg(readSec2, 'G'), 'G 不在已读信息（它是追加条目）');
// 【新已读信息】= G（锚点之后新沉淀的 1 条，≤ 预算 2）
const extraSec2 = r2.up.slice(r2.up.indexOf('【新已读信息】以下是'), r2.up.indexOf('【未读信息】以下是'));
assert.ok(hasMsg(extraSec2, 'G'), 'G 应进新已读信息');
// 字节前缀（记忆+已读信息）与轮 1 完全一致 —— 缓存命中的核心断言
assert.equal(prefixOf(r2.up), prefix1, '锚定轮前缀必须与上轮逐字节一致');
// 模型实际看过的已读条数 = 6（5 锚点 + 1 追加）→ offset 补偿口径
assert.equal(r2.session.pastStateCount, 6, '锚定轮 pastStateCount = 锚点+追加');
const anchor2 = r2.session.promptAnchorState;

// ═══ 轮 3：甲发 I（继续连续触发；追加将达到预算上限）═══
const I = pushUnread('uA', '甲', 'I');
const r3 = runOnce([I], anchor2);
assert.equal(r3.session.promptAnchorMode, 'anchored', '追加 = 预算上限（2 条：G、H）仍应锚定');
assert.equal(prefixOf(r3.up), prefix1, '追加到预算上限时前缀仍逐字节一致');
const extraSec3 = r3.up.slice(r3.up.indexOf('【新已读信息】以下是'), r3.up.indexOf('【未读信息】以下是'));
assert.ok(hasMsg(extraSec3, 'G') && hasMsg(extraSec3, 'H'), '新已读 = G、H（两条追加）');
assert.equal(r3.session.pastStateCount, 7, '锚定轮 pastStateCount = 5 锚点 + 2 追加');
const anchor3 = r3.session.promptAnchorState;

// ═══ 轮 4：乙发 J（追加将超出预算 → 整体重置）═══
const J = pushUnread('uB', '乙', 'J');
const r4 = runOnce([J], anchor3);
assert.equal(r4.session.promptAnchorMode, 'reset', '追加将超出 maxExtraRead → 整体重置');
assert.ok(!r4.up.includes('【新已读信息】以下是'), '重置轮无新已读段');
// 重置后回到标准滑窗（historyCount=5）：EFGHI
const readSec4 = r4.up.slice(r4.up.indexOf('【已读信息】以下是'), r4.up.indexOf('【未读信息】以下是'));
assert.ok(['E','F','G','H','I'].every((x) => hasMsg(readSec4, x)) && !hasMsg(readSec4, 'D'), '重置轮滑窗 = EFGHI');
// 新锚点 = EFGHI，前缀从此重新锚定
assert.equal(r4.session.promptAnchorState.readIds.length, 5, '重置后新锚点 = 新滑窗');
const prefix4 = prefixOf(r4.up);
assert.notEqual(prefix4, prefix1, '重置轮前缀必然不同（滑窗滚动）');
const anchor4 = r4.session.promptAnchorState;

// ═══ 轮 5：甲发 K（重置后再次连续触发 → 新前缀保持）═══
const K = pushUnread('uA', '甲', 'K');
const r5 = runOnce([K], anchor4);
assert.equal(r5.session.promptAnchorMode, 'anchored', '重置后的下一轮连续触发应再次锚定');
assert.equal(prefixOf(r5.up), prefix4, '新锚点的前缀同样逐字节一致');

// ═══ 场景 F：新群友加入话题 → 不再重置（记忆已挪出稳定前缀）═══
// 走 B 前：新群友出现会让【记忆】扩展（新成员印象在锚点里没有）→ 字节前缀必变 → reset。
// 走 B 后：【记忆】排在【已读信息】之后，不参与前缀，所以新群友**不影响锚定**。
// 构造：紧接 r5（锚点 EFGHI + 追加 J，预算 2 尚余 1）让新群友丙发言。
const M = pushUnread('uC', '丙', 'M');
const rM = runOnce([M], r5.session.promptAnchorState);
assert.equal(rM.session.promptAnchorMode, 'anchored', '新群友加入不再导致重置（记忆已不在前缀里）');
assert.ok(rM.up.includes('丙的印象'), '新群友的印象照常出现在【记忆】段');
assert.ok(rM.up.indexOf('【记忆】\n') > rM.up.indexOf('【已读信息】以下是'), '【记忆】必须落在【已读信息】之后');
assert.equal(rM.session.pastStateCount, 7, '锚点 5 + 追加 2（J、K）');
assert.ok(!rM.up.includes('【新加入成员】'), '【新加入成员】段已作废');

// ═══ 场景 G：锚点头滚出存档窗口（太久没触发）→ 重置 ═══
{
  // 纯函数级：锚点第一条不在全量已读池里 → reset
  const r = resolvePromptAnchor({
    readMessages: [{ id: 999, senderId: 'uA', text: 'x' }],
    allReadMessages: [{ id: 998, senderId: 'uA', text: 'y' }, { id: 999, senderId: 'uA', text: 'x' }],
    prevAnchor: { readIds: [1, 998], readCount: 2 },
    maxExtraRead: 2
  });
  assert.equal(r.mode, 'reset', '锚点头不在已读池 → 重置');
}

// ═══ 场景 H：关闭开关 → 永远标准结构、无锚点状态 ═══
{
  cfg.store.promptAnchor.enabled = false;
  setRuntimeConfig(cfg);
  const s = {};
  const up = buildUserPrompt({
    chatKey: CHAT, kind: 'group', chatId: '123', chatName: '测试群',
    triggerEntries: [M], store, memory, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    contextLimit: 5, promptAnchor: { prev: anchor1 }, session: s
  });
  assert.equal(s.promptAnchorMode, 'none', '关闭开关 → none');
  assert.equal(s.promptAnchorState, null, '关闭开关 → 不写锚点状态');
  assert.ok(!up.includes('【新已读信息】以下是'), '关闭开关 → 无新已读段');
  assert.ok(!up.includes('【新加入成员】'), '【新加入成员】段已作废');
  assert.ok(up.includes('【记忆】') && up.includes('【已读信息】'), '标准结构仍在');
  // 标准结构滑窗 = 最近 5 条已读（排除触发批 M → G,H,I,J,K）
  const readSec = up.slice(up.indexOf('【已读信息】以下是'), up.indexOf('【记忆】\n'));
  assert.ok(['G','H','I','J','K'].every((x) => hasMsg(readSec, x)), '关闭开关 → 滑窗口径');
}

// ═══ 场景 I：缓存杀手回归 —— 两轮之间写记忆 + 换表情，稳定前缀必须逐字节一致 ═══
// 这是本次改动要修的核心问题。走 B 之前：【记忆】排在【已读信息】**之前**，
// 一次 remember_member 就会改它的排序/内容，把后面整段（已读信息，token 大头）
// 全部踢出缓存；【可用表情包】同理（useCount 参与选中集合排序 + 60 分钟轮换）。
// 走 B 之后两者都在【已读信息】之后，稳定前缀应当纹丝不动。
// ⚠️ 这条断言在改动前必然失败、改动后必须通过 —— 它就是问题的复现。
{
  cfg.store.promptAnchor.enabled = true;
  cfg.sticker.enabled = true;
  setRuntimeConfig(cfg);

  const X1 = pushUnread('uA', '甲', 'X1');
  const before = runOnce([X1], null);                       // 建立锚点（reset）
  assert.equal(before.session.promptAnchorMode, 'reset', '首轮应为 reset');
  const prefixBefore = prefixOf(before.up);

  // 两轮之间发生两件"专打易变段"的事：
  memory.append(CHAT, 'memberImpression', '甲刚又默默说了句什么', { userId: 'uA', target: '甲' });
  const stickersAfter = [{ id: 'st9', desc: '全新表情', useCount: 99 }];

  const X2 = pushUnread('uB', '乙', 'X2');
  const after = runOnce([X2], before.session.promptAnchorState, { stickerEntries: stickersAfter });
  assert.equal(after.session.promptAnchorMode, 'anchored', '第二轮应继续锚定');

  // 先证明"易变段确实变了"，否则用例是空转
  assert.ok(after.up.includes('甲刚又默默说了句什么'), '新印象应进入【记忆】段');
  assert.ok(after.up.includes('全新表情'), '新表情应进入【可用表情包】段');

  // 核心断言：稳定前缀逐字节不变
  assert.equal(prefixOf(after.up), prefixBefore, '写记忆 + 换表情都不得改变稳定前缀（缓存杀手回归）');
}

try { fs.rmSync(__testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('✓ 提示词锚点自测全部通过');
