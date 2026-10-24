// 触发链路语义回归（2026-09-25 重做后的核心承诺）：
//   1. 逐条判定：不触发的消息入库瞬间标已读（"未读一闪即已读"）；
//   2. 触发消息保持未读并进入固定倒计时；窗口内追加消息不判定、不重置倒计时；
//   3. 倒计时结束后触发批（触发消息 + 窗口内追加的）整体成为【未读信息】，
//      之前已读的闲聊是【已读信息】——边界恰好落在"触发消息之前"；
//   4. 4 档下任何消息必触发，聚批/边界语义与 1~3 档完全一致；
//   5. 暂停期间消息不判定不触发（只积压），恢复后走 drainBacklogAfterResume。
//
// ⚠️ 全程只用一次 bootApp：同进程里第二次 createApp 会因为模块级单例
//    （skillManager / 插件注册表）残留而连不上 OneBot（预存问题，与本次改动无关）。
//    场景之间用改配置 + 不同的消息区分，不再重复 boot/teardown。
//
// ⚠️ 档位由滑条位置派生（contextSliderPos → contextTier），直接写 contextTier
//    会被滑条换算覆盖（未传 pos = 全响应 4 档）。1 档 = sliderPos 0，4 档 = 100。
//    切换档位用 POST /api/config（运行中生效）。
// 运行：node test/wake-semantics-test.mjs
import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  config: { store: { contextSliderPos: 0, historyCount: 80 }, wakeDelayMs: 400 }
});
const { app, pushGroupMsg, llm, request } = env;
const unread = () => app.store.getChatMeta('group:456').unread;
const llmCount = () => llm.state.requests.length;
// 等本批会话彻底结束（含 drain 空转），避免场景之间互相污染
const settle = async () => { await sleep(700); };

// ── 场景 A：1 档（仅艾特）──
await check('A1 不触发的闲聊：当场标已读（零等待、零 LLM）', async () => {
  const before = llmCount();
  pushGroupMsg(111, '张三', '闲聊一句不吃鱼', 9001);
  await sleep(60);   // 远小于 wakeDelayMs：判定是纯本地计算，应已完成
  assert.equal(unread(), 0, '闲聊消息应已立即标已读');
  assert.equal(llmCount(), before, '不应产生 LLM 调用');
});

await check('A2 触发消息（@）：保持未读进倒计时；窗口内追加消息不判定不重置', async () => {
  pushGroupMsg(111, '张三', '@覆盖Bot 在吗', 9002);
  await sleep(80);
  assert.equal(unread(), 1, '触发消息应保持未读');
  pushGroupMsg(112, '李四', '我也插一句闲聊', 9003);
  await sleep(80);
  assert.equal(unread(), 2, '窗口内追加的消息应保持未读（不判定）');
  // 倒计时不可重置：追加消息不重置。触发后 ~500ms（400 窗口 + 余量）时
  // LLM 应已收到请求；若被重置（400ms 从追加起算），此刻必然还没到。
  await sleep(500 - 160);
  assert.ok(llmCount() >= 1, `倒计时不应被追加消息重置（期望已发起 LLM 请求，实际 ${llmCount()}）`);
});

await check('A3 边界：已读闲聊进【已读信息】，触发批进【未读信息】', async () => {
  await waitFor(() => llmCount() >= 1, 5000, 'LLM 请求到达');
  const req = llm.state.requests[0];
  const userText = String(req.messages[1].content);
  // 用完整段头定位（引导说明正文里也引用了段名，浅匹配会拿到正文行）
  const pastIdx = userText.indexOf('【已读信息】以下是');
  const wakeIdx = userText.indexOf('【未读信息】以下');
  assert.ok(pastIdx >= 0 && wakeIdx > pastIdx, '两个段落都应存在且已读信息在前');
  const pastText = userText.slice(pastIdx, wakeIdx);
  const wakeText = userText.slice(wakeIdx);
  assert.ok(pastText.includes('闲聊一句'), '触发前的已读闲聊应在【已读信息】');
  assert.ok(!pastText.includes('在吗'), '触发消息不应出现在【已读信息】');
  assert.ok(wakeText.includes('@覆盖Bot 在吗'), '触发消息应在【未读信息】');
  assert.ok(wakeText.includes('我也插一句闲聊'), '窗口内追加的消息应在【未读信息】');
});
await settle();

// ── 场景 B：切 4 档（全响应）──
await request('POST', '/api/config', { body: { store: { contextSliderPos: 100, historyCount: 80 } } });
await check('B1 4 档：任意消息必触发会话，且同为"触发 + 聚批"语义', async () => {
  const before = llmCount();
  pushGroupMsg(111, '张三', '随便说点什么', 9101);
  await waitFor(() => llmCount() > before, 5000, '4 档必触发');
  const userText = String(llm.state.requests.at(-1).messages[1].content);
  assert.ok(userText.includes('随便说点什么'), '触发消息应进【未读信息】');
});
await settle();

await check('B2 4 档：运行结束后 drain 再开新会话（批与批独立）', async () => {
  const before = llmCount();
  pushGroupMsg(111, '张三', '第二条独立消息', 9102);
  await waitFor(() => llmCount() > before, 6000, 'drain 后新会话');
});
await settle();

// ── 场景 C：暂停 / 恢复（4 档仍在）──
await check('C1 暂停期间消息只积压（未读），不触发不判定', async () => {
  await request('POST', '/api/pause', { body: { paused: true } });
  const before = llmCount();
  pushGroupMsg(111, '张三', '暂停期间的消息', 9201);
  await sleep(400);
  assert.equal(llmCount(), before, '暂停期间不应触发 LLM');
  assert.equal(unread(), 1, '消息应积压为未读');
});

await check('C2 恢复后处理积压（drainBacklogAfterResume）', async () => {
  const before = llmCount();
  await request('POST', '/api/pause', { body: { paused: false, skipBacklog: false } });
  await waitFor(() => llmCount() > before, 8000, '恢复后处理积压');
});
await settle();

// ── 场景 D：磁盘遗留的旧积压未读不得混进【未读信息】──────────────────────
// 真实事故（2026-09-25）：旧进程攒的 60+ 条积压未读躺在磁盘上，新进程启动后
// 第一条 @ 触发时 drain 把它们全部吃进触发批 —— 模型看到一大坨"未读信息"。
// 修复：批边界 = 倒计时起点；更早的旧积压标已读沉入【已读信息】。
await check('D1 旧积压（未经 onIncoming 的遗留未读）沉入【已读信息】，不进【未读信息】', async () => {
  // 直接往 store 塞积压未读，绕过 onIncoming（模拟旧进程/停机期间遗留）
  const oldTs = Date.now() - 5 * 60_000;
  for (let i = 0; i < 15; i++) {
    app.store.appendIncoming('group:456', {
      mid: 30000 + i, ts: oldTs + i * 1000,
      senderId: 'u' + (i % 3), senderName: '旧群友' + (i % 3),
      text: '旧积压闲聊' + i
    });
  }
  assert.equal(unread(), 15, '塞入的旧积压应为未读');
  // 正常路径触发：@ 消息经过 ingest → onIncoming → 倒计时 → wake
  const before = llmCount();
  pushGroupMsg(111, '张三', '@覆盖Bot 看看这段历史', 31000);
  await waitFor(() => llmCount() > before, 8000, '触发运行');
  const userText = String(llm.state.requests.at(-1).messages[1].content);
  // 2026-09-25 锚点改版后顺序 = 记忆 → 已读信息 → 未读信息（记忆在已读之前），
  // 已读段切片的右边界改用【未读信息】；锚定轮还可能在中间多出【新已读信息】段。
  const pastText = userText.slice(userText.indexOf('【已读信息】以下是'), userText.indexOf('【未读信息】以下'));
  const wakeText = userText.slice(userText.indexOf('【未读信息】以下'));
  assert.ok(pastText.includes('旧积压闲聊14'), '旧积压应沉入【已读信息】');
  assert.ok(!wakeText.includes('旧积压'), '旧积压不应混进【未读信息】');
  assert.ok(wakeText.includes('看看这段历史'), '触发消息应在【未读信息】');
  assert.equal(unread(), 0, '处理完后未读应清零');
});
await settle();

// ── 场景 E：运行期间进来的消息（drain 路径）─────────────────────────────
// 真实事故（2026-09-25 晚）：会话运行中 runningChats 占位，期间来的闲聊
// 不经判定挂着未读；会话结束 drain 无差别吃进批 → 大量 tier 0"未触发"会话、
// 【已读信息】为空、白烧 LLM。修复：drain 进 wake 时对未读逐条补判定。
// 时序要点：必须在会话**还在跑**时塞消息（模拟运行期到达）。
// ⚠️ mock 的 script 按**全局请求序号**索引，前面场景已消耗若干个 step，
// 想让本轮响应慢，必须把整段 script 尾部都填上 delay。
await request('POST', '/api/config', { body: { store: { contextSliderPos: 0 } } });   // 切回 1 档（B 场景切过 4 档）
await check('E1 运行期间的闲聊：会话结束后补判定不触发 → 标已读、不建新会话', async () => {
  // 让接下来的若干轮响应都慢（800ms），确保塞消息时会话仍在运行
  for (let i = 0; i < 6; i++) llm.state.script.push({ content: '（慢速响应）', delayMs: 800 });
  const before = llmCount();
  pushGroupMsg(111, '张三', '@覆盖Bot E1批', 32500);
  await waitFor(() => llmCount() > before, 8000, 'E1 触发');
  // 会话 running 中（LLM 响应还需 ~800ms）：塞 3 条运行期闲聊
  for (let i = 0; i < 3; i++) {
    app.store.appendIncoming('group:456', {
      mid: 33000 + i, ts: Date.now(), senderId: 'u9', senderName: '运行期闲聊者', text: '运行期闲聊' + i
    });
  }
  assert.equal(unread(), 3, '运行期闲聊应挂未读');
  // 等会话结束 + drainDelay + 补判定：全不触发 → 标已读、无新 LLM 调用
  const callsAfterE1 = llmCount();
  await sleep(4500);
  assert.equal(unread(), 0, '补判定不触发后应标已读');
  assert.equal(llmCount(), callsAfterE1, '不应为运行期闲聊调 LLM');
  const sessions = await app.sessions.listSummaries(10);
  assert.ok(!sessions.some((s) => (s.trigger || '').includes('运行期闲聊')),
    '不应为运行期闲聊创建会话');
});

await check('E2 运行期间的 @：会话结束后补判定触发 → 从 @ 消息起组批', async () => {
  for (let i = 0; i < 6; i++) llm.state.script.push({ content: '（慢速响应）', delayMs: 800 });
  const before = llmCount();
  pushGroupMsg(111, '张三', '@覆盖Bot E2批', 33900);
  await waitFor(() => llmCount() > before, 8000, 'E2 触发');
  // 会话 running 中：先塞闲聊、再塞 @（时间顺序：闲聊在前，@ 在后）
  app.store.appendIncoming('group:456', {
    mid: 34000, ts: Date.now(), senderId: 'u9', senderName: '运行期闲聊者', text: '运行期又一句闲聊'
  });
  await sleep(50);
  app.store.appendIncoming('group:456', {
    mid: 34001, ts: Date.now(), senderId: 'u10', senderName: '后来者', text: '@覆盖Bot 运行期被点名', atMe: true
  });
  // 会话结束 → drain → 补判定 → @ 触发
  const callsAfterE2 = llmCount();
  await waitFor(() => llmCount() > callsAfterE2, 10000, '运行期 @ 应触发');
  const userText = String(llm.state.requests.at(-1).messages[1].content);
  const wakeText = userText.slice(userText.indexOf('【未读信息】以下'));
  assert.ok(wakeText.includes('运行期被点名'), '运行期 @ 应进【未读信息】');
  assert.ok(!wakeText.includes('运行期又一句闲聊'), '@ 之前的闲聊不应进【未读信息】（沉入已读信息）');
});

await env.teardown();

console.log(`\n触发链路语义：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) { console.log('失败项：'); for (const f of fail) console.log('  - ' + f); process.exit(1); }
