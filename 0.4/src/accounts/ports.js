// 端口探测：账号中心 / 各账号控制台都必须拿到一个真正能监听的端口。
//
// 只监听 127.0.0.1，探测方式与 app.start() 相同（先占用再释放），
// 避免"探测通过、启动时被别的进程抢走"的窗口期尽可能小。
import net from 'node:net';

export function canListen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const value = Number(port);
    if (!Number.isInteger(value) || value <= 0 || value > 65535) return resolve(false);
    const server = net.createServer();
    const done = (ok) => {
      try { server.close(); } catch { /* ignore */ }
      resolve(ok);
    };
    server.once('error', () => done(false));
    server.listen({ port: value, host, exclusive: true }, () => done(true));
  });
}

/** 从 preferred 开始向上找一个能监听的端口；全都失败时返回 0。 */
export async function pickFreePort(preferred, { exclude = [], attempts = 40 } = {}) {
  const blocked = new Set((exclude || []).map(Number).filter(Boolean));
  let port = Math.max(1, Number(preferred) || 1);
  for (let i = 0; i < attempts; i += 1, port += 1) {
    if (port > 65535) break;
    if (blocked.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) return port;
  }
  return 0;
}
