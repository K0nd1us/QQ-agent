import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const equal = (a, b) => {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
};
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = new Map([
  ['/runtime/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/runtime/module.css', ['module.css', 'text/css; charset=utf-8']],
  ['/runtime/connection.js', ['connection-ui.js', 'text/javascript; charset=utf-8']]
]);

export function serverOptions(config, env = process.env) {
  const server = config.server || {};
  const host = env.QQ_AGENT_HOST || server.host || '127.0.0.1';
  const port = Number(env.QQ_AGENT_PORT ?? server.port ?? 3210);
  const token = env.QQ_AGENT_TOKEN || server.token || '';
  const allowedHosts = env.QQ_AGENT_ALLOWED_HOSTS === undefined
    ? (server.allowedHosts || [])
    : env.QQ_AGENT_ALLOWED_HOSTS.split(',').map(x => x.trim()).filter(Boolean);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid QQ_AGENT_PORT');
  if (!token) throw new Error('Headless module requires QQ_AGENT_TOKEN or server.token');
  if (!Array.isArray(allowedHosts) || allowedHosts.some(x => typeof x !== 'string' || /[\s/\\]/.test(x))) throw new Error('Invalid allowedHosts');
  return { host, port, token, allowedHosts };
}

export function createConsoleAuth({ getOptions }) {
  const sessions = new Map();
  function originAllowed(req) {
    const host = String(req.headers.host || '');
    const options = getOptions();
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
    if (!loopback && !options.allowedHosts.includes(host)) return false;
    for (const value of [req.headers.origin, req.headers.referer]) {
      if (!value) continue;
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.host !== host) return false;
      } catch { return false; }
    }
    return true;
  }
  function authorize(req) {
    const token = getOptions().token;
    if (!token) return false;
    if (equal(req.headers['x-console-token'], token)) return true;
    const id = /(?:^|;\s*)qqa_headless=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const session = id && sessions.get(id);
    return Boolean(session && session.expires > Date.now() && session.tokenHash === hash(token));
  }
  function file(res, name, type) {
    res.writeHead(200, {
      'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    });
    res.end(readFileSync(fileURLToPath(new URL(name, import.meta.url))));
  }
  return {
    authorize, originAllowed,
    close() { sessions.clear(); },
    async handleRequest({ req, res, url, readBody, json }) {
      if (!originAllowed(req)) { json(res, 403, { error: 'Untrusted request origin / 请求来源不被信任' }); return true; }
      if (url.pathname === '/api/health' && req.method === 'GET') { json(res, 200, { ok: true }); return true; }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        let body;
        try { body = await readBody(req, { maxBytes: 8192 }); }
        catch (error) {
          if (!error.expose) throw error;
          json(res, error.status, { error: error.message });
          return true;
        }
        const token = getOptions().token;
        if (!equal(body?.token, token)) { json(res, 401, { error: 'Invalid console token / 管理令牌不正确' }); return true; }
        for (const [key, s] of sessions) if (s.expires <= Date.now()) sessions.delete(key);
        if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { tokenHash: hash(token), expires: Date.now() + 24 * 3600000 });
        res.setHeader('set-cookie', `qqa_headless=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.socket.encrypted ? '; Secure' : ''}`);
        json(res, 200, { ok: true });
        return true;
      }
      const asset = assets.get(url.pathname);
      if (asset && req.method === 'GET') { file(res, ...asset); return true; }
      if (!authorize(req)) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) file(res, 'login.html', 'text/html; charset=utf-8');
        else json(res, 401, { error: 'Authentication required / 请先登录' });
        return true;
      }
      if (url.pathname === '/runtime/connection' && req.method === 'GET') {
        file(res, 'connection.html', 'text/html; charset=utf-8');
        return true;
      }
      return false;
    }
  };
}
