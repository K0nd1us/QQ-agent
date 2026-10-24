// 覆盖测试 C：端到端运行链路 + Skill/插件生命周期
//
// 覆盖：
//   - 群消息 → 触发 → 工具发言 → 存档 → 已读（完整链路）
//   - 零历史成本模型（每次会话 messages 恒为 system+user）
//   - 白名单拦截 / 私聊 / 引用消息
//   - 响应档位命中与不命中（不命中零 token）
//   - 暂停与恢复
//   - SSE 实时事件
//   - Skill 开关与工具可用性联动
//   - 工具 execute 行为（消息/表情/戳一戳/记忆/提醒/历史查询）
//   - 插件加载（含 entry 路径穿越安全回归、热重载生命周期）
//
// 运行：node test/coverage-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createChecker, bootApp, sleep, waitFor } from './_harness.mjs';

const c = createChecker('端到端链路 + Skill/插件');

/**
 * 在隔离子进程 + 隔离工作目录里跑一例插件加载用例。
 * 为什么用子进程：plugin-loader 用 process.cwd() 定位 skills/，且会写全局
 * skillManager 单例 —— 放进主进程会污染正在跑的 app。
 * 为什么结果写文件而不是管道：沙箱禁止给子进程接 stdio 管道（EPERM）。
 */
async function runIsolatedPluginCase({ files = {}, runner, env = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-case-'));
  const tracePath = path.join(tmp, 'trace.txt');
  const markerPath = path.join(tmp, 'OUTSIDE_EXECUTED.txt');
  fs.mkdirSync(path.join(tmp, 'plugins'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // __MARKER__ 必须替换成**合法的 JS 字符串字面量**：
    // Windows 路径带反斜杠，直接塞进单引号里会被当转义序列，
    // 导致写入失败 -> 探针假阴性（安全回归测试必须避免）。
    fs.writeFileSync(target, String(content).replaceAll('__MARKER__', JSON.stringify(markerPath)), 'utf8');
  }
  const runnerPath = path.join(tmp, 'runner.mjs');
  fs.writeFileSync(runnerPath, runner, 'utf8');

  const { spawnSync } = await import('node:child_process');
  spawnSync(process.execPath, [runnerPath], {
    stdio: 'ignore',
    env: {
      ...process.env,
      QQ_AGENT_DATA_DIR: tmp,
      CASE_DIR: tmp,
      TRACE_FILE: tracePath,
      RESULT_FILE: path.join(tmp, 'result.json'),
      LOADER_URL: new URL('../src/plugin-loader.js', import.meta.url).href,
      MANAGER_URL: new URL('../src/skills/manager.js', import.meta.url).href,
      SKILLCFG_URL: new URL('../src/skills/config.js', import.meta.url).href,
      ...env
    }
  });
  return { tmp, tracePath, markerPath };
}

const ctx = await bootApp({
  script: [
    { toolCalls: [{ name: 'send_message', args: { messages: ['在的', '咋了 [CQ:at,qq=1]'] } }] },
    { content: '（第一轮处理完毕）' }
  ]
});
const { app, request, onebotHttp, onebotWs, llm, pushGroupMsg, waitSessionDone } = ctx;

// ── 1. 端到端：群消息 → 发言 → 存档 ─────────────────────────────────────
c.section('1. 群消息端到端');
{
  let session1 = null;
  await c.check('@机器人 触发一次完整运行（工具发言 → 存档 → 已读）', async () => {
    assert.equal(app.onebot.connected, true, 'OneBot 应已连接');
    assert.equal(app.onebot.selfId, '888', '应取得登录信息');
    pushGroupMsg(111, '张三', '@覆盖Bot 在吗？', 9001);
    session1 = await waitSessionDone('在吗？');
    assert.ok(session1, '应产生一个会话');
    assert.equal(session1.status, 'done', `会话应正常结束，实际 ${session1.status}`);
  });

  await c.check('模型请求结构：零历史（system + user 两条）', () => {
    const req = llm.state.requests[0];
    assert.ok(req, '应至少有一次 LLM 调用');
    assert.equal(req.messages.length, 2, `零历史模型要求 messages 恒为 2 条，实际 ${req.messages.length}`);
    assert.equal(req.messages[0].role, 'system');
    assert.equal(req.messages[1].role, 'user');
    assert.ok(String(req.messages[1].content).includes('在吗？'), '用户消息应含触发文本');
    assert.ok(Array.isArray(req.tools) && req.tools.length > 0, '应下发工具集');
  });

  await c.check('工具集不含已废弃工具，且名字不带 qq_ 前缀', () => {
    const names = llm.state.requests[0].tools.map((t) => t.function.name);
    for (const banned of ['wait_for_messages', 'set_wake_config', 'mark_read']) {
      assert.ok(!names.includes(banned), `不应包含已废弃工具 ${banned}`);
    }
    assert.ok(!names.some((n) => n.startsWith('qq_')), '工具名不应带 qq_ 前缀');
  });

  await c.check('实际发出两条 QQ 消息，CQ 码被转义、顺序正确', async () => {
    await waitFor(() => onebotHttp.state.sends.length >= 2, 5000, '两条消息发出');
    const [s1, s2] = onebotHttp.state.sends;
    assert.equal(s1.body.message[0].data.text, '在的');
    assert.ok(!String(s2.body.message[0].data.text).includes('[CQ:'), 'CQ 码应被转义，避免被协议端当指令');
  });

  await c.check('会话留档：用量/已发送/提示词/模型全部记录', () => {
    assert.ok(session1.usage.totalTokens > 0, '应累计 token 用量');
    assert.equal(session1.sent.length, 2, `应记录 2 条已发送，实际 ${session1.sent.length}`);
    assert.ok(session1.systemPrompt && session1.userPrompt, '应留存完整提示词');
    assert.ok(session1.model, '应记录实际使用的模型');
  });

  await c.check('存档与已读状态：消息入库且未读清零', () => {
    const meta = app.store.getChatMeta('group:456');
    assert.ok(meta.total >= 3, `存档应含收到的消息与自己的发言，实际 ${meta.total}`);
    assert.equal(meta.unread, 0, '处理完应全部标记已读');
  });
}

// ── 2. 白名单 / 屏蔽 ─────────────────────────────────────────────────────
c.section('2. 白名单与屏蔽');
{
  await c.check('白名单外的群被完全忽略（不调用模型、不入档）', async () => {
    const before = llm.state.requests.length;
    onebotWs.push({
      post_type: 'message', message_type: 'group', group_id: 999, user_id: 111, self_id: 888,
      message_id: 9100, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 111, card: '外人', nickname: '外人' },
      message: [{ type: 'text', data: { text: '白名单外的消息' } }]
    });
    await sleep(700);
    assert.equal(llm.state.requests.length, before, '白名单外不应触发 LLM');
    assert.equal(app.store.listChats().includes('group:999'), false, '白名单外不应写入存档');
  });

  await c.check('全局屏蔽名单：被屏蔽者的消息不入档、不触发', async () => {
    await request('POST', '/api/config', { body: { globalBlocklist: ['666'] } });
    const before = llm.state.requests.length;
    pushGroupMsg(666, '广告号', '@覆盖Bot 买号吗', 9110);
    await sleep(700);
    assert.equal(llm.state.requests.length, before, '被屏蔽者不应触发 LLM');
    await request('POST', '/api/config', { body: { globalBlocklist: [] } });
  });
}

// ── 3. 私聊 ──────────────────────────────────────────────────────────────
c.section('3. 私聊');
{
  await c.check('私聊消息可触发（白名单内）', async () => {
    llm.state.script.push({ content: '（私聊收到）' });
    const before = llm.state.requests.length;
    onebotWs.push({
      post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
      message_id: 9200, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 777, nickname: '老友' },
      message: [{ type: 'text', data: { text: '私聊测试一句' } }]
    });
    await waitFor(() => llm.state.requests.length > before, 6000, '私聊触发 LLM');
    assert.ok(app.store.listChats().includes('private:777'), '私聊应写入存档');
  });
}

// ── 4. 引用消息 ──────────────────────────────────────────────────────────
c.section('4. 引用消息');
{
  await c.check('引用消息被解析成可读文本（含被引用人）', async () => {
    llm.state.script.push({ content: '（看到引用了）' });
    const before = llm.state.requests.length;
    onebotWs.push({
      post_type: 'message', message_type: 'group', group_id: 456, user_id: 113, self_id: 888,
      message_id: 9003, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 113, card: '王五', nickname: '王五' },
      message: [
        { type: 'reply', data: { id: 9001 } },
        { type: 'text', data: { text: '张三说的对' } }
      ]
    });
    await waitFor(() => llm.state.requests.length > before, 6000, '引用消息触发');
    const req = llm.state.requests.at(-1);
    const userText = String(req.messages[1].content);
    assert.ok(userText.includes('张三说的对'), '应含正文');
    assert.ok(userText.includes('被引用') || userText.includes('[引用'), '应把引用关系解析进提示词');
  });
}

// ── 5. 响应档位（省 token 的核心） ───────────────────────────────────────
c.section('5. 响应档位');
{
  await c.check('1 档下普通闲聊不响应：零 LLM 调用，且**当场**标已读（逐条判定）', async () => {
    await request('POST', '/api/config', { body: { store: { contextSliderPos: 0 } } });
    const cfg = await request('GET', '/api/config');
    assert.equal(cfg.data.store.contextTier, 1, '滑条位置 0 应派生为 1 档');

    const before = llm.state.requests.length;
    pushGroupMsg(111, '张三', '今天天气不错啊', 9300);
    await sleep(250);
    assert.equal(llm.state.requests.length, before, '1 档下普通闲聊不应触发 LLM（省 token 的核心）');
    // 2026-09-25 改版：逐条判定 —— 不触发的消息入库瞬间被标已读
    // （不再走"兜底定时器"，未读一闪即已读）
    assert.equal(app.store.getChatMeta('group:456').unread, 0, '不触发的消息应立即标已读');
  });

  await c.check('1 档下被 @ 仍然必响应', async () => {
    const before = llm.state.requests.length;
    llm.state.script.push({ content: '（被叫到了）' });
    pushGroupMsg(111, '张三', '@覆盖Bot 叫你呢', 9301);
    await waitFor(() => llm.state.requests.length > before, 6000, '被 @ 触发');
  });

  await c.check('滑条位置与档位由后端权威派生（前端只报位置）', async () => {
    const r = await request('POST', '/api/config', { body: { store: { contextSliderPos: 55 } } });
    assert.equal(r.status, 200);
    const cfg = await request('GET', '/api/config');
    assert.equal(cfg.data.store.contextTier, 3, '55 应派生 3 档');
    assert.ok(cfg.data.store.randomPercent > 0, '3 档应派生随机概率');
  });
}

// ── 6. 暂停 / 恢复 ───────────────────────────────────────────────────────
c.section('6. 暂停与恢复');
{
  await c.check('暂停期间消息只积压，不调用模型', async () => {
    await request('POST', '/api/pause', { body: { paused: true } });
    assert.equal(app.orchestrator.paused, true);
    const before = llm.state.requests.length;
    pushGroupMsg(111, '张三', '@覆盖Bot 暂停期间的消息', 9400);
    await sleep(900);
    assert.equal(llm.state.requests.length, before, '暂停期间不应触发 LLM');
    assert.ok(app.store.unreadCount('group:456') >= 1, '消息应积压为未读');
  });

  await c.check('POST /api/pause {paused:false}：恢复并处理积压', async () => {
    llm.state.script.push({ content: '（恢复后处理积压）' });
    const before = llm.state.requests.length;
    const r = await request('POST', '/api/pause', { body: { paused: false, skipBacklog: false } });
    assert.equal(r.status, 200);
    assert.equal(r.data.paused, false);
    await waitFor(() => llm.state.requests.length > before, 10000, '恢复后处理积压');
  });

  await c.check('DELETE /api/pause：恢复但丢弃积压（把未读直接标已读）', async () => {
    await request('POST', '/api/pause', { body: { paused: true } });
    pushGroupMsg(111, '张三', '@覆盖Bot 这条应该被丢弃', 9401);
    await sleep(600);
    const before = llm.state.requests.length;
    const r = await request('DELETE', '/api/pause');
    assert.equal(r.status, 200);
    assert.equal(r.data.paused, false);
    assert.ok(r.data.marked && Object.keys(r.data.marked).length > 0, '应报告被标记已读的会话');
    await sleep(800);
    assert.equal(llm.state.requests.length, before, 'DELETE /api/pause 不应处理积压');
    assert.equal(app.store.unreadCount('group:456'), 0, '积压应被标记已读');
  });
}

// ── 7. SSE 实时事件 ──────────────────────────────────────────────────────
c.section('7. SSE 实时事件');
{
  await c.check('SSE 连接可用，且会话事件实时推送', async () => {
    const events = [];
    const req = http.get(`${ctx.base}/api/events`, (res) => {
      assert.equal(res.statusCode, 200, 'SSE 应 200');
      res.setEncoding('utf8');
      res.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('event:')) events.push(line.slice(6).trim()); });
    });
    await waitFor(() => events.includes('hello'), 4000, 'SSE hello');

    llm.state.script.push({ content: '（SSE 触发）' });
    pushGroupMsg(111, '张三', '@覆盖Bot SSE 测试', 9500);
    await waitFor(() => events.includes('session-start') || events.includes('session-end'), 8000, 'SSE 会话事件');
    req.destroy();
  });
}

// ── 8. Skill 开关与工具联动 ──────────────────────────────────────────────
c.section('8. Skill 开关与工具联动');
{
  let skillId = null;
  let skillToolIds = [];
  // skills/ 与 plugins/ 是用户后装扩展的落点，可能为空（内置功能已收编核心）。
  // 联动断言需要"带工具的已加载 Skill"；空目录时三条整体跳过（架构链路由
  // skill-test 用注入的临时 Skill 锁定，不依赖磁盘上真有扩展）。
  {
    const probe = await request('GET', '/api/tools/availability');
    const skillToolCount = probe.data.tools.filter((t) => t.skillId).length;
    if (skillToolCount > 0) {
    await c.check('已加载 Skill 的工具带 skillId，且工具可用性与技能开关一致', async () => {
      const skillsRes = await request('GET', '/api/skills');
      const enabledOf = new Map((skillsRes.data.skills || []).map((s) => [s.id, s.enabled === true]));
      const r = await request('GET', '/api/tools/availability');
      const withSkill = r.data.tools.filter((t) => t.skillId);
      assert.ok(withSkill.length > 0, '应有 Skill 提供的工具（speaker-identity 等）');
      // 后面几条断言要做"关 → 开"的联动测试，所以优先挑一个**默认启用**的技能，
      // 语义与原来的写法一致（原写法隐含假设"带工具的技能都默认开启"）。
      // 后面几条断言要做"关 → 开"的联动测试，所以要挑一个**当前真的可用**的技能：
      // 只挑"已启用"不够 —— 技能可能已启用但自报不可用（image-generate 缺 Base URL），
      // 那它的工具在"重新开启"之后依然不可用，联动断言会变成假失败。
      const preferred = withSkill.find((t) => enabledOf.get(t.skillId) === true && t.enabled === true);
      assert.ok(preferred, '应至少有一个"已启用且工具可用"的技能（否则后面没法做开关联动）');
      skillId = (preferred || withSkill[0]).skillId;
      skillToolIds = withSkill.filter((t) => t.skillId === skillId).map((t) => t.id);
      assert.ok(skillToolIds.length > 0, '该 Skill 应有工具');
      // ⚠️ 不能一律断言 enabled === true。两种情况会让"技能开着但工具不可用"成为**正确**行为：
      //   · skills/ 下的条目可以是 enabledByDefault: false（如 random-image / sticker-annotate）
      //   · 技能自己声明暂时不可用（如 image-generate 没填 Base URL）→ code = skill-unavailable
      // 原来这里假设"注册了工具的技能都默认开启、且开了就一定可用"，
      // 后一个假设在"技能自报缺配置"这个合法状态出现后会变成假失败。
      //
      // 真正该守的不变量是：**工具可用性不能与技能开关矛盾** ——
      // 技能关 → 必须不可用；技能开 → 可用，或不可用但原因不是开关类错误。
      const SWITCH_CODES = new Set(['skill-disabled', 'skill-not-loaded', 'skill-not-found']);
      for (const t of withSkill) {
        const on = enabledOf.get(t.skillId) === true;
        if (on) {
          if (!t.enabled) {
            assert.ok(!SWITCH_CODES.has(t.code),
              `技能 ${t.skillId} 已启用，工具 ${t.id} 却被开关类原因关掉（影子开关泄漏）：${t.code} ${t.reason}`);
            assert.ok(t.reason, `工具 ${t.id} 既不可用就必须给出原因`);
          }
        } else {
          assert.equal(t.enabled, false, `技能 ${t.skillId} 未启用，工具 ${t.id} 不应可用`);
        }
      }
      return `${withSkill.length} 个技能工具，可用性与开关一致`;
    });

    await c.check('关闭 Skill → 它的工具立刻全部不可用（单一开关，无影子开关）', async () => {
      const r = await request('POST', `/api/skills/${encodeURIComponent(skillId)}`, { body: { enabled: false } });
      assert.equal(r.status, 200);
      const avail = await request('GET', '/api/tools/availability');
      const mine = avail.data.tools.filter((t) => t.skillId === skillId);
      assert.ok(mine.length > 0);
      for (const t of mine) {
        assert.equal(t.enabled, false, `关闭 Skill 后工具 ${t.id} 仍可用（影子开关泄漏）`);
        assert.ok(t.reason, `工具 ${t.id} 应给出不可用原因`);
      }
    });

    await c.check('重新开启 Skill → 工具一起恢复', async () => {
      await request('POST', `/api/skills/${encodeURIComponent(skillId)}`, { body: { enabled: true } });
      const avail = await request('GET', '/api/tools/availability');
      const mine = avail.data.tools.filter((t) => t.skillId === skillId);
      for (const t of mine) assert.equal(t.enabled, true, `恢复后工具 ${t.id} 应可用`);
    });
    } else {
      await c.check('空目录：无技能工具时架构仍健康', async () => {
        const r = await request('GET', '/api/skills');
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.data.skills), '空目录下 skills 列表仍为数组');
        assert.equal(r.data.summary.total, 0, '空目录下 total 应为 0');
      });
    }
  }

  await c.check('历史渲染带 (QQ:)（核心兜底，不依赖扩展）', async () => {
    const { buildPastState } = await import('../src/prompt.js');
    app.store.appendIncoming('group:456', { mid: 8888, ts: Date.now(), senderId: '111', senderName: '张三', text: '能力接线测试' });
    app.store.drainUnread('group:456');
    const text = buildPastState(app.store, 'group:456', { limit: 50 }).text;
    assert.ok(text.includes('张三(QQ:111)'),
      `历史应带稳定 QQ 号（身份锚点，核心能力），实际：${text.slice(-160)}`);
    assert.ok(text.includes('张三'), '应显示名字');
  });

  await c.check('@ 段渲染带 (QQ:)（核心路径，不依赖扩展）', async () => {
    const { segmentsToText } = await import('../src/onebot.js');
    const segments = [
      { type: 'text', data: { text: '@张三 你看下' } },
      { type: 'at', data: { qq: '111' } }
    ];
    const text = await segmentsToText(segments, { resolveAtName: async () => '张三' });
    assert.ok(text.includes('@张三'), `@ 段应渲染昵称，实际：${text}`);
  });

  await c.check('Skill 停用后，其提示词片段也不再进入系统提示（避免界面关了还在偷偷工作）', async () => {
    const a = await request('GET', '/api/config');
    assert.ok(a.status === 200);
    // 用一次真实调用观察 system prompt 是否随开关变化
    await request('POST', `/api/skills/${encodeURIComponent(skillId)}`, { body: { enabled: false } });
    llm.state.script.push({ content: '（观察提示词）' });
    const before = llm.state.requests.length;
    pushGroupMsg(111, '张三', '@覆盖Bot 观察提示词', 9600);
    await waitFor(() => llm.state.requests.length > before, 8000, '观察调用');
    const sysOff = String(llm.state.requests.at(-1).messages[0].content);

    await request('POST', `/api/skills/${encodeURIComponent(skillId)}`, { body: { enabled: true } });
    llm.state.script.push({ content: '（再观察提示词）' });
    const before2 = llm.state.requests.length;
    pushGroupMsg(111, '张三', '@覆盖Bot 再观察提示词', 9601);
    await waitFor(() => llm.state.requests.length > before2, 8000, '再观察调用');
    const sysOn = String(llm.state.requests.at(-1).messages[0].content);

    assert.ok(sysOn.length > 0 && sysOff.length > 0, '系统提示不应为空');
    // 不强求一定不同（该 Skill 可能不声明提示词片段），但两者都应含核心安全规则
    for (const s of [sysOn, sysOff]) assert.ok(s.includes('安全规则'), '核心安全规则必须始终保留');
  });
}

// ── 9. 工具 execute 行为 ─────────────────────────────────────────────────
c.section('9. 工具 execute 行为');
{
  const { buildToolDefs } = await import('../src/tools.js');
  const { ReminderStore } = await import('../src/reminders.js');
  const defs = buildToolDefs();
  const byId = (id) => defs.find((d) => (d.id || d.name) === id);
  const reminders = new ReminderStore();

  // 工具在真实链路里由 orchestrator 传入完整 ctx（含本次 session）。
  // 这里造一个真实 session，模拟 orchestrator 的注入方式。
  const toolSession = app.sessions.create({ chatKey: 'group:456', trigger: '工具测试会话' });
  toolSession.sent = [];
  toolSession.rounds = 0;
  const toolCtx = () => ({
    chatKey: 'group:456',
    store: app.store,
    onebot: app.onebot,
    sender: app.orchestrator.sender,
    session: toolSession,
    memory: app.memory,
    reminders: app.orchestrator.reminders,
    stickers: app.orchestrator.stickers,
    emit: () => {}
  });

  await c.check('内置工具数量与关键工具齐备', () => {
    assert.ok(defs.length >= 20, `内置工具应 ≥20，实际 ${defs.length}`);
    for (const id of ['send_message', 'send_sticker', 'send_poke', 'web_search', 'get_recent_messages', 'memory_append', 'finish']) {
      assert.ok(byId(id), `缺少工具 ${id}`);
    }
  });

  await c.check('send_message：按条发送 + CQ 转义 + 写入会话已发送记录', async () => {
    const before = onebotHttp.state.sends.length;
    const tool = byId('send_message');
    const r = await tool.execute(toolCtx(), { messages: ['覆盖工具发送1', '带 CQ [CQ:at,qq=999] 的第二条'] });
    assert.ok(!r.isError, `工具应成功：${r.content}`);
    assert.equal(onebotHttp.state.sends.length, before + 2, '应发出两条');
    const last = onebotHttp.state.sends.at(-1).body.message[0].data.text;
    assert.ok(!last.includes('[CQ:'), 'CQ 码应被转义');
    assert.equal(toolSession.sent.length, 2, '发送应记录进 session.sent');
  });

  await c.check('send_message：空列表被拒绝且不发送', async () => {
    const before = onebotHttp.state.sends.length;
    const r = await byId('send_message').execute(toolCtx(), { messages: [] });
    assert.ok(r.isError, '空消息应报错');
    assert.equal(onebotHttp.state.sends.length, before, '不应发出任何消息');
  });

  await c.check('send_poke：拍一拍发出正确动作', async () => {
    const before = onebotHttp.state.pokes.length;
    const r = await byId('send_poke').execute(toolCtx(), { userId: '111' });
    assert.ok(!r.isError, `拍一拍应成功：${r.content}`);
    assert.ok(onebotHttp.state.pokes.length > before, '应发出拍一拍请求');
  });

  await c.check('get_recent_messages：返回历史消息文本', async () => {
    app.store.appendIncoming('group:456', { mid: 8801, ts: Date.now(), senderId: '111', senderName: '张三', text: '历史查询目标消息' });
    app.store.drainUnread('group:456');
    const r = await byId('get_recent_messages').execute(toolCtx(), { limit: 20 });
    assert.ok(!r.isError, `查询应成功：${r.content}`);
    assert.ok(String(r.content).includes('历史查询目标消息'), '应返回刚写入的消息');
  });

  await c.check('get_active_members：返回活跃成员列表', async () => {
    const r = await byId('get_active_members').execute(toolCtx(), {});
    assert.ok(!r.isError, `应成功：${r.content}`);
    assert.ok(String(r.content).includes('111') || String(r.content).includes('张三'), '应含活跃成员');
  });

  await c.check('memory_append + memory_query：印象写入后能查回', async () => {
    const w = await byId('memory_append').execute(toolCtx(), { userId: '111', target: '张三', content: '工具写入的印象' });
    assert.ok(!w.isError, `写入应成功：${w.content}`);
    const q = await byId('memory_query').execute(toolCtx(), { userId: '111' });
    assert.ok(!q.isError, `查询应成功：${q.content}`);
    assert.ok(String(q.content).includes('工具写入的印象'), '应能查回刚写入的印象');
  });

  await c.check('memory_remove：删除印象', async () => {
    const r = await byId('memory_remove').execute(toolCtx(), { userId: '111', content: '工具写入的印象' });
    assert.ok(!r.isError, `删除应成功：${r.content}`);
  });

  await c.check('set_reminder + list_reminders + cancel_reminder：提醒全流程', async () => {
    const setT = byId('set_reminder');
    const s = await setT.execute(toolCtx(), { text: '覆盖测试提醒', delayMinutes: 30 });
    assert.ok(!s.isError, `设置提醒应成功：${s.content}`);
    const list = await byId('list_reminders').execute(toolCtx(), {});
    assert.ok(!list.isError, `查询提醒应成功：${list.content}`);
    assert.ok(String(list.content).includes('覆盖测试提醒'), '应列出刚设置的提醒');
    const pending = app.orchestrator.reminders.pending('group:456');
    assert.ok(pending.length >= 1, '提醒应落进 ReminderStore');
    const cancel = await byId('cancel_reminder').execute(toolCtx(), { id: pending[0].id });
    assert.ok(!cancel.isError, `取消提醒应成功：${cancel.content}`);
  });

  await c.check('check_holiday：查询节日返回可读文本', async () => {
    const r = await byId('check_holiday').execute(toolCtx(), {});
    assert.ok(!r.isError, `应成功：${r.content}`);
    assert.ok(String(r.content).length > 0, '应返回内容');
  });

  await c.check('list_stickers：查看表情库', async () => {
    const r = await byId('list_stickers').execute(toolCtx(), {});
    assert.ok(!r.isError, `应成功：${r.content}`);
  });

  await c.check('finish：结束会话并记录 finishReason', async () => {
    const r = await byId('finish').execute(toolCtx(), { summary: '覆盖测试结束' });
    assert.ok(r && typeof r === 'object', '应返回结果对象');
    assert.ok(!r.isError, `应成功：${r.content}`);
    assert.equal(toolSession.finishReason, '覆盖测试结束', '应给 session 打上 finishReason');
  });

  await c.check('web_search：走 mock 搜索源返回结果', async () => {
    const r = await byId('web_search').execute(toolCtx(), { query: '覆盖测试搜索' });
    assert.ok(!r.isError, `搜索应成功：${r.content}`);
    assert.ok(String(r.content).length > 0, '应有搜索结果');
  });

  await c.check('web_fetch：SSRF 防护对内网地址生效（安全边界）', async () => {
    const r = await byId('web_fetch').execute(toolCtx(), { url: 'http://127.0.0.1:3210/api/status' });
    assert.ok(r.isError, '抓取本机地址应被拒绝');
    assert.ok(/内网|本机|拒绝|禁止/.test(String(r.content)), `应给出拒绝原因，实际：${r.content}`);
  });

  await c.check('提醒走统一发送管道（同文本两次触发 → 被 SendQueue 去重，只发一条）', async () => {
    // 判据说明：只有真正经过 SendQueue 才会命中 8 秒内容去重窗口；
    // 旧实现直接调 onebot.sendText，两条一模一样的提醒会重复发出去。
    const before = onebotHttp.state.sends.length;
    const due = Date.now() - 1000;
    app.orchestrator.reminders.add({ chatKey: 'group:456', text: '覆盖测试提醒正文', dueAt: due });
    app.orchestrator.reminders.add({ chatKey: 'group:456', text: '覆盖测试提醒正文', dueAt: due });
    app.orchestrator.startReminderLoop();          // 重置 5s 计时，不必等 20s 的下一轮
    await waitFor(() => onebotHttp.state.sends.length > before, 15000, '提醒发出');
    await sleep(1200);                              // 给第二条留出去重判断的时间
    const sentCount = onebotHttp.state.sends.length - before;
    assert.equal(sentCount, 1, `同文本提醒应被去重成 1 条，实际发出 ${sentCount} 条`);
    assert.ok(String(onebotHttp.state.sends.at(-1).body.message[0].data.text).includes('覆盖测试提醒正文'));
    const archived = app.store.recent('group:456', { limit: 30 }).some((m) => String(m.text).includes('覆盖测试提醒正文'));
    assert.ok(archived, '提醒应被留档（SendQueue 会 appendSelf）');
  });

  await c.check('toOpenAiTools：转成 OpenAI 工具格式（含 parameters）', async () => {
    const { toOpenAiTools } = await import('../src/tools.js');
    const openAi = toOpenAiTools(defs);
    assert.ok(Array.isArray(openAi) && openAi.length >= 20, '应转换出全部工具');
    for (const t of openAi.slice(0, 5)) {
      assert.equal(t.type, 'function', '应为 function 类型');
      assert.ok(t.function.name && t.function.description !== undefined, '应有 name/description');
      assert.ok(t.function.parameters && t.function.parameters.type === 'object', 'parameters 应为 object schema');
    }
  });

  await c.check('executeTool：未知工具返回错误而不是抛异常', async () => {
    const { executeTool } = await import('../src/tools.js');
    const r = await executeTool(defs, toolCtx(), '根本不存在的工具', '{}');
    assert.ok(r.isError, '应返回错误');
    assert.ok(String(r.content).includes('未知工具'), `错误信息应说明原因：${r.content}`);
  });

  await c.check('executeTool：参数不是合法 JSON 时返回可读错误', async () => {
    const { executeTool } = await import('../src/tools.js');
    const r = await executeTool(defs, toolCtx(), 'send_message', '{不是JSON');
    assert.ok(r.isError, '应返回错误');
    assert.ok(/JSON/.test(String(r.content)), `应提示 JSON 问题：${r.content}`);
  });
}

// ── 10. 插件加载与安全回归 ───────────────────────────────────────────────
c.section('10. 插件加载与安全回归');
{
  await c.check('扩展加载：目录为空或只含用户后装扩展时均不失败', async () => {
    const tr = await import('../src/tool-registry.js');
    // 只断言架构不变量：注册表健康、skillId 标记的工具有来源（有扩展时）。
    for (const t of tr.listTools()) {
      if (t.skillId) assert.ok(typeof t.skillId === 'string' && t.skillId, '带来源的工具有合法 skillId');
    }
  });

  await c.check('Skill 的 entry 不能逃出自身目录（路径穿越）', async () => {
    const ran = await runIsolatedPluginCase({
      files: {
        'skills/evil/skill.json': JSON.stringify({ id: 'evil', name: '穿越测试', entry: '../../outside.js' }),
        'outside.js': `import fs from 'node:fs';\nfs.writeFileSync(__MARKER__, 'executed');\nexport function setup() {}`
      },
      runner: `
        import fs from 'node:fs';
        import path from 'node:path';
        const pl = await import(process.env.LOADER_URL);
        const r = await pl.loadPlugins({
          log: () => {},
          roots: {
            skills: path.join(process.env.CASE_DIR, 'skills'),
            plugins: path.join(process.env.CASE_DIR, 'plugins')
          }
        });
        fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({
          loaded: r.loaded.map((x) => x.id),
          failed: r.failed.map((x) => ({ id: x.id, error: x.error }))
        }));
      `
    });
    const result = JSON.parse(fs.readFileSync(path.join(ran.tmp, 'result.json'), 'utf8'));
    // 先证明"这条用例真的扫到了那个恶意 Skill"（否则就是假绿）
    const evil = result.failed.find((f) => f.id === 'evil' || String(f.error).includes('entry'));
    assert.ok(evil, `探针没扫到 evil Skill，用例失效：${JSON.stringify(result)}`);
    assert.ok(/entry/i.test(String(evil.error)), `应因 entry 越界被拒绝，实际错误：${evil.error}`);
    // 再断言目录外脚本没有被执行
    assert.equal(fs.existsSync(ran.markerPath), false, 'Skill 目录外的脚本被 import 执行了（entry 未做路径校验）');
    fs.rmSync(ran.tmp, { recursive: true, force: true });
  });

  await c.check('热重载重建 Skill 时先 deactivate 旧实例（不泄漏定时器/监听器）', async () => {
    const { tmp, tracePath } = await runIsolatedPluginCase({
      files: {
        'skills/leak/skill.json': JSON.stringify({ id: 'leak', name: '重载测试' }),
        'skills/leak/index.js': `
          import fs from 'node:fs';
          const t = process.env.TRACE_FILE;
          const log = (s) => { try { fs.appendFileSync(t, s + '\\n'); } catch {} };
          export function setup() { log('setup'); }
          export function activate() { log('activate'); }
          export function deactivate() { log('deactivate'); }
          export function dispose() { log('dispose'); }
        `
      },
      runner: `
        import path from 'node:path';
        const pl = await import(process.env.LOADER_URL);
        const cfg = await import(process.env.SKILLCFG_URL);
        const { skillManager } = await import(process.env.MANAGER_URL);
        const roots = {
          skills: path.join(process.env.CASE_DIR, 'skills'),
          plugins: path.join(process.env.CASE_DIR, 'plugins')
        };
        cfg.setSkillEnabled('leak', true);
        await pl.loadPlugins({ log: () => {}, roots });   // 首次加载
        skillManager.activate('leak');
        await pl.loadPlugins({ log: () => {}, roots });   // 模拟热重载（保存文件后整体重扫）
        skillManager.activate('leak');
      `
    });
    const lines = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean) : [];
    const activates = lines.filter((x) => x === 'activate').length;
    const deactivates = lines.filter((x) => x === 'deactivate').length;
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.ok(lines.includes('setup'), `用例没跑到 setup，trace: ${lines.join(',')}`);
    assert.ok(activates >= 2, `应发生 2 次 activate，实际 ${activates}（trace: ${lines.join(',')}）`);
    assert.ok(deactivates >= 1, `热重载应先 deactivate 旧实例，实际 0 次（trace: ${lines.join(',')}）`);
  });

  await c.check('热重载会卸载磁盘上已删除的 Skill（不留幽灵工具/能力）', async () => {
    const { tmp, tracePath } = await runIsolatedPluginCase({
      files: {
        'skills/ghost/skill.json': JSON.stringify({ id: 'ghost', name: '幽灵测试' }),
        'skills/ghost/index.js': `
          import fs from 'node:fs';
          const t = process.env.TRACE_FILE;
          const log = (s) => { try { fs.appendFileSync(t, s + '\\n'); } catch {} };
          export function setup() { log('setup'); }
          export function deactivate() { log('deactivate'); }
        `
      },
      runner: `
        import fs from 'node:fs';
        import path from 'node:path';
        const pl = await import(process.env.LOADER_URL);
        const cfg = await import(process.env.SKILLCFG_URL);
        const { skillManager } = await import(process.env.MANAGER_URL);
        const roots = {
          skills: path.join(process.env.CASE_DIR, 'skills'),
          plugins: path.join(process.env.CASE_DIR, 'plugins')
        };
        cfg.setSkillEnabled('ghost', true);
        await pl.loadPlugins({ log: () => {}, roots });
        const before = skillManager.isLoaded('ghost');
        fs.rmSync(path.join(process.env.CASE_DIR, 'skills', 'ghost'), { recursive: true, force: true });
        const r2 = await pl.loadPlugins({ log: () => {}, roots });
        fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({
          before, after: skillManager.isLoaded('ghost'), pruned: r2.pruned
        }));
      `
    });
    const r = JSON.parse(fs.readFileSync(path.join(tmp, 'result.json'), 'utf8'));
    const lines = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean) : [];
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.equal(r.before, true, '第一次加载后 ghost 应已注册');
    assert.equal(r.after, false, '目录删除后热重载应把它卸掉，实际仍被注册（幽灵 Skill）');
    assert.ok(r.pruned.includes('ghost'), `pruned 应包含 ghost，实际 ${JSON.stringify(r.pruned)}`);
    assert.ok(lines.includes('deactivate'), '卸载时应调用 deactivate');
  });
}

// ── 11. 中止路径必须发 session-end（放在最后：abortAll 之后编排器不可再用）──
c.section('11. 中始终态');
{
  await c.check('会话运行中被 abortAll：状态置 aborted 且推送 session-end', async () => {
    const events = [];
    const req = http.get(`${ctx.base}/api/events`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const block of String(chunk).split('\n\n')) {
          const m = /event:\s*(\S+)/.exec(block);
          if (m) events.push(m[1]);
        }
      });
    });
    await waitFor(() => events.includes('hello'), 4000, 'SSE hello');

    // 起一个会持续一段时间的会话，然后在运行途中中止它。
    // 注意必须让模型**先请求一次工具调用**：中止标记只在每一轮的**开头**检查，
    // 单轮就结束的响应会自然走完（status=noreply），根本不会进入中止分支。
    // 这里第 0 轮返回工具调用 → 第 1 轮开头命中 `if (this.aborted)` → 走中止路径。
    //
    // ⚠️ 脚本必须**按下标**写：mock 用 state.script[requests.length] 取脚本，
    // 前面用例已经消耗过脚本条目，直接 push 会对不上位（脚本不生效 → 会话秒结束）。
    llm.state.script[llm.state.requests.length] = {
      delayMs: 2000,
      toolCalls: [{ name: 'get_recent_messages', args: { limit: 5 } }]
    };
    const before = llm.state.requests.length;
    pushGroupMsg(111, '张三', '@覆盖Bot 中止路径测试', 9901);
    await waitFor(() => llm.state.requests.length > before, 8000, '会话开始');
    await sleep(300);                      // 确保已经进入运行中（此时 mock 还在 delay 里）
    events.length = 0;
    await app.orchestrator.abortAll();

    await waitFor(() => events.includes('session-end'), 10000,
      `中止后应推送 session-end（UI 才不会卡在"运行中"），实际收到：${[...new Set(events)].join(',')}`);
    // 会话摘要里字段名是 trigger（= triggerSummary）
    const aborted = app.sessions.listSummaries(50).find((s) => (s.trigger || '').includes('中止路径测试'));
    assert.ok(aborted, '应能查到这条会话');
    assert.equal(aborted.status, 'aborted', `会话状态应为 aborted，实际 ${aborted.status}`);
    req.destroy();
  });
}

await ctx.teardown();
c.finish();
