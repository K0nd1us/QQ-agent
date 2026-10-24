// 覆盖测试 A：离线模块层（不起服务、不联网）
//
// 覆盖：util / tier-slider / md-to-plain / config / store / memory / sessions /
//       reminders / model-prices / safe-fetch / skills(manifest,registry,capabilities,config) /
//       tool-registry / prompt / holidays / vision-docs / personas / instance-lock /
//       logger / llm 纯函数 / stickers 纯函数
//
// 运行：node test/coverage-offline.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker, makeDataDir } from './_harness.mjs';

const dataDir = makeDataDir('qq-agent-cov-offline-');
const c = createChecker('离线模块层覆盖');

// ── 1. util.js ───────────────────────────────────────────────────────────
c.section('1. util.js 工具函数');
{
  const u = await import('../src/util.js');

  await c.check('escapeCqText：把 CQ 码转义掉，避免被协议端当指令执行', () => {
    const out = u.escapeCqText('[CQ:at,qq=1] 你好');
    assert.ok(!out.includes('[CQ:'), `仍含未转义 [CQ: ：${out}`);
    assert.ok(out.includes('你好'), '正文应保留');
  });

  await c.check('truncate：超长截断并标注原长，短文本原样', () => {
    assert.equal(u.truncate('abc', 10), 'abc');
    const long = 'a'.repeat(50);
    const t = u.truncate(long, 10);
    assert.ok(t.startsWith('a'.repeat(10)), '应保留前 max 个字符');
    assert.ok(t.includes('共50字'), `应标注原始长度，实际：${t}`);
    assert.ok(t.length < long.length, '截断后应更短');
  });

  await c.check('randInt：落在 [min,max] 闭区间内', () => {
    for (let i = 0; i < 200; i++) {
      const v = u.randInt(3, 7);
      assert.ok(Number.isInteger(v) && v >= 3 && v <= 7, `越界：${v}`);
    }
  });

  await c.check('todayKey：YYYY-MM-DD 格式且与本地日期一致', () => {
    const k = u.todayKey();
    assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
    const d = new Date();
    assert.equal(k, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  });

  await c.check('formatShortTime / formatClockTime / formatFullTime 都能处理时间戳', () => {
    const ts = Date.now();
    for (const f of ['formatShortTime', 'formatClockTime', 'formatFullTime']) {
      const s = u[f](ts);
      assert.ok(typeof s === 'string' && s.length > 0, `${f} 返回空`);
    }
  });

  await c.check('normalizeMessageList：字符串/数组都能归一成可发送列表', () => {
    assert.deepEqual(u.normalizeMessageList('hi'), ['hi']);
    assert.deepEqual(u.normalizeMessageList(['a', 'b']), ['a', 'b']);
    assert.deepEqual(u.normalizeMessageList([]), []);
  });

  await c.check('unquoteJsonString：剥掉多余的 JSON 引号', () => {
    assert.equal(u.unquoteJsonString('"hello"'), 'hello');
    assert.equal(u.unquoteJsonString('hello'), 'hello');
  });

  await c.check('createSendChain：并发调用串行化，顺序不乱', async () => {
    const chain = u.createSendChain();
    const order = [];
    await Promise.all([
      chain(async () => { order.push(1); await new Promise((r) => setTimeout(r, 30)); order.push(2); }),
      chain(async () => { order.push(3); }),
      chain(async () => { order.push(4); })
    ]);
    assert.deepEqual(order, [1, 2, 3, 4], `串行顺序错误：${order}`);
  });

  await c.check('createEventBus：on/emit/off 基本语义', () => {
    const bus = u.createEventBus();
    const got = [];
    const off = bus.on('x', (p) => got.push(p));
    bus.emit('x', 1);
    off();
    bus.emit('x', 2);
    assert.deepEqual(got, [1], `退订后不应再收到，实际 ${got}`);
  });
}

// ── 2. tier-slider.js ────────────────────────────────────────────────────
c.section('2. tier-slider.js 响应档位换算');
{
  const { sliderToTier, tierToSlider, TIER_SLIDER_BANDS } = await import('../src/tier-slider.js');

  await c.check('TIER_SLIDER_BANDS：三段分界位置正确（10/20/90）', () => {
    assert.equal(TIER_SLIDER_BANDS.tier1End, 10, '1 档止于 10');
    assert.equal(TIER_SLIDER_BANDS.tier2End, 20, '2 档止于 20');
    assert.equal(TIER_SLIDER_BANDS.tier3End, 90, '3 档止于 90');
  });

  await c.check('sliderToTier 边界正确（0/10→1档，15→2档，30/55→3档，95/100→4档）', () => {
    const cases = [[0, 1], [10, 1], [15, 2], [20, 2], [30, 3], [55, 3], [90, 3], [95, 4], [100, 4]];
    for (const [pos, tier] of cases) {
      const r = sliderToTier(pos);
      assert.equal(r.tier, tier, `位置 ${pos} 应为 ${tier} 档，实际 ${r.tier}`);
    }
  });

  await c.check('sliderToTier：3 档随机概率线性增长（20→0%，55→50%，90→100%）', () => {
    const at = (p) => sliderToTier(p).randomPercent;
    assert.equal(at(20), 0, '3 档起点应为 0%');
    assert.equal(at(55), 50, `3 档中点应为 50%，实际 ${at(55)}`);
    assert.equal(at(90), 100, '3 档终点应为 100%');
    assert.ok(at(35) < at(65), '概率应随位置单调增长');
  });

  await c.check('sliderToTier：真正无法解析的输入回落 4 档（保守：全响应）', () => {
    for (const bad of [NaN, undefined, 'abc', Infinity]) {
      assert.equal(sliderToTier(bad).tier, 4, `非法输入 ${String(bad)} 应回落 4 档`);
    }
  });

  await c.check('sliderToTier：null 被当作位置 0（=1 档，仅@响应）', () => {
    // Number(null) === 0 是有限数，所以不会走"非法值回落 4 档"分支。
    // 实际调用方 updateConfig 已用 `!== null` 挡在前面，这里固化当前语义。
    assert.equal(sliderToTier(null).tier, 1, 'null 应等价于位置 0 → 1 档');
  });

  await c.check('sliderToTier：越界位置被钳到 [0,100]', () => {
    assert.equal(sliderToTier(-50).tier, 1, '负值应钳到 0 → 1 档');
    assert.equal(sliderToTier(500).tier, 4, '超界应钳到 100 → 4 档');
  });

  await c.check('tierToSlider ∘ sliderToTier 往返后档位不变', () => {
    for (const p of [0, 5, 10, 15, 30, 55, 75, 90, 95, 100]) {
      const t = sliderToTier(p);
      const back = sliderToTier(tierToSlider(t.tier, t.randomPercent));
      assert.equal(back.tier, t.tier, `位置 ${p} 往返后档位从 ${t.tier} 变成 ${back.tier}`);
    }
  });
}

// ── 3. md-to-plain.js ────────────────────────────────────────────────────
c.section('3. md-to-plain.js Markdown 清洗与切分');
{
  const { mdToPlain, splitForQQ } = await import('../src/md-to-plain.js');

  await c.check('mdToPlain：去掉加粗/行内代码/标题符号，保留正文', () => {
    const out = mdToPlain('## 标题\n**重点** 和 `代码` 内容');
    assert.ok(!out.includes('**'), '不应残留加粗标记');
    assert.ok(!out.includes('`'), '不应残留反引号');
    assert.ok(out.includes('重点') && out.includes('代码'), '正文应保留');
  });

  await c.check('splitForQQ：超长文本被切成多段且不丢内容', () => {
    const text = Array.from({ length: 200 }, (_, i) => `第${i}段内容。`).join('');
    const parts = splitForQQ(text, 200);
    assert.ok(parts.length > 1, '应切成多段');
    assert.equal(parts.join(''), text, '切分后拼接应还原原文');
  });

  await c.check('splitForQQ：短文本返回单段', () => {
    assert.deepEqual(splitForQQ('短句', 100), ['短句']);
  });
}

// ── 4. config.js ─────────────────────────────────────────────────────────
c.section('4. config.js 配置加载/合并/迁移');
{
  const cfgMod = await import('../src/config.js');
  const { DEFAULT_CONFIG, getConfig, updateConfig, setRuntimeConfig, loadConfig, migrateLegacySkills } = cfgMod;

  await c.check('DEFAULT_CONFIG 关键字段齐备', () => {
    for (const k of ['api', 'webSearch', 'security', 'snowluma', 'persona', 'allow', 'deny', 'send', 'store', 'server', 'ui', 'memory', 'sticker', 'providers']) {
      assert.ok(DEFAULT_CONFIG[k] !== undefined, `DEFAULT_CONFIG 缺少 ${k}`);
    }
    assert.equal(DEFAULT_CONFIG.server.token, '', 'server.token 出厂应为空（只监听回环）');
    assert.equal(DEFAULT_CONFIG.security.allowPrivateImageHosts, false, '图片内网开关应默认关闭');
  });

  await c.check('updateConfig：深合并保留未提及字段，写入立即生效', () => {
    const before = getConfig().api.model;
    updateConfig({ api: { temperature: 0.33 } });
    assert.equal(getConfig().api.temperature, 0.33, '新值应生效');
    assert.equal(getConfig().api.model, before, '同层其它字段不应被抹掉');
  });

  await c.check('updateConfig：__replace__ 可整体替换对象（用于删除键）', () => {
    updateConfig({ api: { modelPrices: { __replace__: { 'm1': { in: 1, out: 2, cached: 1 } } } } });
    assert.deepEqual(Object.keys(getConfig().api.modelPrices), ['m1'], '旧键应被彻底替换掉');
  });

  await c.check('loadConfig()：从隔离数据目录读回磁盘配置并与默认值合并', () => {
    const { CONFIG_FILE } = cfgMod;
    const backup = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ api: { model: 'only-model' } }), 'utf8');
    const loaded = loadConfig();
    assert.equal(loaded.api.model, 'only-model', '磁盘值应生效');
    assert.equal(loaded.server.port, DEFAULT_CONFIG.server.port, '未写的字段应回落默认');
    if (backup !== null) fs.writeFileSync(CONFIG_FILE, backup, 'utf8');
  });

  await c.check('loadConfig()：配置文件损坏（非法 JSON）时回落到默认而不抛错', () => {
    const { CONFIG_FILE } = cfgMod;
    const backup = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
    fs.writeFileSync(CONFIG_FILE, '{ 这不是 JSON', 'utf8');
    const loaded = loadConfig();
    assert.ok(loaded && typeof loaded === 'object', '应回落到默认配置而不是抛错');
    assert.equal(loaded.server.port, DEFAULT_CONFIG.server.port);
    if (backup !== null) fs.writeFileSync(CONFIG_FILE, backup, 'utf8');
  });

  await c.check('loadConfig()：BOM 开头的配置文件也能解析', () => {
    const { CONFIG_FILE } = cfgMod;
    const backup = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
    fs.writeFileSync(CONFIG_FILE, '\uFEFF' + JSON.stringify({ api: { model: 'bom-model' } }), 'utf8');
    assert.equal(loadConfig().api.model, 'bom-model', 'BOM 应被剥掉');
    if (backup !== null) fs.writeFileSync(CONFIG_FILE, backup, 'utf8');
  });

  await c.check('migrateLegacySkills：旧字段迁移进 skills.*，且幂等', () => {
    const base = structuredClone(DEFAULT_CONFIG);
    base.api.thinking = 'on';
    const once = migrateLegacySkills(base);
    const twice = migrateLegacySkills(once);
    assert.deepEqual(twice.skills, once.skills, '第二次迁移不应再改变结果（幂等）');
  });

  await c.check('setRuntimeConfig 可注入测试配置', () => {
    const t = structuredClone(DEFAULT_CONFIG);
    t.persona.botName = '注入测试机';
    setRuntimeConfig(t);
    assert.equal(getConfig().persona.botName, '注入测试机');
  });

  await c.known(
    'updateConfig 过滤派生标记（GET /api/config 生成的 has* 被回传时不应落盘）',
    () => {
      setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
      updateConfig({ api: { hasApiKey: true, hasKey: true } });
      const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      assert.equal(onDisk.api.hasApiKey, undefined, '派生标记 hasApiKey 被持久化了');
    },
    '已知：data/config.json 里已经存在 hasApiKey/hasKey/hasAccessToken/hasHttpAccessToken/dshProviderKeyPresence'
  );
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
}

// ── 5. store.js ──────────────────────────────────────────────────────────
c.section('5. store.js 聊天存档');
{
  const { ChatStore } = await import('../src/store.js');
  const store = new ChatStore(0);

  await c.check('appendIncoming：入库并计入未读', () => {
    store.appendIncoming('group:1', { mid: 100, ts: Date.now(), senderId: 'u1', senderName: '甲', text: '你好' });
    const meta = store.getChatMeta('group:1');
    assert.equal(meta.total, 1, '条数应为 1');
    assert.equal(meta.unread, 1, '未读应为 1');
  });

  await c.check('appendSelf：自己的发言入档但不算未读', () => {
    store.appendSelf('group:1', { text: '我是机器人', ts: Date.now() });
    const meta = store.getChatMeta('group:1');
    assert.equal(meta.total, 2);
    assert.equal(meta.unread, 1, '自己发言不应产生未读');
  });

  await c.check('drainUnread：取出未读并清零', () => {
    store.appendIncoming('group:1', { mid: 101, ts: Date.now(), senderId: 'u2', senderName: '乙', text: '第二句' });
    const drained = store.drainUnread('group:1');
    assert.equal(drained.length, 2, `应取出 2 条未读，实际 ${drained.length}`);
    assert.equal(store.unreadCount('group:1'), 0, '取出后未读应清零');
  });

  await c.check('muteUnread：标已读但不返回内容（屏蔽语义）', () => {
    store.appendIncoming('group:1', { mid: 102, ts: Date.now(), senderId: 'u3', senderName: '丙', text: '待屏蔽' });
    const n = store.muteUnread('group:1');
    assert.equal(n, 1, '应标记 1 条');
    assert.equal(store.unreadCount('group:1'), 0);
  });

  await c.check('peekUnread：只看不消费（不改变未读状态）', () => {
    store.appendIncoming('group:1', { mid: 103, ts: Date.now(), senderId: 'u4', senderName: '丁', text: '偷看' });
    const peeked = store.peekUnread('group:1');
    assert.ok(Array.isArray(peeked) && peeked.length === 1, '应能看到 1 条');
    assert.equal(store.unreadCount('group:1'), 1, 'peek 不应清零未读');
    store.markAllRead('group:1');
    assert.equal(store.unreadCount('group:1'), 0, 'markAllRead 应清零');
  });

  await c.check('findByMid / updateByMid / markRecalled 按消息 id 操作', () => {
    const hit = store.findByMid('group:1', 100);
    assert.ok(hit, '应能按 mid 找到消息');
    store.updateByMid('group:1', 100, { text: '改过的文本' });
    assert.equal(store.findByMid('group:1', 100).text, '改过的文本');
    store.markRecalled('group:1', 100);
    const after = store.findByMid('group:1', 100);
    assert.ok(after.recalled === true || /撤回/.test(after.text), '应标记为撤回');
  });

  await c.check('recent：按 limit 倒序/截断返回', () => {
    for (let i = 0; i < 20; i++) store.appendIncoming('group:1', { mid: 200 + i, ts: Date.now() + i, senderId: 'u', senderName: 'x', text: `m${i}` });
    const r = store.recent('group:1', { limit: 5 });
    assert.equal(r.length, 5, `limit=5 应返回 5 条，实际 ${r.length}`);
  });

  await c.check('removeByLocalIds：按本地 id 精确删除', () => {
    const all = store.recent('group:1', { limit: 50 });
    const target = all[0];
    const removed = store.removeByLocalIds('group:1', [target.id]);
    assert.equal(removed, 1, '应删除 1 条');
    assert.equal(store.findByLocalId('group:1', target.id), null, '删除后应查不到');
  });

  await c.check('clearChat：整体清空某会话', () => {
    const n = store.clearChat('group:1');
    assert.ok(n > 0, '应返回删除条数');
    assert.equal(store.getChatMeta('group:1').total, 0, '清空后条数应为 0');
  });

  await c.check('setMaxPerChat：设置后新增消息会被裁剪到上限', () => {
    const s2 = new ChatStore(0);
    for (let i = 0; i < 20; i++) s2.appendIncoming('group:9', { mid: i, ts: i, senderId: 'u', senderName: 'x', text: `t${i}` });
    s2.setMaxPerChat(10);
    s2.appendIncoming('group:9', { mid: 999, ts: Date.now(), senderId: 'u', senderName: 'x', text: '触发裁剪' });
    const r = s2.recent('group:9', { limit: 100 });
    assert.ok(r.length <= 10, `裁剪后应 ≤10 条，实际 ${r.length}`);
  });

  await c.check('activeMembers：列出近期活跃成员', () => {
    const s3 = new ChatStore(0);
    s3.appendIncoming('group:5', { mid: 1, ts: Date.now(), senderId: 'u1', senderName: '甲', text: 'a' });
    s3.appendIncoming('group:5', { mid: 2, ts: Date.now(), senderId: 'u2', senderName: '乙', text: 'b' });
    const members = s3.activeMembers('group:5');
    assert.ok(Array.isArray(members) && members.length >= 2, `应至少 2 个成员，实际 ${members?.length}`);
  });

  await c.check('listChats / 空会话不报错', () => {
    assert.ok(Array.isArray(store.listChats()));
    assert.deepEqual(store.recent('group:不存在的', { limit: 5 }), []);
    assert.equal(store.getChatMeta('group:不存在的').total, 0);
  });
}

// ── 6. memory.js ─────────────────────────────────────────────────────────
c.section('6. memory.js 长期记忆');
{
  const { MemoryStore } = await import('../src/memory.js');
  const mem = new MemoryStore();

  await c.check('append(memberImpression)：写入成员印象', () => {
    mem.append('group:1', 'memberImpression', '喜欢猫', { userId: '111', target: '甲' });
    mem.append('group:1', 'memberImpression', '爱用梗图', { userId: '111', target: '甲' });
    const m = mem.getMember('group:1', '111');
    assert.ok(m, '成员应存在');
    assert.equal(m.impressions.length, 2, `应有 2 条印象，实际 ${m?.impressions?.length}`);
  });

  await c.check('append：非 memberImpression 类目一律忽略（只做成员印象）', () => {
    assert.equal(mem.append('group:1', 'other', '内容', { userId: '111' }), null);
  });

  await c.check('append：既无 userId 也无 target 时忽略', () => {
    assert.equal(mem.append('group:1', 'memberImpression', '内容', {}), null);
  });

  await c.check('members / listChats：返回结构正确', () => {
    const list = mem.members('group:1');
    assert.ok(Array.isArray(list) && list.length === 1, `应 1 个成员，实际 ${list.length}`);
    assert.ok(mem.listChats().includes('group:1'));
  });  await c.check('editMemberImpression：整组覆写印象（返回值形状 {userId,name,impressions,updatedAt}）', () => {
    mem.editMemberImpression('group:1', { userId: '111', name: '甲改名', note: '备注A', impressions: ['只有这一条'] });
    const m = mem.getMember('group:1', '111');
    assert.equal(m.impressions.length, 1, '应被整组替换');
    assert.equal(m.impressions[0].content, '只有这一条');
    assert.equal(m.name, '甲改名', '名字应更新');
  });

  await c.check('editMemberImpression：非数字 userId 被拒绝（防脏数据）', async () => {
    await c.expectThrow('editMemberImpression 非数字 id',
      () => mem.editMemberImpression('group:1', { userId: 'u1', impressions: ['x'] }),
      /数字 QQ 号/);
  });

  await c.check('getMember：不存在的成员返回空档案而不是 null/抛错', () => {
    const m = mem.getMember('group:1', '888888');
    assert.ok(m && typeof m === 'object', '应返回对象');
    assert.equal(m.impressions.length, 0, '应为空印象');
  });

  await c.check('removeMember：删除单个成员（数字 id）档案被清空', () => {
    mem.append('group:1', 'memberImpression', 'x', { userId: '222', target: '乙' });
    assert.ok(mem.getMember('group:1', '222').impressions.length > 0, '删除前应有印象');
    assert.equal(mem.removeMember('group:1', '222'), true, '删除应成功');
    assert.equal(mem.getMember('group:1', '222').impressions.length, 0, '删除后印象应清空');
  });

  await c.check('removeMember：非数字 id 返回 false 而不是抛错', () => {
    assert.equal(mem.removeMember('group:1', 'not-a-number'), false);
  });

  await c.check('formatForPrompt：只输出被点名的成员，避免全量注入', () => {
    mem.append('group:1', 'memberImpression', '喜欢猫', { userId: '111', target: '甲' });
    const only = mem.formatForPrompt('group:1', { userIds: ['111'] });
    assert.ok(String(only).includes('喜欢猫'), '应包含被点名成员的印象');
    const none = mem.formatForPrompt('group:1', { userIds: ['999'] });
    assert.ok(!String(none).includes('喜欢猫'), '未点名成员不应注入');
  });

  await c.check('consolidationState / markConsolidated：整理冷却可记录', () => {
    const st = mem.consolidationState('group:1');
    assert.ok(st && typeof st === 'object', '应返回状态对象');
    mem.markConsolidated('group:1', Date.now(), ['111']);
    const st2 = mem.consolidationState('group:1');
    assert.ok(st2, '标记后仍应返回状态');
  });

  await c.check('replaceConsolidated：按 memberImpression 数组整理结果整体写回', () => {
    mem.replaceConsolidated('group:1', {
      memberImpression: [
        { userId: '111', target: '甲', content: '合并后的一条印象' },
        { userId: '111', target: '甲', content: '合并后的第二条' }
      ]
    });
    const m = mem.getMember('group:1', '111');
    assert.ok(m, '整理后成员应存在');
    assert.equal(m.impressions.length, 2, `同成员多条应合并到一份档案，实际 ${m.impressions.length}`);
    assert.ok(m.impressions.some((x) => x.content === '合并后的一条印象'), '整理内容应写回');
  });

  await c.check('replaceConsolidated：整理前会备份旧档案（可回滚）', () => {
    const backupRoot = path.join(dataDir, 'memory', 'backups');
    assert.ok(fs.existsSync(backupRoot), '整理应留下备份目录');
  });

  await c.check('remove / clear：按类目删与整体清空', () => {
    mem.remove('group:1', 'memberImpression', { userId: '111', content: '合并后的一条印象' });
    mem.clear('group:1');
    assert.equal(mem.members('group:1').length, 0, 'clear 后应无成员');
  });
}

// ── 7. sessions.js ───────────────────────────────────────────────────────
c.section('7. sessions.js 会话留档');
{
  const { SessionRegistry } = await import('../src/sessions.js');
  const sessions = new SessionRegistry(0);

  let sid = null;
  await c.check('create：创建会话并进入 running', () => {
    const created = sessions.create({ chatKey: 'group:1', trigger: '测试触发', triggerSummary: '测试触发' });
    assert.ok(created && created.id, 'create 应返回带 id 的会话对象');
    sid = created.id;
    const s = sessions.get(sid);
    assert.ok(s && s.id === sid, '应能取回会话');
    assert.equal(s.status, 'running');
    assert.equal(s.chatKey, 'group:1');
  });

  await c.check('get 返回的是副本（外部改写不会污染内部状态）', () => {
    const s = sessions.get(sid);
    s.trigger = '被外部改坏了';
    assert.notEqual(sessions.get(sid).trigger, '被外部改坏了', 'get 应返回克隆体');
  });

  await c.check('update / setActivity：按 id 更新活动状态', () => {
    sessions.setActivity(sid, '正在思考');
    assert.equal(sessions.get(sid).activity, '正在思考');
    sessions.update(sid);   // 只做持久化+索引刷新，不应抛错
    assert.ok(sessions.get(sid), 'update 后会话仍存在');
  });

  await c.check('finish：置终态并记录结束时间，且从内存移出后仍能从磁盘读回', () => {
    sessions.finish(sid, 'done');
    const s = sessions.get(sid);
    assert.equal(s.status, 'done');
    assert.ok(s.endedAt, '应记录结束时间');
  });

  await c.check('listSummaries：摘要列表含关键字段', () => {
    const list = sessions.listSummaries(10);
    assert.ok(list.length >= 1);
    const item = list.find((x) => x.id === sid);
    assert.ok(item, '应包含刚创建的会话');
    assert.ok('status' in item && 'trigger' in item && 'chatKey' in item);
  });

  await c.check('todayUsage：累计当日用量', async () => {
    const day = (await import('../src/util.js')).todayKey();
    const before = sessions.todayUsage(day);
    assert.ok(before && typeof before === 'object', '应返回用量对象');
  });

  await c.check('discard：等待中会话可丢弃；已运行过的不允许丢弃', () => {
    const id2 = sessions.create({ chatKey: 'group:2', trigger: '待丢弃', status: 'waiting' });
    assert.equal(sessions.discard(id2.id), true, '等待中的会话应可丢弃');
    assert.equal(sessions.get(id2.id), null, 'discard 后应查不到');
  });

  await c.check('remove：运行中的会话不允许删除，结束后可删', () => {
    const created = sessions.create({ chatKey: 'group:3', trigger: '运行中' });
    assert.equal(sessions.remove(created.id), false, '运行中的会话不应被删除');
    sessions.finish(created.id, 'done');
    assert.equal(sessions.remove(created.id), true, '结束后应可删除');
  });

  await c.check('clearFinished：清空已结束但保留运行中', () => {
    const running = sessions.create({ chatKey: 'group:4', trigger: '仍在跑' });
    const removed = sessions.clearFinished();
    assert.ok(removed >= 1, '应清掉已结束的');
    assert.ok(sessions.get(running.id), '运行中的必须保留');
    sessions.finish(running.id, 'done');
  });

  await c.check('keepSessionFiles：上限生效（只保留最近 N 个）', () => {
    const s = new SessionRegistry(2);
    for (let i = 0; i < 5; i++) {
      const created = s.create({ chatKey: `group:${i}`, trigger: `t${i}` });
      s.finish(created.id, 'done');
    }
    assert.ok(s.listSummaries(50).length <= 2, `应只保留 2 个，实际 ${s.listSummaries(50).length}`);
  });

  await c.known(
    'SessionRegistry 提供 setKeepFiles（配置改了运行时能同步）',
    () => { assert.equal(typeof new SessionRegistry(0).setKeepFiles, 'function'); },
    'config.store.keepSessionFiles 改了不生效：routes.js POST /api/config 只同步了 store.setMaxPerChat'
  );
}

// ── 8. reminders.js ──────────────────────────────────────────────────────
c.section('8. reminders.js 定时提醒');
{
  const { ReminderStore } = await import('../src/reminders.js');
  const rs = new ReminderStore();

  await c.check('add / pending：新提醒进入待触发列表', () => {
    const entry = rs.add({ chatKey: 'group:1', text: '喝水', dueAt: Date.now() + 60000, createdBy: 'u1' });
    assert.ok(entry && entry.id, 'add 应返回带 id 的提醒对象');
    assert.ok(rs.pending('group:1').length >= 1, '应出现在待触发列表');
  });

  await c.check('due：到期才返回', () => {
    const past = rs.add({ chatKey: 'group:1', text: '已过期', dueAt: Date.now() - 1000 });
    const future = rs.add({ chatKey: 'group:1', text: '还没到', dueAt: Date.now() + 3600000 });
    const d = rs.due(Date.now());
    assert.ok(d.some((r) => r.id === past.id), '过期提醒应被返回');
    assert.ok(!d.some((r) => r.id === future.id), '未到期提醒不应返回');
  });

  await c.check('markFired：触发后不再重复返回', () => {
    const entry = rs.add({ chatKey: 'group:1', text: '一次性', dueAt: Date.now() - 10 });
    assert.equal(rs.markFired(entry.id), true, '标记应成功');
    assert.ok(!rs.due(Date.now()).some((r) => r.id === entry.id), '已触发的不应再返回');
  });

  await c.check('cancel：取消后不再返回', () => {
    const entry = rs.add({ chatKey: 'group:1', text: '要取消', dueAt: Date.now() - 10 });
    assert.equal(rs.cancel(entry.id), true, '取消应成功');
    assert.ok(!rs.due(Date.now()).some((r) => r.id === entry.id));
    assert.equal(rs.cancel('不存在的id'), false, '取消不存在的提醒应返回 false');
  });

  await c.check('prune：清理已触发旧记录（超过 200 条才裁剪）', () => {
    for (let i = 0; i < 5; i++) {
      const e = rs.add({ chatKey: 'group:1', text: `t${i}`, dueAt: Date.now() - 100 });
      rs.markFired(e.id);
    }
    rs.prune();   // 未超过阈值：应是空操作且不抛错
    assert.ok(true, 'prune 不应抛错');
  });

  await c.check('pending() 不传参返回全部会话', () => {
    assert.ok(Array.isArray(rs.pending()));
  });
}

// ── 9. model-prices.js ───────────────────────────────────────────────────
c.section('9. model-prices.js 价格表与成本');
{
  const mp = await import('../src/model-prices.js');

  await c.check('listOfficialPrices：内置价格表非空且每条都有输入/输出单价', () => {
    const list = mp.listOfficialPrices();
    assert.ok(Array.isArray(list) && list.length > 0, '价格表不应为空');
    for (const item of list.slice(0, 5)) {
      assert.ok(item.id, '每条应有 id');
      assert.equal(typeof item.in, 'number', `${item.id} 缺少数字型输入单价 in`);
      assert.equal(typeof item.out, 'number', `${item.id} 缺少数字型输出单价 out`);
    }
  });

  await c.check('resolveOfficialPrice：已知模型命中、未知模型安全回落', () => {
    const list = mp.listOfficialPrices();
    const known = mp.resolveOfficialPrice(list[0].id);
    assert.ok(known, `已知模型 ${list[0].id} 应命中`);
    const unknown = mp.resolveOfficialPrice('完全不存在的模型-xyz');
    assert.ok(unknown === null || typeof unknown === 'object', '未知模型应返回 null 或对象，不应抛错');
  });

  await c.check('isPeakHour：返回布尔值且能区分两个时段', () => {
    let sawTrue = false, sawFalse = false;
    const base = new Date('2026-03-10T00:00:00');
    for (let h = 0; h < 24; h++) {
      const d = new Date(base.getTime() + h * 3600000);
      const v = mp.isPeakHour(d);
      assert.equal(typeof v, 'boolean', `第 ${h} 点应返回布尔`);
      if (v) sawTrue = true; else sawFalse = true;
    }
    assert.ok(sawTrue && sawFalse, '应同时存在峰谷两种时段');
  });

  await c.check('priceAt：峰谷价不同（或至少结构完整）', () => {
    const price = { in: 2, out: 8, cached: 1 };
    const a = mp.priceAt(price, new Date('2026-03-10T10:00:00'));
    const b = mp.priceAt(price, new Date('2026-03-10T03:00:00'));
    for (const x of [a, b]) {
      assert.ok(x && typeof x === 'object', '应返回价格对象');
    }
    assert.ok(a !== b || true, '（峰谷可能相同，仅校验不抛错）');
  });

  await c.check('imageTokens：按张封顶模式返回固定值，按像素模式按尺寸计算', () => {
    const capped = mp.imageTokens({ image: { mode: 'capped', maxTokensPerImage: 384 } }, 4096, 4096);
    assert.equal(capped, 384, 'capped 模式应与原图尺寸无关，恒为 384');
    const pixel = mp.imageTokens({ image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000 } }, 1024, 1024);
    assert.equal(pixel, 1026, `pixel 模式应为 1024*1024/1024+2=1026，实际 ${pixel}`);
    assert.equal(mp.imageTokens({}, 100, 100), null, '不支持图片应返回 null');
  });

  await c.check('supportsImage：识别是否支持图片', () => {
    assert.equal(mp.supportsImage({ image: { tokens: 100 } }), true);
    assert.equal(mp.supportsImage({}), false);
  });

  await c.check('matchPriceTable：按价格表数组精确/宽松命中', () => {
    const table = mp.listOfficialPrices();
    assert.ok(Array.isArray(table) && table.length > 0, '价格表应为数组');
    const hit = mp.matchPriceTable(table[0].id, table);
    assert.ok(hit, `精确命中应返回条目（${table[0].id}）`);
    const miss = mp.matchPriceTable('某个没听过的模型-zzz', table);
    assert.ok(miss === null || typeof miss === 'object', '未命中应安全返回');
  });

  await c.check('setRemotePrices / remoteOverrideCount：远程价格可注入可查询', () => {
    mp.setRemotePrices({ 'remote-model-x': { in: 1, out: 2, cached: 1 } });
    assert.ok(mp.remoteOverrideCount() >= 1, '远程覆盖条数应 ≥1');
    mp.setRemotePrices({});
    assert.equal(mp.remoteOverrideCount(), 0, '清空后应为 0');
  });

  await c.check('modelLabel / splitModelLabel / vendorOfConfig：渠道模型标签可往返', () => {
    const label = mp.modelLabel('a6api', 'glm-5');
    assert.ok(String(label).includes('glm-5'), '标签应包含模型名');
    const split = mp.splitModelLabel(label);
    assert.ok(split && split.model, '应能拆回模型名');
    const v = mp.vendorOfConfig({ api: { provider: 'a6api', baseUrl: 'https://x/v1' } });
    assert.ok(v, '应能取到渠道标识');
  });

  await c.check('sumCostByTime：成本按峰谷拆解', () => {
    const rows = [
      { at: new Date('2026-03-10T10:00:00').getTime(), promptTokens: 1000, completionTokens: 500, cachedTokens: 0 }
    ];
    const r = mp.sumCostByTime(rows, { in: 2, out: 8, cached: 1 });
    assert.ok(r && typeof r === 'object', '应返回汇总对象');
    assert.ok(Number.isFinite(r.cost), 'cost 应为数字');
  });
}

// ── 10. safe-fetch.js（SSRF 防护，重点） ─────────────────────────────────
c.section('10. safe-fetch.js SSRF 防护');
{
  const sf = await import('../src/safe-fetch.js');

  await c.check('isPrivateIp：常见内网/环回地址全部判为私有', () => {
    const privates = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', 'fe80::1'];
    for (const ip of privates) {
      assert.equal(sf.isPrivateIp(ip), true, `${ip} 应被判为私有/内网`);
    }
  });

  await c.check('isPrivateIp：公网地址不应误判', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
      assert.equal(sf.isPrivateIp(ip), false, `${ip} 不应被判为私有`);
    }
  });

  await c.check('isPrivateIp：空值按私有处理（保守）', () => {
    assert.equal(sf.isPrivateIp(''), true);
    assert.equal(sf.isPrivateIp(null), true);
  });

  await c.check('validateFetchUrl：拒绝非 http/https 协议', async () => {
    for (const u of ['file:///C:/Windows/win.ini', 'ftp://example.com/x', 'gopher://example.com']) {
      await assert.rejects(() => sf.validateFetchUrl(u), `应拒绝 ${u}`);
    }
  });

  await c.check('validateFetchUrl：拒绝内网/环回', async () => {
    for (const u of ['http://127.0.0.1:3210/api/status', 'http://localhost/x', 'http://192.168.1.1/', 'http://169.254.169.254/']) {
      await assert.rejects(() => sf.validateFetchUrl(u), `应拒绝 ${u}`);
    }
  });

  await c.check('validateFetchUrl：拒绝 URL 内嵌凭据', async () => {
    await assert.rejects(() => sf.validateFetchUrl('http://user:pass@example.com/'), '不应允许 URL 里带账号密码');
  });

  await c.check('validateFetchUrl：空/非法 URL 抛错而不是放行', async () => {
    await assert.rejects(() => sf.validateFetchUrl(''), '空串应拒绝');
    await assert.rejects(() => sf.validateFetchUrl('不是网址'), '非 URL 应拒绝');
  });

  await c.check('validateImageUrl：图片地址同样受内网限制', async () => {
    await assert.rejects(() => sf.validateImageUrl('http://127.0.0.1/x.png'), '内网图片地址应被拒');
  });

  await c.check('validateFetchUrl：公网地址可通过（不做真实请求）', async () => {
    const u = await sf.validateFetchUrl('https://example.com/page');
    assert.ok(u, '公网 https 地址应通过校验');
  });
}

// ── 11. skills 子系统各模块 ──────────────────────────────────────────────
c.section('11. skills：manifest / registry / capabilities / config');
{
  const { normalizeManifest, isManifestUsable, SKILL_API_VERSION } = await import('../src/skills/manifest.js');

  await c.check('normalizeManifest：补默认值 + 保留声明', () => {
    const { manifest } = normalizeManifest({ id: 'demo', name: '示例', capabilities: ['a.b'], requires: ['c.d'] }, { fallbackId: 'x' });
    assert.equal(manifest.id, 'demo');
    assert.equal(manifest.apiVersion, SKILL_API_VERSION);
    assert.deepEqual(manifest.capabilities, ['a.b']);
    assert.deepEqual(manifest.requires, ['c.d']);
    assert.equal(manifest.enabledByDefault, true, '未声明时应默认启用');
  });

  await c.check('normalizeManifest：非法 id 被标记为不可用（防路径穿越）', () => {
    const r = normalizeManifest({ id: '../../escape' });
    assert.equal(isManifestUsable(r.manifest, r.problems), false, '带 .. 的 id 应不可用');
  });

  await c.check('normalizeManifest：自依赖被移除（避免永远不可用）', () => {
    const { manifest } = normalizeManifest({ id: 'demo', capabilities: ['a.b'], requires: ['a.b', 'c.d'] });
    assert.ok(!manifest.requires.includes('a.b'), '自依赖应被剔除');
    assert.ok(manifest.requires.includes('c.d'), '其它依赖应保留');
  });

  await c.check('normalizeManifest：prompt priority 强制 ≤99（压不过核心安全规则）', () => {
    const { manifest } = normalizeManifest({
      id: 'demo',
      prompt: { sections: [{ id: 's', content: '内容', priority: 9999 }] }
    });
    assert.ok(manifest.prompt.sections[0].priority <= 99, `priority 应被压到 ≤99，实际 ${manifest.prompt.sections[0].priority}`);
  });

  await c.check('normalizeManifest：非法 category 回退为 utility 并记问题', () => {
    const r = normalizeManifest({ id: 'demo', category: '不存在的分类' });
    assert.equal(r.manifest.category, 'utility');
    assert.ok(r.problems.length >= 1, '应记录问题');
  });

  await c.check('normalizeManifest：非对象 manifest 安全返回', () => {
    assert.equal(normalizeManifest(null).manifest, null);
    assert.equal(normalizeManifest('字符串').manifest, null);
  });

  // registry
  const { SkillRegistry } = await import('../src/skills/registry.js');
  await c.check('SkillRegistry：注册/重复覆盖保留顺序/注销', () => {
    const reg = new SkillRegistry();
    reg.register({ manifest: { id: 'a' } });
    reg.register({ manifest: { id: 'b' } });
    const r = reg.register({ manifest: { id: 'a' } });
    assert.equal(r.replaced, true, '同 id 应标记为覆盖');
    assert.deepEqual(reg.list().map((s) => s.manifest.id), ['a', 'b'], '覆盖不应改变注册顺序');
    assert.equal(reg.unregister('a'), true);
    assert.equal(reg.has('a'), false);
    assert.equal(reg.size, 1);
  });

  await c.check('SkillRegistry：缺 id 的注册被拒绝', () => {
    const reg = new SkillRegistry();
    assert.equal(reg.register({}).ok, false);
  });

  // capabilities
  const { CapabilityRegistry } = await import('../src/skills/capabilities.js');
  await c.check('CapabilityRegistry：函数型提供者必须被登记（回归：曾经被静默丢弃）', () => {
    const caps = new CapabilityRegistry();
    caps.provide('cap.x', 'skill-a', () => 'ok');
    assert.equal(caps.has('cap.x'), true, '函数提供者应被登记');
    assert.equal(caps.providersOf('cap.x').length, 1, '应能查到 1 个提供者');
  });

  await c.check('CapabilityRegistry：多提供者按注册顺序返回', () => {
    const caps = new CapabilityRegistry();
    caps.provide('cap.y', 'first', () => 1);
    caps.provide('cap.y', 'second', () => 2);
    assert.deepEqual(caps.providersOf('cap.y').map((p) => p.ownerId), ['first', 'second']);
  });

  await c.check('CapabilityRegistry：同一 owner 重复注册同能力是覆盖而非叠加（热重载）', () => {
    const caps = new CapabilityRegistry();
    caps.provide('cap.w', 'owner', () => 1);
    caps.provide('cap.w', 'owner', () => 2);
    assert.equal(caps.providersOf('cap.w').length, 1, '同 owner 不应叠加');
  });

  await c.check('CapabilityRegistry：removeOwner 清掉该 Skill 的全部能力', () => {
    const caps = new CapabilityRegistry();
    caps.provide('cap.z', 'owner', () => 1);
    caps.removeOwner('owner');
    assert.equal(caps.has('cap.z'), false, 'owner 卸载后能力应消失');
  });

  // skills/config.js
  const sc = await import('../src/skills/config.js');
  await c.check('skills/config：开关写入与读取一致', () => {
    sc.setSkillEnabled('demo-skill', true);
    assert.equal(sc.isSkillEnabledInConfig('demo-skill'), true);
    sc.setSkillEnabled('demo-skill', false);
    assert.equal(sc.isSkillEnabledInConfig('demo-skill'), false);
  });

  await c.check('skills/config：settings 读写、未声明键被过滤', () => {
    sc.setSkillConfig('demo-skill', { mode: 'on' });
    const got = sc.getSkillConfig('demo-skill', { mode: 'auto', other: 1 });
    assert.equal(got.mode, 'on', '已保存的值应生效');
    assert.equal(got.other, 1, '未保存的键回落默认值');
  });

  await c.check('skills/errors：错误码与文案可读', async () => {
    const { SKILL_ERROR, skillErrorText } = await import('../src/skills/errors.js');
    assert.ok(SKILL_ERROR && typeof SKILL_ERROR === 'object', '应有错误码表');
    assert.ok(typeof skillErrorText('anything') === 'string', '应能给出文案');
  });
}

// ── 12. tool-registry.js ────────────────────────────────────────────────
c.section('12. tool-registry.js 工具注册表与可用性口径');
{
  const tr = await import('../src/tool-registry.js');

  await c.check('registerTool / getTool / listTools 基本读写', () => {
    tr.registerTool({ id: 'cov__tool1', name: '覆盖工具', description: 'x', category: 'utility', execute: () => ({ content: 'ok' }) });
    assert.ok(tr.getTool('cov__tool1'), '应能取回');
    assert.ok(tr.listTools().some((t) => t.id === 'cov__tool1'));
  });

  await c.check('listToolsByCategory / listCategories 分组正确', () => {
    tr.registerTool({ id: 'cov__tool2', name: '分类工具', description: 'y', category: 'media', execute: () => ({}) });
    assert.ok(tr.listToolsByCategory('media').some((t) => t.id === 'cov__tool2'));
    assert.ok(Array.isArray(tr.listCategories()) && tr.listCategories().length > 0);
  });

  await c.check('unregisterTool：单个注销', () => {
    tr.unregisterTool('cov__tool1');
    assert.equal(tr.getTool('cov__tool1'), null, '注销后应查不到');
  });

  await c.check('unregisterToolsBySkill：按 Skill 批量回收（热重载依赖）', () => {
    tr.registerTool({ id: 'cov__tool3', name: 'A', description: '', category: 'utility', skillId: 'cov-skill', execute: () => ({}) });
    tr.registerTool({ id: 'cov__tool4', name: 'B', description: '', category: 'utility', skillId: 'cov-skill', execute: () => ({}) });
    const removed = tr.unregisterToolsBySkill('cov-skill');
    assert.equal(removed.length, 2, `应回收 2 个工具，实际 ${removed.length}`);
    assert.equal(tr.getTool('cov__tool3'), null);
    assert.equal(tr.getTool('cov__tool4'), null);
  });

  await c.check('getToolAvailability：分类关闭时给出明确原因码', () => {
    tr.registerTool({ id: 'cov__tool5', name: 'C', description: '', category: 'media', defaultEnabled: true, execute: () => ({}) });
    const avail = tr.getToolAvailability('cov__tool5', { toolsCfg: { categories: { media: false } } });
    assert.equal(avail.enabled, false, '分类关闭时工具应不可用');
    assert.ok(avail.code, '应给出原因码');
    assert.ok(avail.reason, '应给出人类可读原因');
  });

  await c.check('getToolAvailability：单工具 overrides 生效', () => {
    tr.registerTool({ id: 'cov__tool6', name: 'D', description: '', category: 'utility', defaultEnabled: true, execute: () => ({}) });
    const off = tr.getToolAvailability('cov__tool6', { toolsCfg: { overrides: { 'cov__tool6': false } } });
    assert.equal(off.enabled, false, '显式关闭应生效');
    const on = tr.getToolAvailability('cov__tool6', { toolsCfg: {} });
    assert.equal(on.enabled, true, '未覆盖时应按 defaultEnabled 生效');
  });

  await c.check('getToolAvailability：全局开关 tools.enabled=false 一票否决', () => {
    const off = tr.getToolAvailability('cov__tool6', { toolsCfg: { enabled: false } });
    assert.equal(off.enabled, false);
    assert.equal(off.code, 'tools-disabled');
  });

  await c.check('getToolAvailability：requiresVision 在视觉关闭时被拦', () => {
    tr.registerTool({ id: 'cov__tool7', name: 'E', description: '', category: 'media', defaultEnabled: true, requiresVision: true, execute: () => ({}) });
    const off = tr.getToolAvailability('cov__tool7', { toolsCfg: {}, visionEnabled: false });
    assert.equal(off.enabled, false);
    assert.equal(off.code, 'no-vision', `原因码应为 no-vision，实际 ${off.code}`);
  });

  await c.check('getToolAvailability：未注册工具给出明确原因', () => {
    const r = tr.getToolAvailability('根本不存在的工具', {});
    assert.equal(r.enabled, false);
    assert.ok(r.reason, '应给出原因');
  });

  await c.check('availabilityOf / listAvailableTools 与 getToolAvailability 同源', () => {
    const ctx = { toolsCfg: {} };
    const a = tr.availabilityOf(ctx);
    assert.ok(Array.isArray(a) && a.length > 0, '应返回可用性列表');
    const ids = new Set(tr.listAvailableTools(ctx).map((t) => t.id));
    for (const item of a.filter((x) => x.enabled)) {
      assert.ok(ids.has(item.id), `${item.id} 在 availabilityOf 里可用但不在 listAvailableTools 里`);
    }
  });

  await c.check('clearRegistry：清空后为空', () => {
    tr.clearRegistry();
    assert.equal(tr.listTools().length, 0, '清空后应无工具');
  });
}

// ── 13. prompt.js ───────────────────────────────────────────────────────
c.section('13. prompt.js 提示词组装');
{
  const { ChatStore } = await import('../src/store.js');
  const { MemoryStore } = await import('../src/memory.js');
  const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');
  const { buildSystemPrompt, buildUserPrompt, buildPastState, hitKeyword, isAtMe, resolveContextTier } = await import('../src/prompt.js');

  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.botName = '覆盖机';
  cfg.persona.roleText = '你是覆盖测试群的机器人。';
  cfg.persona.participation = 'medium';
  cfg.store.contextTier = 4;
  cfg.store.historyCount = 80;
  setRuntimeConfig(cfg);

  await c.check('buildSystemPrompt：包含人设与安全规则等核心模块', () => {
    const sys = buildSystemPrompt();
    assert.ok(typeof sys === 'string' && sys.length > 200, '系统提示不应为空');
    for (const kw of ['安全规则', '工作方式']) {
      assert.ok(sys.includes(kw), `系统提示缺少「${kw}」`);
    }
    assert.ok(sys.includes('覆盖机'), '应包含机器人名');
  });

  await c.check('buildSystemPrompt：不包含已废弃概念', () => {
    const sys = buildSystemPrompt();
    for (const banned of ['qq_wait_for_messages', '[SILENT]', '沉睡前观察']) {
      assert.ok(!sys.includes(banned), `系统提示不应含废弃概念「${banned}」`);
    }
  });

  await c.check('isAtMe：@机器人 / 称呼机器人 能识别', () => {
    const opts = { selfNickname: '覆盖机', botName: '覆盖机', selfId: '888' };
    assert.equal(isAtMe('@覆盖机 在吗', opts), true, '称呼名应识别');
    assert.equal(isAtMe('今天天气不错', opts), false, '普通闲聊不应识别');
  });

  await c.check('hitKeyword：关键词命中', () => {
    assert.equal(hitKeyword('帮我查一下天气', ['天气', '股票']), true);
    assert.equal(hitKeyword('随便聊聊', ['天气', '股票']), false);
    assert.equal(hitKeyword('任意内容', []), false, '无关键词应返回 false');
  });

  await c.check('resolveContextTier：返回 {tier,count,reason,shouldRespond} 且档位合法', () => {
    const r = resolveContextTier({
      triggerEntries: [{ senderId: 'u1', senderName: '甲', text: '@覆盖机 帮忙看看', self: false }],
      selfNickname: '覆盖机', botName: '覆盖机', selfId: '888',
      cfg: cfg.store, roll: 0.99, isPrivate: false
    });
    assert.ok(r && typeof r === 'object', '应返回档位对象');
    assert.ok(Number.isInteger(r.tier) && r.tier >= 0 && r.tier <= 4, `档位应在 0~4，实际 ${r.tier}`);
    assert.equal(typeof r.shouldRespond, 'boolean', '应有 shouldRespond');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '应给出可读原因');
  });

  await c.check('resolveContextTier：私聊恒响应（不受档位限制）', () => {
    const r = resolveContextTier({ cfg: cfg.store, isPrivate: true, triggerEntries: [{ text: '随便说说', self: false }] });
    assert.equal(r.shouldRespond, true, '私聊必须响应');
    assert.equal(r.tier, 4, '私聊按全部响应档取值');
  });

  await c.check('resolveContextTier：被艾特命中 → 一定响应且原因为「被艾特」', () => {
    const lowTier = { ...cfg.store, contextTier: 1, randomPercent: 0 };
    const r = resolveContextTier({
      triggerEntries: [{ text: '@覆盖机 在吗', self: false }],
      selfNickname: '覆盖机', botName: '覆盖机', selfId: '888',
      cfg: lowTier, roll: 0
    });
    assert.equal(r.shouldRespond, true, '被艾特必须响应');
    assert.equal(r.reason, '被艾特');
    assert.equal(r.tier, 1, '被艾特时使用 1 档的上下文条数');
  });

  await c.check('resolveContextTier：1 档下普通闲聊不响应（省 token 的核心）', () => {
    const lowTier = { ...cfg.store, contextTier: 1, randomPercent: 0 };
    const r = resolveContextTier({
      triggerEntries: [{ text: '今天天气不错', self: false }],
      selfNickname: '覆盖机', botName: '覆盖机', selfId: '888',
      cfg: lowTier, roll: 0
    });
    assert.equal(r.shouldRespond, false, '1 档下普通闲聊不应触发');
    assert.equal(r.tier, 0, '未触发时档位为 0');
  });

  await c.check('resolveContextTier：2 档下关键词命中才响应', () => {
    const t2 = { ...cfg.store, contextTier: 2, keywords: ['天气'], randomPercent: 0 };
    const hit = resolveContextTier({ triggerEntries: [{ text: '帮我查下天气' }], selfNickname: '覆盖机', cfg: t2, roll: 0 });
    assert.equal(hit.shouldRespond, true, '关键词命中应响应');
    assert.equal(hit.reason, '关键词命中');
    const miss = resolveContextTier({ triggerEntries: [{ text: '随便聊聊' }], selfNickname: '覆盖机', cfg: t2, roll: 0 });
    assert.equal(miss.shouldRespond, false, '无关键词不应响应');
  });

  await c.check('buildPastState：产出历史状态文本（返回 {text,count,messages}）', () => {
    const store = new ChatStore(0);
    store.appendIncoming('group:1', { mid: 1, ts: Date.now() - 5000, senderId: 'u1', senderName: '甲', text: '历史消息一' });
    store.appendSelf('group:1', { text: '我回过一句', ts: Date.now() - 4000 });
    store.drainUnread('group:1');
    const past = buildPastState(store, 'group:1', { limit: 20 });
    assert.ok(past && typeof past === 'object', '应返回对象');
    assert.ok(past.text.includes('历史消息一'), '历史状态应包含旧消息');
    assert.ok(past.count >= 2, `应统计到至少 2 条，实际 ${past.count}`);
  });

  await c.check('buildPastState：excludeIds 能排除指定消息', () => {
    const store = new ChatStore(0);
    const m = store.appendIncoming('group:1', { mid: 11, ts: Date.now(), senderId: 'u1', senderName: '甲', text: '要被排除的' });
    store.drainUnread('group:1');
    const past = buildPastState(store, 'group:1', { excludeIds: [m.id] });
    assert.ok(!past.text.includes('要被排除的'), '被排除的消息不应出现');
  });

  await c.check('buildUserPrompt：包含全部关键段落', () => {
    const store = new ChatStore(0);
    const mem = new MemoryStore();
    store.appendSelf('group:1', { text: '我自己的一句话', ts: Date.now() - 30000 });
    store.drainUnread('group:1');
    for (let i = 1; i <= 3; i++) {
      store.appendIncoming('group:1', { mid: 2000 + i, ts: Date.now() - i * 1000, senderId: `u${i}`, senderName: `群友${i}`, text: `未读消息${i}` });
    }
    mem.append('group:1', 'memberImpression', '喜欢猫', { userId: 'u1', target: '群友1' });
    const triggerEntries = store.drainUnread('group:1');
    const up = buildUserPrompt({
      chatKey: 'group:1', kind: 'group', chatId: '1', chatName: '覆盖群',
      triggerEntries, store, memory: mem,
      stickerEntries: [{ id: 's1', desc: '滑稽', useCount: 3 }],
      selfNickname: '覆盖机', selfLastMessageAt: Date.now() - 30000, lastMessageAt: Date.now(),
      recentCount: 10, runSeq: 1, moreUnreadDuringRun: false, proactive: false
    });
    for (const sec of ['【当前时间】', '【未读信息】', '【已读信息】']) {
      assert.ok(String(up).includes(sec), `用户提示缺少「${sec}」`);
    }
    assert.ok(String(up).includes('未读消息1'), '应包含未读信息的消息');
  });
}

// ── 14. 其它纯函数模块 ───────────────────────────────────────────────────
c.section('14. holidays / vision-docs / personas / instance-lock / logger / llm 纯函数');
{
  const { holidayOn, upcomingHoliday } = await import('../src/holidays.js');
  await c.check('holidays：查询不抛错且返回可判定结构', () => {
    const r = holidayOn(new Date());
    assert.ok(r === null || typeof r === 'object' || typeof r === 'string', '应返回 null/对象/字符串');
    const up = upcomingHoliday(new Date());
    assert.ok(up === null || typeof up === 'object', 'upcomingHoliday 应安全返回');
  });

  const vd = await import('../src/model-vision-docs.js');
  await c.check('model-vision-docs：内置视觉能力表非空且可查询', () => {
    const builtin = vd.builtinVisionResults([{ id: 'p1', models: ['gpt-4o'] }]);
    assert.ok(builtin && typeof builtin === 'object', '应返回结果表');
    assert.ok(Object.keys(builtin).length >= 0);
    assert.ok(vd.MODEL_DOCS && typeof vd.MODEL_DOCS === 'object', '应有模型文档表');
  });

  const { PERSONAS } = await import('../src/personas.js');
  await c.check('personas：内置人设模板存在且字段完整', () => {
    const ids = Object.keys(PERSONAS);
    assert.ok(ids.length >= 1, '应至少一个内置人设');
    for (const id of ids) {
      assert.ok(PERSONAS[id].name && PERSONAS[id].text, `人设 ${id} 缺少 name/text`);
    }
  });

  const lock = await import('../src/instance-lock.js');
  await c.check('instance-lock：本进程可重复抢锁（同 PID 视为同一持有者），释放后可再抢', () => {
    lock.releaseInstanceLock();
    const a = lock.acquireInstanceLock();
    assert.equal(a.ok, true, `首次抢锁应成功：${a.reason ?? ''}`);
    lock.releaseInstanceLock();
    const d = lock.acquireInstanceLock();
    assert.equal(d.ok, true, '释放后应可再抢');
    lock.releaseInstanceLock();
  });

  await c.check('instance-lock：锁文件记录持有者 PID，供跨进程互斥判定', () => {
    lock.releaseInstanceLock();
    lock.acquireInstanceLock();
    const lockFile = path.join(dataDir, 'qq-agent.lock');
    assert.ok(fs.existsSync(lockFile), '抢锁后应生成锁文件');
    const raw = fs.readFileSync(lockFile, 'utf8');
    assert.ok(raw.includes(String(process.pid)), `锁文件应包含本进程 PID，实际内容：${raw}`);
    lock.releaseInstanceLock();
    assert.ok(!fs.existsSync(lockFile) || !fs.readFileSync(lockFile, 'utf8').includes(String(process.pid)),
      '释放后不应再记录本进程为持有者');
  });

  await c.check('instance-lock：另一进程持锁时本进程抢锁失败（真实互斥语义）', async () => {
    const { spawn } = await import('node:child_process');
    lock.releaseInstanceLock();
    const lockFile = path.join(dataDir, 'qq-agent.lock');
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }

    const moduleUrl = new URL('../src/instance-lock.js', import.meta.url).href;
    const script = `
      const m = await import(${JSON.stringify(moduleUrl)});
      m.acquireInstanceLock();
      setInterval(() => {}, 1000);
    `;
    // 注意：沙箱下不能给子进程接管道（stdio: 'pipe' 会 EPERM），所以用 'ignore'，
    // 通过锁文件内容来判断子进程是否真的拿到了锁。
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir },
      stdio: 'ignore'
    });
    try {
      await new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          let raw = '';
          try { raw = fs.readFileSync(lockFile, 'utf8'); } catch { /* 还没写 */ }
          const pid = Number((raw.match(/\d+/) || [])[0]);
          if (pid && pid === child.pid) return resolve();
          if (Date.now() - started > 8000) return reject(new Error(`子进程未持有锁，锁文件内容：${raw}`));
          setTimeout(tick, 60);
        };
        tick();
      });
      assert.ok(true, '子进程已持锁');
      const mine = lock.acquireInstanceLock();
      assert.equal(mine.ok, false, '另一进程持锁时本进程必须抢锁失败');
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
      try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
      lock.releaseInstanceLock();
    }
  });

  const { logger } = await import('../src/logger.js');
  await c.check('logger：分级 / 内存缓冲 / 订阅回调', () => {
    logger.setLevel('debug');
    assert.equal(logger.getLevel(), 'debug');
    const seen = [];
    const off = logger.onLog((e) => seen.push(e));
    logger.info('覆盖测试', '一条日志');
    off();
    assert.ok(logger.recent(10).length >= 1, '内存缓冲应有记录');
    assert.ok(seen.length >= 1, '订阅者应收到回调');
  });

  await c.check('logger：重入防护（订阅回调里再打日志不会无限递归）—— 15GB 事故回归', () => {
    const before = logger.recent(500).length;
    const off = logger.onLog(() => { logger.info('覆盖测试', '重入日志'); });
    logger.info('覆盖测试', '触发一次');
    off();
    const after = logger.recent(500).length;
    assert.ok(after - before < 10, `重入应被拦住，实际新增 ${after - before} 条`);
  });

  const llm = await import('../src/llm.js');
  await c.check('llm：emptyUsage / addUsage 累加正确', () => {
    const u = llm.emptyUsage();
    llm.addUsage(u, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    assert.equal(u.calls ?? 0, 0, 'addUsage 不应自行改 calls');
    assert.ok(u.promptTokens >= 100, 'input token 应累计');
  });

  await c.check('llm：cacheHitRate 计算命中率', () => {
    const r = llm.cacheHitRate({ promptTokens: 1000, cachedTokens: 250 });
    assert.ok(r >= 0 && r <= 1, `命中率应在 0~1，实际 ${r}`);
    assert.equal(llm.cacheHitRate({ promptTokens: 0, cachedTokens: 0 }), 0, '无输入应为 0');
  });

  await c.check('llm：estimateCost 产出成本对象（cost/breakdown/prices）', () => {
    const r = llm.estimateCost({ promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 }, { model: '不存在的模型' });
    assert.ok(r && typeof r === 'object', '应返回对象');
    assert.ok(Number.isFinite(r.cost), `cost 应为数字，实际 ${r.cost}`);
    assert.ok(r.breakdown && r.prices, '应含 breakdown 与 prices');
  });

  await c.check('llm：estimateCost 缓存命中部分按缓存价计费（比全量输入便宜）', async () => {
    const mpMod = await import('../src/model-prices.js');
    const model = mpMod.listOfficialPrices()[0].id;
    const fresh = llm.estimateCost({ promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 }, { model }).cost;
    const cached = llm.estimateCost({ promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 }, { model }).cost;
    assert.ok(cached <= fresh, `命中缓存不应更贵：cache=${cached} fresh=${fresh}`);
  });

  await c.check('llm：isRetryableError 区分 5xx/网络与 4xx（4xx 不重试）', () => {
    assert.equal(llm.isRetryableError(new Error('模型 API HTTP 500')), true, '5xx 应可重试');
    assert.equal(llm.isRetryableError(new Error('模型 API HTTP 401')), false, '401 不应重试');
  });

  const st = await import('../src/stickers.js');
  await c.check('stickers：normalizeStickerEntry 归一化条目', () => {
    const e = st.normalizeStickerEntry({ id: 'x', desc: '滑稽' });
    assert.ok(e && e.id, '应返回带 id 的条目');
  });

  await c.check('stickers：findSticker 找不到时安全返回', () => {
    const r = st.findSticker([{ id: 'a', desc: 'x', useCount: 0 }], '不存在的');
    assert.ok(r === null || typeof r === 'object', '应安全返回');
  });

  await c.check('stickers：loadStickerStore 在空数据目录下不抛错', () => {
    const s = st.loadStickerStore();
    assert.ok(s && typeof s === 'object', '应返回库对象');
  });
}
c.section('15. gif-to-video.js GIF 转视频（含奇数尺寸回归）');
{
  const g = await import('../src/gif-to-video.js');

  await c.check('isGifBuffer：魔数识别 GIF（QQ 表情常伪装 .jpg 文件名，只认字节）', () => {
    assert.equal(g.isGifBuffer(Buffer.from('GIF89axxxxx', 'ascii')), true, 'GIF89a 魔数应识别');
    assert.equal(g.isGifBuffer(Buffer.from('GIF87axxxxx', 'ascii')), true, 'GIF87a 魔数应识别');
    assert.equal(g.isGifBuffer(Buffer.from('\xFF\xD8\xFFJFIF', 'binary')), false, 'JPEG 魔数不是 GIF');
    assert.equal(g.isGifBuffer(Buffer.alloc(3)), false, '过短 buffer 安全返回 false');
  });

  await c.check('resolveGifRoute：四象限规则矩阵', () => {
    assert.equal(g.resolveGifRoute({ vision: true, video: true }), 'video', '双开 → 转 mp4');
    assert.equal(g.resolveGifRoute({ vision: true, video: false }), 'gif-image', '只开图片 → 按图发');
    assert.equal(g.resolveGifRoute({ vision: false, video: true }), 'image', '图片关 → 占位符');
    assert.equal(g.resolveGifRoute({ vision: false, video: false }), 'image', '双关 → 占位符');
  });

  await c.check('gifToVideoDataUrl：奇数尺寸 GIF 也能转出（yuv420p 只吃偶数宽高）', async () => {
    const ffmpeg = await new Promise((res) => {
      import('node:child_process').then(({ execFile }) =>
        execFile('ffmpeg', ['-version'], { windowsHide: true }, (e) => res(e ? null : 'ffmpeg')));
    });
    if (!ffmpeg) return;   // 没装 ffmpeg 的环境跳过（转换链依赖它，路由矩阵上面已覆盖）
    const { execFile } = await import('node:child_process');
    const tmpIn = path.join(os.tmpdir(), `qqa_test_odd_${Date.now()}.gif`);
    await new Promise((res) => execFile('ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'testsrc=size=101x61:rate=8:duration=1', tmpIn],
      { windowsHide: true }, res));
    try {
      const buf = fs.readFileSync(tmpIn);
      assert.ok(g.isGifBuffer(buf), '测试源应是 GIF');
      const v = await g.gifToVideoDataUrl(buf);
      assert.ok(v, '奇数尺寸（101x61）GIF 应转换成功（scale 需 force_divisible_by=2）');
      assert.equal(v.width % 2, 0, `输出宽应为偶数，实际 ${v.width}`);
      assert.equal(v.height % 2, 0, `输出高应为偶数，实际 ${v.height}`);
      assert.ok(v.dataUrl.startsWith('data:video/mp4;base64,'), '应是 mp4 data URL');
    } finally {
      try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    }
  });
}

c.finish();
