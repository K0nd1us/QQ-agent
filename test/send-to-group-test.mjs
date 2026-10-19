import assert from 'node:assert/strict';
import { bootApp, createChecker, waitFor } from './_harness.mjs';

const c = createChecker('send_to 群成员授权');
const ctx = await bootApp({ config: {
  tools: { crossChatSend: true },
  tempSession: { enabled: true, groups: ['456', '789'] },
  sticker: { enabled: false, collectEnabled: false }
} });
const { app, request, onebotHttp, llm } = ctx;
const memberships = new Map([[555, new Set([456])], [666, new Set([789])], [667, new Set([789])]]);
const friends = new Set([555, 777]);
let memberFailure = false;
let friendFailure = false;
let protocolRejectsTemp = false;
let afterFriendLookup = null;
let blockNextSend = null;
const realCall = app.onebot.call.bind(app.onebot);
app.onebot.call = async (action, params, ...rest) => {
  if (action === 'get_group_member_info') {
    if (memberFailure) throw new Error('成员查询失败');
    return memberships.get(params.user_id)?.has(params.group_id)
      ? { user_id: params.user_id, group_id: params.group_id } : null;
  }
  if (action === 'get_friend_list') {
    if (friendFailure) throw new Error('好友查询失败');
    if (afterFriendLookup) await afterFriendLookup();
    return [...friends].map((user_id) => ({ user_id }));
  }
  if (action === 'send_private_msg' && blockNextSend) {
    const blocked = blockNextSend;
    blockNextSend = null;
    blocked.started = true;
    await blocked.wait;
  }
  if (action === 'send_private_msg' && params.group_id && protocolRejectsTemp) {
    throw new Error(`cannot send to user ${params.user_id} in group ${params.group_id}: no such temp session`);
  }
  return realCall(action, params, ...rest);
};
const { buildToolDefs } = await import('../src/tools.js');
const tool = buildToolDefs().find((d) => d.id === 'send_to');
const toolCtx = {
  chatKey: 'group:456', kind: 'group', chatId: '456', onebot: app.onebot,
  sender: app.sender, store: app.store, session: { id: 'send-to-test', sent: [] }, emit: () => {}
};
let message = 0;
const send = (target) => tool.execute(toolCtx, { targetChatKey: target, messages: [`主动私聊测试 ${++message}`] });
const patch = async (body) => {
  const r = await request('POST', '/api/config', { body });
  assert.equal(r.status, 200, r.text);
};
const rejected = async (target) => {
  const before = onebotHttp.state.sends.length;
  const recorded = toolCtx.session.sent.length;
  const r = await send(target);
  assert.equal(r.isError, true, r.content);
  assert.equal(onebotHttp.state.sends.length, before, '拒绝时不发送');
  assert.equal(toolCtx.session.sent.length, recorded, '拒绝时不记为发送成功');
  return r;
};

try {
  await c.check('未有私聊记录的群友好友，无需单独 QQ 白名单即可主动私聊', async () => {
    assert.equal(app.store.listChats().includes('private:555'), false);
    const r = await send('private:555');
    assert.ok(!r.isError, r.content);
    const last = onebotHttp.state.sends.at(-1);
    assert.equal(last.action, 'send_private_msg');
    assert.equal(last.body.user_id, 555);
    assert.equal(last.body.group_id, undefined);
    assert.equal(app.store.lastIncoming('private:555'), null, '不伪造入站消息');
  });

  await c.check('无私聊记录的非好友群成员，向协议端发起带正确群号的临时私聊', async () => {
    const r = await send('private:666');
    assert.ok(!r.isError, r.content);
    assert.equal(onebotHttp.state.sends.at(-1).body.user_id, 666);
    assert.equal(onebotHttp.state.sends.at(-1).body.group_id, 789);
    assert.equal(app.store.lastIncoming('private:666'), null);
  });

  await c.check('关闭 send_to、消息发送分类、单工具或工具总开关均不能主动私聊', async () => {
    for (const tools of [
      { crossChatSend: false }, { categories: { messaging: false } },
      { overrides: { send_to: false } }, { enabled: false }
    ]) {
      await patch({ tools });
      await rejected('private:555');
      await patch({ tools: { enabled: true, crossChatSend: true, categories: { messaging: true }, overrides: { send_to: true } } });
    }
  });

  await c.check('群成员私聊停用、群名单为空、非成员及身份查询失败均拒绝', async () => {
    await patch({ tempSession: { enabled: false } });
    await rejected('private:555');
    await patch({ tempSession: { enabled: true, groups: [] } });
    await rejected('private:555');
    await patch({ tempSession: { groups: ['456', '789'] } });
    await rejected('private:999');
    memberFailure = true;
    try { await rejected('private:555'); } finally { memberFailure = false; }
    friendFailure = true;
    try { await rejected('private:555'); } finally { friendFailure = false; }
  });

  await c.check('群、QQ、全局及按群成员黑名单均优先拦截，退群也不能发送', async () => {
    for (const config of [
      { deny: { groups: ['456'] } }, { deny: { private: ['555'] } },
      { blocklist: { '456': ['555'] } }, { globalBlocklist: ['555'] }
    ]) {
      await patch(config);
      await rejected('private:555');
      await patch({ deny: { groups: [], private: [] }, blocklist: { '456': [] }, globalBlocklist: [] });
    }
    memberships.get(555).clear();
    try { await rejected('private:555'); } finally { memberships.get(555).add(456); }
  });

  await c.check('查询期间停用群成员授权或 send_to 时，在途主动私聊被拦截', async () => {
    afterFriendLookup = () => patch({ tempSession: { enabled: false } });
    try { await rejected('private:555'); } finally { afterFriendLookup = null; }
    await patch({ tempSession: { enabled: true } });
    afterFriendLookup = () => patch({ tools: { crossChatSend: false } });
    try { await rejected('private:555'); } finally { afterFriendLookup = null; }
    await patch({ tools: { crossChatSend: true } });
  });

  await c.check('非好友变为好友后主动私聊切换正常路由，不沿用临时群号', async () => {
    friends.add(666);
    try {
      const r = await send('private:666');
      assert.ok(!r.isError, r.content);
      assert.equal(onebotHttp.state.sends.at(-1).body.group_id, undefined);
    } finally { friends.delete(666); }
  });

  await c.check('排队期间关闭 send_to，尚未出站的主动私聊也被拦截', async () => {
    let release;
    const blocked = { started: false, wait: new Promise((resolve) => { release = resolve; }) };
    blockNextSend = blocked;
    const first = app.sender.sendTextBatch('private:555', ['排队测试的前一条消息']);
    let pending;
    try {
      await waitFor(() => blocked.started, 2000, '前一条消息占用发送队列');
      let queried = false;
      afterFriendLookup = () => { queried = true; };
      pending = send('private:555');
      await waitFor(() => queried, 2000, 'send_to 已完成成员和好友查询');
      await patch({ tools: { crossChatSend: false } });
      release();
      await first;
      const result = await pending;
      assert.equal(result.isError, true, result.content);
      assert.match(result.content, /跨会话发送未开启/);
      assert.equal(onebotHttp.state.sends.at(-1).body.message.at(-1).data.text, '排队测试的前一条消息');
    } finally {
      release();
      await Promise.allSettled([first, pending].filter(Boolean));
      blockNextSend = null;
      afterFriendLookup = null;
      await patch({ tools: { crossChatSend: true } });
    }
  });

  await c.check('协议端拒绝新临时会话时如实报告，不降级绕过或伪报成功', async () => {
    protocolRejectsTemp = true;
    try {
      const r = await rejected('private:667');
      assert.match(r.content, /临时会话/);
    } finally { protocolRejectsTemp = false; }
  });

  await c.check('原有 QQ 白名单和群聊目标仍可用，黑名单目标和非法目标被拒绝', async () => {
    for (const target of ['private:777', 'group:789']) {
      if (target.startsWith('group:')) await patch({ allow: { groups: ['456', '789'] } });
      const r = await send(target);
      assert.ok(!r.isError, r.content);
    }
    await patch({ deny: { private: ['777'], groups: ['789'] } });
    await rejected('private:777');
    await rejected('group:789');
    await rejected('private:abc');
    await rejected('private:0555');
    await rejected('private:0');
    await rejected('private:9007199254740993');
    await rejected('group:456');
    await patch({ deny: { private: [], groups: [] } });
  });

  await c.check('真实群消息 → 模型 send_to → 白名单群友私聊全链路', async () => {
    const step = llm.state.requests.length;
    llm.state.script[step] = { toolCalls: [{ name: 'send_to', args: { targetChatKey: 'private:555', messages: ['模型主动私聊白名单群友'] } }] };
    llm.state.script[step + 1] = { content: '' };
    const before = onebotHttp.state.sends.length;
    ctx.pushGroupMsg(111, '群友', '@覆盖Bot 请私聊群友555', 88001);
    const session = await ctx.waitSessionDone('请私聊群友555');
    assert.equal(session.status, 'done');
    assert.equal(onebotHttp.state.sends.length, before + 1);
    assert.equal(onebotHttp.state.sends.at(-1).body.user_id, 555);
    assert.equal(onebotHttp.state.sends.at(-1).body.group_id, undefined);
  });
} finally { await ctx.teardown(); }
process.exit(c.finish() ? 0 : 1);
