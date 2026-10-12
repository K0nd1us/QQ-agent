// Regression for issue #13. Real stores/orchestrator, isolated files, mocked model only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-member-memory-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const realFetch = globalThis.fetch;
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const legacy = (chat, uid, content, time = 1) => write(path.join(dir, 'memory', chat, `${uid}.json`), {
  userId: uid, name: '同名成员', impressions: [{ content, createdAt: time }], updatedAt: time, lastConsolidatedAt: 0
});
legacy('group_1', '111', '喜欢猫');
legacy('group_2', '111', '长期学习日语', 2);
legacy('group_2', '222', '喜欢狗');
write(path.join(dir, 'memory', 'group_3.json'), { memberImpression: [
  { userId: '111', target: '同名成员', content: '喜欢猫', createdAt: 1 },
  { userId: '111', target: '同名成员', content: '擅长绘画', createdAt: 3 },
  { target: '无法确认QQ的人', content: '保留旧印象', createdAt: 4 }
] });
const orchestrators = [];
let passed = 0;
const requests = [], responses = [];
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'http://mock.invalid/v1/chat/completions');
  requests.push(JSON.parse(init.body));
  assert.ok(responses.length, 'Unexpected extra model call');
  const response = responses.shift();
  const payload = typeof response === 'function' ? await response() : response;
  if (payload instanceof Error) throw payload;
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }], usage: {} }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
};
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
try {
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
  const { MemoryStore } = await import('../src/memory.js');
  const { ChatStore } = await import('../src/store.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { listTools } = await import('../src/tool-registry.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api = { ...cfg.api, baseUrl: 'http://mock.invalid/v1', model: 'mock', apiKey: '' };
  cfg.memory = { ...cfg.memory, memberUpdateMinMessages: 3, consolidateMinIntervalMs: 60_000 };
  cfg.store.contextSliderPos = 0;
  cfg.allowAllWhenEmpty = true;
  setRuntimeConfig(cfg);
  const memory = new MemoryStore();
  const store = new ChatStore();
  const make = () => {
    const orch = new Orchestrator({ memory, store, onebot: { selfId: '888' } });
    orchestrators.push(orch);
    return orch;
  };
  const orch = make();
  const add = (chat, uid, text, opts = {}) => store.appendIncoming(chat, {
    mid: null, ts: now, senderId: uid, senderName: '同名成员', text, ...opts
  });
  const profile = uid => memory.getMember('private:999', uid);
  const contents = uid => profile(uid).impressions.map(e => e.content);
  await check('all legacy folders and single-file format merge by QQ id, deduplicate and preserve backups', () => {
    assert.deepEqual(contents('111'), ['喜欢猫', '长期学习日语', '擅长绘画']);
    assert.deepEqual(contents('222'), ['喜欢狗']);
    assert.ok(fs.existsSync(path.join(dir, 'memory', 'members', '111.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'memory', 'group_1', '111.json')));
    assert.ok(fs.existsSync(path.join(dir, 'memory', 'backups', 'migration-v2', 'group_1', '111.json')));
    assert.ok(fs.existsSync(path.join(dir, 'memory', 'backups', 'group_3.json')));
    assert.ok(memory.members('group:3').some(m => !m.userId && m.impressions[0].content === '保留旧印象'));
  });
  await check('legacy group traits retain source scope when shared or supplied to the update model', () => {
    assert.deepEqual(profile('111').impressions.find(e => e.content === '喜欢猫').sourceChatKeys, ['group:1', 'group:3']);
    assert.ok(memory.formatForPrompt('group:999', { userIds: ['111'] }).includes('群内关系仅适用于对应会话'));
  });
  await check('same-name different QQ accounts remain separate; prompt retrieves QQ traits in an unseen chat', () => {
    const prompt = memory.formatForPrompt('group:999', { userIds: ['111'] });
    assert.ok(prompt.includes('长期学习日语'));
    assert.ok(!prompt.includes('喜欢狗'));
    assert.ok(!prompt.includes('无法确认QQ的人'));
  });
  await check('migration and canonical profile lookup remain stable after restart', () => {
    const restarted = new MemoryStore();
    assert.deepEqual(restarted.getMember('private:111', '111').impressions.map(e => e.content), contents('111'));
    assert.equal(restarted.getMember('group:2', '111').impressions.length, 3);
  });
  await check('fewer than threshold new messages makes zero model calls even when old traits exist', async () => {
    memory.append('group:10', 'memberImpression', '喜欢猫', { userId: '1001', target: '成员' });
    add('group:10', '1001', '学习日语一'); add('group:10', '1001', '学习日语二');
    const count = requests.length;
    assert.equal(await orch.maybeUpdateMemberMemory('group:10'), null);
    assert.equal(requests.length, count);
  });
  await check('existing 1→2 impressions uses old traits AND new messages in one automatic request', async () => {
    add('group:10', '1001', '长期学习日语三');
    responses.push({ impressions: ['喜欢猫', '长期学习日语'] });
    const count = requests.length;
    const result = await orch.maybeUpdateMemberMemory('group:10');
    assert.equal(result.failed.length, 0);
    assert.equal(requests.length, count + 1);
    assert.deepEqual(contents('1001'), ['喜欢猫', '长期学习日语']);
    const prompt = requests.at(-1).messages[1].content;
    assert.ok(prompt.includes('喜欢猫') && prompt.includes('学习日语一') && prompt.includes('长期学习日语三'));
    assert.equal(profile('1001').processedMessages['group:10'].id, 3);
  });
  await check('new message totals combine group/private chats; each chat gets its own cursor', async () => {
    add('group:20', '2001', '喜欢做饭');
    add('private:2001', '2001', '长期学习做饭');
    add('private:2001', '2001', '经常自己下厨');
    responses.push({ impressions: ['喜欢做饭'] });
    await orch.maybeUpdateMemberMemory('group:20');
    assert.equal(profile('2001').processedMessages['group:20'].id, 1);
    assert.equal(profile('2001').processedMessages['private:2001'].id, 2);
    assert.ok(requests.at(-1).messages[1].content.includes('private:2001'));
    assert.ok(memory.formatForPrompt('group:900', { userIds: ['2001'] }).includes('喜欢做饭'));
  });
  await check('cooldown follows QQ id across chats, without blocking a different QQ', async () => {
    for (let i = 0; i < 3; i++) add('group:21', '2001', `发言${i}`);
    const count = requests.length;
    assert.equal(await orch.maybeUpdateMemberMemory('group:21'), null);
    assert.equal(requests.length, count);
    assert.ok(orch.memoryUpdateTimers.has('group:21'), 'cooldown schedules a wake even without another incoming message');
    for (let i = 0; i < 3; i++) add('group:21', '2002', `其他人发言${i}`);
    responses.push({ impressions: ['喜欢运动'] });
    const result = await orch.maybeUpdateMemberMemory('group:21');
    assert.deepEqual(result.results.map(r => r.userId), ['2002']);
  });
  await check('after cooldown only unprocessed messages are sent, and restarting preserves progress', async () => {
    now += 60_001;
    responses.push({ impressions: ['喜欢做饭', '经常参加聚会'] });
    await orch.maybeUpdateMemberMemory('group:21');
    const prompt = requests.at(-1).messages[1].content;
    assert.ok(prompt.includes('发言0'));
    assert.ok(!prompt.includes('经常自己下厨'));
    const restarted = new MemoryStore();
    assert.equal(restarted.getMember('private:2001', '2001').processedMessages['group:21'].id, 3);
    assert.equal(await orch.maybeUpdateMemberMemory('group:21'), null);
  });
  await check('same-name sender is not used as evidence for another QQ', async () => {
    add('group:30', '3001', '长期喜欢猫');
    add('group:30', '3002', '仅另一个QQ说过的事实');
    responses.push({ impressions: ['长期喜欢猫'] });
    await orch.consolidateMemoryForChat('group:30', { userIds: ['3001'], force: true });
    assert.ok(!requests.at(-1).messages[1].content.includes('仅另一个QQ说过的事实'));
  });
  await check('self messages, pokes, empty messages, and invalid sender ids cannot satisfy threshold', async () => {
    store.appendSelf('group:31', { text: '自言自语', ts: now });
    add('group:31', '3101', '', {}); add('group:31', '3101', '拍一拍', { isPoke: true });
    add('group:31', 'invalid', '说话'); add('group:31', '3101', '唯一有效发言');
    const count = requests.length;
    assert.equal(await orch.maybeUpdateMemberMemory('group:31'), null);
    assert.equal(requests.length, count);
  });
  await check('malformed/schema-invalid/model-failed responses preserve traits and cursors', async () => {
    memory.append('group:40', 'memberImpression', '原印象', { userId: '4001', target: '甲' });
    for (let i = 0; i < 3; i++) add('group:40', '4001', `新证据${i}`);
    const before = profile('4001');
    for (const response of ['not json', {}, { impressions: [42] }, new Error('mock failure')]) {
      responses.push(response);
      const result = await orch.consolidateMemoryForChat('group:40', { userIds: ['4001'], force: true });
      assert.equal(result.failed.length, 1);
      assert.deepEqual(profile('4001'), before);
    }
    assert.equal(await orch.maybeUpdateMemberMemory('group:40'), null, 'failure retry is throttled');
    now += 60_001;
    responses.push({ impressions: ['原印象', '新稳定印象'] });
    await orch.maybeUpdateMemberMemory('group:40');
    assert.equal(profile('4001').processedMessages['group:40'].id, 3);
  });
  await check('valid empty extraction still persists progress and cooldown', async () => {
    for (let i = 0; i < 3; i++) add('group:41', '4101', `临时聊天${i}`);
    responses.push({ impressions: [] });
    const result = await orch.maybeUpdateMemberMemory('group:41');
    assert.equal(result.failed.length, 0);
    assert.deepEqual(contents('4101'), []);
    assert.equal(profile('4101').processedMessages['group:41'].id, 3);
    assert.equal(await orch.maybeUpdateMemberMemory('group:41'), null);
  });
  await check('max impression count and length enforced; duplicate traits removed', async () => {
    add('group:42', '4201', '足够手动分析的消息');
    responses.push({ impressions: ['重复', '重复', 'x'.repeat(180), '三', '四', '五', '六', '七'] });
    await orch.consolidateMemoryForChat('group:42', { userIds: ['4201'], force: true });
    assert.equal(contents('4201').length, 5);
    assert.equal(contents('4201')[1].length, 120);
  });
  await check('a capped batch advances only sampled messages, preserving the rest', async () => {
    for (let i = 0; i < 45; i++) add('group:43', '4301', `消息${i}`);
    responses.push({ impressions: ['印象'] });
    await orch.maybeUpdateMemberMemory('group:43');
    assert.equal(profile('4301').processedMessages['group:43'].id, 40);
    assert.ok(!requests.at(-1).messages[1].content.includes('消息44'));
    now += 60_001;
    responses.push({ impressions: ['印象'] });
    await orch.maybeUpdateMemberMemory('group:43');
    assert.equal(profile('4301').processedMessages['group:43'].id, 45);
    assert.ok(requests.at(-1).messages[1].content.includes('消息44'));
    assert.ok(!requests.at(-1).messages[1].content.includes('消息0'));
  });
  await check('QQ lock blocks cross-chat overlap, and incoming messages during request remain pending', async () => {
    for (let i = 0; i < 3; i++) add('group:50', '5001', `旧消息${i}`);
    let release, entered;
    const started = new Promise(r => entered = r);
    responses.push(async () => { entered(); await new Promise(r => release = r); return { impressions: ['印象'] }; });
    const first = orch.maybeUpdateMemberMemory('group:50');
    await started;
    add('group:51', '5001', '请求过程中新增');
    const count = requests.length;
    const second = await orch.consolidateMemoryForChat('group:51', { userIds: ['5001'], force: true });
    assert.equal(second.skipped.length, 1);
    assert.equal(requests.length, count);
    release(); await first;
    assert.equal(profile('5001').processedMessages['group:51'], undefined);
    assert.equal(profile('5001').processedMessages['group:50'].id, 3);
  });
  await check('tool/UI edits during request are preserved rather than overwritten', async () => {
    memory.append('group:52', 'memberImpression', '初始', { userId: '5201', target: '甲' });
    add('group:52', '5201', '新发言');
    responses.push(() => {
      memory.append('private:5201', 'memberImpression', '请求期间工具新记录', { userId: '5201', target: '甲' });
      return { impressions: ['模型旧快照'] };
    });
    const result = await orch.consolidateMemoryForChat('group:52', { userIds: ['5201'], force: true });
    assert.equal(result.failed.length, 1);
    assert.deepEqual(contents('5201'), ['初始', '请求期间工具新记录']);
    assert.equal(profile('5201').processedMessages['group:52'], undefined);
  });
  await check('explicit QQ query and deletion work from a different chat; name alone cannot delete numeric profiles', async () => {
    const query = listTools().find(t => t.id === 'memory_query');
    const result = await query.execute({ memory, chatKey: 'group:999' }, { userId: '5201' });
    assert.ok(result.content.includes('请求期间工具新记录'));
    assert.equal(memory.remove('group:52', 'memberImpression', { target: '甲' }), false);
    assert.equal(memory.remove('group:999', 'memberImpression', { userId: '5201', content: '初始' }), true);
    assert.deepEqual(contents('5201'), ['请求期间工具新记录']);
    memory.removeMember('group:999', '5201');
    assert.deepEqual(contents('5201'), []);
    assert.ok(!memory.members('private:5201').some(m => m.userId === '5201'));
  });
  await check('removing a chat unlinks members without destroying global QQ traits', () => {
    memory.removeChat('group:10');
    assert.equal(memory.members('group:10').length, 0);
    assert.deepEqual(contents('1001'), ['喜欢猫', '长期学习日语']);
    assert.ok(memory.formatForPrompt('private:1001', { userIds: ['1001'] }).includes('长期学习日语'));
  });
  await check('automatic update runs for silent incoming messages without a normal chat-model reply', async () => {
    const silent = make();
    const start = requests.length;
    for (let i = 0; i < 2; i++) silent.onIncoming('group:60', add('group:60', '6001', `普通闲聊${i}`, { atMe: false }));
    assert.equal(requests.length, start);
    responses.push({ impressions: ['喜欢聊天'] });
    silent.onIncoming('group:60', add('group:60', '6001', '长期爱聊天', { atMe: false }));
    for (let i = 0; i < 30 && !profile('6001').lastConsolidatedAt; i++) await new Promise(r => setImmediate(r));
    assert.deepEqual(contents('6001'), ['喜欢聊天']);
    assert.equal(requests.length, start + 1);
    assert.ok(!silent.pendingWake.has('group:60'));
  });
  await check('disabled/paused automatic updater makes zero model calls', async () => {
    for (let i = 0; i < 3; i++) add('group:61', '6101', `消息${i}`);
    const count = requests.length;
    cfg.memory.consolidateEnabled = false;
    assert.equal(await orch.maybeUpdateMemberMemory('group:61'), null);
    cfg.memory.consolidateEnabled = true;
    orch.paused = true;
    assert.equal(await orch.maybeUpdateMemberMemory('group:61'), null);
    orch.paused = false;
    assert.equal(requests.length, count);
  });
  await check('per-batch member limit leaves other members eligible for the next automatic check', async () => {
    for (const uid of ['7101', '7102', '7103', '7104']) {
      for (let i = 0; i < 3; i++) add('group:71', uid, `发言${i}`);
    }
    responses.push(...Array.from({ length: 3 }, () => ({ impressions: ['印象'] })));
    const first = await orch.maybeUpdateMemberMemory('group:71');
    assert.equal(first.results.length, 3);
    responses.push({ impressions: ['第四人的印象'] });
    const second = await orch.maybeUpdateMemberMemory('group:71');
    assert.deepEqual(second.results.map(r => r.userId), ['7104']);
  });
  await check('pending member messages are still counted after 2000 newer messages from someone else', async () => {
    for (let i = 0; i < 3; i++) add('group:72', '7201', `较早的新证据${i}`);
    for (let i = 0; i < 2001; i++) add('group:72', '7202', `后续闲聊${i}`);
    responses.push({ impressions: ['较早证据提炼'] });
    const result = await orch.consolidateMemoryForChat('group:72', { userIds: ['7201'], automatic: true });
    assert.equal(result.results.length, 1);
    assert.ok(requests.at(-1).messages[1].content.includes('较早的新证据0'));
    assert.ok(!requests.at(-1).messages[1].content.includes('后续闲聊'));
  });
  await check('deleting shared traits retains cursors and does not replay already processed messages', async () => {
    memory.removeMember('private:1001', '1001');
    assert.deepEqual(contents('1001'), []);
    now += 60_001;
    const count = requests.length;
    assert.equal(await orch.maybeUpdateMemberMemory('group:10'), null);
    assert.equal(requests.length, count);
  });
  await check('cooldown timer actually wakes and updates without any additional incoming message', async () => {
    // Cancel other test timers before exercising a real timer against our simulated clock.
    for (const instance of orchestrators) {
      for (const timer of instance.memoryUpdateTimers.values()) clearTimeout(timer);
      instance.memoryUpdateTimers.clear();
    }
    const timerStore = new ChatStore();
    const timerOrch = new Orchestrator({ memory, store: timerStore, onebot: { selfId: '888' } });
    orchestrators.push(timerOrch);
    for (let i = 0; i < 3; i++) timerStore.appendIncoming('group:73', {
      senderId: '7301', senderName: '定时成员', text: `新消息${i}`, ts: now
    });
    memory.markMemberProcessed('group:73', '7301', { id: 0, ts: 0 }, now - 59_000);
    assert.equal(await timerOrch.maybeUpdateMemberMemory('group:73'), null);
    responses.push({ impressions: ['定时更新印象'] });
    now += 1001;
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.deepEqual(contents('7301'), ['定时更新印象']);
  });
  await check('out-of-order timestamps cannot advance cursors past unsampled messages', async () => {
    for (let i = 0; i < 45; i++) add('group:74', '7401', `乱序消息${i}`, { ts: now + (45 - i) * 1000 });
    responses.push({ impressions: ['印象'] });
    await orch.consolidateMemoryForChat('group:74', { userIds: ['7401'], force: true });
    assert.equal(profile('7401').processedMessages['group:74'].id, 40);
    assert.ok(requests.at(-1).messages[1].content.includes('乱序消息0'));
    assert.ok(!requests.at(-1).messages[1].content.includes('乱序消息44'));
  });
  await check('pause clears cooldown timers and resume schedules retained chats again', () => {
    orch.setPaused(true);
    assert.equal(orch.memoryUpdateTimers.size, 0);
    orch.setPaused(false);
    assert.ok(orch.memoryUpdateTimers.size > 0);
  });
  await check('denied historical chats do not trigger or contribute evidence to automatic updates', async () => {
    for (let i = 0; i < 3; i++) add('group:75', '7501', `被屏蔽的发言${i}`);
    add('group:76', '7501', '允许会话中的一条发言');
    cfg.deny.groups = ['75'];
    const count = requests.length;
    assert.equal(await orch.maybeUpdateMemberMemory('group:75'), null);
    assert.equal(await orch.maybeUpdateMemberMemory('group:76'), null);
    assert.equal(requests.length, count);
    cfg.deny.groups = [];
  });
  await check('corrupt canonical profile is preserved and reported, never silently replaced', () => {
    const file = path.join(dir, 'memory', 'members', '6201.json');
    fs.writeFileSync(file, '{invalid');
    assert.throws(() => memory.getMember('group:62', '6201'), /损坏/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
  });
  await check('recalled and blocked senders cannot contribute new memory evidence', async () => {
    const blocked = add('group:78', '7801', '撤回内容', { mid: 780 });
    store.markRecalled('group:78', 780);
    cfg.blocklist['78'] = ['7802']; cfg.globalBlocklist = ['7803'];
    for (const uid of ['7802', '7803']) for (let i = 0; i < 3; i++) add('group:78', uid, `屏蔽发言${i}`);
    const before = requests.length;
    assert.equal(await orch.maybeUpdateMemberMemory('group:78'), null);
    assert.equal(requests.length, before);
    cfg.blocklist['78'] = []; cfg.globalBlocklist = [];
  });
  await check('failed migration backup leaves original and canonical profile untouched, retry succeeds', () => {
    legacy('group_79', '7901', '完整旧印象');
    const source = path.join(dir, 'memory', 'group_79', '7901.json');
    const canonical = path.join(dir, 'memory', 'members', '7901.json');
    const originalCopy = fs.copyFileSync;
    const fresh = new MemoryStore();
    try {
      fs.copyFileSync = () => { throw new Error('simulated disk failure'); };
      assert.throws(() => fresh.getMember('group:79', '7901'), /disk failure/);
      assert.ok(fs.existsSync(source)); assert.ok(!fs.existsSync(canonical));
    } finally { fs.copyFileSync = originalCopy; }
    assert.equal(fresh.getMember('group:79', '7901').impressions[0].content, '完整旧印象');
    assert.ok(!fs.existsSync(source));
  });
  await check('migration preserves a conflicting prior backup and all source impression text', () => {
    legacy('group_80', '8001', '长'.repeat(400));
    const backup = path.join(dir, 'memory', 'backups', 'migration-v2', 'group_80', '8001.json');
    write(backup, { previous: 'do not overwrite' });
    const migrated = new MemoryStore();
    assert.equal(migrated.getMember('group:80', '8001').impressions[0].content.length, 400);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup)), { previous: 'do not overwrite' });
    assert.ok(fs.existsSync(backup + '.1'));
  });
  assert.equal(responses.length, 0);
  console.log(`\n${passed} memory regression checks passed; no real model or QQ calls.`);
} finally {
  for (const orch of orchestrators) {
    orch.aborted = true;
    for (const timer of orch.memoryUpdateTimers.values()) clearTimeout(timer);
    for (const timer of orch.wakeTimers.values()) clearTimeout(timer);
    orch.memoryUpdateTimers.clear();
  }
  globalThis.fetch = realFetch;
  Date.now = realNow;
  fs.rmSync(dir, { recursive: true, force: true });
}
