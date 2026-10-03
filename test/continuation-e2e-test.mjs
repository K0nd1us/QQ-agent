// 会话延续端到端（②P1"沉默为界"）：
//   1. 首次触发 → fresh（无历史会话），并把缓冲写盘
//   2. 紧接着再触发（间隔 < 沉默阈值）→ continuation：
//      **第 2 次请求的 messages 以第 1 次的 messages 逐字节开头**，只追加增量
//   3. 手动「重开会话」接口 → 缓冲清空，下次触发回到 fresh
//   4. 沉默超过阈值 → 回到 fresh
//
// 沉默阈值用 0.1 分钟（6 秒）—— 既能在一轮里跑完"连续→沉默"的对比，
// 又留足余量（连续那次间隔 < 1 秒，沉默那次 sleep 7 秒）。
import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  config: {
    store: {
      contextSliderPos: 100,
      historyCount: 20,
      continuation: { enabled: true, silenceMinutes: 0.1, maxTurns: 30, maxChars: 240000 }
    },
    wakeDelayMs: 200,
    drainDelayMs: 150
  }
});
const { app, llm, pushGroupMsg, teardown, request } = env;

const reqCount = () => llm.state.requests.length;
const contList = async () => (await request('GET', '/api/continuations')).data.continuations || [];

// 触发一次并等这一轮跑完（LLM 请求数 +1、会话结束、缓冲写盘）
async function fire(text, mid) {
  const before = reqCount();
  pushGroupMsg(111, '张三', text, mid);
  await waitFor(() => reqCount() > before, 8000, `触发：${text}`);
  await sleep(500);   // 等 #runAgent 收尾（写缓冲 + sessions.finish）
  return llm.state.requests[reqCount() - 1];
}

// ═══ 场景 1：首次触发 = fresh，并建立缓冲 ═══
await check('首次触发走 fresh，并把会话缓冲写盘（turns=1）', async () => {
  const req = await fire('@覆盖Bot 第一句', 70001);
  assert.equal(req.messages.length, 2, '首次会话 messages 应只有 system + user');
  // 首次会话没有任何已读历史 → 段头是"（暂无历史记录）"那种，所以只断言段名
  assert.ok(String(req.messages[1].content).includes('【已读信息】'), 'fresh 轮应带【已读信息】段');
  const list = await contList();
  const item = list.find((x) => x.chatKey === 'group:456');
  assert.ok(item, `应出现会话缓冲：${JSON.stringify(list)}`);
  assert.equal(item.turns, 1, 'turns 应为 1');
});

// ═══ 场景 2：紧接触发 = continuation，前缀逐字节复用 ═══
await check('紧接触发走 continuation：新请求以上一轮 messages 逐字节开头，只追加增量', async () => {
  const before = llm.state.requests.length;
  const prev = llm.state.requests[before - 1];
  const req = await fire('@覆盖Bot 第二句', 70002);

  // 核心断言：前缀完全一致（这是"命中前缀缓存"的前提）
  const prefix = req.messages.slice(0, prev.messages.length);
  assert.equal(
    JSON.stringify(prefix), JSON.stringify(prev.messages),
    '第二轮请求的 messages 前缀必须与第一轮逐字节一致'
  );
  assert.ok(req.messages.length > prev.messages.length, '应追加了增量');
  assert.equal(req.messages[0].content, prev.messages[0].content, 'system 提示应逐字节相同');

  // 增量消息只带新内容，不重复已读信息整窗
  const delta = req.messages[req.messages.length - 1];
  assert.equal(delta.role, 'user', '最后一条应是 user（本轮增量）');
  assert.ok(String(delta.content).includes('第二句'), '增量应包含本条新消息');
  assert.ok(!String(delta.content).includes('第一句'), '增量不该重复上一轮的消息');
  assert.ok(!String(delta.content).includes('【已读信息】'), '延续轮不得再带【已读信息】整窗');

  const item = (await contList()).find((x) => x.chatKey === 'group:456');
  assert.equal(item.turns, 2, 'turns 应累加到 2');
});

// ═══ 场景 3：手动「重开会话」→ 缓冲清空，下次回到 fresh ═══
await check('手动重开会话：缓冲被清空，下次触发回到 fresh', async () => {
  const r = await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.had, true, '重开前应存在缓冲');
  assert.equal((await contList()).some((x) => x.chatKey === 'group:456'), false, '列表里不该再有它');

  const req = await fire('@覆盖Bot 重开之后', 70003);
  assert.equal(req.messages.length, 2, '重开后应是全新的 system + user');
  assert.ok(String(req.messages[1].content).includes('【已读信息】以下是'), 'fresh 轮应带【已读信息】整窗');
});

await check('重开会话接口对"本来就没有缓冲"的会话也返回 200（幂等）', async () => {
  await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  const r = await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.had, false, '第二次应报 had=false');
});

// ═══ 场景 4：沉默超过阈值 → 回到 fresh ═══
await check('沉默超过阈值后触发：走 fresh（不再续用旧上下文）', async () => {
  // 先建立一段缓冲（上一条用例把缓冲清掉了），再静默 7 秒（阈值 6 秒）
  await fire('@覆盖Bot 先建立一段', 70004);
  assert.ok((await contList()).some((x) => x.chatKey === 'group:456'), '此时应有缓冲');
  await sleep(7000);
  const req = await fire('@覆盖Bot 沉默之后', 70005);
  assert.equal(req.messages.length, 2, '沉默超阈值后应回到全新的 system + user');
});

// ═══ 场景 5：软重置后又能继续续用 ═══
await check('沉默重置后的下一轮又能走 continuation（链路自愈）', async () => {
  const before = llm.state.requests.length;
  const prev = llm.state.requests[before - 1];
  const req = await fire('@覆盖Bot 重置后紧接着', 70006);
  const prefix = req.messages.slice(0, prev.messages.length);
  assert.equal(JSON.stringify(prefix), JSON.stringify(prev.messages), '软重置后应重新开始锚定并复用前缀');
});

await teardown();

console.log(`\n会话延续端到端：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) { console.log('失败项：'); for (const f of fail) console.log('  - ' + f); process.exit(1); }
