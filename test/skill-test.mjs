// Skill 架构自测：验证"开关不打架"的核心承诺。
//
// 覆盖（每一条都对应一个曾经容易出问题的点）：
//   1. Skill 加载后能力可被核心模块按**能力名**取到（不依赖 Skill 名字）
//   2. 关闭 Skill 后：能力不可用、它注册的工具不可用、hook 不再执行
//   3. 依赖链：requires 的能力没有提供者时，Skill 判定为不可用并给出明确原因
//   4. 工具可用性只有一个口径，且能解释"为什么不可用"
//   5. hook 抛错/超时被隔离，不影响其它 Skill 与主流程
//   6. 配置迁移：旧字段（api.thinking）迁移进 skills.thinking，且幂等
//   7. thinking Skill 真的会改写请求体，且降级建议只在字段被拒时给出
//   8. speaker Skill 的同名/改名/未知发送者边界
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 数据目录隔离：必须在 import src/config.js 之前
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-skill-'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 按 id 定位技能模块：技能按两型分居 skills/（LLM 型）与 plugins/（确定性型），
// 测试不该写死目录 —— 否则调整归类时整个套件会以"路径不存在"的形式断掉。
function skillDirOf(id) {
  for (const root of ['skills', 'plugins']) {
    const d = path.join(ROOT, root, id);
    if (fs.existsSync(path.join(d, 'index.js'))) return d;
  }
  throw new Error(`找不到技能目录：${id}（skills/ 与 plugins/ 下都没有）`);
}
const skillModuleUrl = (id) => pathToFileURL(path.join(skillDirOf(id), 'index.js')).href;

let pass = 0, fail = 0;
function ok(name, extra = '') {
  pass++;
  console.log(`  ✓ ${name}${extra ? ` —— ${extra}` : ''}`);
}

async function main() {
  const { getConfig, setRuntimeConfig, migrateLegacySkills, DEFAULT_CONFIG } = await import('../src/config.js');
  const { SkillManager } = await import('../src/skills/manager.js');
  const { normalizeManifest } = await import('../src/skills/manifest.js');
  const { getToolAvailability, registerTool, clearRegistry, listTools } = await import('../src/tool-registry.js');

  // ══ 1. manifest 规范化 ══════════════════════════════════════════════
  {
    const r = normalizeManifest({
      id: 'demo', name: '示例',
      capabilities: ['a.b', 'a.b'],
      requires: ['x.y', 'a.b'],           // a.b 是自己的能力，应被去掉
      prompt: { sections: [{ id: 's', content: '内容', priority: 500 }] }
    });
    assert.ok(r.manifest, 'manifest 应可用');
    assert.deepEqual(r.manifest.capabilities, ['a.b'], '能力应去重');
    assert.deepEqual(r.manifest.requires, ['x.y'], '自依赖应被移除');
    assert.equal(r.manifest.prompt.sections[0].priority, 99, 'Skill 片段 priority 必须被压到 99 以内（不能盖过安全规则）');

    const bad = normalizeManifest({ name: '没有 id' }, { fallbackId: 'dir' });
    assert.equal(bad.manifest.id, 'dir', '缺 id 时回退目录名');
    const illegal = normalizeManifest({ id: '有 空格' });
    assert.ok(illegal.problems.some((p) => p.includes('id 只能包含')), '非法 id 要报问题');
    ok('manifest 规范化：去重/自依赖移除/priority 上限/id 校验');
  }

  // ══ 2. 注册 → 能力可查 → 工具可用 ══════════════════════════════════
  const mgr = new SkillManager({ log: () => {} });
  const calls = [];
  mgr.register({
    manifest: normalizeManifest({
      id: 'cap-skill', name: '能力示例',
      capabilities: ['demo.cap'], enabledByDefault: true
    }).manifest,
    providers: { 'demo.cap': () => 'ok' },
    hooks: {
      'before-context': () => { calls.push('before-context'); },
      'before-tool': () => { calls.push('before-tool'); return { block: true, reason: '演示否决' }; }
    }
  });
  assert.ok(mgr.hasCapability('demo.cap'), '能力应可查');
  assert.equal(mgr.getCapabilityProviders('demo.cap').length, 1, '生效中的能力提供者应被返回');
  assert.equal(mgr.isActive('cap-skill').active, true, '默认开启的 Skill 应生效');
  ok('注册后能力可被按能力名取到');

  // hook 执行
  await mgr.runHook('before-context', {});
  assert.deepEqual(calls, ['before-context'], 'hook 应被调用');
  const toolHook = await mgr.runHook('before-tool', {});
  assert.equal(toolHook[0].value.block, true, 'hook 返回值应可被读取（用于否决工具）');
  ok('hook 执行与返回值传递');

  // ══ 3. 依赖链：缺能力 → 不可用 + 明确原因 ═════════════════════════════
  mgr.register({
    manifest: normalizeManifest({
      id: 'needs-cap', name: '依赖示例', requires: ['missing.cap']
    }).manifest
  });
  const dep = mgr.isActive('needs-cap');
  assert.equal(dep.active, false, '缺依赖的 Skill 不应生效');
  assert.equal(dep.code, 'capability-missing', '原因码应是 capability-missing');
  assert.ok(dep.reason.includes('missing.cap'), `原因里应点名缺哪个能力：${dep.reason}`);
  ok('依赖缺失时给出可解释的原因', dep.reason);

  // 依赖满足后应变为生效
  mgr.register({
    manifest: normalizeManifest({ id: 'provides-cap', name: '提供者', capabilities: ['missing.cap'] }).manifest,
    providers: { 'missing.cap': () => 1 }
  });
  assert.equal(mgr.isActive('needs-cap').active, true, '依赖被满足后应生效');
  ok('依赖被满足后自动生效（能力优先于名字）');

  // ══ 4. 关闭 Skill → 能力与工具同时失效 ══════════════════════════════
  clearRegistry();
  // 工具 id 必须符合 OpenAI 函数名规范（registerTool 入口已强制），测试用 __ 分隔
  registerTool({
    id: 'cap-skill__do', name: '示例工具', skillId: 'cap-skill',
    execute: async () => ({ content: 'x' })
  });
  // 记录写入：让 isEnabled 读到 false
  const baseCfg = structuredClone(DEFAULT_CONFIG);
  baseCfg.skills = { 'cap-skill': { enabled: false } };
  setRuntimeConfig(baseCfg);

  const toolCtx = { skills: mgr, toolsCfg: baseCfg.tools, visionEnabled: true, searchEnabled: true };
  const av = getToolAvailability('cap-skill__do', toolCtx);
  assert.equal(av.enabled, false, 'Skill 关闭时它的工具必须不可用');
  assert.equal(av.code, 'skill-disabled', '原因码应是 skill-disabled');
  assert.ok(av.reason.includes('能力示例'), `原因应带 Skill 名：${av.reason}`);
  assert.equal(mgr.getCapabilityProviders('demo.cap').length, 0, '关闭后不应再返回能力提供者');
  ok('关闭 Skill → 能力与工具同时失效（单一开关）', av.reason);

  // 重新打开：两者一起恢复（验证不存在第二处影子开关）
  baseCfg.skills = { 'cap-skill': { enabled: true } };
  setRuntimeConfig(baseCfg);
  assert.equal(getToolAvailability('cap-skill__do', toolCtx).enabled, true, '重新开启后工具应恢复');
  assert.equal(mgr.getCapabilityProviders('demo.cap').length, 1, '重新开启后能力应恢复');
  ok('重新开启 → 能力与工具一起恢复（无影子开关）');

  // ══ 5. 工具可用性的分层原因 ═════════════════════════════════════════
  {
    const disabledAll = { ...baseCfg, tools: { ...baseCfg.tools, enabled: false } };
    const a1 = getToolAvailability('cap-skill__do', { skills: mgr, toolsCfg: disabledAll.tools });
    assert.equal(a1.code, 'tools-disabled', '全局开关优先于 Skill 开关判断');

    const catOff = { ...baseCfg.tools, categories: { ...baseCfg.tools.categories, system: false } };
    const a2 = getToolAvailability('cap-skill__do', { skills: mgr, toolsCfg: catOff });
    assert.equal(a2.code, 'category-disabled', '分类关闭应被识别');

    const overrideOff = { ...baseCfg.tools, overrides: { 'cap-skill__do': false } };
    const a3 = getToolAvailability('cap-skill__do', { skills: mgr, toolsCfg: overrideOff });
    assert.equal(a3.code, 'tool-disabled', '单工具关闭应被识别');

    // 视觉依赖
    registerTool({ id: 'cap-skill__see', name: '看图', skillId: 'cap-skill', requiresVision: true, execute: async () => ({}) });
    const a4 = getToolAvailability('cap-skill__see', { skills: mgr, toolsCfg: baseCfg.tools, visionEnabled: false });
    assert.equal(a4.code, 'no-vision', '视觉依赖不满足应被识别');
    ok('工具可用性分层判定：全局/分类/单工具/运行期依赖各有明确原因码');
  }

  // ══ 6. hook 错误隔离与超时 ═══════════════════════════════════════════
  {
    mgr.register({
      manifest: normalizeManifest({ id: 'bad-skill', name: '坏 Skill' }).manifest,
      hooks: {
        'before-context': () => { throw new Error('我坏了'); },
        'after-response': () => new Promise(() => {})   // 永不 resolve → 触发超时
      }
    });
    mgr.register({
      manifest: normalizeManifest({ id: 'good-skill', name: '好 Skill' }).manifest,
      hooks: { 'before-context': () => { calls.push('good'); } }
    });
    await mgr.runHook('before-context', {});
    assert.ok(calls.includes('good'), '一个 Skill 抛错不能影响其它 Skill');
    assert.ok(mgr.status('bad-skill').lastError.includes('我坏了'), '错误应被记录到 Skill 状态里，便于 UI 排障');

    mgr.hookTimeoutMs = 60;
    const t0 = Date.now();
    await mgr.runHook('after-response', {});
    const dt = Date.now() - t0;
    assert.ok(dt < 2000, `超时 hook 应被及时跳过（实际 ${dt}ms）`);
    mgr.hookTimeoutMs = 5000;
    ok('hook 错误隔离 + 超时跳过', `耗时 ${dt}ms`);
  }

  // ══ 7. 配置迁移（幂等） ═════════════════════════════════════════════
  {
    // 思考已收编进核心（src/thinking.js）：api.thinking 旧值现在映射成
    // api.thinkingMode（false→off / true→on），不再迁往任何 Skill 命名空间。
    const legacy = { api: { model: 'x', thinking: false }, tools: { enabled: true, knowledgeEnabled: true } };
    const m1 = migrateLegacySkills(legacy);
    assert.equal(m1.api.thinkingMode, 'off', 'api.thinking=false 应迁移为 thinkingMode=off');
    assert.equal(m1.api.thinking, undefined, '旧字段应被清掉');
    assert.equal(m1.skills['knowledge-base'].enabled, true, 'tools.knowledgeEnabled 应迁移');
    assert.equal(m1.tools.knowledgeEnabled, undefined, '旧字段应被清掉');
    // 幂等 + 不覆盖新配置（已设 thinkingMode 的配置不被旧值冲掉）
    const again = migrateLegacySkills({ ...m1, api: { ...m1.api, thinking: true } });
    assert.equal(again.api.thinkingMode, 'off', '已有新配置时旧字段不应覆盖它');
    assert.equal(again.api.thinking, undefined, '幂等：旧字段再次被清掉');
    // true → on 的映射
    const m2 = migrateLegacySkills({ api: { thinking: true } });
    assert.equal(m2.api.thinkingMode, 'on', 'api.thinking=true 应迁移为 thinkingMode=on');
    ok('旧配置迁移：收拢进 skills.*、清旧字段、不覆盖新值');
  }

  // ══ 7b. 迁移目标必须是真实存在的技能 ═════════════════════════════════
  {
    // 这条检查来自一个真实 bug：迁移表里的技能名写错**不会报任何错误**，
    // 只是旧配置被迁进没人读的命名空间 —— 用户看着开关迁过来了，实际还是关的。
    // 现在迁移目标分两类：
    //   · PLANNED：未移植/已收编进核心的功能，显式登记（收编后目录不在但仍要留名）
    //   · 其余：必须真实存在于 skills/ 或 plugins/ 下（用户后装扩展的落点）
    const cfgSrc = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
    const targets = [...cfgSrc.matchAll(/\{\s*from:\s*\[[^\]]+\],\s*skill:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(targets.length > 0, '应能从迁移表解析出规则');
    // 两个根都要扫：技能按两型分居 skills/ 与 plugins/，
    // 只查 skills/ 会把已迁到 plugins/ 的确定性型误判成"不存在"。
    const dirs = new Set();
    for (const root of ['skills', 'plugins']) {
      const abs = path.join(ROOT, root);
      if (!fs.existsSync(abs)) continue;
      for (const d of fs.readdirSync(abs, { withFileTypes: true })) if (d.isDirectory()) dirs.add(d.name);
    }
    const PLANNED = new Set([
      'knowledge-base',      // 未移植，显式登记为预留目标
      'video-frames',        // 视频抽帧：砍掉的内置插件，旧配置迁移跳过即可
      'sticker-annotate'     // 表情包标注：同上
    ]);
    const missing = targets.filter((t) => !dirs.has(t) && !PLANNED.has(t));
    assert.deepEqual(missing, [], `迁移目标技能必须真实存在或显式登记为预留：${missing.join('、')}`);
    ok(`旧配置迁移的目标技能都真实存在或已登记（${targets.length} 条规则）`);
  }

  // ══ 8. 内置思考模块（src/thinking.js，原 thinking-adapters 插件收编）══
  {
    const d = await import('../src/thinking.js');

    // 方言识别
    assert.equal(d.detectDialect({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' }).dialect, 'deepseek');
    assert.equal(d.detectDialect({ baseUrl: 'https://openrouter.ai/api/v1', model: 'anything' }).dialect, 'openrouter');
    assert.equal(d.detectDialect({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' }).dialect, 'ollama');
    assert.equal(d.detectDialect({ baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2' }).dialect, 'generic');
    // 域名优先两轮匹配：openrouter.ai 上的 claude 模型必须走 openrouter 方言
    assert.equal(d.detectDialect({ baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet' }).dialect, 'openrouter',
      'OpenRouter 上的 claude 不能被判成 anthropic 直连（发错参数会 400）');
    ok('思考方言识别：deepseek / openrouter / 本地 / 未知 / 域名优先');

    // 六档参数构造（off / low / medium / high / xhigh / max）
    const on = d.buildThinkingParams({ effort: 'high', dialect: 'deepseek' });
    assert.deepEqual(on.params, { thinking: { type: 'enabled' } }, 'DeepSeek 开启应发 thinking.type');
    assert.equal(on.omitTemperature, true, 'DeepSeek 思考与 temperature 互斥，应声明省略');
    const off = d.buildThinkingParams({ effort: 'off', dialect: 'qwen' });
    assert.deepEqual(off.params, { enable_thinking: false }, 'Qwen 关闭应发 enable_thinking=false');
    const xhigh = d.buildThinkingParams({ effort: 'xhigh', dialect: 'openai-o' });
    assert.deepEqual(xhigh.params, { reasoning_effort: 'high' }, 'OpenAI 只认到 high，xhigh 应就近映射');
    const maxEff = d.buildThinkingParams({ effort: 'max', dialect: 'openai-o' });
    assert.deepEqual(maxEff.params, { reasoning_effort: 'high' }, 'max 同样映射到 high');
    const lowEff = d.buildThinkingParams({ effort: 'low', dialect: 'openai-o' });
    assert.deepEqual(lowEff.params, { reasoning_effort: 'low' }, 'low 原样透传');
    const generic = d.buildThinkingParams({ effort: 'high', dialect: 'generic' });
    assert.equal(generic.applied, false, '未知渠道不应发任何思考参数（否则会 400）');
    assert.deepEqual(generic.params, {}, '未知渠道参数必须为空');
    // 无档位（跟随默认）时不发参数 —— "不改用户网关行为"的默认姿态
    const noEffort = d.buildThinkingParams({ effort: '', dialect: 'deepseek' });
    assert.equal(noEffort.applied, false, '没选档位时不应主动加参数');
    ok('思考参数构造：六档按方言翻译，未知渠道/未选档位保持空');

    // resolveThinkingRequest：旧三态（thinkingMode）兼容 + 按次覆盖
    const rOn = d.resolveThinkingRequest({ thinkingMode: 'on' });
    assert.equal(rOn.on, true, '旧 mode=on 应视为开启');
    const rOff = d.resolveThinkingRequest({ thinkingMode: 'off' });
    assert.equal(rOff.effort, 'off', '旧 mode=off 应映射为 off 档');
    const rAuto = d.resolveThinkingRequest({ thinkingMode: 'auto' });
    assert.equal(rAuto.on, false, 'auto = 跟随默认，不主动开');
    const rPerCall = d.resolveThinkingRequest({ thinkingEffort: 'high' }, { thinkingMode: 'off' });
    assert.equal(rPerCall.effort, 'off', '按次覆盖（裁判类调用）优先于用户配置');
    const rXhigh = d.resolveThinkingRequest({ thinkingEffort: 'xhigh', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' });
    assert.equal(rXhigh.dialect, 'openai-o', '按 baseUrl+model 识别方言');
    assert.equal(rXhigh.on, true, 'xhigh 属于开启态');
    ok('思考配置求解：六档 + 旧三态兼容 + 按次覆盖');

    // 降级建议：只在真被拒时给
    assert.equal(d.looksLikeThinkingRejection('field ReasoningEffort invalid'), true, '驼峰写法也要认');
    assert.equal(d.looksLikeThinkingRejection('unknown parameter enable_thinking'), true, '未知参数要认');
    assert.equal(d.looksLikeThinkingRejection('Invalid API key'), false, 'Key 错误不应被当成参数拒绝');
    assert.equal(d.looksLikeThinkingRejection('invalid model name: deepseek-thinking'), false, '模型名里的 thinking 不是参数名');
    const stripped = d.stripThinkingParams({ model: 'm', thinking: { type: 'enabled' }, temperature: 0.8 });
    assert.deepEqual(stripped, { model: 'm', temperature: 0.8 }, '降级应摘掉思考字段但保留其它字段');
    ok('降级判据：只认"字段被拒"，Key/模型错误不触发重试');

    // 响应的思考内容 / token 提取
    assert.equal(d.extractReasoning({ reasoning_content: '想一下' }), '想一下', 'DeepSeek 风格');
    assert.equal(d.extractReasoning({ reasoning_details: [{ text: 'A' }, 'B'] }), 'A\nB', 'OpenRouter 风格');
    assert.equal(d.extractReasoning({ content: '普通回答' }), '', '没有思考字段时返回空');
    assert.equal(d.extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 42 } }), 42, 'OpenAI 风格 token');
    assert.equal(d.extractReasoningTokens({ reasoning_tokens: 7 }), 7, '平铺字段也能认');
    assert.equal(d.extractReasoningTokens(null), 0, '没有 usage 时返回 0 而不是崩');
    ok('思考内容/思考 token 提取：兼容多种返回结构');
  }

  // ══ 10. 真实加载：插件/技能目录扫描（目录可为空，架构自身仍要健康）════
  {
    const { loadPlugins } = await import('../src/plugin-loader.js');
    const res = await loadPlugins({ log: () => {} });
    // 内置功能已收编进核心（思考模式等），skills/ 与 plugins/ 是用户后装扩展的
    // 落点 —— 空目录是合法状态。这里只锁架构不变量：加载不报错、失败清单为空。
    assert.equal(res.failed.length, 0, `不应有加载失败：${res.failed.map((f) => `${f.id}:${f.error}`).join('; ')}`);
    assert.ok(Array.isArray(res.loaded), '加载结果应是数组');
    ok('真实加载：扫描健康（空目录 = 无扩展，属合法状态）', `${res.loaded.length} 个扩展`);
  }

  // ══ 11. 端到端：内置思考模块真的改变了发出去的 HTTP 请求体 ══════════
  // 这是整套架构最关键的验证：config → 思考模块生效 → llm.js 应用 →
  // 实际请求体变化。只有真的拦一次 fetch 才能证明链路是通的。
  {
    const { chatCompletion } = await import('../src/llm.js');

    // 选 high 档（开启思考）
    const cfgOn = structuredClone(getConfig());
    cfgOn.api = { ...cfgOn.api, thinkingEffort: 'high', thinkingMode: 'on' };
    setRuntimeConfig(cfgOn);

    // 拦截 fetch，记录实际发出去的请求体
    const realFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hi', reasoning_content: '我在想' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } },
        model: 'deepseek-reasoner'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const r = await chatCompletion({
        messages: [{ role: 'user', content: 'hi' }],
        overrides: {
          baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-reasoner',
          temperature: 0.8, timeoutMs: 5000, thinkingEffort: 'high'
        }
      });

      assert.ok(captured, '应该真的发出了请求');
      assert.deepEqual(captured.body.thinking, { type: 'enabled' },
        `请求体应带上 thinking 参数（实际：${JSON.stringify(captured.body.thinking)}）`);
      assert.equal(captured.body.temperature, undefined,
        'DeepSeek 思考模式与 temperature 互斥，应被省略（否则网关 400）');
      assert.equal(captured.body.model, 'deepseek-reasoner', '其它字段不应被改动');
      assert.equal(r.reasoning, '我在想', '响应里的思考内容应被提取出来');
      assert.deepEqual(r.extraUsage, { reasoningTokens: 3 }, '思考 token 应进入附加统计（不混进成本口径）');
      ok('端到端：请求体被内置思考模块改写 + 响应思考被提取 + 互斥字段被省略');
    } finally {
      globalThis.fetch = realFetch;
    }

    // off 档后，同样的调用应明确关闭思考且保留 temperature
    const cfgOff = structuredClone(getConfig());
    cfgOff.api = { ...cfgOff.api, thinkingEffort: 'off' };
    setRuntimeConfig(cfgOff);

    let captured2 = null;
    globalThis.fetch = async (url, init) => {
      captured2 = { body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      await chatCompletion({
        messages: [{ role: 'user', content: 'hi' }],
        overrides: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-reasoner', temperature: 0.8, timeoutMs: 5000, thinkingEffort: 'off' }
      });
      assert.ok(captured2, '应该发出了请求');
      assert.deepEqual(captured2.body.thinking, { type: 'disabled' }, 'off 档应明确关闭思考');
      assert.equal(captured2.body.temperature, 0.8, 'off 档下 temperature 应保留（不互斥）');
      ok('端到端：off 档 → 明确关闭思考，temperature 保留');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ══ 12. 端到端：网关拒绝思考参数时，只多打一次且降级后成功 ═══════════
  // 这是风险最高的一条路径：如果实现成"自己重试"，就会绕开超时/abort/计费，
  // 变成悄悄多打 API。这里断言：请求次数恰好 2（原始 + 降级），第二次不带思考字段。
  {
    const { chatCompletion } = await import('../src/llm.js');
    const cfgOn = structuredClone(getConfig());
    cfgOn.api = { ...cfgOn.api, thinkingEffort: 'high', thinkingMode: 'on' };
    setRuntimeConfig(cfgOn);

    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      // 第一次：网关不认识 thinking 字段 → 400
      if (seen.length === 1) {
        return new Response('{"error":{"message":"unknown parameter: thinking"}}',
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      // 第二次（降级后）：应当成功
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const r = await chatCompletion({
        messages: [{ role: 'user', content: 'hi' }],
        overrides: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-reasoner', temperature: 0.8, timeoutMs: 5000, thinkingEffort: 'high' }
      });
      assert.equal(seen.length, 2, `应恰好请求 2 次（原始 + 降级），实际 ${seen.length} 次`);
      assert.ok(seen[0].thinking, '第一次应带思考参数（说明是参数被拒，不是别的问题）');
      assert.equal(seen[1].thinking, undefined, '降级后的请求不应再带思考字段');
      assert.equal(seen[1].temperature, 0.8, '降级不应顺手删掉 temperature');
      assert.equal(r.degraded, true, '结果应标记本次走了降级');
      assert.ok(String(r.degradeNote || '').includes('thinking') || String(r.degradeNote || '').includes('思考'),
        `降级原因应说清是思考参数：${r.degradeNote}`);
      ok('端到端降级：参数被拒 → 恰好重试一次 → 摘掉字段后成功', `请求 ${seen.length} 次`);
    } finally {
      globalThis.fetch = realFetch;
    }

    // 反例：不是参数问题（Key 错）时不应触发第二次请求
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('{"error":{"message":"Invalid API key"}}',
        { status: 400, headers: { 'content-type': 'application/json' } });
    };
    try {
      await assert.rejects(
        () => chatCompletion({
          messages: [{ role: 'user', content: 'hi' }],
          overrides: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'bad', model: 'deepseek-reasoner', timeoutMs: 5000 }
        }),
        /Invalid API key/,
        'Key 错误应原样抛出'
      );
      assert.equal(calls, 1, `Key 错误不该触发降级重试（实际 ${calls} 次请求）`);
      ok('降级反例：与参数无关的 400 不触发重试（不浪费配额）');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ══ 13. 视频两条路线：互斥、可解释、不把 base64 当文本 ═══════════════
  {
    const { resolveVideoRoute, VIDEO_MODES } = await import('../src/video-reader.js');

    // auto：配了视频专用模型 → 原生；否则抽帧；都不行只给元信息
    assert.equal(resolveVideoRoute({ mode: 'auto', videoModel: 'gemini-2.5-pro', framesOk: true, hasUrl: true }).route, 'native',
      'auto + 配了视频模型 → 原生读视频');
    assert.equal(resolveVideoRoute({ mode: 'auto', videoModel: '', framesOk: true, hasUrl: true }).route, 'frames',
      'auto + 没配视频模型 → 抽帧');
    assert.equal(resolveVideoRoute({ mode: 'auto', videoModel: '', framesOk: false, hasUrl: true }).route, 'meta',
      'auto + 抽帧不可用 → 只给元信息');

    // 显式指定：模式说了算，不被自动判断覆盖
    assert.equal(resolveVideoRoute({ mode: 'frames', videoModel: 'gemini-2.5-pro', framesOk: true, hasUrl: true }).route, 'frames',
      '明确要求抽帧时，即使配了全模态模型也不走原生');
    assert.equal(resolveVideoRoute({ mode: 'native', videoModel: '', framesOk: true, hasUrl: true }).route, 'native',
      '明确要求原生时，即使没配专用模型也走原生（用户自己承担风险）');
    assert.equal(resolveVideoRoute({ mode: 'native', videoModel: 'x', framesOk: true, hasUrl: false }).route, 'meta',
      '原生模式但视频没有可用地址 → 退回元信息（不能发个空 video 部分）');
    assert.equal(resolveVideoRoute({ mode: 'off', videoModel: 'x', framesOk: true, hasUrl: true }).route, 'meta',
      'off 模式永远只给元信息');
    assert.equal(resolveVideoRoute({ mode: 'frames', framesOk: false }).route, 'meta',
      '要求抽帧但 Skill 关了 / 没装 ffmpeg → 退回元信息而不是报错');

    // 配置写错时回退 auto，不能因为一个错字把视频功能整个关掉
    const bogus = resolveVideoRoute({ mode: 'FRAMEZ', videoModel: '', framesOk: true, hasUrl: true });
    assert.equal(bogus.route, 'frames', '非法 videoMode 应回退 auto（而不是当成 off）');
    assert.deepEqual(VIDEO_MODES, ['auto', 'native', 'frames', 'off'], '模式取值固定四种');

    // 每条路都要有可读原因（UI 要显示"为什么走了这条"）
    for (const cfg of [
      { mode: 'auto', videoModel: 'x', framesOk: true, hasUrl: true },
      { mode: 'auto', videoModel: '', framesOk: true, hasUrl: true },
      { mode: 'frames', framesOk: false },
      { mode: 'off' }
    ]) {
      const r = resolveVideoRoute(cfg);
      assert.ok(r.reason && r.reason.length > 0, `路线要给出原因：${JSON.stringify(cfg)}`);
    }
    ok('视频路线决策：两路互斥、显式优先、不可用时降级并给出原因');
  }

  // ══ 14. 图片/视频专用模型真的会切（以前是死配置） ═══════════════════
  {
    const { chatCompletion } = await import('../src/llm.js');
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const c = structuredClone(getConfig());
      c.api.baseUrl = 'https://api.deepseek.com/v1';
      c.api.apiKey = 'k';
      c.api.model = 'cheap-text-model';
      c.api.visionModel = 'vision-model-x';
      c.api.videoModel = 'omni-video-model-y';
      c.skills = {};   // 本项只验证模型切换，不掺思考参数
      setRuntimeConfig(c);

      // 纯文本 → 主模型
      await chatCompletion({ messages: [{ role: 'user', content: '你好' }] });
      assert.equal(calls.at(-1).model, 'cheap-text-model', '纯文本请求应使用主模型');

      // 带图片 → visionModel
      await chatCompletion({
        messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }]
      });
      assert.equal(calls.at(-1).model, 'vision-model-x', '带图片的请求应切到图片专用模型');

      // 带视频 → videoModel（视频优先于图片）
      await chatCompletion({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看视频' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
            { type: 'video_url', video_url: { url: 'https://example.com/v.mp4' } }
          ]
        }]
      });
      assert.equal(calls.at(-1).model, 'omni-video-model-y', '带视频的请求应切到视频专用模型（优先级高于图片）');

      // 显式 overrides（记忆整理/备选降级）不能被专用模型覆盖
      await chatCompletion({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }],
        overrides: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'explicit-model', timeoutMs: 5000 }
      });
      assert.equal(calls.at(-1).model, 'explicit-model', '显式指定模型时不应被专用模型覆盖');

      // 没配专用模型时保持主模型（默认行为不变）
      const c2 = structuredClone(c);
      c2.api.visionModel = '';
      c2.api.videoModel = '';
      setRuntimeConfig(c2);
      await chatCompletion({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }]
      });
      assert.equal(calls.at(-1).model, 'cheap-text-model', '没配专用模型时应继续用主模型');
      ok('专用模型切换：图片→visionModel、视频→videoModel、显式覆盖优先、未配置时不变');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ══ 15. 视频工具的返回值里绝不能把 base64 当文本 ═════════════════════
  {
    const { buildToolDefs, executeTool } = await import('../src/tools.js');
    const { VideoReader } = await import('../src/video-reader.js');
    buildToolDefs();   // 确保工具已注册

    // 造一个假 videoReader：直接返回已抽好的帧，避免依赖 ffmpeg
    const fakeReader = {
      async probe() {
        return {
          durationSec: 12.5, width: 1280, height: 720, sizeBytes: 3 * 1024 * 1024,
          route: 'frames', routeReason: '测试',
          frames: ['data:image/jpeg;base64,FRAME1', 'data:image/jpeg;base64,FRAME2'],
          frameTimes: [0.6, 11.9],
          note: '测试用'
        };
      }
    };
    const ctx = {
      chatKey: 'group:1', kind: 'group', chatId: '1',
      store: { findByMid: () => ({ mid: '123', media: [{ kind: 'video', url: 'https://example.com/v.mp4' }] }) },
      videoReader: fakeReader,
      session: { id: 's1' }, emit: () => {}
    };
    const defs = buildToolDefs();
    const r = await executeTool(defs, ctx, 'read_video', JSON.stringify({ messageId: '123' }));

    assert.ok(Array.isArray(r.content), '抽帧路线应返回 parts 数组（而不是一串 JSON 文本）');
    const textParts = r.content.filter((p) => p.type === 'text');
    const imgParts = r.content.filter((p) => p.type === 'image_url');
    assert.equal(imgParts.length, 2, '两帧应作为两个 image_url 部分返回');
    // 关键回归：文本部分不能含 base64 —— 那等于把图片当文本喂模型
    const text = textParts.map((p) => p.text).join('\n');
    assert.ok(!/base64/i.test(text), '文本部分绝不能包含 base64（模型看不到图却要付 token 钱）');
    assert.ok(text.includes('抽帧') || text.includes('截图'), '文本部分应说明这是抽帧截图');
    assert.ok(text.includes('12.5'), '文本部分应带元信息（时长）');

    // 原生路线：应返回 video_url 部分
    const omniCtx = {
      ...ctx,
      videoReader: {
        async probe() {
          return { durationSec: 5, route: 'native', routeReason: '测试', nativeUrl: 'https://example.com/v.mp4', note: 'n' };
        }
      }
    };
    const r2 = await executeTool(defs, omniCtx, 'read_video', JSON.stringify({ messageId: '123' }));
    assert.ok(Array.isArray(r2.content), '原生路线也应返回 parts');
    assert.equal(r2.content.filter((p) => p.type === 'video_url').length, 1, '原生路线应带一个 video_url 部分');

    // 只给元信息：不应有媒体部分
    const metaCtx = {
      ...ctx,
      videoReader: { async probe() { return { durationSec: 5, route: 'meta', routeReason: 'off', note: 'n' }; } }
    };
    const r3 = await executeTool(defs, metaCtx, 'read_video', JSON.stringify({ messageId: '123' }));
    assert.equal(typeof r3.content, 'string', '只给元信息时应是普通文本');
    assert.ok(!/base64/i.test(r3.content), '元信息文本同样不能夹 base64');
    ok('视频工具返回值：抽帧→image parts、原生→video parts、只读→纯文本，全程不夹 base64');
  }


  console.log(`\n全部 ${pass} 项 Skill 架构检查通过 ✅`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error('\n❌ Skill 架构自测失败：', error?.message ?? error);
  if (error?.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
