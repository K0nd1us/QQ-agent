import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-protocol-test-'));
process.env.QQ_AGENT_DATA_DIR = temp;
process.env.QQ_AGENT_HOST = '127.0.0.1';
process.env.QQ_AGENT_PORT = '';
process.env.QQ_AGENT_TOKEN = '';
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { OneBotTransport: OneBotClient } = await import('../modules/headless/onebot.js');
const { QQBotClient } = await import('../modules/headless/qqbot.js');
const { BotConnection, validateConnection, CONNECTION_DEFAULTS, connectionConfig } = await import('../modules/headless/connection.js');
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import('../src/config.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, label = 'condition') {
  for (let i = 0; i < 150; ++i) { if (await fn()) return; await sleep(20); }
  throw new Error(`Timed out: ${label}`);
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function cleanupServer(t, server, wss) {
  t.after(() => { for (const ws of wss?.clients || []) ws.terminate(); wss?.close(); server.closeAllConnections(); server.close(); });
}
const answer = (ws, p, data, extra = {}) => ws.send(JSON.stringify({ echo: p.echo, status: 'ok', retcode: 0, data, ...extra }));

test('OneBot forward WS: auth, concurrent echo, errors, timeouts and pending disconnect', async t => {
  const server = http.createServer();
  const port = await listen(server);
  const wss = new WebSocketServer({ server }); cleanupServer(t, server, wss);
  let peer;
  const requests = [];
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, 'Bearer test-onebot'); peer = ws;
    ws.on('message', raw => {
      const p = JSON.parse(raw); requests.push(p);
      if (p.action === 'get_login_info') answer(ws, p, { user_id: 42, nickname: 'fixture' });
      if (p.action === 'first') setTimeout(() => answer(ws, p, 'first'), 30);
      if (p.action === 'second') answer(ws, p, 'second');
      if (p.action === 'failure') answer(ws, p, null, { status: 'ok', retcode: 100 });
    });
  });
  const events = [];
  const client = new OneBotClient({ wsUrl: `ws://127.0.0.1:${port}`, apiTransport: 'ws', accessToken: 'test-onebot', onEvent: e => events.push(e) });
  t.after(() => client.close()); await client.connect();
  await wait(() => client.selfId === '42');
  assert.deepEqual(await Promise.all([client.call('first'), client.call('second')]), ['first', 'second']);
  assert.equal(events.length, 0, 'API responses do not become events');
  await assert.rejects(client.call('failure'), /retcode=100/);
  await assert.rejects(client.call('timeout', {}, 20), /timed out/);
  const pending = assert.rejects(client.call('pending'), /closed/);
  await wait(() => requests.some(p => p.action === 'pending'));
  peer.terminate(); await pending;
  assert.equal(client.pending.size, 0);
  assert.equal(requests.filter(p => p.action === 'pending').length, 1);
});

test('OneBot reverse WS: bearer authentication, Universal role, duplicate rejection and listener cleanup', async t => {
  const server = http.createServer(); const port = await listen(server); cleanupServer(t, server);
  const client = new OneBotClient({ server, mode: 'reverse', accessToken: 'reverse-secret', apiTransport: 'ws' });
  t.after(() => client.close()); await client.connect();
  async function refused(headers, code) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers });
    await new Promise((resolve, reject) => {
      ws.on('unexpected-response', (req, res) => { assert.equal(res.statusCode, code); res.resume(); ws.terminate(); resolve(); });
      ws.on('open', () => reject(new Error('unauthorized connection accepted')));
      ws.on('error', () => {});
    });
  }
  await refused({}, 401);
  await refused({ Authorization: 'Bearer reverse-secret', 'X-Client-Role': 'API' }, 401);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer reverse-secret', 'X-Client-Role': 'Universal' } });
  t.after(() => ws.terminate());
  ws.on('message', raw => { const p = JSON.parse(raw); answer(ws, p, p.action === 'get_login_info' ? { user_id: 43, nickname: 'reverse' } : { message_id: -99 }); });
  await wait(() => client.selfId === '43');
  await refused({ Authorization: 'Bearer reverse-secret' }, 409);
  assert.equal((await client.sendText('group', '123', 'hello')).message_id, -99);
  client.close();
  assert.equal(server.listenerCount('upgrade'), 0);
});

async function officialFixture(t) {
  const server = http.createServer(); const port = await listen(server);
  const wss = new WebSocketServer({ server }); cleanupServer(t, server, wss);
  const state = { peers: [], packets: [], requests: [], tokens: 0, ack: true };
  wss.on('connection', ws => {
    state.peers.push(ws);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 80 } }));
    ws.on('message', raw => {
      const p = JSON.parse(raw); state.packets.push(p);
      if (p.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1', user: { id: 'bot-id', username: 'Official fixture' } } }));
      if (p.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 2, d: {} }));
      if (p.op === 1 && state.ack) ws.send(JSON.stringify({ op: 11, d: null }));
    });
  });
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (String(url).includes('getAppAccessToken')) {
      state.tokens++; assert.deepEqual(body, { appId: 'app-1', clientSecret: 'secret-1' });
      return Response.json({ access_token: 'token-fixture', expires_in: '120' });
    }
    assert.equal(options.headers.authorization, 'QQBot token-fixture');
    assert.equal(options.headers['X-Union-Appid'], 'app-1');
    state.requests.push({ url, body });
    if (String(url).endsWith('/gateway/bot')) return Response.json({ url: `ws://127.0.0.1:${port}` });
    if (String(url).endsWith('/files')) return Response.json({ file_info: 'image-info' });
    return Response.json({ id: `sent-${state.requests.length}` });
  };
  const events = [];
  const client = new QQBotClient({ appId: 'app-1', appSecret: 'secret-1', intents: 1107296256, fetchImpl, reconnectMs: 20, onEvent: e => events.push(e) });
  t.after(() => client.close()); await client.connect(); await wait(() => client.connected);
  const dispatch = (type, data) => state.peers.at(-1).send(JSON.stringify({ op: 0, t: type, s: 3, d: data }));
  return { state, client, events, dispatch };
}
const groupMessage = (id = 'message-alpha') => ({ id, group_openid: 'GROUP_OPENID_ABC', author: { member_openid: 'USER_OPENID_ABC' }, content: '<@!bot-id> hello', timestamp: new Date().toISOString(), attachments: [{ content_type: 'image/png', url: 'https://example.com/test.png' }] });

test('QQBot identify/token reuse, group/C2C normalization, reply binding and media upload', async t => {
  const { state, client, events, dispatch } = await officialFixture(t);
  assert.equal(state.packets[0].op, 2);
  assert.equal(state.packets[0].d.token, 'QQBot token-fixture');
  dispatch('GROUP_AT_MESSAGE_CREATE', groupMessage());
  dispatch('GROUP_AT_MESSAGE_CREATE', groupMessage());
  await wait(() => events.length === 1);
  const event = events[0];
  assert.equal(event.group_id, 'qqbot_group_GROUP_OPENID_ABC');
  assert.equal(event.message_id, 'message-alpha');
  assert.equal(event.message[0].data.qq, 'bot-id');
  assert.equal(event.message[1].data.text, 'hello');
  assert.equal(event.message[2].type, 'image');
  const id = event.group_id;
  const count = state.requests.length;
  await assert.rejects(client.sendText('group', 'qqbot_group_OTHER', 'bad', { replyToMessageId: 'message-alpha' }), /本会话|缺少/);
  assert.equal(state.requests.length, count);
  await client.sendText('group', id, 'first', { replyToMessageId: 'message-alpha' });
  await client.sendText('group', id, 'second');
  const replies = state.requests.filter(r => r.url.endsWith('/messages'));
  assert.equal(replies[0].body.msg_id, 'message-alpha');
  assert.deepEqual(replies.map(r => r.body.msg_seq), [1, 2]);
  await client.sendImage('group', id, 'https://example.com/image.png');
  assert.equal(state.requests.at(-2).body.srv_send_msg, false);
  assert.equal(state.requests.at(-1).body.msg_type, 7);
  assert.equal(state.requests.at(-1).body.media.file_info, 'image-info');
  await assert.rejects(client.sendImage('group', id, 'base64://aaa'), /URL/);
  await client.sendText('group', id, 'four'); await client.sendText('group', id, 'five');
  await assert.rejects(client.sendText('group', id, 'six'), /5 次/);
  client.anchors.get('message-alpha').receivedAt -= 300001;
  await assert.rejects(client.sendText('group', id, 'expired'), /过期/);
  dispatch('C2C_MESSAGE_CREATE', { id: 'c2c-id', author: { user_openid: 'C2C_OPENID' }, content: 'private hello', timestamp: new Date().toISOString() });
  await wait(() => events.length === 2);
  assert.equal(events[1].user_id, 'qqbot_user_C2C_OPENID');
  await client.sendText('private', events[1].user_id, 'reply');
  assert.match(state.requests.at(-1).url, /\/v2\/users\/C2C_OPENID\/messages$/);
  assert.equal(state.tokens, 1);
  await assert.rejects(client.sendPoke(), /不支持/);
  await assert.rejects(client.call('get_group_member_list'), /不支持/);
});

test('QQBot gateway reconnect uses Resume; missed heartbeat ACK reconnects; close cancels retries', async t => {
  const { state, client } = await officialFixture(t);
  state.peers.at(-1).send(JSON.stringify({ op: 7, d: null }));
  await wait(() => state.packets.some(p => p.op === 6));
  const resume = state.packets.find(p => p.op === 6);
  assert.equal(resume.d.token, 'token-fixture');
  assert.equal(resume.d.session_id, 'session-1'); assert.equal(resume.d.seq, 1);
  await wait(() => client.connected);
  state.ack = false;
  const before = state.peers.length;
  await wait(() => state.peers.length > before, 'heartbeat timeout reconnect');
  client.close(); const closed = state.peers.length;
  await sleep(150); assert.equal(state.peers.length, closed);
});

test('OpenID archive and memory survive new store instances; legacy endpoints migrate', () => {
  const key = 'group:qqbot_group_GROUP-ABC';
  const store = new ChatStore();
  store.appendIncoming(key, { mid: 'string-mid', senderId: 'MEMBER_OPENID_ABC', senderName: 'member', text: 'persist me' });
  const reloaded = new ChatStore(); assert.ok(reloaded.listChats().includes(key));
  assert.equal(reloaded.recent(key, { limit: 1 })[0].mid, 'string-mid');
  const memory = new MemoryStore();
  // Write through the public memory API used by the agent.
  memory.replaceMember(key, 'MEMBER_OPENID_ABC', 'member', ['persisted']);
  assert.ok(new MemoryStore().listChats().includes(key));
  const migrated = connectionConfig({ snowluma: { wsUrl: 'ws://legacy:3001', httpUrl: 'http://legacy:3000', accessToken: 'legacy', autoLaunch: true } });
  assert.equal(migrated.onebot.apiTransport, 'http'); assert.equal(migrated.onebot.accessToken, 'legacy');
  const cfg = structuredClone(CONNECTION_DEFAULTS); cfg.enabled = true; cfg.onebot.mode = 'reverse';
  assert.throws(() => validateConnection(cfg), /token/);
});

test('Disabled connection blocks API and scheduled sends before transport I/O', async t => {
  const config = structuredClone(CONNECTION_DEFAULTS);
  config.onebot.apiTransport = 'http';
  const connection = new BotConnection({ config, onEvent: () => {} });
  t.after(() => connection.close());
  connection.selfInfo = { user_id: 42, nickname: 'core-refresh-fixture' };
  assert.equal(connection.selfId, '42', 'core delayed identity refresh remains compatible');
  let requests = 0;
  connection.client.call = async () => { requests++; return {}; };
  connection.client.sendText = async () => { requests++; return {}; };
  await assert.rejects(connection.sendText('group', '123', 'scheduled'), /未启用/);
  await assert.rejects(connection.call('get_group_list'), /未启用/);
  assert.equal(requests, 0);
});
