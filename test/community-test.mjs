// 社区模块（云端共享屏蔽名单 + 固定价格表）离线回归测试。
//
// 为什么需要它：这两个功能直接决定"谁被拦、价怎么算"，一旦退化不会 crash，
// 而是静默放行消息或算错成本 —— 必须由断言钉住。全程假 fetch，不依赖外网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-community-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  api: { baseUrl: '', apiKey: '', model: '' },
  globalBlocklist: ['666', '1234567'],
  server: { port: 3399 }
}));

// ── 假服务端：内存名单 + 鉴权语义与 community_app.py 对齐 ──
const cloud = { ids: new Set(), requireKeyForReplace: 'community-secret' };
let postedAdd = 0;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const json = (status, value) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) });
  if (target.includes('/blocklist/add') && method === 'POST') {
    postedAdd++;
    for (const id of body.ids || []) cloud.ids.add(String(id));
    return json(200, { ok: true, ids: [...cloud.ids] });
  }
  if (target.endsWith('/blocklist') && method === 'PUT') {
    const key = options.headers?.['X-Community-Key'] || '';
    if (key !== cloud.requireKeyForReplace) return json(403, { ok: false, error: '社区管理密钥错误' });
    cloud.ids = new Set((body.ids || []).map(String));
    return json(200, { ok: true, ids: [...cloud.ids] });
  }
  if (target.endsWith('/blocklist') && method === 'GET') {
    return json(200, { ok: true, ids: [...cloud.ids] });
  }
  return json(404, { ok: false, error: 'not found' });
};

const community = await import('../src/community.js');
const { getConfig, updateConfig } = await import('../src/config.js');

await check('配置里的全局屏蔽项立即生效（含短号码，不被长度校验吞掉）', () => {
  const list = community.getGlobalBlocklist();
  assert.ok(list.includes('666'), `短号码 666 必须生效，实际 ${JSON.stringify(list)}`);
  assert.ok(list.includes('1234567'), '长号码应生效');
  assert.ok(community.isGloballyBlocked('666'), 'isGloballyBlocked 应对 666 返回 true');
  assert.equal(community.isGloballyBlocked('99999888'), false, '未列入者不应被判为屏蔽');
});

await check('运行中修改配置（不重启）也能立刻接管屏蔽判定', () => {
  updateConfig({ globalBlocklist: ['666', '1234567', '888001'] });
  assert.ok(community.isGloballyBlocked('888001'), '改配置后新号码应立刻生效');
  updateConfig({ globalBlocklist: ['666', '1234567'] });
  assert.equal(community.isGloballyBlocked('888001'), false, '移除后应立刻不再屏蔽');
});

await check('追加屏蔽走公开接口，无需密钥', async () => {
  const before = postedAdd;
  const res = await community.updateGlobalBlocklist(['5550001'], { mode: 'add' });
  assert.ok(postedAdd > before, '应调用公开追加接口');
  assert.ok(res.ids.includes('5550001'), `追加后名单应含新号码，实际 ${JSON.stringify(res.ids)}`);
  assert.equal(res.warning, '', '有权限时不应产生告警');
});

await check('没有密钥时：删除只在本机生效并给出明确告警（不报错中断）', async () => {
  process.env.QQ_AGENT_COMMUNITY_KEY = '';   // 显式表示"本机没有管理密钥"
  const res = await community.updateGlobalBlocklist(['666'], { mode: 'replace' });
  assert.ok(res.warning.includes('管理密钥'), `应提示需要管理密钥，实际 "${res.warning}"`);
  assert.ok(!res.ids.includes('1234567'), '本机应已解除对 1234567 的屏蔽');
});

await check('密钥正确时：覆盖写入云端成功且无告警', async () => {
  process.env.QQ_AGENT_COMMUNITY_KEY = 'community-secret';
  const res = await community.updateGlobalBlocklist([], { mode: 'replace' });
  assert.equal(res.warning, '', `有有效密钥时不应告警，实际 "${res.warning}"`);
  assert.deepEqual(res.ids, [], '云端应被清空');
  const synced = await community.syncGlobalBlocklist({ pushLocal: false });
  assert.deepEqual(synced, [], '重新同步应拿回云端结果');
});

await check('固定价格表 URL 不接受配置覆盖', async () => {
  const { setPriceFeedTestUrl, refreshPriceFeed, priceFeedStatus } = await import('../src/price-feed.js');
  updateConfig({ api: { priceRemoteUrl: 'https://evil.example.com/prices.json' } });
  const status = priceFeedStatus();
  assert.equal(status.url, community.FIXED_PRICE_FEED_URL, '状态里的 URL 必须是固定官网地址');
  assert.equal(community.FIXED_PRICE_FEED_URL, 'https://kondius.cn/qq-agent/model-prices.json', '固定地址不应被改动（且必须是 https：价格表会落盘覆盖内置表，明文可被 MITM 篡改成本展示）');
  setPriceFeedTestUrl('');
  await refreshPriceFeed('https://evil.example.com/prices.json').catch(() => {});
  assert.equal(priceFeedStatus().url, community.FIXED_PRICE_FEED_URL, '即使调用方传别的地址也不能改写生效地址');
});

await check('站点页面必须引用统一主题包（否则鼠标拖尾/波浪点击等特效全丢）', async () => {
  // 2026-09-14 事故：把"本地预览用的自包含版"落地页覆盖到线上，页面看着正常，
  // 但 /assets/theme.css + /assets/theme.js 的引用没了 —— 整站特效（流动背景/极光/
  // 粒子连线/鼠标拖尾/波浪点击/滚动入场）当场消失，且没有任何报错。
  // 这条断言就是为了让这种静默退化在测试阶段就红。
  const fs2 = await import('node:fs');
  const pages = [
    'ui/landing.html',
    'ui/skill-market/index.html',
    'ui/persona-plaza/index.html'
  ];
  for (const rel of pages) {
    const src = fs2.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.ok(src.includes('/assets/theme.js'), `${rel} 必须引用 /assets/theme.js（站点特效）`);
    assert.ok(src.includes('/assets/theme.css'), `${rel} 必须引用 /assets/theme.css（站点特效）`);
    assert.ok(src.includes('no-theme'), `${rel} 应带 .no-theme 兜底，保证本地预览不缺背景`);
  }
});

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n社区模块：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
