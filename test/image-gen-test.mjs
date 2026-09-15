// 本地图片生成工具的自测：用 mock 绘图服务验证「工具开关 / 生成 / 轮询 / 取图 / 发送 / 冷却」。
// 不碰真实 QQ、真实模型。
//
// 运行：node test/image-gen-test.mjs
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR 在 config.js 导入时就会求值，所以必须先设好环境变量再动态 import。
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-imgtest-'));

const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');
const { buildToolDefs } = await import('../src/tools.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 透明 PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** mock 绘图服务：只实现契约里的三个接口 */
function createMockDrawingService() {
  const state = { jobs: new Map(), nextId: 0, polls: 0, generates: 0, failNext: false, slowNext: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/api/v1/generate') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      state.generates += 1;
      const jobId = `job${++state.nextId}`;
      state.jobs.set(jobId, {
        prompt: body.prompt, size: body.size, width: body.width, height: body.height,
        steps: body.steps, ratio: body.ratio,
        session_id: body.session_id, user_id: body.user_id, polls: 0
      });
      return json(202, { job_id: jobId, position: 0, ready_eta: 0 });
    }
    const jobMatch = url.pathname.match(/^\/api\/v1\/job\/([A-Za-z0-9_-]+)$/);
    if (jobMatch) {
      const job = state.jobs.get(jobMatch[1]);
      if (!job) return json(404, { error: 'not_found' });
      job.polls += 1;
      state.polls += 1;
      if (state.failNext) return json(200, { job_id: jobMatch[1], status: 'failed', error: '显存不足' });
      if (state.slowNext && job.polls < 3) return json(200, { job_id: jobMatch[1], status: 'running', progress: 0.3 });
      return json(200, {
        job_id: jobMatch[1], status: 'done', progress: 1, elapsed: 4.5, seed: 20260915,
        image_url: `/api/v1/image/${jobMatch[1]}.png`
      });
    }
    const imgMatch = url.pathname.match(/^\/api\/v1\/image\/([A-Za-z0-9_-]+)\.png$/);
    if (imgMatch) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TINY_PNG.length });
      return res.end(TINY_PNG);
    }
    return json(404, { error: 'no_such_route' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

/**
 * 造一个执行上下文。
 * @param {string|null} requesterId 触发消息的发送者 QQ 号；null = 主动开话题（没有触发消息）
 * @param {string} chatKey 会话键
 */
function makeCtx(requesterId = null, chatKey = 'group:123') {
  const sent = [];
  return {
    sent,
    chatKey,
    session: requesterId
      ? { id: 'sess-test', trigger: [{ id: 1, senderId: requesterId, senderName: '群友', text: '帮我画一张' }] }
      : { id: 'sess-test' },
    store: { appendSelf() {}, activeMembers: () => [], recent: () => [] },
    emit() {},
    sender: {
      async sendTextBatch(chatKey, messages) {
        sent.push({ kind: 'text', messages });
        return { sent: messages.map((t) => ({ text: t, messageId: 1 })), failed: [] };
      },
      async sendImage(chatKey, source, options) {
        sent.push({ kind: 'image', source, options });
        return { message_id: 2 };
      }
    }
  };
}

const mock = await createMockDrawingService();
const baseCfg = () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.imageGen = {
    enabled: true,
    serviceUrl: `http://127.0.0.1:${mock.port}`,
    timeoutMs: 20000,
    defaultSize: 512,
    defaultSteps: 20,
    cooldownMs: 60000,
    maxPromptChars: 600
  };
  return cfg;
};
const findTool = (defs) => defs.find((d) => d.name === 'generate_image');

// ── 1. 未启用时不暴露给模型 ──
{
  const cfg = baseCfg();
  cfg.imageGen.enabled = false;
  setRuntimeConfig(cfg);
  assert.ok(!findTool(buildToolDefs()), 'imageGen.enabled=false 时不应暴露 generate_image');
}

// ── 2. 启用后出现，且参数结构正确 ──
setRuntimeConfig(baseCfg());
const defs = buildToolDefs();
const tool = findTool(defs);
assert.ok(tool, 'imageGen.enabled=true 时应暴露 generate_image');
assert.strictEqual(tool.parameters.required[0], 'prompt', 'prompt 必填');
assert.ok(tool.description.includes('danbooru'), '工具描述必须要求模型写英文 danbooru 标签');
assert.ok(tool.description.includes('不要直接传中文'), '工具描述必须明确禁止直接传中文');

// ── 3. 参数校验 ──
{
  const ctx = makeCtx();
  const r = await tool.execute(ctx, { prompt: '   ' });
  assert.ok(r.isError && r.content.includes('不能为空'), '空 prompt 应报错');
  const r2 = await tool.execute(makeCtx(), { prompt: 'x'.repeat(700) });
  assert.ok(r2.isError && r2.content.includes('过长'), '超长 prompt 应报错');
}

// ── 4. 正常生成：请求参数、取图、发送 ──
{
  const ctx = makeCtx();
  const t0 = Date.now();
  const r = await tool.execute(ctx, { prompt: '1girl, cherry blossoms', size: 768, steps: 24, caption: '给你画了' });
  const cost = Date.now() - t0;
  assert.ok(!r.isError, `生成不应失败：${r.content}`);
  const payload = JSON.parse(r.content);
  assert.strictEqual(payload.sent, true, '结果应标记已发送');
  assert.strictEqual(payload.elapsedSeconds, 4.5, '应回传耗时');

  const req = [...mock.jobs.values()][0];
  assert.strictEqual(req.prompt, '1girl, cherry blossoms', 'prompt 应原样传给绘图服务');
  assert.strictEqual(req.size, 768, 'size 应透传');
  assert.strictEqual(req.steps, 24, 'steps 应透传');

  assert.strictEqual(ctx.sent.length, 2, '应先发文字再发图');
  assert.strictEqual(ctx.sent[0].kind, 'text');
  assert.strictEqual(ctx.sent[0].messages[0], '给你画了', 'caption 应作为文字先发');
  assert.strictEqual(ctx.sent[1].kind, 'image');
  assert.ok(ctx.sent[1].source.startsWith('data:image/png;base64,'), '应以 data URL 发送图片');
  assert.ok(ctx.sent[1].source.length > 50, 'data URL 应含真实图片字节');
  assert.ok(ctx.sent[1].options.label.includes('1girl'), '留档文字应带上 prompt 便于下一轮看到');
  assert.ok(cost < 10000, `轮询不应拖太久（实际 ${cost}ms）`);
}

// ── 5. 冷却：同一会话第二次应被挡 ──
{
  const ctx = makeCtx();
  const r = await tool.execute(ctx, { prompt: '1girl, second' });
  assert.ok(r.isError && r.content.includes('刚生成过'), '冷却期内应拒绝');
  assert.strictEqual(ctx.sent.length, 0, '被拒绝时不应发出任何消息');
}

// ── 6. 换一个会话不受冷却影响 ──
{
  const ctx = makeCtx();
  ctx.chatKey = 'group:456';
  const r = await tool.execute(ctx, { prompt: '1girl, other chat' });
  assert.ok(!r.isError, `另一个会话应当能生成：${r.content}`);
}

// ── 7. 绘图服务返回失败 → 工具报错且不发图 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  setRuntimeConfig(cfg);
  mock.failNext = true;
  const ctx = makeCtx();
  ctx.chatKey = 'group:789';
  const r = await tool.execute(ctx, { prompt: '1girl, will fail' });
  assert.ok(r.isError && r.content.includes('显存不足'), `应把服务端错误带回来：${r.content}`);
  assert.strictEqual(ctx.sent.length, 0, '失败时不应发图');
  mock.failNext = false;
}

// ── 8. 服务连不上 → 明确报错，不是抛异常 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  cfg.imageGen.serviceUrl = 'http://127.0.0.1:1';   // 必定连不上
  setRuntimeConfig(cfg);
  const ctx = makeCtx();
  ctx.chatKey = 'group:999';
  const r = await tool.execute(ctx, { prompt: '1girl, no service' });
  assert.ok(r.isError && r.content.includes('连接绘图服务失败'), `应给出可读的失败原因：${r.content}`);
}

// ── 9. ratio 预设与来源字段透传 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  setRuntimeConfig(cfg);
  const ctx = makeCtx('2968808382', 'group:ratio1');
  const r = await tool.execute(ctx, { prompt: '1girl, vertical', ratio: '3:4' });
  assert.ok(!r.isError, `ratio 生成不应失败：${r.content}`);
  const req = [...mock.jobs.values()].at(-1);
  assert.strictEqual(req.ratio, '3:4', 'ratio 应透传给绘图服务');
  assert.strictEqual(req.size, undefined, '给了 ratio 就不该再传 size');
  assert.strictEqual(req.session_id, 'group:ratio1', 'session_id 应是 chatKey');
  assert.strictEqual(req.user_id, '2968808382', 'user_id 应是触发消息的发送者 QQ 号');

  const tool9 = findTool(buildToolDefs());
  const ratios = tool9.parameters.properties.ratio.enum;
  assert.ok(ratios.includes('3:4') && ratios.includes('9:16'), 'ratio 参数应给出预设枚举');
  assert.ok(tool9.description.includes('ratio'), '工具描述应告诉模型用 ratio 而不是自己算像素');
}

// ── 10. 冷却按「人」算：同一个群里换个人不该被前面那个人挡住 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 60000;
  setRuntimeConfig(cfg);
  const a = makeCtx('111', 'group:shared');
  const ra = await tool.execute(a, { prompt: '1girl, person A' });
  assert.ok(!ra.isError, `A 首次应能生成：${ra.content}`);

  const b = makeCtx('222', 'group:shared');
  const rb = await tool.execute(b, { prompt: '1girl, person B' });
  assert.ok(!rb.isError, `B 在同一个群里不应被 A 的冷却挡住：${rb.content}`);

  const a2 = makeCtx('111', 'group:shared');
  const ra2 = await tool.execute(a2, { prompt: '1girl, person A again' });
  assert.ok(ra2.isError && ra2.content.includes('刚生成过'), 'A 自己第二次仍应被冷却挡住');
}

// ── 11. 主动开话题（没有触发消息）：user_id 为空，冷却退化成按会话 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  setRuntimeConfig(cfg);
  const ctx = makeCtx(null, 'group:proactive');
  const r = await tool.execute(ctx, { prompt: '1girl, proactive' });
  assert.ok(!r.isError, `没有触发消息时也应能生成：${r.content}`);
  const req = [...mock.jobs.values()].at(-1);
  assert.strictEqual(req.user_id, null, '拿不到发送者时应传 null，不能瞎编');
  assert.strictEqual(req.session_id, 'group:proactive', 'session_id 任何情况下都要有');
}

// ── 12. 不传 ratio 时退回旧的 size 字段（向后兼容） ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  setRuntimeConfig(cfg);
  const ctx = makeCtx('333', 'group:legacy');
  const r = await tool.execute(ctx, { prompt: '1girl, legacy size', size: 640 });
  assert.ok(!r.isError, `旧用法仍应可用：${r.content}`);
  const req = [...mock.jobs.values()].at(-1);
  assert.strictEqual(req.size, 640, '不传 ratio 时应继续用 size');
  assert.strictEqual(req.ratio, undefined, '不该凭空造出 ratio');
}

// ── 13. 模型没指定尺寸时，用配置里的默认比例 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  cfg.imageGen.defaultRatio = '3:4';
  setRuntimeConfig(cfg);
  const ctx = makeCtx('444', 'group:defaultratio');
  const r = await tool.execute(ctx, { prompt: '1girl, default ratio' });
  assert.ok(!r.isError, `用配置默认比例也应能生成：${r.content}`);
  const req = [...mock.jobs.values()].at(-1);
  assert.strictEqual(req.ratio, '3:4', '模型没给尺寸时应该用配置的 defaultRatio');
  assert.strictEqual(req.size, undefined, '有 defaultRatio 就不该再传 size');
}

// ── 14. defaultRatio 为空时改用自定义宽高 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  cfg.imageGen.defaultRatio = '';
  cfg.imageGen.defaultWidth = 640;
  cfg.imageGen.defaultHeight = 384;
  setRuntimeConfig(cfg);
  const ctx = makeCtx('555', 'group:customwh');
  const r = await tool.execute(ctx, { prompt: '1girl, custom width height' });
  assert.ok(!r.isError, `自定义宽高也应能生成：${r.content}`);
  const req = [...mock.jobs.values()].at(-1);
  assert.strictEqual(req.width, 640, '自定义宽应透传');
  assert.strictEqual(req.height, 384, '自定义高应透传');
  assert.strictEqual(req.ratio, undefined, '没有 defaultRatio 就不该传 ratio');
}

// ── 15. 模型明确指定时压过配置默认 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  cfg.imageGen.defaultRatio = '1:1';
  setRuntimeConfig(cfg);
  const ctx = makeCtx('666', 'group:override');
  const r = await tool.execute(ctx, { prompt: '1girl, override', ratio: '9:16' });
  assert.ok(!r.isError, `模型指定比例时应能生成：${r.content}`);
  const req = [...mock.jobs.values()].at(-1);
  assert.strictEqual(req.ratio, '9:16', '模型给的比例应压过配置默认');
}

// ── 16. 默认配置本身要自洽（界面与后端读的是同一份 DEFAULT_CONFIG） ──
{
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const ig = DEFAULT_CONFIG.imageGen;
  assert.strictEqual(ig.enabled, false, '生图默认必须是关的');
  assert.strictEqual(ig.defaultRatio, '1:1', '默认比例应为 1:1');
  assert.ok(Number.isInteger(ig.defaultWidth) && Number.isInteger(ig.defaultHeight), '自定义宽高必须是整数');
  assert.strictEqual(ig.defaultWidth % 8, 0, '默认宽必须是 8 的倍数');
  assert.strictEqual(ig.defaultHeight % 8, 0, '默认高必须是 8 的倍数');
}

await mock.close();
console.log('✓ 本地图片生成工具自测全部通过');
