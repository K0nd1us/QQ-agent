// 提示词组装的单元自测：验证"零历史"成本模型的关键性质。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 数据目录隔离：必须在 import src/* 之前设置。
// 本测试会真的 new ChatStore()/MemoryStore() 并 append 上百条消息；
// config.js 在模块加载时就把 DATA_DIR 定死，所以这里必须用 process.env
// 重定向 + **动态 import**（静态 import 会被提升，写在后面的赋值来不及生效）。
// 不隔离的话，每跑一次 npm test 都会往用户真实 data/messages/group_123.json
// 追加 ~104 条测试消息（历史上已累积 4600+ 条）。
const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-prompt-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildSystemPrompt, buildUserPrompt, buildPastState, resolveContextTier, stripMentions } = await import('../src/prompt.js');
const { segmentsToText } = await import('../src/onebot.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

// 注入测试配置
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '测试机';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.persona.participation = 'medium';
// 上下文读取档位（替代旧的 pastStateLimit/pastStateMaxChars）；2026-09-25 起各档条数统一
cfg.store.contextTier = 4;
cfg.store.historyCount = 80;
cfg.sticker.enabled = true;
setRuntimeConfig(cfg);

function makeStore() {
  const store = new ChatStore(0);
  // 造 100 条历史
  for (let i = 1; i <= 100; i++) {
    store.appendIncoming('group:123', {
      mid: 1000 + i,
      ts: Date.now() - (101 - i) * 60000,
      senderId: `u${i % 5}`,
      senderName: `群友${i % 5}`,
      text: i % 2 === 0 ? `这是第${i}条消息，比较长一点为了占用预算一点为了占用预算` : `消息${i}`,
      reply: i % 7 === 0 ? { sender: '某人', text: '引用内容' } : null
    });
  }
  store.appendSelf('group:123', { text: '我自己的一句话', ts: Date.now() - 30000 });
  // 历史消息视为已读
  store.drainUnread('group:123');
  // 3 条未读（触发批）
  for (let i = 1; i <= 3; i++) {
    store.appendIncoming('group:123', {
      mid: 2000 + i,
      ts: Date.now() - (4 - i) * 1000,
      senderId: `u${i}`,
      senderName: `群友${i}`,
      text: `未读消息${i}`
    });
  }
  return store;
}

// ── 1. 系统提示包含全部行为模块，且不包含已移除的沉睡/唤醒机制 ──
const sys = buildSystemPrompt();
for (const keyword of ['安全规则', '工作方式', '反 AI 味', '保持主体性', '该说/不该说', '群聊不是客服队列', '像真人一样', '引用与点名', '记忆', '表情包策略', '发送与汇报禁令']) {
  assert.ok(sys.includes(keyword), `系统提示缺少模块：${keyword}`);
}
for (const banned of ['沉睡前观察', 'qq_wait_for_messages', 'qq_set_wake_config', 'qq_mark_read', '[SILENT]', '会话令牌']) {
  assert.ok(!sys.includes(banned), `系统提示不应包含已废弃概念：${banned}`);
}

// ── 2. 用户提示：包含当前实现的真实段落 ──
// 注意：段落清单必须与 buildUserPrompt 实际产出保持一致。
// 当前实现产出（2026-10-03 走 B 重排）：
// 【角色设定】【引导说明】【已读信息】【新已读信息】【记忆】【未读信息】【可用表情包】【当前时间】
// （2026-09-25 改版：【此刻状态】删除、【过去状态】→【已读信息】、【本次唤醒】→【未读信息】。
//   2026-10-03：【记忆】【可用表情包】从稳定前缀（已读信息之前）挪到其后。【新加入成员】段作废。）
const store = makeStore();
const memory = new MemoryStore();
memory.append('group:123', 'memberImpression', '喜欢猫', { userId: 'u1', target: '群友1' });

const unreadBefore = store.unreadCount('group:123');
assert.strictEqual(unreadBefore, 3, '应有 3 条未读');

const triggerEntries = store.drainUnread('group:123');
assert.strictEqual(triggerEntries.length, 3, '触发批应是 3 条未读');
assert.strictEqual(store.unreadCount('group:123'), 0, 'drain 后无未读');

const userPrompt = buildUserPrompt({
  chatKey: 'group:123',
  kind: 'group',
  chatId: '123',
  chatName: '测试群',
  triggerEntries,
  store,
  memory,
  stickerEntries: [{ id: 's1', desc: '滑稽', useCount: 3 }],
  selfNickname: '测试机',
  runSeq: 7,
  moreUnreadDuringRun: false,
  proactive: false
});

for (const section of ['【当前时间】', '【角色设定', '【已读信息】', '【未读信息】', '【记忆】', '【可用表情包】', '【引导说明】']) {
  assert.ok(userPrompt.includes(section), `用户提示缺少段落：${section}`);
}
for (const banned of ['沉睡前观察', 'qq_', '[SILENT]', '【此刻状态】', '【过去状态】', '【本次唤醒】']) {
  assert.ok(!userPrompt.includes(banned), `用户提示不应包含（已删除/改名段落）：${banned}`);
}

// ── 2b. 段落顺序 = 变化频率升序（前缀缓存命中）───────────────────────────
// 判据（2026-10-03 走 B 重排）：前缀缓存遇到第一个不同的字节就整段失效，所以
// **凡是"会自己变"的段，一律排到【已读信息】之后**。
// 稳定前缀 = 系统提示 +【角色设定】+【引导说明】+【已读信息】。
// ·【记忆】曾排在已读信息**之前**，但它的成员顺序吃 updatedAt、内容随新印象增长
//   —— 一次 remember_member 就能把后面整块踢出缓存 → 挪到已读信息之后。
// ·【可用表情包】同理（选中集合受 useCount 影响 + 每 60 分钟洗牌）→ 挪到尾部。
// 注意用**完整标题行**定位：引导说明正文里也提到了"【已读信息】【记忆】
// 【可用表情包】"等段名，只搜段名会匹配到正文引用。
{
  const header = (mark) => userPrompt.indexOf(mark);
  assert.ok(header('【角色设定（管理员设置') >= 0, '应有角色设定段');
  assert.ok(header('【角色设定（管理员设置') < header('【引导说明】'), '角色设定应在引导说明之前');
  assert.ok(header('【引导说明】') < header('【已读信息】以下是这个会话'), '引导说明应在已读信息之前');
  assert.ok(header('【已读信息】以下是这个会话') < header('【记忆】\n'), '已读信息应在记忆之前（记忆已挪出稳定前缀）');
  assert.ok(header('【记忆】\n') < header('【未读信息】以下是'), '记忆应在未读信息之前');
  assert.ok(header('【未读信息】以下是') < header('【可用表情包】你的'), '未读信息应在可用表情包之前');
  assert.ok(header('【可用表情包】你的') < header('【当前时间】'), '可用表情包应在当前时间之前');
  // 稳定前缀（系统 + 角色设定 + 引导说明 + 已读信息）里不得出现会自己变的段
  const readIdx = header('【已读信息】以下是这个会话');
  assert.ok(header('【可用表情包】你的') > readIdx, '【可用表情包】必须排在【已读信息】之后');
  assert.ok(header('【记忆】\n') > readIdx, '【记忆】必须排在【已读信息】之后');
}

// ── 3. 触发批不出现在"已读信息"里（避免重复） ──
const past = buildPastState(store, 'group:123', { excludeIds: triggerEntries.map((m) => m.id) });
assert.ok(!past.text.includes('未读消息1'), '已读信息不应包含触发批消息');
assert.ok(past.text.includes('第100条消息'), '已读信息应包含历史消息');
assert.ok(past.text.includes('我自己的一句话'), '已读信息应包含自己的发言');

// ── 4. 预算控制：historyCount 限制读取条数 ──
// 旧实现用 pastStateMaxChars 截断字符数；2026-09-25 改版后各档统一 historyCount。
// 把上限调小后，已读信息应只带最近的 N 条。
cfg.store.historyCount = 10;
const tiny = buildPastState(store, 'group:123', {});
assert.ok(tiny.count <= 10, `超上限：读了 ${tiny.count} 条（应 ≤10）`);
// 100 条历史 + 1 条自己发言，调小到 10 条后最早的历史（第1~91条）应被丢弃
assert.ok(!tiny.text.includes('第2条消息'), '调小上限后不应再读到最早的历史');
assert.ok(tiny.text.includes('第100条消息'), '调小上限后仍应读到最近的历史');
cfg.store.historyCount = 80;

// ── 5. 零历史性质：整个用户提示里不出现"assistant 说过的话"这种 LLM 轮次结构 ──
// （用户消息是单个字符串，不含 OpenAI messages 数组的历史角色）
assert.ok(!userPrompt.includes('role'), '用户提示不应包含角色结构标记');

// ── 6. 主动机会模式 ──
const proactivePrompt = buildUserPrompt({
  chatKey: 'group:123', kind: 'group', chatId: '123', chatName: '测试群',
  triggerEntries: [], store, memory, stickerEntries: [],
  selfNickname: '测试机', runSeq: 8, moreUnreadDuringRun: false, proactive: true
});
assert.ok(proactivePrompt.includes('【已读信息】'), '主动模式也带已读信息');

// ── 7. 默认人设 = 原版小鲸鱼角色卡（已适配新架构，不含旧机制指令） ──
assert.ok(DEFAULT_CONFIG.persona.roleText.includes('DeepSeek 小鲸鱼'), '默认人设为原版小鲸鱼角色卡');
for (const banned of ['[SILENT]', 'mcp__snowluma', 'qq_set_wake_config', 'qq_mark_read', 'qq_wait_for_messages', 'qq_send_message', '空格分隔（例如']) {
  assert.ok(!DEFAULT_CONFIG.persona.roleText.includes(banned), `默认人设不应包含旧架构指令：${banned}`);
}

// ── 收尾：清理隔离数据目录 ──
// ── 8. 档位判定误判回归（2026-09-26）────────────────────────────────
// 实际 bug：① 群友 @ 的人与机器人重名 → 1 档误判为召唤；② @ 别人的名字里
// 带关键词 → 2 档误命中。修复：atMe 标记（来自 @ 段 QQ 号）优先于文本匹配、
// 关键词判定剔除 @ 片段。
{
  const tcfg = {
    contextTier: 1, keywords: ['鱼'], randomPercent: 0,
    historyCount: 80
  };
  // ① 同名误判：文本长得像 @机器人，但标记说不是
  let r = resolveContextTier({ triggerEntries: [{ text: '@小鲸鲸 你好', atMe: false }], cfg: tcfg, selfNickname: '小鲸鲸' });
  assert.equal(r.shouldRespond, false, '同名 @ 别人不应触发 1 档');
  // 真召唤（标记）
  r = resolveContextTier({ triggerEntries: [{ text: '@小鲸鲸 你好', atMe: true }], cfg: tcfg, selfNickname: '小鲸鲸' });
  assert.equal(r.shouldRespond, true, 'atMe 标记应触发 1 档');
  assert.equal(r.tier, 1);
  // 老存档无标记：回落文本匹配（保持旧行为，重名仍会误判 —— 已知局限）
  r = resolveContextTier({ triggerEntries: [{ text: '@小鲸鲸 你好' }], cfg: tcfg, selfNickname: '小鲸鲸' });
  assert.equal(r.shouldRespond, true, '老存档仍按文本匹配');
  // ② 2 档：@ 别人的名字里带关键词 → 不命中
  tcfg.contextTier = 2;
  r = resolveContextTier({ triggerEntries: [{ text: '@摸鱼小能手 你好', atMe: false, atNames: ['@摸鱼小能手'] }], cfg: tcfg });
  assert.equal(r.shouldRespond, false, '@ 别人的名字含关键词不应命中');
  // 正文含关键词 → 照常命中
  r = resolveContextTier({ triggerEntries: [{ text: '@摸鱼小能手 鱼来了', atMe: false, atNames: ['@摸鱼小能手'] }], cfg: tcfg });
  assert.equal(r.shouldRespond, true, '正文关键词应命中');
  assert.equal(r.tier, 2);
  // 老存档无 atNames：粗剥 @ 片段后不误命中
  r = resolveContextTier({ triggerEntries: [{ text: '@摸鱼小能手 你好' }], cfg: tcfg });
  assert.equal(r.shouldRespond, false, '老存档也应粗剥 @ 片段防误命中');
  // CQ 码形态同样剔除
  r = resolveContextTier({ triggerEntries: [{ text: '[CQ:at,qq=123] 你好', atMe: false }], cfg: tcfg });
  assert.equal(r.shouldRespond, false, 'CQ at 码不应命中关键词');
  // stripMentions 直测：精确剔除渲染原文（含 speaker-identity 的 (QQ:xxx) 形态）
  assert.equal(stripMentions({ text: '@摸鱼小能手(QQ:1) 鱼', atNames: ['@摸鱼小能手(QQ:1)'] }).trim(), '鱼');

  // ③ 引用前缀里的群友名包含关键词（2026-09-25 实测）：
  // 群友名「大肥鱼批发商（直播中）」包含关键词「大肥鱼」，别人引用/回复他的
  // 消息因 [引用 ...] 前缀参与判定被整批误触发。引用块是被引用者的名字+原文，
  // 不是本条消息正文，必须整块剔除后再做关键词判定。
  const tcfg2 = { contextTier: 2, keywords: ['大肥鱼'], randomPercent: 0, historyCount: 80 };
  const quoted = { text: '[引用 大肥鱼批发商（直播中）(QQ:111111111)：你用qwen3.8max肯定没这问题]（）（引用）', atMe: false, atNames: [] };
  r = resolveContextTier({ triggerEntries: [quoted], cfg: tcfg2, selfNickname: '大肥鱼' });
  assert.equal(r.shouldRespond, false, '引用块里被引用者的名字含关键词不应触发（纯引用无正文）');
  const quotedWithAt = { text: '[引用 大肥鱼批发商（直播中）(QQ:111111111)：你用qwen3.8max肯定没这问题]@大肥鱼批发商（直播中） 4.1也不行啊（引用）', atMe: false, atNames: ['@大肥鱼批发商（直播中）'] };
  r = resolveContextTier({ triggerEntries: [quotedWithAt], cfg: tcfg2, selfNickname: '大肥鱼' });
  assert.equal(r.shouldRespond, false, '引用前缀 + @别人（名字含关键词）的组合也不应触发');
  // 引用的原文本身含关键词：同样不该触发 —— 原文是别人说的话，不是本条消息的正文
  const quotedKw = { text: '[引用 张三(QQ:1)：大肥鱼今天直播吗]想问问', atMe: false, atNames: [] };
  r = resolveContextTier({ triggerEntries: [quotedKw], cfg: tcfg2 });
  assert.equal(r.shouldRespond, false, '引用块里的原文含关键词不应触发（不是本条正文说的）');
  // 本条消息正文含关键词 → 照常命中（正文=剔除引用块与@后的剩余部分）
  const ownKw = { text: '[引用 张三(QQ:1)：随便说说]大肥鱼快出来', atMe: false, atNames: [] };
  r = resolveContextTier({ triggerEntries: [ownKw], cfg: tcfg2 });
  assert.equal(r.shouldRespond, true, '正文关键词应照常命中（不受剔除影响）');
  assert.equal(r.tier, 2);
  // 解析失败兜底形态 [引用消息] 同样剔除；嵌套方括号占位的引用块也能整块剥
  assert.equal(stripMentions({ text: '[引用消息] 大肥鱼在哪' }).includes('大肥鱼'), true, '[引用消息] 兜底形态剔除后正文保留');
  assert.equal(stripMentions({ text: '[引用 张三：发了[图片]和[表情]]大肥鱼在哪' }).includes('大肥鱼'), true, '嵌套方括号的引用块整块剥，正文保留');
  assert.equal(stripMentions({ text: '[引用 张三：发了[图片]和[表情]]在哪' }).replace(/\s/g, ''), '在哪', '剥离后只剩正文');
}

// ── 9. 入库标记链路：segmentsToText 的 @ 收集器 ───────────────────────
{
  const marks = [];
  const text = await segmentsToText(
    [{ type: 'at', data: { qq: 12345 } }, { type: 'text', data: { text: ' 鱼来了' } }],
    { resolveAtName: async () => '摸鱼小能手', onAt: (m) => marks.push(m) }
  );
  assert.equal(text, '@摸鱼小能手 鱼来了', '渲染文本保持原样（@ 片段仍在正文里）');
  assert.deepEqual(marks, [{ qq: '12345', text: '@摸鱼小能手' }], '收集器应给出 @ 段的 QQ 号与渲染原文');
}

try { fs.rmSync(__testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('✓ 提示词自测全部通过');
