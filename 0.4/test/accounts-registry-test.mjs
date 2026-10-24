// 多账号：注册表 / 模板脱敏 / 端口分配 的离线单测（不启动 QQ、不联网）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_ID_RE, PRIMARY_ID, accountDataDir, findAccount, loadRegistry, nextAccountPort,
  readAccountConfig, saveRegistry, writeAccountConfig
} from '../src/accounts/registry.js';
import { buildAccountConfig } from '../src/accounts/template.js';
import { canListen, pickFreePort } from '../src/accounts/ports.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log(`  OK    ${name}`); };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function main() {
  console.log('\n=== 注册表 ===');
  const base = tempDir('qqa-acc-reg-');
  const first = loadRegistry(base, { defaultPort: 3210 });
  assert.equal(first.registry.accounts.length, 1);
  assert.equal(first.registry.accounts[0].id, PRIMARY_ID);
  assert.equal(first.registry.accounts[0].dir, '.');
  assert.equal(first.registry.accounts[0].port, 3210);
  assert.ok(fs.existsSync(path.join(base, 'accounts.json')));
  ok('首次读取自动创建 1 号账号并落盘');

  const second = {
    id: 'acc_test1', name: '测试小号', dir: 'accounts/acc_test1', port: 3212,
    enabled: true, primary: false, createdAt: Date.now(), updatedAt: Date.now(), uin: ''
  };
  first.registry.accounts.push(second);
  saveRegistry(base, first.registry);
  const reloaded = loadRegistry(base, { defaultPort: 3210 });
  assert.equal(reloaded.registry.accounts.length, 2);
  assert.equal(findAccount(reloaded.registry, 'acc_test1').dir, 'accounts/acc_test1');
  assert.equal(accountDataDir(base, findAccount(reloaded.registry, 'acc_test1')), path.join(base, 'accounts', 'acc_test1'));
  ok('新增账号保存后可重新读取');

  assert.equal(nextAccountPort(reloaded.registry, { hubPort: 3211 }), 3213);
  ok('端口分配避开已有账号与 HUB 端口');

  assert.throws(() => accountDataDir(base, { id: 'bad', dir: '../../etc' }), /非法/);
  ok('拒绝目录穿越');

  const corruptBase = tempDir('qqa-acc-corrupt-');
  fs.writeFileSync(path.join(corruptBase, 'accounts.json'), '{ not json', 'utf8');
  const recovered = loadRegistry(corruptBase, { defaultPort: 3210 });
  assert.equal(recovered.registry.accounts.length, 1);
  assert.equal(recovered.warnings.length > 0, true);
  assert.ok(fs.readdirSync(corruptBase).some((f) => f.startsWith('accounts.json.corrupt-')));
  ok('损坏注册表先备份再重建');

  console.log('\n=== 设置模板脱敏 ===');
  const template = {
    api: {
      baseUrl: 'https://api.example.com', model: 'model-a', apiKey: 'sk-should-not-copy',
      fallbackModels: [{ model: 'model-b' }]
    },
    providers: [{ id: 'p1', name: '中转', baseUrl: 'https://relay', apiKey: 'relay-key', hasKey: true }],
    dshProviderKeys: { p1: 'relay-key' },
    webSearch: { provider: 'bing', deepseek: { apiKey: 'search-key' } },
    onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'ws-token', httpAccessToken: 'http-token' },
    snowluma: { dir: 'C:/snowluma', autoLaunch: true, wsUrl: 'ws://127.0.0.1:3001', accessToken: 'snow-token' },
    allow: { groups: ['111'], private: ['222'] },
    deny: { groups: ['333'], private: [] },
    allowAllWhenEmpty: true,
    blocklist: { 111: ['444'] },
    globalBlocklist: ['555'],
    communityExemptions: ['666'],
    personaByChat: { 111: { roleText: '分会话人设' } },
    persona: { botName: '小鲸鱼', roleText: '角色卡' },
    commandMute: { enabled: true, active: { 111: 0 } },
    skills: {
      'token-saver': { enabled: true, apiKey: 'skill-secret', mode: 'aggressive' },
      'market-tool': { enabled: false, cookie: 'session-cookie' }
    },
    server: { port: 3210, token: 'console-token', autoStart: true },
    ui: { theme: 'light' }
  };
  const cfg = buildAccountConfig(template, { port: 3214 });
  assert.equal(cfg.api.apiKey, '');
  assert.equal(cfg.api.baseUrl, 'https://api.example.com');
  assert.equal(cfg.api.model, 'model-a');
  assert.deepEqual(cfg.api.fallbackModels, [{ model: 'model-b' }]);
  assert.equal(cfg.providers[0].apiKey, undefined);
  assert.equal(cfg.providers[0].hasKey, undefined);
  assert.deepEqual(cfg.dshProviderKeys, {});
  assert.equal(cfg.webSearch.deepseek.apiKey, '');
  assert.equal(cfg.onebot.wsUrl, '');
  assert.equal(cfg.onebot.accessToken, '');
  assert.equal(cfg.snowluma.wsUrl, '');
  assert.equal(cfg.snowluma.accessToken, '');
  assert.equal(cfg.snowluma.autoLaunch, false);
  assert.deepEqual(cfg.allow, { groups: [], private: [] });
  assert.deepEqual(cfg.deny, { groups: [], private: [] });
  assert.equal(cfg.allowAllWhenEmpty, false);
  assert.deepEqual(cfg.blocklist, {});
  assert.deepEqual(cfg.globalBlocklist, []);
  assert.deepEqual(cfg.communityExemptions, []);
  assert.deepEqual(cfg.personaByChat, {});
  assert.deepEqual(cfg.commandMute.active, {});
  assert.equal(cfg.server.port, 3214);
  assert.equal(cfg.server.token, '');
  assert.equal(cfg.server.autoStart, false);
  assert.equal(cfg.skills['token-saver'].enabled, true);
  assert.equal(cfg.skills['token-saver'].mode, 'aggressive');
  assert.equal(cfg.skills['token-saver'].apiKey, '');
  assert.equal(cfg.skills['market-tool'].cookie, '');
  assert.equal(cfg.persona.roleText, '角色卡');
  assert.equal(cfg.ui.theme, 'light');
  ok('Key / 令牌 / Cookie 全部擦除，人设与开关保留');

  assert.notEqual(cfg, template);
  assert.equal(template.api.apiKey, 'sk-should-not-copy');
  ok('不修改传入的模板对象');

  console.log('\n=== 账号目录读写 ===');
  const account = { id: 'acc_test1', dir: 'accounts/acc_test1', port: 3214 };
  writeAccountConfig(base, account, cfg);
  const read = readAccountConfig(base, account);
  assert.equal(read.server.port, 3214);
  assert.ok(fs.existsSync(path.join(accountDataDir(base, account), 'config.json')));
  ok('每账号 config.json 独立落盘');

  console.log('\n=== 端口工具 ===');
  const free = await pickFreePort(3210);
  assert.ok(free >= 3210);
  assert.equal(await canListen(free), true);
  const blocker = await import('node:net').then(({ createServer }) => new Promise((resolve) => {
    const s = createServer();
    s.listen(free, '127.0.0.1', () => resolve(s));
  }));
  assert.equal(await canListen(free), false);
  await new Promise((resolve) => blocker.close(resolve));
  ok('端口探测能识别已占用端口');

  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(corruptBase, { recursive: true, force: true });

  console.log(`\n通过 ${pass} 项 ✅`);
}

main().catch((error) => {
  console.error('\n失败：', error);
  process.exitCode = 1;
});
