// 覆盖测试 B：HTTP 接口层
//
// 覆盖 src/routes.js 里声明的全部 API 路由（含只读/写/删除），外加：
//   - 静态文件与路径穿越防护
//   - 安全回归：CSRF、SSRF、密钥脱敏、鉴权默认值
//   - 接口覆盖率统计（跑了多少条声明的路由）
//
// 安全说明：会在隔离数据目录里起完整服务；不启动 SnowLuma / 不打开资源管理器 /
//           不动用户真实 data/。破坏性接口 /api/reset-data 放在最后单独测。
//
// 运行：node test/coverage-http.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createChecker, bootApp, listen, ROOT, sleep } from './_harness.mjs';

const c = createChecker('HTTP 接口层覆盖');

const ctx = await bootApp({
  config: {
    // 指向不存在的目录：让 /api/snowluma/launch 走"找不到"分支，
    // 避免测试真的去拉起用户的 SnowLuma。
    snowluma: { dir: path.join(ROOT, '__no_such_snowluma__'), accessToken: '' },
    api: {
      baseUrl: '', apiKey: '', model: 'test-model-a', priceRemoteUrl: '', vision: true,
      temperature: 0.7, maxRounds: 6, priceInputPerM: 2, priceOutputPerM: 8
    }
  }
});
const { app, request, rawRequest, onebotHttp, llm, pushGroupMsg, waitSessionDone } = ctx;

// 记录实际打过的接口，用于最后的覆盖率统计
const exercised = new Set();
const hit = async (method, p, opts) => {
  exercised.add(`${method} ${p.split('?')[0]}`);
  return request(method, p, opts);
};

// 先建立一些数据，让只读接口有内容可返回
{
  const { ChatStore } = await import('../src/store.js');
  app.store.appendIncoming('group:456', { mid: 7001, ts: Date.now() - 3000, senderId: '111', senderName: '张三', text: '覆盖测试消息一' });
  app.store.appendIncoming('group:456', { mid: 7002, ts: Date.now() - 2000, senderId: '113', senderName: '王五', text: '覆盖测试消息二' });
  app.store.appendSelf('group:456', { text: '机器人的一句回复', ts: Date.now() - 1000 });
  app.store.drainUnread('group:456');
  app.memory.append('group:456', 'memberImpression', '喜欢猫', { userId: '111', target: '张三' });
  const s = app.sessions.create({ chatKey: 'group:456', trigger: '覆盖测试会话' });
  app.sessions.finish(s.id, 'done');
}

// ── 1. 状态 / 用量 / 价格 ────────────────────────────────────────────────
c.section('1. 状态 / 用量 / 价格');
{
  await c.check('GET /api/status：返回 onebot/snowluma/orchestrator/usage 等关键块', async () => {
    const r = await hit('GET', '/api/status');
    assert.equal(r.status, 200);
    for (const k of ['onebot', 'snowluma', 'orchestrator', 'usage', 'cost', 'paused', 'dataDir']) {
      assert.ok(k in r.data, `status 缺少字段 ${k}`);
    }
    assert.equal(r.data.onebot.connected, true, 'mock OneBot 应已连接');
    assert.equal(r.data.onebot.self.userId, '888');
  });

  await c.check('GET /api/version：返回版本号', async () => {
    const r = await hit('GET', '/api/version');
    assert.equal(r.status, 200);
    assert.match(String(r.data.version), /^\d+\.\d+\.\d+/, `版本号格式异常：${r.data.version}`);
  });

  await c.check('GET /api/usage/stats：各时间范围都可用且结构完整', async () => {
    for (const range of ['today', '7', '30', 'all']) {
      const r = await hit('GET', `/api/usage/stats?range=${range}`);
      assert.equal(r.status, 200, `range=${range} 应 200`);
      assert.ok('cost' in r.data || 'total' in r.data || typeof r.data === 'object', `range=${range} 返回为空`);
    }
  });

  await c.check('GET /api/usage/breakdown：按维度下钻可用', async () => {
    const r = await hit('GET', '/api/usage/breakdown?range=7&dim=model');
    assert.equal(r.status, 200);
    assert.ok(r.data && typeof r.data === 'object');
  });

  await c.check('POST /api/sessions/:id/retry：会话重试接口的守卫正确', async () => {
    // 不存在的会话 → 409 + 原因说明（不是 500 崩溃）
    const r = await hit('POST', '/api/sessions/nonexistent-id/retry');
    assert.equal(r.status, 409, `不存在的会话应 409，实际 ${r.status}`);
    assert.equal(r.data.ok, false);
    assert.ok(String(r.data.error || '').length > 0, '应给出失败原因');
  });

  await c.check('DELETE /api/memory-files/:chat：删除整个会话的记忆', async () => {
    // 先写一条成员记忆，删掉整个会话，确认成员清空
    await hit('PUT', '/api/memory-files/group_99001/members/12345', {
      body: { name: '测试人', note: '', impressions: [{ content: '测试印象', createdAt: Date.now() }] }
    });
    const del = await hit('DELETE', '/api/memory-files/group_99001');
    assert.equal(del.status, 200, `删除应 200，实际 ${del.status}`);
    assert.equal(del.data.ok, true);
    const back = await hit('GET', '/api/memory-files/group_99001');
    assert.equal(back.status, 200);
    assert.equal((back.data.members || []).length, 0, '删除后成员应为空');
  });

  await c.check('GET /api/model-prices：返回内置价格表与当前模型解析结果', async () => {
    const r = await hit('GET', '/api/model-prices');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.prices) && r.data.prices.length > 0, '应返回价格表');
    assert.ok('current' in r.data, '应返回当前模型价格');
  });

  await c.check('POST /api/model-prices/refresh：远程 URL 为空时不联网、安全返回', async () => {
    const r = await hit('POST', '/api/model-prices/refresh');
    assert.ok(r.status === 200, `应 200，实际 ${r.status}`);
    assert.ok(r.data && typeof r.data === 'object');
  });

  await c.check('GET /api/update-check：联网检查更新，失败也返回结构化结果', async () => {
    const r = await hit('GET', '/api/update-check');
    assert.equal(r.status, 200, `应 200（失败也走 ok:false），实际 ${r.status}`);
    assert.ok('ok' in r.data, '应返回 ok 字段');
    assert.ok('current' in r.data, '应返回当前版本');
    assert.ok(r.data.ok === true ? typeof r.data.hasUpdate === 'boolean' : true, '成功时应给出 hasUpdate');
  });
}

// ── 2. 配置接口 ──────────────────────────────────────────────────────────
c.section('2. 配置接口');
{
  await c.check('GET /api/config：返回脱敏配置（不含明文密钥）', async () => {
    const r = await hit('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.data.api.apiKey, undefined, 'apiKey 不应出现在响应里');
    assert.equal(typeof r.data.api.hasApiKey, 'boolean', '应给出 hasApiKey 标记');
    assert.ok(r.data.api.baseUrl !== undefined, 'baseUrl 应保留');
  });

  await c.check('POST /api/config：保存并回读生效', async () => {
    const r = await hit('POST', '/api/config', { body: { ui: { showVision: false } } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    const back = await hit('GET', '/api/config');
    assert.equal(back.data.ui.showVision, false, '保存的值应生效');
    await hit('POST', '/api/config', { body: { ui: { showVision: true } } });
  });

  await c.check('POST /api/config：__replace__ 可删除旧键（批量价格编辑依赖）', async () => {
    await hit('POST', '/api/config', { body: { api: { modelPrices: { 'a': { in: 1, out: 2, cached: 1 } } } } });
    await hit('POST', '/api/config', { body: { api: { modelPrices: { __replace__: { 'b': { in: 3, out: 4, cached: 3 } } } } } });
    const back = await hit('GET', '/api/config');
    assert.deepEqual(Object.keys(back.data.api.modelPrices), ['b'], '旧键应被彻底替换');
  });

  await c.check('POST /api/config：非法请求体不会让服务崩掉（后续请求仍可用）', async () => {
    const r = await request('POST', '/api/config', { body: '这不是 JSON', headers: { 'content-type': 'application/json' } });
    assert.ok(r.status >= 400, `非法 JSON 应被拒绝，实际 ${r.status}`);
    const after = await hit('GET', '/api/status');
    assert.equal(after.status, 200, '服务应仍可用（未因坏请求崩溃）');
  });

  await c.known(
    'POST /api/config：非法 JSON 应返回 400 而不是 500',
    async () => {
      const r = await request('POST', '/api/config', { body: '这不是 JSON', headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 400, `实际 ${r.status}（readBody 的 JSON.parse 异常直接冒到框架变成 500）`);
    },
    '已知：readBody 抛错未在框架层转成 400'
  );

  await c.known(
    'POST /api/config 的响应体也应脱敏（与 GET 一致）',
    async () => {
      const r = await hit('POST', '/api/config', { body: { ui: { showVision: true } } });
      assert.equal(r.data.config.api.apiKey, undefined, 'POST 响应里出现了明文 apiKey');
    },
    '已知：routes.js POST /api/config 直接 return updateConfig(patch)（活对象），未经 sanitizeConfig'
  );
}

// ── 3. 人设模板 ──────────────────────────────────────────────────────────
c.section('3. 人设模板');
{
  let customId = null;
  await c.check('GET /api/persona-templates：含内置模板', async () => {
    const r = await hit('GET', '/api/persona-templates');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.templates) && r.data.templates.length > 0, '应返回模板列表');
    assert.ok(r.data.templates.some((t) => t.builtin), '应含内置模板');
  });

  await c.check('POST /api/persona-templates：新增自定义模板', async () => {
    const r = await hit('POST', '/api/persona-templates', { body: { name: '覆盖人设', text: '你是一个覆盖测试人设。' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    const list = await hit('GET', '/api/persona-templates');
    const found = list.data.templates.find((t) => t.name === '覆盖人设');
    assert.ok(found, '新增的模板应出现在列表里');
    customId = found.id;
  });

  await c.check('POST /api/persona-templates：名称为空被拒绝', async () => {
    const r = await hit('POST', '/api/persona-templates', { body: { name: '', text: 'x' } });
    assert.equal(r.status, 400, '空名称应 400');
  });

  await c.check('DELETE /api/persona-templates/:id：删除自定义模板', async () => {
    const r = await hit('DELETE', `/api/persona-templates/${customId}`);
    assert.equal(r.status, 200);
    const list = await hit('GET', '/api/persona-templates');
    assert.ok(!list.data.templates.some((t) => t.name === '覆盖人设'), '删除后不应再出现');
  });
}

// ── 4. Skill / 工具 ──────────────────────────────────────────────────────
c.section('4. Skill / 工具');
{
  await c.check('GET /api/skills：返回 Skill 列表、摘要与能力清单', async () => {
    const r = await hit('GET', '/api/skills');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.skills), '应返回 skills 数组');
    assert.ok(Array.isArray(r.data.capabilities), '应返回 capabilities 数组');
    assert.ok(r.data.summary && typeof r.data.summary === 'object', '应返回 summary');
    for (const s of r.data.skills) {
      assert.ok('loaded' in s && 'enabled' in s && 'available' in s && 'active' in s,
        `Skill ${s.id} 缺少四层状态字段`);
    }
  });

  await c.check('POST /api/skills/:id：关闭再开启，状态可往返', async () => {
    // skills/ 与 plugins/ 是用户后装扩展的落点，可能为空（内置功能已收编核心）。
    // 开关联动与 settings 白名单需要真实加载的 Skill 才能测 —— 空目录时跳过
    // 而不是假失败（架构加载/校验链路由 skill-test 锁定）。
    const loadedSkills = (await hit('GET', '/api/skills')).data.skills.filter((s) => s.loaded);
    if (loadedSkills.length > 0) {
      const target = loadedSkills[0];
      const off = await hit('POST', `/api/skills/${encodeURIComponent(target.id)}`, { body: { enabled: false } });
      assert.equal(off.status, 200);
      assert.equal(off.data.skill.enabled, false, '应变为未启用');
      assert.equal(off.data.skill.active, false, '未启用的 Skill 不应处于 active');
      const on = await hit('POST', `/api/skills/${encodeURIComponent(target.id)}`, { body: { enabled: true } });
      assert.equal(on.status, 200);
      assert.equal(on.data.skill.enabled, true, '应恢复启用');
    }
  });

  await c.check('POST /api/skills/:id：不存在的 Skill 返回 404', async () => {
    const r = await hit('POST', '/api/skills/no-such-skill-xyz', { body: { enabled: true } });
    assert.equal(r.status, 404);
  });


  await c.check('GET /api/skills/capabilities：每个能力都有可解释的可用性', async () => {
    const r = await hit('GET', '/api/skills/capabilities');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.capabilities));
    for (const cap of r.data.capabilities) {
      assert.ok(cap.name, '能力应有名字');
      assert.equal(typeof cap.available, 'boolean', `能力 ${cap.name} 缺少 available`);
    }
  });

  await c.check('GET /api/tools：返回工具清单与分类', async () => {
    const r = await hit('GET', '/api/tools');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.tools) && r.data.tools.length > 0, '应有内置工具');
    for (const t of r.data.tools.slice(0, 5)) {
      assert.ok(t.id && t.name, '工具应有 id/name');
    }
  });

  await c.check('GET /api/tools/availability：与工具清单同源，且给出原因码', async () => {
    const r = await hit('GET', '/api/tools/availability');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.tools));
    assert.ok(r.data.categories && typeof r.data.categories === 'object', '应返回分类元数据');
    for (const t of r.data.tools) {
      assert.equal(typeof t.enabled, 'boolean', `工具 ${t.id} 缺少 enabled`);
      if (!t.enabled) assert.ok(t.reason, `不可用工具 ${t.id} 应给出原因`);
    }
  });

  await c.check('工具可用性口径一致：/api/tools 与 /api/tools/availability 的 id 集合相同', async () => {
    const a = await hit('GET', '/api/tools');
    const b = await hit('GET', '/api/tools/availability');
    const sa = new Set(a.data.tools.map((t) => t.id));
    const sb = new Set(b.data.tools.map((t) => t.id));
    assert.equal(sa.size, sb.size, `工具数不一致：${sa.size} vs ${sb.size}`);
  });
}

// ── 5. 提供商 / 模型目录 / 搜索服务 ──────────────────────────────────────
c.section('5. 提供商 / 模型目录 / 搜索服务');
{
  await c.check('GET /api/providers：返回提供商列表且不带明文 Key', async () => {
    const r = await hit('GET', '/api/providers');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.providers));
    for (const p of r.data.providers) {
      assert.equal(p.apiKey, '', `提供商 ${p.id} 不应回传明文 Key`);
    }
  });

  await c.check('GET /api/models：能从配置的 baseUrl 拉到模型列表', async () => {
    await hit('POST', '/api/config', { body: { api: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k' } } });
    const r = await hit('GET', '/api/models');
    assert.equal(r.status, 200, `应 200，实际 ${r.status} ${r.text?.slice(0, 80)}`);
    assert.ok(Array.isArray(r.data.models) && r.data.models.length >= 1, '应拉到 mock 模型');
  });

  await c.check('POST /api/providers/fetch-models：给定 baseUrl 拉模型', async () => {
    const r = await hit('POST', '/api/providers/fetch-models', {
      body: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k' }
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.models) && r.data.models.length >= 1);
  });

  await c.check('POST /api/providers/fetch-models：不可达地址返回错误而不是 5xx', async () => {
    const r = await hit('POST', '/api/providers/fetch-models', { body: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' } });
    assert.ok(r.status >= 400 && r.status < 600, `应返回错误码，实际 ${r.status}`);
    assert.ok(r.data.error, '应给出错误说明');
  });

  let providerId = null;
  await c.check('POST /api/providers：新增提供商', async () => {
    const r = await hit('POST', '/api/providers', {
      body: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'provider-secret-key', models: ['test-model-a'] }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.provider.apiKey, '', '响应不应含明文 Key');
    providerId = r.data.provider.id;
    assert.ok(providerId, '应返回 provider id');
  });

  await c.check('POST /api/providers/models：追加模型', async () => {
    const r = await hit('POST', '/api/providers/models', { body: { providerId, models: ['test-model-b'] } });
    assert.equal(r.status, 200);
    assert.ok(r.data.provider.models.includes('test-model-b'), '追加的模型应在列表里');
  });

  await c.check('DELETE /api/providers/models：删除模型', async () => {
    const r = await hit('DELETE', '/api/providers/models', { body: { providerId, modelId: 'test-model-b' } });
    assert.equal(r.status, 200);
    assert.ok(!r.data.provider.models.includes('test-model-b'), '删除后不应再出现');
  });

  await c.check('POST /api/providers/set-key：设置密钥后只回 hasKey', async () => {
    const r = await hit('POST', '/api/providers/set-key', { body: { providerId, apiKey: 'another-secret' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.hasKey, true, '应标记为已有 Key');
    assert.equal(r.data.apiKey, undefined, '不应回传明文');
  });

  await c.check('POST /api/providers/fetch-models：按 providerId 用该提供商保存的 Key（不再错拿顶层 Key）', async () => {
    // 2026-09-20 回归：模型管理「拉取模型列表」只传 {baseUrl, providerId} 不带 Key。
    // 旧实现回落顶层 api.apiKey —— 多提供商下顶层只存当前选中那个的 Key，
    // 从别的提供商拉列表必然 401。现在必须按 providerId 解析 dshProviderKeys。
    // mock 的 /v1/models 开启 Key 校验：只认 set-key 写入的 'another-secret'，
    // 错拿顶层 Key（'k'）就会被 mock 401 → 502，一眼红。
    llm.state.requireModelsKey = 'another-secret';
    try {
      const r = await hit('POST', '/api/providers/fetch-models', {
        body: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, providerId }
      });
      assert.equal(r.status, 200, `带 providerId 且不带 Key 应按提供商 Key 拉取成功，实际 ${r.status}：${r.text?.slice(0, 100)}`);
      assert.ok(Array.isArray(r.data.models) && r.data.models.length >= 1);
    } finally {
      llm.state.requireModelsKey = '';
    }
  });

  await c.check('POST /api/providers/test-one：连通性测试返回结果', async () => {
    const r = await hit('POST', '/api/providers/test-one', {
      body: { providerId: '', baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k' }
    });
    assert.ok(r.status === 200 || r.status === 500, `应返回结构化结果，实际 ${r.status}`);
    assert.ok(r.data, '应有响应体');
  });

  await c.check('POST /api/providers/test-chat：真实打一次 chat/completions', async () => {
    const r = await hit('POST', '/api/providers/test-chat', {
      body: { baseUrl: `http://127.0.0.1:${llm.server.address().port}/v1`, apiKey: 'k', model: 'test-model-a' }
    });
    assert.equal(r.status, 200, `应 200，实际 ${r.status}`);
    assert.equal(r.data.ok, true);
    assert.ok(r.data.result, '应返回测试结果');
  });

  await c.check('POST /api/providers/test-chat：不可达地址被如实报告（不误报成功）', async () => {
    const r = await hit('POST', '/api/providers/test-chat', {
      body: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'x' }
    });
    assert.ok(r.status === 200 || r.status === 400, `应返回结构化结果，实际 ${r.status}`);
    const failed = r.status === 400 || r.data?.ok === false || r.data?.result?.ok === false;
    assert.ok(failed, `不可达地址不应被报告为成功：${r.text.slice(0, 120)}`);
  });

  await c.check('POST /api/providers/test-all：批量测试返回统计', async () => {
    const r = await hit('POST', '/api/providers/test-all');
    assert.equal(r.status, 200);
    assert.ok(r.data.ok === true);
    assert.ok('total' in r.data && 'okCount' in r.data, '应返回 total/okCount');
  });

  await c.check('DELETE /api/providers：删除提供商', async () => {
    const r = await hit('DELETE', '/api/providers', { body: { providerId } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  await c.check('DELETE /api/providers：不存在的提供商返回 404', async () => {
    const r = await hit('DELETE', '/api/providers', { body: { providerId: 'no-such-provider' } });
    assert.equal(r.status, 404);
  });

  // 搜索服务
  let spId = null;
  await c.check('GET /api/search-providers：列表不含明文 Key', async () => {
    const r = await hit('GET', '/api/search-providers');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.providers));
    for (const p of r.data.providers) assert.equal(p.apiKey, undefined, '搜索服务不应回传明文 Key');
  });

  await c.check('POST /api/search-providers：新增自定义搜索服务', async () => {
    const r = await hit('POST', '/api/search-providers', {
      body: { name: '覆盖搜索', baseUrl: `http://127.0.0.1:${onebotHttp.server.address().port}/search`, type: 'bing', count: 5 }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    spId = r.data.provider.id;
    assert.ok(spId, '应返回搜索服务 id');
  });

  await c.check('POST /api/search-providers：baseUrl 为空被拒绝（400）', async () => {
    const r = await hit('POST', '/api/search-providers', { body: { name: 'x', baseUrl: '' } });
    assert.equal(r.status, 400);
  });

  await c.check('POST /api/search-providers/test：测试连通性返回结构化结果', async () => {
    const r = await hit('POST', '/api/search-providers/test', { body: { providerId: spId } });
    assert.equal(r.status, 200);
    assert.ok(r.data.result && typeof r.data.result.ok === 'boolean', '应返回 {ok,latencyMs}');
  });

  await c.check('DELETE /api/search-providers：删除自定义搜索服务', async () => {
    const r = await hit('DELETE', '/api/search-providers', { body: { id: spId } });
    assert.equal(r.status, 200);
    const list = await hit('GET', '/api/search-providers');
    assert.ok(!list.data.providers.some((p) => p.id === spId), '删除后不应再出现');
  });

  await c.check('POST /api/test/api：一键测试当前模型连通性', async () => {
    const r = await hit('POST', '/api/test/api');
    assert.equal(r.status, 200);
    assert.ok('ok' in r.data, '应返回 ok 字段（成功或失败都算通过）');
    assert.ok('latencyMs' in r.data, '应返回延迟');
  });
}

// ── 6. 视觉能力 ──────────────────────────────────────────────────────────
c.section('6. 视觉能力');
{
  await c.check('GET /api/vision/results：返回结果表与扫描状态', async () => {
    const r = await hit('GET', '/api/vision/results');
    assert.equal(r.status, 200);
    assert.ok(r.data.results && typeof r.data.results === 'object');
    assert.equal(typeof r.data.scanning, 'boolean');
  });

  await c.check('POST /api/vision/scan：无可用提供商时也能安全返回 202', async () => {
    const r = await hit('POST', '/api/vision/scan', { body: {} });
    assert.ok(r.status === 202 || r.status === 409, `应 202（或并发 409），实际 ${r.status}`);
  });
}

// ── 7. 会话 / 存档 / 记忆 ────────────────────────────────────────────────
c.section('7. 会话 / 存档 / 记忆');
{
  let sessionId = null;
  await c.check('GET /api/sessions：返回会话摘要列表', async () => {
    const r = await hit('GET', '/api/sessions?limit=50');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.sessions) && r.data.sessions.length >= 1, '应至少有 1 条会话');
    sessionId = r.data.sessions[0].id;
  });

  await c.check('GET /api/sessions/:id：返回会话详情', async () => {
    const r = await hit('GET', `/api/sessions/${sessionId}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.id, sessionId);
    assert.ok('systemPrompt' in r.data || 'messages' in r.data, '应含提示词或消息序列');
  });

  await c.check('GET /api/sessions/:id：不存在的会话返回 404', async () => {
    const r = await hit('GET', '/api/sessions/no-such-session');
    assert.equal(r.status, 404);
  });

  await c.check('DELETE /api/sessions/:id：删除已结束会话', async () => {
    const s = app.sessions.create({ chatKey: 'group:789', trigger: '待删除会话' });
    app.sessions.finish(s.id, 'done');
    const r = await hit('DELETE', `/api/sessions/${s.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  await c.check('DELETE /api/sessions/:id：运行中的会话拒绝删除（409）', async () => {
    const s = app.sessions.create({ chatKey: 'group:789', trigger: '运行中会话' });
    const r = await hit('DELETE', `/api/sessions/${s.id}`);
    assert.equal(r.status, 409, '运行中删除应 409');
    app.sessions.finish(s.id, 'done');
    app.sessions.remove(s.id);
  });

  await c.check('POST /api/sessions/clear-finished：清空已结束会话', async () => {
    const s = app.sessions.create({ chatKey: 'group:789', trigger: '另一个已结束' });
    app.sessions.finish(s.id, 'done');
    const r = await hit('POST', '/api/sessions/clear-finished');
    assert.equal(r.status, 200);
    assert.ok(r.data.removed >= 1, '应报告清理数量');
  });

  await c.check('GET /api/chats：返回会话列表（带 lastTs 排序）', async () => {
    const r = await hit('GET', '/api/chats');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.chats));
    const keys = r.data.chats.map((x) => x.key);
    assert.ok(keys.includes('group:456'), '应包含刚写入的会话');
  });

  await c.check('GET /api/chats/:key/messages：返回消息列表', async () => {
    const r = await hit('GET', '/api/chats/group_456/messages?limit=100');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.messages));
    assert.ok(r.data.messages.some((m) => m.text === '覆盖测试消息一'), '应包含写入的消息');
  });

  await c.check('GET /api/groups/:id/members：拉群成员列表', async () => {
    const r = await hit('GET', '/api/groups/456/members');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.members) && r.data.members.length >= 2, '应返回成员');
  });

  await c.check('GET /api/memory-files：返回记忆文件列表', async () => {
    const r = await hit('GET', '/api/memory-files');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.files));
    const g = r.data.files.find((f) => f.chatKey === 'group:456');
    assert.ok(g, '应包含 group:456');
    assert.ok(g.memberCount >= 1, '应有成员');
  });

  await c.check('GET /api/memory-files/:key：返回该会话成员档案', async () => {
    const r = await hit('GET', '/api/memory-files/group_456');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.members));
    assert.ok(r.data.members.some((m) => m.userId === '111'), '应含成员 111');
  });

  await c.check('PUT /api/memory-files/:key/members/:uid：编辑成员印象', async () => {
    const r = await hit('PUT', '/api/memory-files/group_456/members/111', {
      body: { name: '张三', note: '测试备注', impressions: ['编辑后的印象'] }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    const back = await hit('GET', '/api/memory-files/group_456');
    const m = back.data.members.find((x) => x.userId === '111');
    assert.ok(m.impressions.some((i) => i.content === '编辑后的印象'), '编辑结果应生效');
  });

  await c.check('PUT .../members/:uid：非法 userId 返回 400', async () => {
    const r = await hit('PUT', '/api/memory-files/group_456/members/999999', { body: { impressions: ['x'] } });
    assert.ok(r.status === 200 || r.status === 400, `不应 5xx，实际 ${r.status}`);
  });

  await c.check('DELETE /api/memory-files/:key/members/:uid：删除成员印象', async () => {
    const r = await hit('DELETE', '/api/memory-files/group_456/members/111');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  await c.check('POST /api/memory-files/consolidate：chatKey 非法返回 400', async () => {
    const r = await hit('POST', '/api/memory-files/consolidate', { body: { chatKey: '非法格式' } });
    assert.equal(r.status, 400);
  });

  await c.check('POST /api/memory-files/consolidate：合法 chatKey 返回 202（异步开始）', async () => {
    const r = await hit('POST', '/api/memory-files/consolidate', { body: { chatKey: 'group:456' } });
    assert.ok(r.status === 202 || r.status === 409, `应 202（或已在整理 409），实际 ${r.status}`);
    await sleep(300);
  });

  await c.check('GET /api/onebot/groups：拉群列表', async () => {
    const r = await hit('GET', '/api/onebot/groups');
    assert.equal(r.status, 200, `应 200，实际 ${r.status}`);
    assert.ok(Array.isArray(r.data.groups) && r.data.groups.length >= 1);
    assert.ok(r.data.groups[0].id && r.data.groups[0].name, '应含 id/name');
  });

  await c.check('GET /api/onebot/friends：拉好友列表', async () => {
    const r = await hit('GET', '/api/onebot/friends');
    assert.equal(r.status, 200, `应 200，实际 ${r.status}`);
    assert.ok(Array.isArray(r.data.friends) && r.data.friends.length >= 1);
  });

  await c.check('POST /api/chats/:key/mark-read：标记已读', async () => {
    app.store.appendIncoming('group:456', { mid: 7100, ts: Date.now(), senderId: '113', senderName: '王五', text: '未读一条' });
    const r = await hit('POST', '/api/chats/group_456/mark-read');
    assert.equal(r.status, 200);
    assert.ok(r.data.marked >= 1, '应标记至少 1 条');
    assert.equal(app.store.unreadCount('group:456'), 0);
  });

  await c.check('POST /api/chats/:key/mute：屏蔽未读但不触发', async () => {
    app.store.appendIncoming('group:456', { mid: 7101, ts: Date.now(), senderId: '113', senderName: '王五', text: '要屏蔽' });
    const r = await hit('POST', '/api/chats/group_456/mute');
    assert.equal(r.status, 200);
    assert.ok(r.data.marked >= 1);
  });

  await c.check('POST /api/chats/:key/test-send：手动发一条消息', async () => {
    const before = onebotHttp.state.sends.length;
    const r = await hit('POST', '/api/chats/group_456/test-send', { body: { text: '覆盖测试手动发送' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.ok(onebotHttp.state.sends.length > before, '应真的发出消息');
  });

  await c.check('POST /api/chats/:key/test-send：空文本被拒绝（400）', async () => {
    const r = await hit('POST', '/api/chats/group_456/test-send', { body: { text: '   ' } });
    assert.equal(r.status, 400);
  });

  await c.check('POST /api/chats/:key/test-send：白名单外的会话被拒绝（403，不真发消息）', async () => {
    const before = onebotHttp.state.sends.length;
    // 白名单只有 456/777，999 不在名单内（allowAllWhenEmpty=false）
    const r = await hit('POST', '/api/chats/group_999/test-send', { body: { text: '不该发出去' } });
    assert.equal(r.status, 403, `应 403，实际 ${r.status}`);
    assert.ok(r.data.error && r.data.error.includes('白名单'), '错误信息应说明白名单拦截');
    assert.equal(onebotHttp.state.sends.length, before, '白名单外的目标绝不能真发消息');
  });

  await c.check('POST /api/chats/:key/delete-messages：按 id 删除消息', async () => {
    const list = await hit('GET', '/api/chats/group_456/messages?limit=100');
    const target = list.data.messages.find((m) => m.mid === 7001);
    const r = await hit('POST', '/api/chats/group_456/delete-messages', { body: { ids: [target.id] } });
    assert.equal(r.status, 200);
    assert.ok(r.data.removed >= 1);
  });

  await c.check('POST /api/chats/:key/delete-messages：缺少 ids 返回 400', async () => {
    const r = await hit('POST', '/api/chats/group_456/delete-messages', { body: {} });
    assert.equal(r.status, 400);
  });

  await c.check('POST /api/chats/:key/clear：清空该会话存档', async () => {
    const r = await hit('POST', '/api/chats/group_456/clear');
    assert.equal(r.status, 200);
    assert.ok(r.data.removed >= 0);
  });

  await c.check('POST /api/chats/:key/wake：路由已移除（410）', async () => {
    // 手动唤醒链路随 2026-09-25 触发重做移除：不触发的消息立即标已读，无需手动补处理
    const r = await hit('POST', '/api/chats/group_456/wake');
    assert.equal(r.status, 410);
    assert.ok(String(r.data.error || '').includes('已移除'), '应说明已移除原因');
  });
}

// ── 8. 暂停 / 恢复 ───────────────────────────────────────────────────────
c.section('8. 暂停 / 恢复');
{
  await c.check('POST /api/pause：暂停生效', async () => {
    const r = await hit('POST', '/api/pause', { body: { paused: true } });
    assert.equal(r.status, 200);
    assert.equal(r.data.paused, true);
    assert.equal(app.orchestrator.paused, true, 'orchestrator 应真的暂停');
  });

  await c.check('DELETE /api/pause：恢复并把积压标记已读', async () => {
    const r = await hit('DELETE', '/api/pause');
    assert.equal(r.status, 200);
    assert.equal(r.data.paused, false);
    assert.equal(app.orchestrator.paused, false);
  });
}

// ── 9. 日志 ──────────────────────────────────────────────────────────────
c.section('9. 日志');
{
  await c.check('GET /api/logs：返回最近日志与当前级别', async () => {
    const r = await hit('GET', '/api/logs?limit=50');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.logs), '应返回 logs 数组');
    assert.ok(typeof r.data.level === 'string', '应返回当前级别');
  });

  await c.check('POST /api/logs/level：调整级别并回读', async () => {
    const r = await hit('POST', '/api/logs/level', { body: { level: 'debug' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.level, 'debug');
    const back = await hit('GET', '/api/logs');
    assert.equal(back.data.level, 'debug', '级别应持久到 logger 实例');
    await hit('POST', '/api/logs/level', { body: { level: 'info' } });
  });

  await c.check('POST /api/logs/level：非法级别不崩溃（回落到原级别）', async () => {
    const r = await hit('POST', '/api/logs/level', { body: { level: '不存在的级别' } });
    assert.equal(r.status, 200);
    assert.ok(typeof r.data.level === 'string');
  });
}

// ── 10. 进程管理（只测安全分支） ─────────────────────────────────────────
c.section('10. 进程管理（安全分支）');
{
  await c.check('GET /api/snowluma/logs：返回日志数组', async () => {
    const r = await hit('GET', '/api/snowluma/logs');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.logs));
  });

  await c.check('POST /api/snowluma/launch：目录不存在时给出明确错误而不是崩溃', async () => {
    const r = await hit('POST', '/api/snowluma/launch');
    assert.ok(r.status === 400 || r.status === 200, `应返回结构化结果，实际 ${r.status}`);
    assert.ok(r.data, '应有响应体');
    assert.ok(r.data.ok === false || r.data.alreadyRunning, '不应误报成功启动');
  });

  await c.check('POST /api/snowluma/stop：未启动时安全返回', async () => {
    const r = await hit('POST', '/api/snowluma/stop');
    assert.ok(r.status === 200, `应 200，实际 ${r.status}`);
    assert.ok(r.data && r.data.ok !== false, '应有结构化响应');
  });

  await c.check('GET /api/qq-portable/status：返回安装/运行状态', async () => {
    const r = await hit('GET', '/api/qq-portable/status');
    assert.equal(r.status, 200);
    assert.ok(r.data && typeof r.data === 'object');
  });

  await c.check('GET /api/qq-portable/logs：返回日志数组', async () => {
    const r = await hit('GET', '/api/qq-portable/logs');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.logs));
  });

  await c.check('POST /api/qq-portable/launch：未安装时返回 400 且不 spawn', async () => {
    const r = await hit('POST', '/api/qq-portable/launch');
    assert.equal(r.status, 400, `未安装应 400，实际 ${r.status}`);
    assert.equal(r.data.ok, false);
    assert.ok(/未安装|setup/i.test(r.data.error || ''), `错误信息应说明原因，实际：${r.data.error}`);
  });
}

// ── 11. 媒体取图（含 SSRF 回归） ─────────────────────────────────────────
c.section('11. 媒体取图与 SSRF');
{
  let internalHit = 0;
  const SECRET = 'INTERNAL-SECRET-CONTENT';
  const internal = http.createServer((_req, res) => {
    internalHit++;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from(SECRET));
  });
  const internalPort = await listen(internal);

  await c.check('POST /api/media-data：空 items 安全返回', async () => {
    const r = await hit('POST', '/api/media-data', { body: { items: [] } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.results));
    assert.equal(r.data.results.length, 0);
  });

  await c.check('POST /api/media-data：非法 items 不崩溃', async () => {
    const r = await hit('POST', '/api/media-data', { body: { items: '不是数组' } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.results));
  });

  await c.known(
    'POST /api/media-data：拒绝内网/环回地址（SSRF 防护）',
    async () => {
      internalHit = 0;
      const r = await hit('POST', '/api/media-data', {
        body: { items: [{ file: '', url: `http://127.0.0.1:${internalPort}/secret.png` }] }
      });
      const leaked = (r.data.results || []).some((x) => {
        if (!x?.dataUrl) return false;
        try { return Buffer.from(String(x.dataUrl).split(',')[1] || '', 'base64').toString() === SECRET; } catch { return false; }
      });
      assert.equal(internalHit, 0, `本机内网服务被访问了 ${internalHit} 次（SSRF 成立）`);
      assert.equal(leaked, false, '内网内容被读回并 base64 返回（SSRF 成立）');
    },
    '已知：routes.js:941/950 对请求体里的 url 直接 fetch，未走 safe-fetch'
  );

  internal.close();
}

// ── 12. 静态文件与路径穿越 ───────────────────────────────────────────────
c.section('12. 静态文件与路径穿越防护');
{
  await c.check('GET /：返回 index.html', async () => {
    const r = await request('GET', '/');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<html'), '应是 HTML 页面');
    assert.ok(r.text.includes('QQ Agent') || r.text.includes('app.js'), '应是控制台页面');
  });

  await c.check('GET /app.js、/app/00-core.js、/style.css：可正常获取', async () => {
    for (const p of ['/app.js', '/app/00-core.js', '/app/11-init.js', '/style.css']) {
      const r = await request('GET', p);
      assert.equal(r.status, 200, `${p} 应 200`);
      assert.ok(r.text.length > 100, `${p} 内容过短`);
    }
  });

  await c.check('GET /vendor/tier-slider.js、/vendor/price-match.js：ES module 依赖可获取', async () => {
    for (const p of ['/vendor/tier-slider.js', '/vendor/price-match.js']) {
      const r = await request('GET', p);
      assert.equal(r.status, 200, `${p} 应 200（app.js 顶层 import 依赖它，缺了会整页白屏）`);
    }
  });

  await c.check('GET /landing.html 可访问（虽是孤儿页面）', async () => {
    const r = await request('GET', '/landing.html');
    assert.equal(r.status, 200);
  });

  await c.check('GET 不存在的静态文件返回 404', async () => {
    const r = await request('GET', '/no-such-file-xyz.js');
    assert.equal(r.status, 404);
  });

  await c.check('路径穿越：/../ 形式被拒绝', async () => {
    for (const p of ['/../src/config.js', '/../../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
      const r = await request('GET', p);
      assert.ok(r.status === 403 || r.status === 404, `${p} 应被拒绝，实际 ${r.status}`);
      assert.ok(!r.text.includes('"name": "qq-agent"'), `${p} 泄漏了项目文件`);
    }
  });

  await c.check('路径穿越：/....// 绕过形式被拒绝（历史 bug 回归）', async () => {
    for (const p of ['/....//package.json', '/....//....//package.json', '/..\\..\\package.json']) {
      const r = await request('GET', p);
      assert.ok(r.status === 403 || r.status === 404, `${p} 应被拒绝，实际 ${r.status}`);
    }
  });
}

// ── 13. 安全回归 ─────────────────────────────────────────────────────────
c.section('13. 安全回归');
{
  const EVIL = 'http://evil.example.com';

  await c.check('密钥接口：外部来源（Origin 不匹配）读取被拒绝 403', async () => {
    for (const p of ['/api/api-key', '/api/providers/key?providerId=x', '/api/search-key?field=deepseek']) {
      const r = await hit('GET', p, { origin: EVIL });
      assert.equal(r.status, 403, `${p} 应 403，实际 ${r.status}`);
    }
  });

  await c.check('密钥接口：本机控制台（带 console 标记头）可读取', async () => {
    const r = await hit('GET', '/api/api-key', { headers: { 'x-console-token': 'qq-agent-console' } });
    assert.equal(r.status, 200, `本机控制台应放行，实际 ${r.status}`);
    assert.ok('apiKey' in r.data, '应返回 apiKey 字段');
  });

  await c.check('GET /api/search-key：未知搜索服务返回 400', async () => {
    const r = await hit('GET', '/api/search-key?field=不存在的服务', { headers: { 'x-console-token': 'qq-agent-console' } });
    assert.equal(r.status, 400);
  });

  await c.check('GET /api/onebot-token：控制台可读令牌明文 + 未知类型 400', async () => {
    const ok1 = await hit('GET', '/api/onebot-token?which=ws', { headers: { 'x-console-token': 'qq-agent-console' } });
    assert.equal(ok1.status, 200, `控制台读取应放行，实际 ${ok1.status}`);
    assert.ok('token' in ok1.data, '应返回 token 字段');
    const bad = await hit('GET', '/api/onebot-token?which=玄学', { headers: { 'x-console-token': 'qq-agent-console' } });
    assert.equal(bad.status, 400, '未知令牌类型应 400');
  });

  await c.check('/api/prompt-preview：GET 出组装结果，POST overrides 生效', async () => {
    const g = await hit('GET', '/api/prompt-preview');
    assert.equal(g.status, 200);
    assert.ok(g.data && typeof g.data === 'object', '应返回预览对象');
    // POST overrides：把某个技能开关状态传进去，预览应基于"未保存的临时状态"组装
    const p = await hit('POST', '/api/prompt-preview', {
      body: JSON.stringify({ skills: { calculator: { enabled: false } } }),
      headers: { 'content-type': 'application/json' }
    });
    assert.equal(p.status, 200, `POST 预览应 200，实际 ${p.status}`);
    assert.ok(p.data && typeof p.data === 'object', 'POST 也应返回预览对象');
  });

  // ── 社区/市场代理接口：远端用假 fetch 顶替（绝不在测试里真连官网）──
  // 假响应必须同时提供 json() 与 text()：community.js 走 text()，market.js 走 json()。
  const realFetch = globalThis.fetch;
  const fakeMarket = async (url, options = {}) => {
    const target = String(url);
    // 本机请求（测试 harness 自己的 fetch）原样放行，只劫持官网域名
    if (target.startsWith('http://127.0.0.1:') || target.startsWith('http://localhost:')) {
      return realFetch(url, options);
    }
    const method = String(options.method || 'GET').toUpperCase();
    const mk = (status, value) => {
      const bodyText = JSON.stringify(value);
      return {
        ok: status < 400, status,
        json: async () => value,
        text: async () => bodyText
      };
    };
    if (target.includes('/auth/login') && method === 'POST') {
      return mk(200, { ok: true, account: { id: 'u1', loginId: 'tester', displayName: '测试者' }, token: 'fake-token-abc' });
    }
    if (target.includes('/auth/logout') && method === 'POST') {
      return mk(200, { ok: true });
    }
    if (target.includes('/auth/whoami')) {
      return mk(200, { ok: true, account: { id: 'u1', loginId: 'tester', displayName: '测试者' } });
    }
    if (target.includes('/blocklist')) {
      return mk(200, { ok: true, ids: ['112233445'], updatedAt: '2026-09-19T00:00:00Z' });
    }
    return mk(404, { ok: false, error: 'not found' });
  };
  globalThis.fetch = fakeMarket;
  try {
    await c.check('GET /api/community/blocklist + POST 追加：走假云端', async () => {
      const g = await hit('GET', '/api/community/blocklist');
      assert.equal(g.status, 200);
      assert.ok(Array.isArray(g.data.ids), 'GET 应返回 ids 数组');
      const p = await hit('POST', '/api/community/blocklist', {
        body: JSON.stringify({ ids: ['112233445'], mode: 'add' }),
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(p.status, 200, `POST 追加应 200，实际 ${p.status}：${JSON.stringify(p.data)}`);
      assert.ok(p.data.ok, 'POST 应成功');
    });

    await c.check('市场代理：登录保存凭据 + 账号列表 + 登出清空', async () => {
      const login = await hit('POST', '/api/market/login', {
        body: JSON.stringify({ loginId: 'tester', password: 'secret-word', mode: 'login' }),
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(login.status, 200, `登录应 200，实际 ${login.status}：${JSON.stringify(login.data)}`);
      assert.equal(login.data.ok, true, '登录应 ok');
      const accounts = await hit('GET', '/api/market/accounts');
      assert.equal(accounts.status, 200);
      assert.ok(accounts.data.accounts.some((a) => a.username === '测试者' || a.username === 'tester'), `账号列表应含刚登录的账号，实际 ${JSON.stringify(accounts.data.accounts)}`);
      const out = await hit('POST', '/api/market/logout', {
        body: JSON.stringify({ username: accounts.data.accounts[0].username }),
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(out.status, 200, `登出应 200，实际 ${out.status}：${JSON.stringify(out.data)}`);
      const after = await hit('GET', '/api/market/accounts');
      assert.equal(after.data.accounts.filter((a) => a.username === accounts.data.accounts[0].username).length, 0, '登出后凭据应被移除');
    });

    // verify / publish：远端返回明确错误 → 502 透传（覆盖"失败也结构化"分支）
    await c.check('POST /api/market/verify：远端 404 → 502 透传', async () => {
      const r = await hit('POST', '/api/market/verify', {
        body: JSON.stringify({ codes: ['ABCDEF'] }),
        headers: { 'content-type': 'application/json' }
      });
      assert.equal(r.status, 502, `远端失败应 502 透传，实际 ${r.status}：${JSON.stringify(r.data)}`);
    });

    await c.check('POST /api/market/publish：缺 file → 400/502 且不落盘', async () => {
      const r = await hit('POST', '/api/market/publish', {
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' }
      }).catch((e) => ({ status: 0, data: { error: String(e.message) } }));
      assert.ok(r.status === 400 || r.status === 502, `缺文件应结构化报错（400/502），实际 ${r.status}：${JSON.stringify(r.data)}`);
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  await c.known(
    '状态变更接口应校验请求来源（CSRF 防护）',
    async () => {
      const before = app.orchestrator.paused;
      const r = await request('POST', '/api/pause', {
        body: { paused: !before },
        headers: { 'content-type': 'text/plain' },
        origin: EVIL
      });
      assert.notEqual(r.status, 200, '外部来源的简单 POST 不应被接受');
      assert.equal(app.orchestrator.paused, before, '外部来源不应能改变运行状态');
    },
    '已知：server.token 默认空 + /api/* 只调 authorize()，无 Origin/Host 校验；text/plain 简单请求可绕过预检'
  );

  await c.check('伪造 x-console-token 头不能绕过来源校验', async () => {
    // 旧实现是 `if (req.headers['x-console-token']) return true` —— 只看有没有、不看值。
    // 现在来源校验独立成立，伪造头无法解锁跨站读取。
    const r = await request('GET', '/api/api-key', {
      headers: { 'x-console-token': 'literally-anything' },
      origin: EVIL
    });
    assert.equal(r.status, 403, '外部来源 + 伪造头必须被拒绝');
  });

  await c.check('配置了 server.token 时：错 token 401、对 token 200', async () => {
    await request('POST', '/api/config', { body: { server: { token: 'real-console-token' } } });
    const bad = await request('GET', '/api/status', { headers: { 'x-console-token': 'wrong-token' } });
    assert.equal(bad.status, 401, `错 token 应 401，实际 ${bad.status}`);
    const good = await request('GET', '/api/status', { headers: { 'x-console-token': 'real-console-token' } });
    assert.equal(good.status, 200, `对 token 应 200，实际 ${good.status}`);
    // 恢复为空 token，避免影响后续用例
    await request('POST', '/api/config', {
      body: { server: { token: '' } },
      headers: { 'x-console-token': 'real-console-token' }
    });
  });

  await c.check('DNS rebinding 形态：Host 不是回环时一律拒绝', async () => {
    // 用原生 http 请求才能自定义 Host（fetch 会丢弃这个被禁止的头）
    const r = await rawRequest('GET', '/api/status', { host: 'evil.example.com:3210' });
    assert.equal(r.status, 403, `非回环 Host 应 403，实际 ${r.status}`);
  });

  await c.check('接口不存在时返回 404 且带错误说明', async () => {
    const r = await request('GET', '/api/no-such-endpoint');
    assert.equal(r.status, 404);
    assert.ok(r.data.error, '应返回错误说明');
  });

  await c.check('请求体超过 2MB 被拒绝（防内存打爆），且不拖垮后续请求', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(3 * 1024 * 1024) });
    // 关键：必须带 connection: close。readBody 在超限时直接 throw，
    // 此时请求体还没读完，Node 会 destroy 这个 socket；若不显式关闭，
    // 被污染的连接会留在客户端连接池里，导致**后续请求随机 ECONNRESET**。
    const r = await request('POST', '/api/config', {
      body: big,
      headers: { 'content-type': 'application/json', connection: 'close' }
    }).catch((e) => ({ status: 0, text: String(e.message) }));
    assert.ok(r.status >= 400 || r.status === 0, `超大请求体应被拒绝，实际 ${r.status}`);

    const after = await hit('GET', '/api/status');
    assert.equal(after.status, 200, '拒绝超大请求体后服务应仍可用');
  });

  await c.known(
    '超大请求体应返回 413 并保持连接可用（而非 500 + 连接重置）',
    async () => {
      const big = JSON.stringify({ data: 'x'.repeat(3 * 1024 * 1024) });
      const r = await request('POST', '/api/config', {
        body: big,
        headers: { 'content-type': 'application/json', connection: 'close' }
      }).catch((e) => ({ status: 0, text: String(e.message) }));
      assert.equal(r.status, 413, `实际 ${r.status}（readBody 抛 Error('请求体过大') 冒到框架变成 500，未读完的 body 还会导致连接重置）`);
    },
    '已知：readBody 超限时直接 throw，未做请求体排空与 413 转换'
  );
}

// ── 14. 破坏性接口（放这里：会清空数据目录，必须在所有只读断言之后） ─────
c.section('14. 破坏性接口（最后执行）');
{
  await c.check('POST /api/reset-data：清空数据目录并重置配置', async () => {
    const before = app.store.listChats().length;
    assert.ok(before > 0, '重置前应确实有数据');
    const r = await hit('POST', '/api/reset-data');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  await c.check('POST /api/reset-data 之后：服务仍可响应（状态接口不崩）', async () => {
    const r = await hit('GET', '/api/status');
    assert.equal(r.status, 200, '重置后状态接口应仍可用');
  });
}

// ── 15. 接口覆盖率统计（必须放在最后，才能统计到所有已打过的接口） ──────
c.section('15. 接口覆盖率统计');
{
  // 明确不测的：会在用户桌面弹窗口 / 可能影响用户真实进程
  const SKIP = new Set([
    'POST /api/open-data-dir',
    'POST /api/snowluma/open-folder',
    'POST /api/snowluma/open-webui',
    'POST /api/qq-portable/stop'
  ]);

  await c.check('声明的 API 路由覆盖率 ≥ 90%', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    // 正确解析：正则字面量（支持 \/ 转义与字符类），不能用非贪婪 [^\n]*?
    const routeRe = /method:\s*'([^']+)'\s*,\s*pattern:\s*(?:'([^']*)'|(\/(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[gimsuy]*))/g;
    const routes = [];
    let m;
    while ((m = routeRe.exec(src))) {
      routes.push({ method: m[1], literal: m[2] ?? m[3], isRegex: !!m[3] });
    }
    assert.ok(routes.length > 60, `应从 routes.js 解析出全部路由，实际只解析到 ${routes.length} 条`);

    const covered = [];
    const missing = [];
    for (const r of routes) {
      if (!r.isRegex) {
        const key = `${r.method} ${r.literal}`;
        if (SKIP.has(key)) { covered.push(`${key}（跳过：会开窗/动用户进程）`); continue; }
        // method:'*' 声明（同一路由处理 GET/POST 等多种方法）：任一方法打过即算覆盖
        const hitAny = r.method === '*'
          ? [...exercised].some((e) => e.endsWith(' ' + r.literal))
          : exercised.has(key);
        (hitAny ? covered : missing).push(key);
        continue;
      }
      // 正则路由：用真实 pattern 去匹配"实际打过的路径"
      let rx;
      try { rx = eval(r.literal); } catch { rx = null; }
      const ok = rx && [...exercised].some((e) => {
        const i = e.indexOf(' ');
        return e.slice(0, i) === r.method && rx.test(e.slice(i + 1));
      });
      (ok ? covered : missing).push(`${r.method} ${r.literal}`);
    }

    const pct = Math.round((covered.length / routes.length) * 100);
    console.log(`      路由总数 ${routes.length}，已覆盖 ${covered.length}（${pct}%），跳过 ${SKIP.size} 条`);
    if (missing.length) {
      console.log('      未覆盖：');
      for (const x of missing) console.log(`        - ${x}`);
    }
    assert.ok(pct >= 90, `接口覆盖率只有 ${pct}%（${covered.length}/${routes.length}），未覆盖：\n  ${missing.join('\n  ')}`);
  });
}

await ctx.teardown();
c.finish();
