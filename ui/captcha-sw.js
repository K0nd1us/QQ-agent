/* QQ Agent 验证码网络桥（Service Worker）。
 *
 * 背景（2026-09-26）：部分用户机器上，Chromium 渲染层访问 *.alicdn.com /
 * *.aliyuncs.com 全部失败（Failed to fetch），而同机系统 curl 直连、主进程
 * Node 层、kondius.cn 均正常 —— 属本机安全软件按进程+域名压制 Chromium 网络。
 * 本 SW 把 SDK 对阿里域的请求改写到 kondius.cn 的实时反代。
 *
 * 实现要点：
 *   - 请求体用 arrayBuffer() 读取后转发（直接转发 ReadableStream 会在
 *     fetch 里因缺 duplex 选项同步抛错，respondWith reject → 页面网络错误，
 *     且请求不出网络栈，webRequest 重定向也救不回来 —— 第一版踩过的坑）；
 *   - handler 内任何异常都返回 HTTP 599 + 错误详情（而不是静默网络错误），
 *     让"SW 路径是否生效、失败在哪"在页面上直接可见；
 *   - 仅拦截 https 的 aliyuncs.com / alicdn.com 两族域名，其余原样放行。
 */
const PROXY_BASE = 'https://kondius.cn/qq-agent/captcha-api/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  let url;
  try { url = new URL(event.request.url); } catch { return; }
  if (url.protocol !== 'https:') return;
  const h = url.hostname;
  const isAli = h === 'aliyuncs.com' || h.endsWith('.aliyuncs.com')
             || h === 'alicdn.com' || h.endsWith('.alicdn.com');
  if (!isAli) return;

  const rewritten = PROXY_BASE + url.hostname + url.pathname + url.search;
  event.respondWith((async () => {
    try {
      const init = {
        method: event.request.method,
        headers: event.request.headers,
        redirect: 'follow',
      };
      if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
        init.body = await event.request.arrayBuffer();
      }
      const resp = await fetch(rewritten, init);
      // 反代响应带 CORS 头（nginx 配置），透传即可；补一层状态标记便于排查
      const headers = new Headers(resp.headers);
      headers.set('x-qqa-via', 'sw-proxy');
      return new Response(resp.body, { status: resp.status, headers });
    } catch (e) {
      return new Response(JSON.stringify({ proxyError: String(e && (e.stack || e.message) || e) }), {
        status: 599,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'x-qqa-via': 'sw-proxy-error',
        },
      });
    }
  })());
});
