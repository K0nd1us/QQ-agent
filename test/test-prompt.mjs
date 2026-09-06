// 提示词组装的单元自测：验证"零历史"成本模型的关键性质。
import assert from 'node:assert';
import { ChatStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { buildSystemPrompt, buildUserPrompt, buildPastState } from '../src/prompt.js';
import { setRuntimeConfig, DEFAULT_CONFIG } from '../src/config.js';

// 注入测试配置
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '测试机';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.persona.participation = 'medium';
cfg.store.pastStateLimit = 80;
cfg.store.pastStateMaxChars = 6000;
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

// ── 2. 用户提示：包含理想清单的全部段落，顺序正确 ──
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
  selfLastMessageAt: Date.now() - 30000,
  lastMessageAt: Date.now(),
  recentCount: 42,
  runSeq: 7,
  moreUnreadDuringRun: false,
  proactive: false
});

for (const section of ['【当前时间】', '【会话标识】', '【角色设定', '【此刻状态】', '【过去状态】', '【本次唤醒】', '【参与度参考】', '【记忆】', '【可用表情包】', '【引导说明】']) {
  assert.ok(userPrompt.includes(section), `用户提示缺少段落：${section}`);
}
for (const banned of ['沉睡前观察', 'qq_', '[SILENT]']) {
  assert.ok(!userPrompt.includes(banned), `用户提示不应包含：${banned}`);
}

// ── 3. 触发批不出现在"过去状态"里（避免重复） ──
const past = buildPastState(store, 'group:123', { excludeIds: triggerEntries.map((m) => m.id) });
assert.ok(!past.text.includes('未读消息1'), '过去状态不应包含触发批消息');
assert.ok(past.text.includes('第100条消息'), '过去状态应包含历史消息');
assert.ok(past.text.includes('我自己的一句话'), '过去状态应包含自己的发言');

// ── 4. 预算控制：把预算调小后过去状态被截断 ──
cfg.store.pastStateMaxChars = 1500;
const tiny = buildPastState(store, 'group:123', {});
assert.ok(tiny.text.length <= 1600, `超预算：${tiny.text.length}`);
cfg.store.pastStateMaxChars = 6000;

// ── 5. 零历史性质：整个用户提示里不出现"assistant 说过的话"这种 LLM 轮次结构 ──
// （用户消息是单个字符串，不含 OpenAI messages 数组的历史角色）
assert.ok(!userPrompt.includes('role'), '用户提示不应包含角色结构标记');

// ── 6. 主动机会模式 ──
const proactivePrompt = buildUserPrompt({
  chatKey: 'group:123', kind: 'group', chatId: '123', chatName: '测试群',
  triggerEntries: [], store, memory, stickerEntries: [],
  selfNickname: '测试机', selfLastMessageAt: 0, lastMessageAt: Date.now() - 3600000,
  recentCount: 0, runSeq: 8, moreUnreadDuringRun: false, proactive: true
});
assert.ok(proactivePrompt.includes('【过去状态】'), '主动模式也带过去状态');

// ── 7. 默认人设 = 原版小鲸鱼角色卡（已适配新架构，不含旧机制指令） ──
assert.ok(DEFAULT_CONFIG.persona.roleText.includes('DeepSeek 小鲸鱼'), '默认人设为原版小鲸鱼角色卡');
for (const banned of ['[SILENT]', 'mcp__snowluma', 'qq_set_wake_config', 'qq_mark_read', 'qq_wait_for_messages', 'qq_send_message', '空格分隔（例如']) {
  assert.ok(!DEFAULT_CONFIG.persona.roleText.includes(banned), `默认人设不应包含旧架构指令：${banned}`);
}

console.log('✓ 提示词自测全部通过');
