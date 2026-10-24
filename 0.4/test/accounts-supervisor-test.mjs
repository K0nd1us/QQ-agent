// 多账号端到端：真实启动 supervisor + 两个账号 worker + 两个假 OneBot。
// 验证：单进程内隔离、独立端口/数据目录、消息不串、HUB 增删改查、脱敏与启停。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createSupervisor } from '../src/accounts/supervisor.js';
import { loadRegistry, findAccount, saveRegistry, writeAccountConfig } from '../src/accounts/registry.js';
import { pickFreePort } from '../src/accounts/ports.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 15000, label = 'condition') {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(60);
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

function jsonReply(res, data) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
}

function createFakeOneBot({ uin, nickname }) {
  const state = { calls: [], sends: [], events: [] };
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const action = req.url.replace(/^\//, '');
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
      state.calls.push(action);
      if (action === 'get_login_info') return jsonReply(res, { user_id: Number(uin), nickname });
      if (action === 'get_group_list') return jsonReply(res, [{ group_id: Number(uin) === 10001 ? 111 : 222, group_name: `${nickname}的群` }]);
      if (action === 'get_group_info') return jsonReply(res, { group_id: body.group_id, group_name: `群${body.group_id}` });
      if (action === 'get_group_member_info') return jsonReply(res, { card: `名片${body.user_id}`, nickname: `昵称${body.user_id}` });
      if (action === 'get_group_member_list') return jsonReply(res, []);
      if (action === 'get_friend_list') return jsonReply(res, []);
      if (action === 'send_group_msg' || action === 'send_private_msg') {
        state.sends.push({ action, body });
        return jsonReply(res, { message_id: 7000 + state.sends.length });
      }
      if (action === 'send_poke' || action === 'group_poke') return jsonReply(res, {});
      return jsonReply(res, {});
    });
  });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const ready = new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket) => { state.socket = socket; });

  return {
    state,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      await ready;
      return { httpPort: server.address().port, wsPort: wss.address().port };
    },
    push(event) {
      state.events.push(event);
      if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error('假 OneBot WS 未连接');
      state.socket.send(JSON.stringify(event));
    },
    async close() {
      try { state.socket?.close(); } catch { /* ignore */ }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function makeConfig({ protocol, port, groups, apiKey, model, skillEnabled = true }) {
  return {
    api: {
      baseUrl: 'http://127.0.0.1:9', apiKey, model, provider: '',
      fallbackModels: [], vision: false, video: false, maxRounds: 4, temperature: 0.8,
      timeoutMs: 5000, thinkingMode: 'off', thinkingEffort: '', thinkingBudget: 0,
      priceInputPerM: 0, priceOutputPerM: 0, priceCachedPerM: 0, useOfficialPrice: false, modelPrices: {}
    },
    providers: [],
    dshProviderKeys: {},
    webSearch: { enabled: false, provider: 'bing', maxResults: 3, providers: [] },
    security: {},
    onebot: protocol,
    snowluma: { dir: path.join(os.tmpdir(), 'qqa-no-snowluma'), autoLaunch: false, ...protocol },
    allow: { groups, private: [] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {},
    globalBlocklist: [],
    communityExemptions: [],
    persona: { botName: '小鲸鱼', selfNickname: '', roleText: '角色卡：测试用', participation: 'medium', customRules: '', systemPromptOverride: '' },
    personaByChat: {},
    personaUnified: true,
    store: { contextSliderPos: 0, contextTier: 1, maxMessagesPerChat: 0, keepSessionFiles: 0 },
    proactive: { enabled: false },
    memory: { consolidateEnabled: false },
    send: {},
    tools: { enabled: false, categories: {} },
    skills: { 'token-saver': { enabled: skillEnabled, mode: 'balanced' } },
    extensions: { hotReload: false },
    server: { port, token: '', autoStart: false, closeToTray: true },
    ui: { theme: 'dark' }
  };
}

async function main() {
  console.log('\n=== 启动两个互不相同的假协议端 ===');
  const fakeA = createFakeOneBot({ uin: 10001, nickname: '一号鱼' });
  const fakeB = createFakeOneBot({ uin: 10002, nickname: '二号鱼' });
  const protoA = await fakeA.start();
  const protoB = await fakeB.start();
  console.log(`  A: ws=${protoA.wsPort} http=${protoA.httpPort}`);
  console.log(`  B: ws=${protoB.wsPort} http=${protoB.httpPort}`);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-acc-e2e-'));
  const primaryPort = await pickFreePort(33010);
  const hubPreferred = await pickFreePort(33011);
  const registry = loadRegistry(base, { defaultPort: primaryPort }).registry;
  saveRegistry(base, registry);
  writeAccountConfig(base, findAccount(registry, 'main'), makeConfig({
    protocol: { wsUrl: `ws://127.0.0.1:${protoA.wsPort}`, httpUrl: `http://127.0.0.1:${protoA.httpPort}`, accessToken: '', httpAccessToken: '' },
    port: primaryPort,
    groups: ['111'],
    apiKey: 'secret-primary-key',
    model: 'primary-model'
  }));

  const supervisor = createSupervisor({ baseDataDir: base, hubPort: hubPreferred, autoStart: false, log: () => {} });
  const hubPort = await supervisor.start();
  assert.ok(hubPort > 0);
  console.log(`  账号中心：${hubPort}`);

  console.log('\n=== 1 号账号启动与连接 ===');
  await supervisor.manager.start('main');
  await waitFor(() => supervisor.manager.get('main').status.connected && supervisor.manager.get('main').uin === '10001', 15000, '1 号连接并取得 UIN');
  const mainInfo = supervisor.manager.get('main');
  assert.equal(mainInfo.uin, '10001');
  assert.equal(mainInfo.status.running, true);
  assert.equal(mainInfo.port, primaryPort);
  assert.equal(mainInfo.dataDir, base);
  console.log('  OK    1 号在线，UIN 10001');

  console.log('\n=== 新建 2 号（设置模板 + 清空凭据） ===');
  const created = await supervisor.manager.createAccount({ name: '二号账号' });
  const account2 = findAccount(supervisor.manager.registry, created.id);
  assert.ok(account2);
  assert.equal(account2.primary, false);
  assert.ok(account2.port > 0 && account2.port !== primaryPort && account2.port !== hubPort);
  console.log(`  OK    2 号创建：${account2.id} 端口 ${account2.port}`);

  // 刚创建时没有 OneBot 地址 → 不应误连 1 号的 3001；配置里的模板凭据也必须已清空。
  const copied = JSON.parse(fs.readFileSync(path.join(base, 'accounts', account2.id, 'config.json'), 'utf8'));
  assert.equal(copied.api.apiKey, '');
  assert.deepEqual(copied.allow, { groups: [], private: [] });
  assert.equal(copied.persona.roleText, '角色卡：测试用');
  assert.equal(copied.skills['token-saver'].enabled, true);
  assert.equal(copied.onebot.wsUrl, '');
  console.log('  OK    Key/白名单清空，人设与技能开关保留');

  // 通过控制台的 /api/config 填 2 号自己的协议端/白名单/Key：
  // 这条路径同时验证"保存后自动重连"，而不是只能重启才生效。
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${created.port}/api/version`)).ok; } catch { return false; }
  }, 15000, '2 号控制台 HTTP 就绪');
  const applyRes = await fetch(`http://127.0.0.1:${created.port}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      onebot: { wsUrl: `ws://127.0.0.1:${protoB.wsPort}`, httpUrl: `http://127.0.0.1:${protoB.httpPort}`, accessToken: '', httpAccessToken: '' },
      snowluma: { wsUrl: `ws://127.0.0.1:${protoB.wsPort}`, httpUrl: `http://127.0.0.1:${protoB.httpPort}`, accessToken: '', httpAccessToken: '' },
      allow: { groups: ['222'], private: [] },
      api: { apiKey: 'secret-second-key', model: 'second-model' }
    })
  });
  assert.equal(applyRes.status, 200);
  await waitFor(() => supervisor.manager.get(account2.id).status.connected && supervisor.manager.get(account2.id).uin === '10002', 15000, '2 号连接并取得 UIN');

  const info2 = supervisor.manager.get(account2.id);
  assert.equal(info2.uin, '10002');
  assert.equal(info2.status.running, true);
  assert.equal(info2.dataDir, path.join(base, 'accounts', account2.id));
  assert.notEqual(info2.dataDir, mainInfo.dataDir);
  console.log('  OK    2 号在线，UIN 10002，数据目录独立');

  console.log('\n=== 消息按账号隔离 ===');
  fakeA.push({
    post_type: 'message', message_type: 'group', group_id: 111, message_id: 50001,
    user_id: 9001, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 9001, nickname: '群友甲' },
    message: [{ type: 'text', data: { text: '只属于一号的消息' } }],
    raw_message: '只属于一号的消息'
  });
  fakeB.push({
    post_type: 'message', message_type: 'group', group_id: 222, message_id: 50002,
    user_id: 9002, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 9002, nickname: '群友乙' },
    message: [{ type: 'text', data: { text: '只属于二号的消息' } }],
    raw_message: '只属于二号的消息'
  });

  const readMessages = (dir, chat) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'messages', `${chat}.json`), 'utf8')).messages || []; } catch { return []; }
  };
  await waitFor(() => readMessages(base, 'group_111').some((m) => m.text.includes('只属于一号')), 10000, '1 号收到消息');
  await waitFor(() => readMessages(info2.dataDir, 'group_222').some((m) => m.text.includes('只属于二号')), 10000, '2 号收到消息');
  assert.equal(readMessages(base, 'group_222').length, 0, '1 号目录不应出现 2 号群消息');
  assert.equal(readMessages(info2.dataDir, 'group_111').length, 0, '2 号目录不应出现 1 号群消息');
  console.log('  OK    两边各写各的 messages/，没有串号');

  console.log('\n=== 配置隔离 ===');
  const cfgA = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  const cfgB = JSON.parse(fs.readFileSync(path.join(info2.dataDir, 'config.json'), 'utf8'));
  assert.equal(cfgA.api.apiKey, 'secret-primary-key');
  assert.equal(cfgB.api.apiKey, 'secret-second-key');
  assert.deepEqual(cfgA.allow.groups, ['111']);
  assert.deepEqual(cfgB.allow.groups, ['222']);
  assert.notEqual(cfgB.onebot.wsUrl, cfgA.onebot.wsUrl);
  console.log('  OK    Key / 白名单 / 协议端地址互相独立');

  console.log('\n=== 账号中心 HUB API ===');
  const stateRes = await fetch(`http://127.0.0.1:${hubPort}/api/hub/state`);
  assert.equal(stateRes.status, 200);
  const hubState = await stateRes.json();
  assert.equal(hubState.accounts.length, 2);
  const text = JSON.stringify(hubState);
  assert.equal(text.includes('secret-primary-key'), false);
  assert.equal(text.includes('secret-second-key'), false);
  assert.ok(!/wsToken|accessToken/.test(text), 'HUB 状态不应包含令牌字段');
  const urls = hubState.accounts.map((a) => a.onebot.wsUrl);
  assert.equal(new Set(urls).size, 2);
  console.log('  OK    列表含 2 个账号、无密钥、协议端地址不重复');

  const pageRes = await fetch(`http://127.0.0.1:${hubPort}/`);
  assert.equal(pageRes.status, 200);
  assert.ok(String(pageRes.headers.get('content-security-policy')).includes("frame-ancestors 'none'"));
  const pageHtml = await pageRes.text();
  assert.ok(pageHtml.includes('账号中心'));
  assert.ok(pageHtml.includes('/hub.js'));
  const cssRes = await fetch(`http://127.0.0.1:${hubPort}/hub.css`);
  assert.equal(cssRes.status, 200);
  const jsRes = await fetch(`http://127.0.0.1:${hubPort}/hub.js`);
  assert.equal(jsRes.status, 200);
  console.log('  OK    账号中心页面 / 样式 / 脚本可访问，CSP 生效');

  const ctxRes = await fetch(`http://127.0.0.1:${primaryPort}/api/account-context`);
  assert.equal(ctxRes.status, 200);
  const ctxInfo = await ctxRes.json();
  assert.equal(ctxInfo.multiAccount, true);
  assert.equal(ctxInfo.accountId, 'main');
  assert.equal(ctxInfo.hubUrl, `http://127.0.0.1:${hubPort}/`);
  const consoleHtml = await (await fetch(`http://127.0.0.1:${primaryPort}/`)).text();
  assert.ok(consoleHtml.includes('/app/13-account-center.js'));
  console.log('  OK    账号控制台可读到账号中心上下文，并加载返回入口脚本');

  const createRes = await fetch(`http://127.0.0.1:${hubPort}/api/hub/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '三号账号' })
  });
  assert.equal(createRes.status, 201);
  const created3 = (await createRes.json()).account;
  assert.equal(created3.name, '三号账号');
  await waitFor(() => fs.existsSync(path.join(base, 'accounts', created3.id, 'config.json')), 5000, '3 号配置落盘');
  const cfg3 = JSON.parse(fs.readFileSync(path.join(base, 'accounts', created3.id, 'config.json'), 'utf8'));
  assert.equal(cfg3.api.apiKey, '');
  assert.deepEqual(cfg3.allow.groups, []);
  console.log('  OK    HUB 新建账号成功且配置已脱敏');

  // 3 号创建时没有 OneBot 地址：必须“跳过连接”，绝不能回退去连 1 号的 3001。
  const logDir = path.join(base, 'accounts', created3.id, 'logs');
  await waitFor(() => {
    if (!fs.existsSync(logDir)) return false;
    const text = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
    return text.includes('尚未配置协议端地址');
  }, 6000, '3 号跳过 OneBot 连接');
  console.log('  OK    未配置协议端的新账号不会误连默认 3001');

  const badDelete = await fetch(`http://127.0.0.1:${hubPort}/api/hub/accounts/${created3.id}?confirm=${encodeURIComponent('错名字')}`, { method: 'DELETE' });
  assert.equal(badDelete.status, 400);
  console.log('  OK    删除必须输入正确账号名');

  const goodDelete = await fetch(`http://127.0.0.1:${hubPort}/api/hub/accounts/${created3.id}?confirm=${encodeURIComponent('三号账号')}`, { method: 'DELETE' });
  assert.equal(goodDelete.status, 200);
  const del = await goodDelete.json();
  assert.ok(fs.existsSync(del.movedTo), '删除后数据应移到回收目录');
  assert.equal(fs.existsSync(path.join(base, 'accounts', created3.id)), false);
  console.log('  OK    删除后数据进入 accounts/.trash/，未永久删除');

  console.log('\n=== 单号启停不影响另一个 ===');
  await supervisor.manager.stop(account2.id);
  const afterStop = supervisor.manager.get(account2.id);
  assert.equal(afterStop.status.running, false);
  assert.equal(findAccount(supervisor.manager.registry, account2.id).enabled, false, '停止 = 下次不随程序自启');
  assert.equal(supervisor.manager.get('main').status.running, true);
  console.log('  OK    停 2 号后 1 号仍在运行，且 2 号不再随程序自启');

  await supervisor.manager.start(account2.id);
  assert.equal(findAccount(supervisor.manager.registry, account2.id).enabled, true, '启动 = 重新纳入自启名单');
  await waitFor(() => supervisor.manager.get(account2.id).status.connected && supervisor.manager.get(account2.id).uin === '10002', 15000, '2 号重新连接');
  console.log('  OK    2 号可单独重新启动');

  console.log('\n=== 整体退出 ===');
  await supervisor.stop();
  assert.equal(findAccount(supervisor.manager.registry, 'main').enabled, true, '整体退出不应取消各自启状态');
  await waitFor(() => !supervisor.manager.get('main').status.running, 8000, '1 号停止');
  await waitFor(() => !supervisor.manager.get(account2.id).status.running, 8000, '2 号停止');
  console.log('  OK    全部账号与 HUB 已停止');

  await fakeA.close();
  await fakeB.close();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('\n多账号端到端：全部通过 ✅');
}

main().catch((error) => {
  console.error('\n失败：', error?.stack ?? error);
  process.exitCode = 1;
});
