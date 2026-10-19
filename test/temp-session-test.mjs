import assert from 'node:assert/strict';
import { bootApp, createChecker, sleep, waitFor } from './_harness.mjs';
import { privateMessageSource } from '../src/temp-session.js';

const c = createChecker('群临时会话');
const ctx = await bootApp({ config: {
  tempSession: { enabled: true, groups: ['456', '789'] },
  tools: { crossChatSend: false },
  sticker: { enabled: false, collectEnabled: false }
} });
const { app, request, onebotHttp, onebotWs, llm } = ctx;
const realCall = app.onebot.call.bind(app.onebot);
let memberFailure = false;
const memberships = new Map([
  [111, new Set([456, 789])], [444, new Set([789])], [777, new Set([456])]
]);
app.onebot.call = async (action, params, ...rest) => {
  if (action === 'get_group_member_info') {
    if (memberFailure) throw new Error('成员查询不可用');
    return memberships.get(params.user_id)?.has(params.group_id)
      ? { user_id: params.user_id, group_id: params.group_id, nickname: '群友' } : null;
  }
  return realCall(action, params, ...rest);
};
let mid = 7000;
const event = (user, group, extra = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'group',
  user_id: user, self_id: 888, message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: user, nickname: `群友${user}`, ...(group == null ? {} : { group_id: group }) },
  message: [{ type: 'text', data: { text: `临时会话测试 ${mid}` } }], ...extra
});
const patch = async (body) => {
  const r = await request('POST', '/api/config', { body });
  assert.equal(r.status, 200, r.text);
};
const rejectEvent = async (e) => {
  const chats = app.store.listChats();
  const before = app.store.lastIncoming(`private:${e.user_id}`)?.id;
  const sends = onebotHttp.state.sends.length;
  const calls = llm.state.requests.length;
  onebotWs.push(e);
  await sleep(350);
  assert.equal(app.store.lastIncoming(`private:${e.user_id}`)?.id, before, '拒绝消息不入库');
  assert.equal(onebotHttp.state.sends.length, sends, '拒绝消息不回复');
  assert.equal(llm.state.requests.length, calls, '拒绝消息不触发模型');
  assert.deepEqual(app.store.listChats(), chats, '拒绝消息不产生空会话');
};

try {
  await c.check('支持 SnowLuma 的 sender.group_id 及顶层来源；冲突、缺失不猜测', () => {
    assert.deepEqual(privateMessageSource(event(111, 456)), { temporary: true, groupId: '456' });
    assert.equal(privateMessageSource(event(111, null, { group_id: 789 })).groupId, '789');
    assert.equal(privateMessageSource(event(111, 456, { group_id: 789 })).groupId, null);
    assert.equal(privateMessageSource(event(111, null)).groupId, null);
    assert.equal(privateMessageSource(event(111, null, { temp_source: { group_id: '456' } })).groupId, '456');
  });

  await c.check('非好友、未列入 QQ 白名单的群成员可触发真实模型工具回复，出站携带来源群', async () => {
    llm.state.script.push({ toolCalls: [{ name: 'send_message', args: { messages: ['临时会话收到'] } }] }, { content: '' });
    onebotWs.push(event(111, 456));
    await waitFor(() => onebotHttp.state.sends.some((s) => s.body.user_id === 111), 10000, '临时会话回复');
    const sent = onebotHttp.state.sends.find((s) => s.body.user_id === 111);
    assert.equal(sent.action, 'send_private_msg');
    assert.equal(sent.body.group_id, 456);
    assert.equal(app.store.lastIncoming('private:111').sourceGroupId, '456');
    await waitFor(() => app.sessions.listSummaries().some((s) => s.chatKey === 'private:111' && s.status === 'done'), 10000, '会话完成');
  });

  await c.check('关闭 send_to 不影响当前私聊回复；消息发送分类和 send_message 开关仍生效', async () => {
    const tools = llm.state.requests[0].tools.map((t) => t.function.name);
    assert.ok(tools.includes('send_message'));
    assert.ok(!tools.includes('send_to'));
    const { getToolAvailability } = await import('../src/tool-registry.js');
    const { buildToolDefs } = await import('../src/tools.js');
    const defs = buildToolDefs();
    const send = defs.find((d) => d.id === 'send_message');
    const cross = defs.find((d) => d.id === 'send_to');
    assert.equal(getToolAvailability(send.id, { toolsCfg: { crossChatSend: false } }).enabled, true);
    assert.equal(getToolAvailability(cross.id, { toolsCfg: { crossChatSend: false } }).enabled, false);
    assert.equal(getToolAvailability(send.id, { toolsCfg: { categories: { messaging: false } } }).enabled, false);
    assert.equal(getToolAvailability(send.id, { toolsCfg: { overrides: { send_message: false } } }).enabled, false);
  });

  await c.check('未知来源、冲突来源、非成员、查询失败均拒绝，即便 QQ 本身已在好友白名单', async () => {
    await rejectEvent(event(777, null));
    await rejectEvent(event(777, 555));
    await rejectEvent(event(777, 456, { group_id: 789 }));
    await rejectEvent(event(999, 456));
    memberFailure = true;
    try { await rejectEvent(event(777, 456)); } finally { memberFailure = false; }
  });

  await c.check('空来源名单不能被 allowAllWhenEmpty 放行；停用同样拒绝', async () => {
    await patch({ tempSession: { groups: [] }, allowAllWhenEmpty: true });
    await rejectEvent(event(777, 456));
    await patch({ tempSession: { groups: ['456', '789'], enabled: false } });
    await rejectEvent(event(777, 456));
    await patch({ tempSession: { enabled: true }, allowAllWhenEmpty: false });
  });

  await c.check('群黑名单、QQ 黑名单、群内屏蔽和全局屏蔽继续优先拦截', async () => {
    for (const config of [
      { deny: { groups: ['456'] } }, { deny: { private: ['777'] } },
      { blocklist: { '456': ['777'] } }, { globalBlocklist: ['777'] }
    ]) {
      await patch(config);
      await rejectEvent(event(777, 456));
      await patch({ deny: { groups: [], private: [] }, blocklist: { '456': [] }, globalBlocklist: [] });
    }
  });

  await c.check('图片、表情、原始消息段和重启后的存档路由均携带群号', async () => {
    const { ChatStore } = await import('../src/store.js');
    assert.equal(new ChatStore().lastIncoming('private:111').sourceGroupId, '456');
    const capped = new ChatStore(1);
    capped.appendIncoming('private:333', { senderId: '333', text: '入站', sourceGroupId: '456' });
    capped.appendSelf('private:333', { text: '回复' });
    assert.equal(new ChatStore().sourceGroupId('private:333'), '456', '裁剪历史后仍持久保留来源');
    assert.equal(new ChatStore().accessGroupId('private:333'), '456');
    await app.sender.sendImage('private:111', { dataUrl: 'base64://aGVsbG8=' });
    await app.sender.sendSticker('private:111', { id: 'test', url: 'base64://c3RpY2tlcg==' });
    await app.onebot.sendSegments('private', '111', [{ type: 'text', data: { text: '段' } }]);
    for (const send of onebotHttp.state.sends.slice(-3)) assert.equal(send.body.group_id, 456);
  });

  await c.check('处理期间新来源不会覆盖当前回复群号；停用后在途回复被拦截', async () => {
    await app.onebot.withPrivateSource('111', '789', async () => {
      await sleep(10);
      await app.sender.sendTextBatch('private:111', ['固定群号回复']);
    });
    assert.equal(onebotHttp.state.sends.at(-1).body.group_id, 789);
    await patch({ tempSession: { enabled: false } });
    await assert.rejects(app.sender.sendTextBatch('private:111', ['停用后的回复']), /停用|不被允许/);
    await patch({ tempSession: { enabled: true } });
  });

  await c.check('普通好友私聊仍按原名单处理，后续好友消息清除临时来源', async () => {
    await rejectEvent(event(222, null, { sub_type: 'friend' }));
    llm.state.script.push({ toolCalls: [{ name: 'send_message', args: { messages: ['好友收到'] } }] }, { content: '' });
    onebotWs.push(event(777, null, { sub_type: 'friend' }));
    await waitFor(() => onebotHttp.state.sends.some((s) => s.body.user_id === 777), 10000, '好友回复');
    assert.equal(onebotHttp.state.sends.find((s) => s.body.user_id === 777).body.group_id, undefined);
    await patch({ allow: { private: ['777', '111'] } });
    const friend = event(111, null, { sub_type: 'friend' });
    onebotWs.push(friend);
    await waitFor(() => app.store.lastIncoming('private:111')?.sourceGroupId === null, 5000, '好友清除来源');
    await app.onebot.sendText('private', '111', '好友路径');
    assert.equal(onebotHttp.state.sends.at(-1).body.group_id, undefined);
    await ctx.waitSessionDone(`临时会话测试 ${friend.message_id}`);
  });

  await c.check('加好友后的群成员不需要 QQ 白名单，即使从未发过临时消息也能直接私聊', async () => {
    await patch({ allow: { private: ['777'] } });
    for (const user of [111, 444]) {
      llm.state.script[llm.state.requests.length] = { toolCalls: [{ name: 'send_message', args: { messages: [`群友好友回复 ${user}`] } }] };
      llm.state.script[llm.state.requests.length + 1] = { content: '' };
      const before = onebotHttp.state.sends.length;
      const e = event(user, null, { sub_type: 'friend' });
      onebotWs.push(e);
      await waitFor(() => onebotHttp.state.sends.length > before, 2000, '群成员好友私聊回复');
      const send = onebotHttp.state.sends.at(-1);
      assert.equal(send.body.user_id, user);
      assert.equal(send.body.group_id, undefined, '好友回复使用普通私聊路由');
      const incoming = app.store.lastIncoming(`private:${user}`);
      assert.equal(incoming.sourceGroupId, null, '不伪造好友消息的临时来源');
      assert.equal(incoming.accessGroupId, user === 111 ? '456' : '789', '记录成员授权群');
      await ctx.waitSessionDone(`临时会话测试 ${e.message_id}`);
    }
  });

  await c.check('好友群成员的授权也受开关、群名单、成员身份及各类黑名单约束', async () => {
    for (const config of [
      { tempSession: { enabled: false } }, { tempSession: { groups: [] } },
      { tempSession: { groups: ['456'] } }, { deny: { groups: ['789'] } },
      { deny: { private: ['444'] } }, { blocklist: { '789': ['444'] } },
      { globalBlocklist: ['444'] }
    ]) {
      await patch(config);
      await rejectEvent(event(444, null, { sub_type: 'friend' }));
      await assert.rejects(app.sender.sendTextBatch('private:444', ['撤销授权后不再回复']), /停用|不被允许/);
      await patch({ tempSession: { enabled: true, groups: ['456', '789'] },
        deny: { groups: [], private: [] }, blocklist: { '789': [] }, globalBlocklist: [] });
    }
    memberships.get(444).clear();
    try { await rejectEvent(event(444, null, { sub_type: 'friend' })); }
    finally { memberships.get(444).add(789); }
    memberFailure = true;
    try { await rejectEvent(event(444, null, { sub_type: 'friend' })); }
    finally { memberFailure = false; }
    const { ChatStore } = await import('../src/store.js');
    assert.equal(new ChatStore().sourceGroupId('private:444'), null);
    assert.equal(new ChatStore().accessGroupId('private:444'), '789', '好友授权可跨重启恢复');
    await app.onebot.withPrivateSource('444', null, async () => {
      await sleep(10);
      await app.sender.sendTextBatch('private:444', ['好友群授权独立于临时路由']);
    }, '789');
    assert.equal(onebotHttp.state.sends.at(-1).body.group_id, undefined);
  });

  await c.check('API 校验临时配置，去重群号且不覆盖黑名单', async () => {
    for (const tempSession of [null, { enabled: 'true' }, { groups: '*' }, { groups: ['-1'] }, { groups: [1.5] }]) {
      assert.equal((await request('POST', '/api/config', { body: { tempSession } })).status, 400);
    }
    await patch({ deny: { private: ['999'] }, tempSession: { groups: [456, '456'] } });
    const cfg = (await request('GET', '/api/config')).data;
    assert.deepEqual(cfg.tempSession.groups, ['456']);
    assert.deepEqual(cfg.deny.private, ['999']);
  });
} finally {
  await ctx.teardown();
}
process.exit(c.finish() ? 0 : 1);
