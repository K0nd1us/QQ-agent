// 账号中心（HUB）：一个只监听 127.0.0.1 的小型控制台。
//
// 它不承载任何 QQ 逻辑，只做三件事：
//   1. 把账号列表/运行状态/今日用量汇总给页面；
//   2. 接收"新建/改名/启停/删除"操作并转给账号管理器；
//   3. 提供每个账号控制台的入口（跳转到 127.0.0.1:<该号端口>/）。
//
// 安全边界与主控制台一致：只监听回环地址；带 Origin/Referer 时必须同源；
// 请求体有上限；不向前端返回任何 Key/令牌。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickFreePort } from './ports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_DIR = path.resolve(__dirname, '..', '..', 'ui', 'hub');
const BODY_LIMIT = 64 * 1024;
const USAGE_TTL_MS = 20_000;
const PROBE_TTL_MS = 10_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function isLoopbackHost(host) {
  return /^127\.0\.0\.1(:\d+)?$/.test(host)
    || /^localhost(:\d+)?$/.test(host)
    || /^\[::1\](:\d+)?$/.test(host);
}

function originAllowed(req) {
  const host = String(req.headers.host || '');
  if (!isLoopbackHost(host)) return false;
  const origin = String(req.headers.origin || '');
  if (origin) {
    try {
      const u = new URL(origin);
      return isLoopbackHost(u.host) && u.host === host;
    } catch { return false; }
  }
  const referer = String(req.headers.referer || '');
  if (referer) {
    try { return new URL(referer).host === host; } catch { return false; }
  }
  return true;
}

function probeTcp(urlText, timeoutMs = 700) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(String(urlText || '')); } catch { return resolve(null); }
    // 只探测本机：账号中心不应替用户扫描外部地址（SSRF/隐私都不合适）。
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return resolve(null);
    const port = Number(url.port) || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80);
    if (!port) return resolve(null);
    const socket = net.connect({ host: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, port });
    const done = (value) => {
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function fetchStatus(account, cache) {
  const cached = cache.get(account.id);
  if (cached && Date.now() - cached.at < (cached.ttl || USAGE_TTL_MS)) return cached.value;
  const port = Number(account.port);
  let value = null;
  if (port > 0) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(1800),
        headers: { 'x-console-token': 'qq-agent-console' }
      });
      if (res.ok) {
        const data = await res.json();
        const usage = data.usage || {};
        const cost = Number(data.cost?.cost ?? data.cost ?? 0) || 0;
        value = {
          connected: Boolean(data.onebot?.connected),
          self: data.onebot?.self || null,
          paused: Boolean(data.paused ?? data.orchestrator?.paused),
          usage: {
            runs: Number(usage.runs ?? usage.calls ?? 0) || 0,
            cost,
            promptTokens: Number(usage.promptTokens) || 0,
            completionTokens: Number(usage.completionTokens) || 0,
            totalTokens: (Number(usage.promptTokens) || 0) + (Number(usage.completionTokens) || 0),
            webSearchCount: Number(data.webSearchCount) || 0
          },
          diagnosis: String(data.onebot?.diagnosis || '')
        };
      }
    } catch { /* 账号刚启动/已停止时拿不到状态是正常的 */ }
  }
  // 拿不到状态（账号刚启动/刚重启）只缓存 3 秒，避免卡片长时间停在“读取中”。
  cache.set(account.id, { at: Date.now(), value, ttl: value ? USAGE_TTL_MS : 3000 });
  return value;
}

function openDirectory(dir) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
}

export function createHub({ manager, log = () => {} } = {}) {
  const usageCache = new Map();
  const probeCache = new Map();
  let server = null;
  let hubPort = 0;

  async function enrich(accounts) {
    return Promise.all(accounts.map(async (account) => {
      const live = await fetchStatus(account, usageCache);
      const firstUrl = account.onebot.wsUrl || account.onebot.httpUrl;
      let reachable = null;
      if (firstUrl) {
        const key = `${account.id}|${firstUrl}`;
        const hit = probeCache.get(key);
        if (hit && Date.now() - hit.at < PROBE_TTL_MS) reachable = hit.value;
        else {
          reachable = await probeTcp(firstUrl);
          probeCache.set(key, { at: Date.now(), value: reachable });
        }
      }
      const status = { ...account.status };
      if (live) {
        status.connected = live.connected;
        status.paused = live.paused;
        if (live.self?.nickname) status.nickname = live.self.nickname;
      }
      const hasEndpoint = Boolean(account.onebot.wsUrl || account.onebot.httpUrl);
      // 空地址时内核会报 “Invalid URL”，对用户没有意义：换成可执行的提示。
      if (!hasEndpoint && /invalid url/i.test(String(status.lastError || ''))) {
        status.lastError = '';
      }
      return {
        ...account,
        status,
        protocolEnd: { reachable, url: firstUrl },
        usage: live?.usage || null,
        diagnosis: !hasEndpoint
          ? '未配置 OneBot 地址：打开控制台 → 设置 → OneBot 填写'
          : (reachable === false
            ? '协议端端口未监听：请确认协议端已运行，且该 QQ 已登录'
            : (live?.diagnosis || (status.connected ? '' : status.lastError || '')))
      };
    }));
  }

  function notices(accounts) {
    const out = [];
    const missing = accounts.filter((a) => !a.onebot.wsUrl && !a.onebot.httpUrl);
    if (missing.length) out.push({
      level: 'info',
      text: `${missing.length} 个账号还没填写 OneBot 地址：点「打开控制台」→ 设置 → OneBot 里填写。`
    });
    const byUrl = new Map();
    for (const a of accounts) {
      const key = `${a.onebot.wsUrl}|${a.onebot.httpUrl}`;
      if (!a.onebot.wsUrl && !a.onebot.httpUrl) continue;
      byUrl.set(key, [...(byUrl.get(key) || []), a.name]);
    }
    for (const names of byUrl.values()) {
      if (names.length > 1) out.push({
        level: 'danger',
        text: `账号 ${names.join('、')} 指向同一组 OneBot 地址：会互相抢事件、重复回复。请为每个号配置独立端口。`
      });
    }
    const byPort = new Map();
    for (const a of accounts) byPort.set(a.port, [...(byPort.get(a.port) || []), a.name]);
    for (const [port, names] of byPort.entries()) {
      if (names.length > 1) out.push({
        level: 'danger',
        text: `账号 ${names.join('、')} 的控制台端口都是 ${port}，只能有一个真正启动。`
      });
    }
    const notConnected = accounts.filter((a) => a.status.running && !a.status.connected);
    if (notConnected.length) out.push({
      level: 'warn',
      text: `${notConnected.map((a) => a.name).join('、')} 已启动但还没连上协议端：检查协议端是否运行、端口/令牌是否正确。`
    });
    return out;
  }

  async function state() {
    const accounts = await enrich(manager.list());
    const summary = {
      accounts: accounts.length,
      running: accounts.filter((a) => a.status.running).length,
      connected: accounts.filter((a) => a.status.connected).length,
      paused: accounts.filter((a) => a.status.paused).length,
      groups: accounts.reduce((sum, a) => sum + (a.allowGroups || 0), 0),
      privateChats: accounts.reduce((sum, a) => sum + (a.allowPrivate || 0), 0),
      todayCost: accounts.reduce((sum, a) => sum + (a.usage?.cost || 0), 0),
      todayRuns: accounts.reduce((sum, a) => sum + (a.usage?.runs || 0), 0)
    };
    return {
      ok: true,
      hubPort,
      baseDataDir: manager.baseDataDir,
      accounts,
      summary,
      notices: notices(accounts)
    };
  }

  function safeStatic(pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.resolve(HUB_DIR, rel);
    const check = path.relative(HUB_DIR, full);
    if (check.startsWith('..') || path.isAbsolute(check)) return null;
    return full;
  }

  function serveStatic(req, res, pathname) {
    const file = safeStatic(pathname);
    if (!file) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    let data;
    try { data = fs.readFileSync(file); } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(file);
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    };
    if (ext === '.html') headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function handle(req, res) {
    if (!originAllowed(req)) return json(res, 403, { ok: false, error: '请求来源不被信任' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (!pathname.startsWith('/api/hub/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: '方法不允许' });
      return serveStatic(req, res, pathname);
    }

    try {
      if (req.method === 'GET' && pathname === '/api/hub/state') {
        return json(res, 200, await state());
      }

      if (req.method === 'POST' && pathname === '/api/hub/accounts') {
        const body = await readBody(req);
        const account = await manager.createAccount({ name: body.name, copyFrom: body.copyFrom });
        return json(res, 201, { ok: true, account });
      }

      if (req.method === 'POST' && pathname === '/api/hub/open-data-dir') {
        const body = await readBody(req);
        const id = String(body.id || '');
        const dir = id ? manager.get(id).dataDir : manager.baseDataDir;
        openDirectory(dir);
        return json(res, 200, { ok: true, dir });
      }

      let match = /^\/api\/hub\/accounts\/([a-z][a-z0-9_-]{1,31})(?:\/(start|stop|restart|pause|resume|open))?$/.exec(pathname);
      if (match) {
        const id = match[1];
        const action = match[2] || '';
        if (!action && req.method === 'PATCH') {
          const body = await readBody(req);
          let account = manager.get(id);
          if (body.name !== undefined) account = await manager.renameAccount(id, body.name);
          if (body.enabled !== undefined) account = await manager.setEnabled(id, body.enabled !== false);
          return json(res, 200, { ok: true, account });
        }
        if (!action && req.method === 'DELETE') {
          const result = await manager.removeAccount(id, { confirmName: url.searchParams.get('confirm') });
          return json(res, 200, { ok: true, ...result });
        }
        if (!action && req.method === 'GET') {
          return json(res, 200, { ok: true, account: manager.get(id) });
        }
        if (req.method === 'POST' && action === 'start') {
          const port = await manager.start(id);
          return json(res, 200, { ok: true, port });
        }
        if (req.method === 'POST' && action === 'stop') {
          await manager.stop(id);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && action === 'restart') {
          const port = await manager.restart(id);
          return json(res, 200, { ok: true, port });
        }
        if (req.method === 'POST' && (action === 'pause' || action === 'resume')) {
          await manager.pause(id, action === 'pause');
          return json(res, 200, { ok: true, paused: action === 'pause' });
        }
        if (req.method === 'GET' && action === 'open') {
          return json(res, 200, { ok: true, url: manager.openConsole(id) });
        }
        return json(res, 405, { ok: false, error: '方法不允许' });
      }

      return json(res, 404, { ok: false, error: '接口不存在' });
    } catch (error) {
      const message = String(error?.message ?? error);
      log(`[账号中心] 请求失败：${message}`);
      return json(res, 400, { ok: false, error: message });
    }
  }

  async function listen(preferred = 3211) {
    const used = manager.list().map((a) => Number(a.port)).filter(Boolean);
    const port = await pickFreePort(preferred, { exclude: used });
    if (!port) throw new Error('账号中心找不到可用的监听端口');
    server = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        try { json(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch { /* ignore */ }
      });
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    hubPort = port;
    log(`[账号中心] 已就绪：http://127.0.0.1:${port}/`);
    return port;
  }

  async function close() {
    if (!server) return;
    const current = server;
    server = null;
    await new Promise((resolve) => {
      try { current.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 1500).unref?.();
    });
  }

  return { listen, close, state, get port() { return hubPort; }, _server: () => server };
}
