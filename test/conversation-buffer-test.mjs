// 会话缓冲（"沉默为界"，②P1）单元测试：
//   1. ConversationStore：save / get / clear / list + **落盘**（换一个实例仍能读到）
//   2. resolveSilenceMs：按渠道自动取值 + 手动覆盖 + 0 = 不按沉默切分
//   3. sameToolNames：顺序无关，但集合必须完全一致
//   4. buildContinuationPrompt：**只带增量**，不带【已读信息】整窗
//      （延续轮的意义就是"只付增量的钱"，带上整窗等于双重计费）
// 纯离线：隔离数据目录 + 真实例。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-conv-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const { ConversationStore, resolveSilenceMs, sameToolNames } = await import('../src/conversation.js');
const { buildContinuationPrompt } = await import('../src/prompt.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

const pass = [], fail = [];
function check(name, fn) {
  try { fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

// ═══ 1. ConversationStore ═══
check('save 后 get 能取回；turns/chars 记账正确', () => {
  const s = new ConversationStore();
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在的' }
  ];
  s.save('group:100', { systemPrompt: 'SYS', toolNames: ['a', 'b'], messages, turns: 1 });
  const b = s.get('group:100');
  assert.ok(b, '应能取回缓冲');
  assert.equal(b.systemPrompt, 'SYS');
  assert.deepEqual(b.toolNames, ['a', 'b']);
  assert.equal(b.turns, 1);
  assert.equal(b.messages.length, 2);
  assert.equal(b.chars, '你好'.length + '在的'.length, 'chars 应等于内容字符数');
  assert.ok(b.lastTurnAt > 0 && b.startedAt > 0, '时间戳应被写入');
});

check('落盘：新实例（空缓存）仍能读到 —— 重启可续的关键', () => {
  const s2 = new ConversationStore();
  const b = s2.get('group:100');
  assert.ok(b, '换实例后应能从磁盘读回');
  assert.equal(b.systemPrompt, 'SYS');
  assert.equal(b.messages.length, 2);
});

check('save 二次调用会沿用 startedAt（会话开始时间不漂移）', () => {
  const s = new ConversationStore();
  const first = s.get('group:100');
  s.save('group:100', {
    systemPrompt: 'SYS', toolNames: ['a', 'b'],
    messages: [{ role: 'user', content: 'x' }], turns: 2
  });
  const b = s.get('group:100');
  assert.equal(b.startedAt, first.startedAt, 'startedAt 应沿用首次');
  assert.equal(b.turns, 2);
});

check('clear 删除内存与磁盘；get 变 null', () => {
  const s = new ConversationStore();
  assert.ok(s.get('group:100'), '清之前应存在');
  s.clear('group:100');
  assert.equal(s.get('group:100'), null, '清之后应为 null');
  assert.equal(new ConversationStore().get('group:100'), null, '磁盘上也不该再有');
});

check('list 返回缓冲摘要', () => {
  const s = new ConversationStore();
  s.save('group:200', { systemPrompt: 'S', toolNames: [], messages: [{ role: 'user', content: 'hi' }], turns: 3 });
  const list = s.list();
  const item = list.find((x) => x.chatKey === 'group:200');
  assert.ok(item, '列表里应有 group:200');
  assert.equal(item.turns, 3);
  assert.equal(item.messages, 1);
});

// ═══ 2. resolveSilenceMs ═══
check('未设 silenceMinutes → 按渠道自动取值（贴着各家缓存 TTL）', () => {
  assert.equal(resolveSilenceMs({}, { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4' }), 4 * 60_000);
  assert.equal(resolveSilenceMs({}, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }), 60 * 60_000);
  assert.equal(resolveSilenceMs({}, { baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen-plus' }), 5 * 60_000);
  assert.equal(resolveSilenceMs({}, { baseUrl: 'https://unknown.example.com', model: 'whatever' }), 5 * 60_000, '认不出渠道时兜底 5 分钟');
});

check('手动数值覆盖自动取值；0 = 不按沉默切分', () => {
  assert.equal(resolveSilenceMs({ silenceMinutes: 12 }, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }), 12 * 60_000);
  assert.equal(resolveSilenceMs({ silenceMinutes: 0 }, {}), 0, '0 表示不切分');
  assert.equal(resolveSilenceMs({ silenceMinutes: 0.05 }, {}), 3000, '小数可用于短阈值（测试/调试）');
});

// ═══ 3. sameToolNames ═══
check('sameToolNames：顺序无关，集合必须一致', () => {
  assert.equal(sameToolNames(['a', 'b'], ['b', 'a']), true, '顺序不同应视为相同');
  assert.equal(sameToolNames(['a', 'b'], ['a']), false, '少一个应不同');
  assert.equal(sameToolNames(['a'], ['a', 'c']), false, '多一个应不同');
  assert.equal(sameToolNames([], []), true);
  assert.equal(sameToolNames(null, []), true, 'null 当空处理');
});

// ═══ 4. buildContinuationPrompt ═══
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.botName = '测试机';
  setRuntimeConfig(cfg);
  const store = new ChatStore(0);
  const memory = new MemoryStore();
  const CHAT = 'group:900';
  memory.append(CHAT, 'memberImpression', '喜欢猫', { userId: 'u1', target: '小明' });

  let mid = 1;
  const read = (text, uid = 'u1') => {
    const e = store.appendIncoming(CHAT, { mid: ++mid, ts: Date.now(), senderId: uid, senderName: '小明', text });
    store.markEntryRead(CHAT, e.id);
    return e;
  };
  read('老消息1'); read('老消息2');
  const trigger = store.appendIncoming(CHAT, { mid: ++mid, ts: Date.now(), senderId: 'u1', senderName: '小明', text: '@测试机 新消息' });

  const delta = buildContinuationPrompt({
    chatKey: CHAT, kind: 'group', chatId: '900', chatName: '测试群',
    triggerEntries: [trigger], store, memory, selfNickname: '测试机', runSeq: 2
  });

  check('延续提示词带【未读信息】与【当前时间】', () => {
    assert.ok(delta.includes('【未读信息】以下是'), '应带未读信息段');
    assert.ok(delta.includes('@测试机 新消息'), '应包含本轮增量消息');
    assert.ok(delta.includes('【当前时间】'), '应带当前时间');
  });

  check('延续提示词带【记忆】（可能刚被自己更新过）', () => {
    assert.ok(delta.includes('【记忆】'), '应带记忆段');
    assert.ok(delta.includes('喜欢猫'), '记忆内容应包含相关群友印象');
  });

  check('延续提示词**不带**【已读信息】整窗（否则等于双重计费）', () => {
    assert.ok(!delta.includes('【已读信息】'), '不得带已读信息段');
    assert.ok(!delta.includes('老消息1'), '不得重复历史消息');
  });

  check('延续提示词不带【角色设定】【引导说明】【可用表情包】（都还在上下文里）', () => {
    assert.ok(!delta.includes('【角色设定'), '不得带角色设定');
    assert.ok(!delta.includes('【引导说明】'), '不得带引导说明');
    assert.ok(!delta.includes('【可用表情包】'), '不得带表情包目录');
  });
}

try { fs.rmSync(__testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n会话缓冲：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) { console.log('失败项：'); for (const f of fail) console.log('  - ' + f); process.exit(1); }
