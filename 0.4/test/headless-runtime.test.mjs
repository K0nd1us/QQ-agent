import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-headless-test-'));
process.env.QQ_AGENT_DATA_DIR = temp;
process.env.QQ_AGENT_HOST = '127.0.0.1';
process.env.QQ_AGENT_PORT = '';
process.env.QQ_AGENT_TOKEN = '';
process.env.QQ_AGENT_ALLOWED_HOSTS = '';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(url).hostname !== '127.0.0.1') return Promise.reject(new Error('External network disabled by headless test'));
  return realFetch(url, options);
};
after(() => { globalThis.fetch = realFetch; fs.rmSync(temp, { recursive: true, force: true }); });
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig, getConfig } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { OneBotClient: DesktopOneBot } = await import('../src/onebot.js');
const { createHeadlessApp } = await import('../modules/headless/index.js');
const { CONNECTION_DEFAULTS } = await import('../modules/headless/connection.js');
const { serverOptions } = await import('../modules/headless/console.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  for (let i = 0; i < 250; i++) { if (await fn()) return; await sleep(20); }
  assert.fail(label);
}

async function boot(t, patch = {}) {
  setRuntimeConfig(deepMerge(DEFAULT_CONFIG, {
    extensions: { hotReload: false }, proactive: { enabled: false },
    connection: structuredClone(CONNECTION_DEFAULTS), ...patch
  }));
  const env = { QQ_AGENT_HOST: '127.0.0.1', QQ_AGENT_PORT: '0', QQ_AGENT_TOKEN: 'console-fixture', QQ_AGENT_ALLOWED_HOSTS: 'console.test' };
  const app = createHeadlessApp({ env, log: () => {} });
  t.after(async () => { await app.stop(); app.server.closeAllConnections(); });
  const port = await app.start();
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...options, headers: { 'content-type': 'application/json', 'x-console-token': env.QQ_AGENT_TOKEN, ...options.headers }
  });
  return { app, env, port, request };
}

test('headless composition is opt-in and validates credentials before taking a data lock', async () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  assert.throws(() => createHeadlessApp({ env: {} }), /requires/);
  assert.throws(() => serverOptions(DEFAULT_CONFIG, { QQ_AGENT_TOKEN: 'fixture', QQ_AGENT_PORT: 'oops' }), /PORT/);
  const app = createApp({ log: () => {} });
  try {
    assert.ok(app.onebot instanceof DesktopOneBot);
    assert.equal(app.onebot.constructor, DesktopOneBot);
    assert.equal(typeof app.launchSnowluma, 'function');
    assert.equal(typeof app.launchPortableQQ, 'function');
    assert.equal(getConfig().connection, undefined, 'desktop defaults do not acquire module-specific settings');
  } finally { await app.stop(); }
});

test('console login, SSE cookies, host/origin checks, secret masking and desktop route isolation', async t => {
  const { app, env, port, request } = await boot(t);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.match(await (await fetch(base)).text(), /Console token/);
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  const hostStatus = host => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/api/config', headers: { host, 'x-console-token': env.QQ_AGENT_TOKEN } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(await hostStatus('evil.example'), 403);
  assert.equal(await hostStatus('console.test'), 200);
  assert.equal((await request('/api/config', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/login`, { method: 'POST', body: 'bad json' })).status, 400);
  const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token: env.QQ_AGENT_TOKEN }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 200);
  const page = await fetch(`${base}/runtime/connection`, { headers: { cookie } });
  assert.match(await page.text(), /Save and connect/);
  await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/events`, { headers: { cookie } }, res => {
      assert.equal(res.statusCode, 200);
      res.once('data', chunk => { assert.match(String(chunk), /event: hello/); req.destroy(); resolve(); });
    });
    req.on('error', reject);
  });
  let response = await request('/api/config', { method: 'POST', body: JSON.stringify({ connection: {
    type: 'qqbot', enabled: false, qqbot: { appId: 'fixture-app', appSecret: 'fixture-app-secret' }
  } }) });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /fixture-app-secret/);
  assert.doesNotMatch(await (await request('/api/config')).text(), /fixture-app-secret/);
  const connection = await (await request('/api/runtime/connection')).json();
  assert.equal(connection.qqbot.appSecret, undefined);
  assert.equal(connection.qqbot.hasAppSecret, true);
  const chatKey = 'group:qqbot_group_GROUP-ABC';
  app.store.appendIncoming(chatKey, { mid: 'fixture-mid', senderId: 'MEMBER_OPENID', senderName: 'fixture-user', text: 'OpenID fixture' });
  app.memory.replaceMember(chatKey, 'MEMBER_OPENID', 'fixture-user', ['fixture memory']);
  assert.match(await (await request('/api/chats/group_qqbot_group_GROUP-ABC/messages')).text(), /OpenID fixture/);
  assert.equal((await request('/api/memory-files/group_qqbot_group_GROUP-ABC')).status, 200);
  assert.equal((await request('/api/memory-files/group_qqbot_group_GROUP-ABC/members/MEMBER_OPENID', {
    method: 'PUT', body: JSON.stringify({ name: 'fixture-user', impressions: ['updated fixture memory'] })
  })).status, 200);
  assert.equal((await request('/api/config', { method: 'POST', body: JSON.stringify({ connection: { type: 'invalid' } }) })).status, 400);
  assert.equal(app.onebot.type, 'qqbot');
  assert.equal((await request('/api/qq-portable/launch', { method: 'POST', body: '{}' })).status, 409);
  assert.equal((await request('/api/snowluma/launch', { method: 'POST', body: '{}' })).status, 409);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'config.json'))).server.token, '', 'environment credential is not persisted');
  env.QQ_AGENT_TOKEN = 'rotated-console-fixture';
  assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 401, 'rotated token invalidates sessions');
});

async function modelFixture(t) {
  const state = { requests: 0, block: false, blocked: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    state.requests++;
    if (state.block) { state.blocked++; return; }
    const alreadySent = body.messages.some(m => m.role === 'tool' && m.name === 'send_message');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture-model', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: `tool-${state.requests}`, type: 'function', function: {
        name: alreadySent ? 'finish' : 'send_message', arguments: JSON.stringify(alreadySent ? { reason: 'fixture done' } : { messages: ['fixture reply'] })
      } }]
    } }] }));
  });
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { state, port };
}

async function protocolPeer(t, port, token, sends) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { authorization: `Bearer ${token}` } });
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  ws.on('message', raw => {
    const p = JSON.parse(raw);
    let data = {};
    if (p.action === 'get_login_info') data = { user_id: 888, nickname: 'fixture' };
    else if (p.action === 'get_group_member_info') data = { user_id: p.params.user_id, nickname: 'fixture-user', shut_up_timestamp: 0 };
    else if (p.action === 'get_group_info') data = { group_id: p.params.group_id, group_name: 'fixture-group' };
    else if (['send_group_msg', 'send_private_msg'].includes(p.action)) { sends.push(p); data = { message_id: -100 - sends.length }; }
    ws.send(JSON.stringify({ echo: p.echo, status: 'ok', retcode: 0, data }));
  });
  await once(ws, 'open');
  return ws;
}
function incoming(ws, kind, id) {
  ws.send(JSON.stringify({
    post_type: 'message', message_type: kind, self_id: 888, user_id: 777,
    ...(kind === 'group' ? { group_id: 456 } : {}),
    sender: { user_id: 777, nickname: 'fixture-user' }, message_id: id,
    time: Date.now() / 1000, message: [{ type: 'text', data: { text: `hello-${id}` } }]
  }));
}

test('saving connections twice still produces private/group replies through mock LLM and OneBot', async t => {
  const model = await modelFixture(t);
  const { app, port, request } = await boot(t, {
    api: { baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: 'model-fixture', model: 'fixture-model', maxRounds: 3 },
    allow: { private: ['777'], groups: ['456'] }, wakeDelayMs: 1,
    store: { contextSliderPos: 100 }, send: { minGapMs: 0, maxGapMs: 0, byLengthMs: 0, dedupeWindowMs: 0 }
  });
  const sends = [];
  for (const revision of [1, 2]) {
    const token = `reverse-fixture-${revision}`;
    const response = await request('/api/config', { method: 'POST', body: JSON.stringify({ connection: {
      enabled: true, type: 'onebot', onebot: { mode: 'reverse', apiTransport: 'ws', accessToken: token }
    } }) });
    assert.equal(response.status, 200);
    const peer = await protocolPeer(t, port, token, sends);
    await waitFor(() => app.onebot.selfId === '888', 'OneBot identity missing');
    incoming(peer, 'private', revision * 10);
    incoming(peer, 'group', revision * 10 + 1);
    await waitFor(() => sends.length === revision * 2, 'private and group replies did not reach the protocol peer');
    await waitFor(() => app.orchestrator.runningChats.size === 0, 'reply sessions did not finish');
  }
  assert.equal(sends.filter(p => p.action === 'send_private_msg').length, 2);
  assert.equal(sends.filter(p => p.action === 'send_group_msg').length, 2);
  assert.equal(app.orchestrator.paused, false);
});

test('reconfiguration cancels an in-flight model request without reviving its old send', async t => {
  const model = await modelFixture(t);
  const { app, port, request } = await boot(t, {
    api: { baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: 'model-fixture', model: 'fixture-model', maxRounds: 3 },
    allow: { private: ['777'] }, wakeDelayMs: 1
  });
  const save = token => request('/api/config', { method: 'POST', body: JSON.stringify({ connection: {
    type: 'onebot', enabled: true, onebot: { mode: 'reverse', apiTransport: 'ws', accessToken: token }
  } }) });
  assert.equal((await save('old-fixture')).status, 200);
  const sends = [];
  const oldPeer = await protocolPeer(t, port, 'old-fixture', sends);
  await waitFor(() => app.onebot.selfId === '888', 'old peer missing');
  model.state.block = true;
  incoming(oldPeer, 'private', 300);
  await waitFor(() => model.state.blocked > 0, 'model call did not start');
  assert.equal((await save('new-fixture')).status, 200);
  await waitFor(() => app.orchestrator.runningChats.size === 0, 'old model call was not cancelled');
  assert.equal(sends.length, 0);
  model.state.block = false;
  const peer = await protocolPeer(t, port, 'new-fixture', sends);
  await waitFor(() => app.onebot.selfId === '888', 'new peer missing');
  incoming(peer, 'private', 301);
  await waitFor(() => sends.length === 1, 'new message was not answered after reconfiguration');
});

test('SIGTERM exits the standalone module cleanly and releases its instance lock', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-headless-signal-'));
  const guard = path.join(dataDir, 'network-guard.mjs');
  fs.writeFileSync(guard, `const original = globalThis.fetch; globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : Promise.reject(new Error('External requests disabled'));`);
  const child = spawn(process.execPath, ['--import', guard, 'modules/headless/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_HOST: '127.0.0.1', QQ_AGENT_PORT: '0', QQ_AGENT_TOKEN: 'signal-fixture' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await waitFor(() => /Headless console listening on port \d+/.test(output), `child startup failed: ${output}`);
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await exit;
  assert.equal(code, 0, output);
  assert.equal(signal, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), false);
});

test('shutdown wins over an overlapping connection reconfiguration', async t => {
  const { app, request } = await boot(t);
  let connecting = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  app.onebot.connect = async () => { connecting = true; await gate; };
  const save = request('/api/config', { method: 'POST', body: JSON.stringify({ connection: { onebot: { wsUrl: 'ws://127.0.0.1:39999' } } }) });
  await waitFor(() => connecting, 'reconfiguration did not enter the connection operation');
  await app.stop();
  release();
  assert.equal((await save).status, 200);
  assert.equal(app.orchestrator.aborted, true, 'late configuration completion must not resume a stopped app');
  assert.equal(app.orchestrator.reminderTimer, null);
});
