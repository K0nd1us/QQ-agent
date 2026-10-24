// 测试脚手架（供 coverage-*.mjs 复用）
//
// 复用 test/selftest.mjs 的 mock 模式：
//   - mock OneBot：HTTP（发消息/取列表/取图）+ WebSocket（推事件）
//   - mock OpenAI 兼容 API：脚本化响应 + 全量请求记录
//   - 数据目录一律隔离到临时目录（QQ_AGENT_DATA_DIR），绝不碰真实 data/
//
// 断言收集器支持三种结果：
//   pass  通过
//   fail  失败（会让进程以非 0 退出）
//   known 已知缺陷（不计入失败，但会明确列出；修好后会自动变成 pass）
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 基础设施 ─────────────────────────────────────────────────────────────
export async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

export function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch { resolve(text); }
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 继续等 */ }
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export function makeDataDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.QQ_AGENT_DATA_DIR = dir;
  return dir;
}

export function writeConfig(dataDir, cfg) {
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg), 'utf8');
}

// ── 断言收集器 ───────────────────────────────────────────────────────────
export function createChecker(title) {
  const results = { pass: [], fail: [], known: [] };

  const api = {
    results,
    section(name) {
      console.log(`\n=== ${name} ===`);
    },
    ok(name, extra = '') {
      results.pass.push(name);
      console.log(`  OK    ${name}${extra ? ` —— ${extra}` : ''}`);
    },
    bad(name, error) {
      results.fail.push({ name, error: String(error?.message ?? error) });
      console.log(`  FAIL  ${name}\n        -> ${String(error?.message ?? error)}`);
    },
    /** 期望通过；抛错即失败 */
    async check(name, fn) {
      try {
        const extra = await fn();
        api.ok(name, typeof extra === 'string' ? extra : '');
      } catch (error) {
        api.bad(name, error);
      }
    },
    /**
     * 已知缺陷：断言"正确行为"，若确实不满足则记为 known（不算失败）。
     * 修好之后同一条会自动变成 OK。
     */
    async known(name, fn, note = '') {
      try {
        const extra = await fn();
        api.ok(`${name}（已修复）`, typeof extra === 'string' ? extra : '');
      } catch (error) {
        results.known.push({ name, note: note || String(error?.message ?? error) });
        console.log(`  KNOWN ${name}${note ? ` —— ${note}` : ''}`);
      }
    },
    async expectThrow(name, fn, matcher) {
      try {
        await fn();
        api.bad(name, new Error('本应抛错，但没有抛'));
      } catch (error) {
        if (matcher && !matcher.test(String(error?.message ?? error))) {
          api.bad(name, new Error(`抛错信息不符：${error.message}`));
        } else {
          api.ok(name, String(error?.message ?? error).slice(0, 60));
        }
      }
    },
    finish() {
      const { pass, fail, known } = results;
      console.log(`\n${'='.repeat(64)}`);
      console.log(`${title}：通过 ${pass.length}，失败 ${fail.length}，已知缺陷 ${known.length}`);
      if (known.length) {
        console.log('\n已知缺陷（不计入失败，修好后会自动转 OK）：');
        for (const k of known) console.log(`  · ${k.name} —— ${k.note}`);
      }
      if (fail.length) {
        console.log('\n失败明细：');
        for (const f of fail) console.log(`  ✗ ${f.name}\n      ${f.error}`);
        process.exitCode = 1;
      } else {
        console.log('\n全部通过 ✅');
      }
      return fail.length === 0;
    }
  };
  return api;
}

// ── Mock OneBot HTTP ─────────────────────────────────────────────────────
export function createMockOneBotHttp() {
  const state = { sends: [], pokes: [], calls: [] };
  const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const action = req.url.replace(/^\//, '');
    state.calls.push(action);
    const reply = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (action === 'get_login_info') return reply({ user_id: 888, nickname: '覆盖Bot' });
    if (action === 'get_group_info') return reply({ group_id: body.group_id, group_name: `覆盖群${body.group_id}` });
    if (action === 'get_group_member_info') return reply({ card: `名片${body.user_id}`, nickname: `昵称${body.user_id}` });
    if (action === 'get_group_list') return reply([{ group_id: 456, group_name: '覆盖群456' }, { group_id: 789, group_name: '备用群789' }]);
    if (action === 'get_friend_list') return reply([{ user_id: 777, nickname: '好友777', remark: '老友' }]);
    if (action === 'get_group_member_list') return reply([
      { user_id: 111, nickname: '张三', card: '张三' },
      { user_id: 113, nickname: '王五', card: '' }
    ]);
    if (action === 'get_msg') return reply({ sender: { user_id: 9101, card: '被引用者', nickname: '被引用者' }, message: [{ type: 'text', data: { text: '被引用的原话' } }] });
    if (action === 'get_forward_msg') {
      return reply({
        messages: [
          { user_id: 1001, time: 1000, message_id: 9001, sender: { user_id: 1001, nickname: '转发者A', card: '' }, message: [{ type: 'text', data: { text: '第一段转发内容' } }] },
          { user_id: 1002, time: 1001, message_id: 9002, sender: { user_id: 1002, nickname: '转发者B', card: '' }, message: [{ type: 'image', data: { url: `http://127.0.0.1:${server.address()?.port}/img.png`, summary: '[图片]', file: 'fwd.png' } }] }
        ]
      });
    }
    if (action === 'fetch_custom_face_detail') return reply([{ emoji_id: 'st1', res_id: 'st1', md5: 'aaa', desc: '滑稽', url: `http://127.0.0.1:${server.address()?.port}/img.png` }]);
    if (action.startsWith('search')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body>
        <li class="b_algo"><h2><a href="https://example.com/a">覆盖梗的完整解释</a></h2><p>覆盖梗是指……的完整解释内容。</p></li>
        <li class="b_algo"><h2><a href="https://example.com/b">第二个结果</a></h2><p>摘要二。</p></li>
      </body></html>`);
      return;
    }
    if (action === 'group_poke' || action === 'send_poke') {
      state.pokes.push(body);
      return reply({});
    }
    if (action === 'get_image') {
      // 只对显式登记的本地文件返回 file，其他走 url
      return reply({ file: '', url: body?.file || '' });
    }
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      state.sends.push({ action, body, at: Date.now() });
      return reply({ message_id: 5000 + state.sends.length });
    }
    if (action === 'img.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作' }));
  });
  return { server, state, TINY_PNG };
}

// ── Mock OneBot WebSocket ────────────────────────────────────────────────
export function createMockOneBotWs() {
  const state = { client: null, events: [] };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const ready = new Promise((r) => wss.once('listening', r));
  wss.on('connection', (socket) => { state.client = socket; });
  return {
    server: wss,
    state,
    async ready() { await ready; return wss.address().port; },
    push(event) {
      state.events.push(event);
      if (state.client && state.client.readyState === WebSocket.OPEN) {
        state.client.send(JSON.stringify(event));
      } else {
        throw new Error('Mock OneBot WS 尚无客户端连接');
      }
    },
    close() { return new Promise((r) => wss.close(r)); }
  };
}

// ── Mock OpenAI 兼容 API ─────────────────────────────────────────────────
export function createMockLLM() {
  const state = { requests: [], script: [], forceStatus: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      // authEcho 模式（可选）：state.requireModelsKey 设了值时，/v1/models 校验
      // authorization 头 —— 用于"按 providerId 解析该提供商 Key"的回归测试
      //（错拿顶层 Key 时这里回 401，一眼红）。
      if (state.requireModelsKey) {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${state.requireModelsKey}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `mock expects Bearer ${state.requireModelsKey.slice(0, 4)}…` } }));
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] }));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      const body = await readBody(req);
      // 视觉探测请求：不进脚本队列
      const isProbe = (body.messages || []).some((m) => Array.isArray(m.content)
        && m.content.some((c) => c.type === 'text' && String(c.text || '').includes('这张图片里是什么')));
      if (isProbe) {
        state.probes = state.probes || [];
        state.probes.push(body.model);
        if (String(body.model).includes('vision-no')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'image input is not supported for this model' } }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '一个红色像素点' } }] }));
        }
        return;
      }
      const step = state.requests.length;
      state.requests.push(body);
      if (state.forceStatus.length) {
        const code = state.forceStatus.shift();
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `HTTP ${code}` } }));
        return;
      }
      let scripted = state.script[step];
      if (!scripted) scripted = { content: '（默认：无动作）' };
      if (scripted.delayMs) await sleep(scripted.delayMs);
      const message = { role: 'assistant', content: scripted.content ?? null };
      if (scripted.toolCalls) {
        message.tool_calls = scripted.toolCalls.map((tc, i) => ({
          id: `call_${step}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl_${step}`,
        model: scripted.model || 'test-model-a',
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100 + step * 10, completion_tokens: 20, total_tokens: 120 + step * 10 }
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, state };
}

// ── 启动一套完整环境（mock 全起 + app） ──────────────────────────────────
export async function bootApp({ config = {}, script = [] } = {}) {
  const dataDir = makeDataDir('qq-agent-cov-');
  const onebotHttp = createMockOneBotHttp();
  const onebotHttpPort = await listen(onebotHttp.server);
  const onebotWs = createMockOneBotWs();
  const onebotWsPort = await onebotWs.ready();
  const llm = createMockLLM();
  llm.state.script.push(...script);
  const llmPort = await listen(llm.server);

  const baseConfig = {
    api: {
      baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      apiKey: 'test-api-key-SECRET',
      model: 'test-model-a',
      vision: true,
      temperature: 0.7,
      maxRounds: 6,
      priceInputPerM: 2,
      priceOutputPerM: 8
    },
    webSearch: { enabled: true, searchUrl: `http://127.0.0.1:${onebotHttpPort}/search`, maxResults: 6 },
    security: { allowPrivateImageHosts: false },
    snowluma: { wsUrl: `ws://127.0.0.1:${onebotWsPort}`, httpUrl: `http://127.0.0.1:${onebotHttpPort}`, accessToken: '' },
    persona: { botName: '覆盖Bot', participation: 'medium', roleText: '你是覆盖测试群里的机器人。' },
    allow: { groups: ['456'], private: ['777'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    wakeDelayMs: 200,
    drainDelayMs: 150,
    maxConcurrentRuns: 2,
    send: { minGapMs: 10, maxGapMs: 20, byLengthMs: 0, maxPerMinute: 100, maxPerHour: 1000, hardSplitAt: 4000 },
    proactive: { enabled: false },
    sticker: { enabled: true, collectEnabled: true },
    store: { maxMessagesPerChat: 0, contextTier: 4, historyCount: 80, keepSessionFiles: 100 },
    server: { port: await freePort(), token: '' }
  };
  // config 覆盖：对 api / snowluma / store 这类对象做一层合并，
  // 避免调用方只写 { snowluma: { dir } } 时把 wsUrl/httpUrl 一起冲掉。
  const merged = { ...baseConfig, ...config };
  for (const key of ['api', 'snowluma', 'store', 'send', 'persona', 'ui', 'webSearch']) {
    if (config[key] && typeof config[key] === 'object' && baseConfig[key]) {
      merged[key] = { ...baseConfig[key], ...config[key] };
    }
  }
  writeConfig(dataDir, merged);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ log: () => {} });
  const port = await app.start();
  // OneBot 是异步连接的，必须等它连上再返回，否则 /api/onebot/* 会全部 502
  await waitFor(() => app.onebot.connected, 10000, 'OneBot WS 连接');

  const base = `http://127.0.0.1:${port}`;
  const request = async (method, p, { body, headers = {}, origin } = {}) => {
    const h = { ...headers };
    if (origin) h.origin = origin;
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    } catch (error) {
      // 把 undici 的真实原因（ECONNREFUSED / ECONNRESET / UND_ERR_…）带出来，否则只有一句 fetch failed
      const cause = error?.cause?.code || error?.cause?.message || '';
      throw new Error(`${method} ${p} 请求失败：${error.message}${cause ? `（cause: ${cause}）` : ''}`);
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, headers: res.headers, text, data };
  };

  /**
   * 原生 http 请求：用于需要设置 fetch 禁止修改的头（如 Host）的场景，
   * 模拟 DNS rebinding —— 攻击者域名解析到 127.0.0.1，Host 头仍是攻击者域名。
   */
  const rawRequest = (method, p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(body); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, text: body, data });
      });
    });
    req.on('error', reject);
    req.end();
  });

  const pushGroupMsg = (userId, name, text, mid, extra = {}) => onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: userId, self_id: 888,
    message_id: mid, time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, card: name, nickname: name },
    message: [{ type: 'text', data: { text } }],
    ...extra
  });

  const waitSessionDone = async (triggerSubstring, timeout = 9000) => {
    const s = await waitFor(() => {
      const found = app.sessions.listSummaries(50).find((e) => (e.trigger || '').includes(triggerSubstring));
      if (found && found.status !== 'running' && found.status !== 'waiting') return found;
      return null;
    }, timeout, `会话(${triggerSubstring})结束`);
    return app.sessions.get(s.id);
  };

  const teardown = async () => {
    try { await app.stop(); } catch { /* ignore */ }
    onebotWs.close();
    onebotHttp.server.close();
    llm.server.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { dataDir, app, port, base, request, rawRequest, onebotHttp, onebotWs, llm, pushGroupMsg, waitSessionDone, teardown };
}
