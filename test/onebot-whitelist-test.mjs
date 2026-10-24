// 聊天白名单拉取全链路测试（2026-09-26）
//
// 覆盖「设置 → 聊天白名单 → 选择群 / 选择好友」的拉取链路：
//   前端 openWhitelistPicker → GET /api/onebot/groups|friends → OneBot get_group_list / get_friend_list
//
// 除 OneBot 本身是 _harness 的 mock（标准 OneBot v11 形状，与 SnowLuma 对外口径一致）外，
// 其余全部是真实代码：
//   · 真实后端（bootApp：真实路由 + onebot.call 的 HTTP 调用 + {id,name} 映射）
//   · 真实前端（jsdom + ui/app 拆分段：点「选择群/选择好友」→ 弹窗渲染 → 勾选 → 确认写回）
//
// 背景：SnowLuma 更新 v1.14.19（仓库迁移 SnowLuma/SnowLuma）后，验证这条用户常用链路
// 不受影响；同时锁定两条配套行为：
//   · 群名补底缓存（groupDisplayName：无存档白名单群也只显示群名）
//   · 拉取失败的可读文案（前端「拉取失败：…」的依据是 502 里的 error）
//
// 运行：node test/onebot-whitelist-test.mjs（jsdom 为可选依赖，缺前端段自动跳过）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, bootApp, createChecker, listen, sleep, waitFor } from './_harness.mjs';

const c = createChecker('聊天白名单拉取（后端全链路）');
const ctx = await bootApp({});
const { request, app, onebotHttp, teardown } = ctx;

// ── 1) 后端 API：真实路由 + 真实 onebot.call + 映射 ──────────────────────
await c.check('GET /api/onebot/groups：群列表映射为 {id,name}（id 字符串化）', async () => {
  const r = await request('GET', '/api/onebot/groups');
  assert.equal(r.status, 200, `状态码：${r.status} ${r.text}`);
  assert.deepEqual(r.data.groups, [
    { id: '456', name: '覆盖群456' },
    { id: '789', name: '备用群789' }
  ]);
  assert.ok(onebotHttp.state.calls.includes('get_group_list'), 'OneBot 侧确实收到了 get_group_list');
});

await c.check('GET /api/onebot/friends：好友名 remark 优先于 nickname', async () => {
  const r = await request('GET', '/api/onebot/friends');
  assert.equal(r.status, 200, `状态码：${r.status} ${r.text}`);
  // mock 返回 {user_id:777, nickname:'好友777', remark:'老友'} —— 名字应取备注「老友」
  assert.deepEqual(r.data.friends, [{ id: '777', name: '老友' }]);
  assert.ok(onebotHttp.state.calls.includes('get_friend_list'), 'OneBot 侧确实收到了 get_friend_list');
});

await c.check('缺名字时的兜底：群名缺省退回群号、好友退回昵称/账号', async () => {
  // 起一个只回边界数据的临时 OneBot（不动共享 mock 的固定夹具）
  const edge = http.createServer((req, res) => {
    const action = String(req.url || '').replace(/^\//, '');
    const reply = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (action === 'get_group_list') return reply([{ group_id: 10001 }, { group_id: 10002, group_name: '有名群' }]);
    if (action === 'get_friend_list') return reply([{ user_id: 20001 }, { user_id: 20002, nickname: '小名' }]);
    res.writeHead(404); res.end('{}');
  });
  const port = await listen(edge);
  const old = app.onebot.httpUrl;
  app.onebot.httpUrl = `http://127.0.0.1:${port}`;
  try {
    const g = await request('GET', '/api/onebot/groups');
    assert.deepEqual(g.data.groups, [{ id: '10001', name: '10001' }, { id: '10002', name: '有名群' }]);
    const f = await request('GET', '/api/onebot/friends');
    assert.deepEqual(f.data.friends, [{ id: '20001', name: '20001' }, { id: '20002', name: '小名' }]);
  } finally {
    app.onebot.httpUrl = old;
    await new Promise((r) => edge.close(r));
  }
});

await c.check('OneBot 不可达 → 502 + 可读 error（前端「拉取失败」文案的依据）', async () => {
  const old = app.onebot.httpUrl;
  app.onebot.httpUrl = 'http://127.0.0.1:9';   // 关闭端口：连接被拒
  try {
    const r = await request('GET', '/api/onebot/groups');
    assert.equal(r.status, 502, `状态码：${r.status} ${r.text}`);
    assert.ok(r.data && typeof r.data.error === 'string' && /get_group_list/.test(r.data.error),
      `error 应说明是哪个动作失败：${r.data && r.data.error}`);
  } finally {
    app.onebot.httpUrl = old;
  }
});

// ── 2) 前端真实操作路径（jsdom + 真实后端）────────────────────────────────
const c2 = createChecker('聊天白名单拉取（前端真实操作路径）');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { JSDOM = null; }

if (!JSDOM) {
  c2.ok('jsdom 未安装 —— 前端段已跳过（npm i -D jsdom 后自动启用）');
} else {
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;
  code = code.replace(/^'use strict';\s*$/m, '');
  code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');

  const dom = new JSDOM(html, { url: ctx.base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  // 与 coverage-wiring 同款环境垫片：fetch 代理到真实后端、EventSource/confirm 等空实现
  window.fetch = (input, init) => fetch(new URL(String(input), ctx.base).href, init);
  window.EventSource = class { constructor() {} addEventListener() {} close() {} };
  window.alert = () => {};
  window.confirm = () => true;
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  }
  const tier = await import(pathToFileURL(path.join(ROOT, 'src', 'tier-slider.js')).href);
  const priceMod = await import(pathToFileURL(path.join(ROOT, 'ui', 'vendor', 'price-match.js')).href);
  window.TIER_SLIDER_BANDS = tier.TIER_SLIDER_BANDS;
  window.sliderToTier = tier.sliderToTier;
  window.tierToSlider = tier.tierToSlider;
  window.matchPriceTable = priceMod.matchPriceTable;

  window.eval(code);
  await sleep(1500);

  const doc = window.document;

  await c2.check('进设置 → 白名单分区：「选择群 / 选择好友」按钮就位', async () => {
    window.switchTab('settings');
    await waitFor(() => doc.querySelector('.settings-menu-item[data-section="allow"]'), 8000, '设置侧栏渲染');
    doc.querySelector('.settings-menu-item[data-section="allow"]').click();
    await waitFor(() => doc.querySelector('#pick-groups-btn') && doc.querySelector('#pick-friends-btn') && doc.querySelector('#pick-result'),
      8000, '白名单分区渲染');
  });

  await c2.check('点「选择群」：拉取成功 → 弹窗列出群名与群号', async () => {
    doc.querySelector('#pick-groups-btn').click();
    await waitFor(() => doc.querySelector('.modal-overlay .pick-item'), 5000, '群选择弹窗');
    const rows = [...doc.querySelectorAll('.modal-overlay .pick-item')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
    assert.ok(rows.some((t) => t.includes('覆盖群456') && t.includes('456')), `应有群名+群号：${JSON.stringify(rows)}`);
    assert.ok(rows.some((t) => t.includes('备用群789') && t.includes('789')), `应有群名+群号：${JSON.stringify(rows)}`);
    assert.ok(/已选\s*\d+\s*个/.test(doc.querySelector('.modal-overlay .modal-head').textContent), '弹窗头应显示已选计数');
  });

  await c2.check('勾选 → 确定：写回白名单输入框并关闭弹窗', async () => {
    const box = doc.querySelector('.modal-overlay input[type=checkbox]');
    box.checked = true;
    doc.querySelector('#pick-apply').click();
    await waitFor(() => !doc.querySelector('.modal-overlay'), 3000, '弹窗关闭');
    assert.equal(doc.querySelector('#cfg-allowgroups').value, '456', '白名单输入框应写入所选群号');
    assert.ok(doc.querySelector('#pick-result').textContent.includes('已选 1 个群'), '结果栏应提示已选数量');
  });

  await c2.check('群名补底缓存生效：无存档的白名单群也只显示群名', async () => {
    // 上一步的拉取把 /api/onebot/groups 的名字写进了缓存（state.qqGroupNames）
    assert.equal(window.groupDisplayName('456'), '覆盖群456');
    assert.equal(window.groupDisplayName('789'), '备用群789');
    assert.equal(window.groupDisplayName('999999'), '群 999999');   // 真没有名字才退回群号
  });

  await c2.check('点「选择好友」：备注名优先显示', async () => {
    doc.querySelector('#pick-friends-btn').click();
    await waitFor(() => doc.querySelector('.modal-overlay .pick-item'), 5000, '好友选择弹窗');
    const rows = [...doc.querySelectorAll('.modal-overlay .pick-item')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
    assert.ok(rows.some((t) => t.includes('老友') && t.includes('777')), `应显示备注名+账号：${JSON.stringify(rows)}`);
    doc.querySelector('#pick-cancel').click();
    await waitFor(() => !doc.querySelector('.modal-overlay'), 3000, '弹窗关闭');
  });

  await c2.check('OneBot 掉线：点按钮显示「拉取失败」且不弹窗', async () => {
    const old = app.onebot.httpUrl;
    app.onebot.httpUrl = 'http://127.0.0.1:9';
    try {
      doc.querySelector('#pick-groups-btn').click();
      await waitFor(() => doc.querySelector('#pick-result').textContent.includes('拉取失败'), 5000, '失败文案');
      assert.ok(!doc.querySelector('.modal-overlay'), '拉取失败不应弹出选择框');
    } finally {
      app.onebot.httpUrl = old;
    }
  });

  dom.window.close();
}

await teardown();
console.log('');
process.exit(c.finish() && c2.finish() ? 0 : 1);
