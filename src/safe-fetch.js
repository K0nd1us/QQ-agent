// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程。
//
// 例外开关：security.allowPrivateImageHosts = true 时，图片下载跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { getConfig } from './config.js';

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────
//
// ⚠️ 2026-09-12 修复「有时候识图失败：域名解析失败：DNS 解析超时」：
// 老实现只用 dns.lookup（getaddrinfo）且只给 5 秒、不重试、不缓存。
// 实测同一台机器解析多媒体图床 multimedia.nt.qq.com.cn：
//     dns.lookup 冷启动 11066ms   ← getaddrinfo 走系统 DNS 客户端，冷启动极慢
//     dns.resolve4          18ms   ← c-ares 直接问 DNS 服务器
// 于是系统 DNS 缓存一过期（隔一段时间/重启后第一次取图），5 秒必爆。
// 现在两条路一起跑、谁先给出地址用谁，再加重试、缓存与多 IP 回退。

const DNS_TTL_MS = 5 * 60 * 1000;   // 解析结果缓存 5 分钟
const DNS_TIMEOUT_MS = 8000;        // 单次解析上限（getaddrinfo 冷启动实测可到 11s）
const DNS_MAX_ATTEMPTS = 3;
const MAX_IP_ATTEMPTS = 3;          // 一个域名常解析出十几个 IP，偶尔有连不通的节点

const dnsCache = new Map();         // hostname -> { addresses: string[], at: number }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 第一个成功的结果胜出；其余尝试继续在后台跑完，不阻塞调用方。 */
function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    let lastError = null;
    if (!pending) {
      reject(new Error('没有可用的解析方式'));
      return;
    }
    for (const p of promises) {
      p.then(resolve).catch((error) => {
        lastError = error;
        pending -= 1;
        if (pending === 0) reject(lastError ?? new Error('解析失败'));
      });
    }
  });
}

/**
 * 单次解析：getaddrinfo 与 c-ares 竞速，谁先给出地址用谁。
 * 两者互补 —— lookup 认 hosts 文件、能拿 IPv6；resolve4 快且不受 getaddrinfo 拖累。
 */
async function resolveOnce(hostname, { timeoutMs, lookup, resolve4 }) {
  const attempts = [
    withTimeout(
      Promise.resolve()
        .then(() => lookup(hostname, { all: true, verbatim: true }))
        .then((rows) => {
          const list = (Array.isArray(rows) ? rows : [rows])
            .map((r) => (typeof r === 'string' ? r : r?.address))
            .filter(Boolean);
          if (!list.length) throw new Error('getaddrinfo 没有返回地址');
          return list;
        }),
      timeoutMs,
      'DNS 解析超时'
    ),
    withTimeout(
      Promise.resolve()
        .then(() => resolve4(hostname))
        .then((list) => {
          if (!Array.isArray(list) || !list.length) throw new Error('c-ares 没有 A 记录');
          return list;
        }),
      timeoutMs,
      'DNS 解析超时'
    )
  ];
  const addresses = await firstSuccess(attempts);
  return [...new Set(addresses)];
}

/**
 * 解析主机名 → 去重后的地址列表（IPv4 优先）。
 * lookup / resolve4 可注入，便于单测模拟「getaddrinfo 卡死、c-ares 秒回」的场景。
 */
export async function resolveHostAddresses(hostname, opts = {}) {
  const {
    timeoutMs = DNS_TIMEOUT_MS,
    attempts: maxAttempts = DNS_MAX_ATTEMPTS,
    lookup = dnsLookup,
    resolve4 = dns.promises.resolve4,
    cache = true
  } = opts;
  const key = String(hostname || '').toLowerCase();
  if (!key) throw new Error('主机名为空');
  if (cache) {
    const hit = dnsCache.get(key);
    if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.addresses.slice();
  }
  let lastError = null;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const addresses = await resolveOnce(key, { timeoutMs, lookup, resolve4 });
      // IPv4 排前面：部分 CDN 的 AAAA 记录在纯 IPv4 网络下根本连不通
      const sorted = [
        ...addresses.filter((a) => net.isIP(a) === 4),
        ...addresses.filter((a) => net.isIP(a) !== 4)
      ];
      if (cache) dnsCache.set(key, { addresses: sorted, at: Date.now() });
      return sorted;
    } catch (error) {
      lastError = error;
      if (i < maxAttempts) await sleep(200 * i);   // 200ms → 400ms 退避
    }
  }
  throw lastError ?? new Error('域名解析失败');
}

/** 清空 DNS 缓存（测试用；正常情况下靠 5 分钟 TTL 自然过期）。 */
export function clearDnsCache() {
  dnsCache.clear();
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return [h];
  }
  let addresses;
  try {
    addresses = await resolveHostAddresses(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    for (const address of addresses) {
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip, ips }。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ips = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip: ips[0], ips };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBounded(res, maxBytes, asText) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chunks = [];
    let total = 0;
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (asText) text += decoder.write(chunk);
      else chunks.push(chunk);
      // 只用字节数判断是否超限。原实现还额外判断了 text.length >= maxBytes，
      // 但 text.length 是字符数而 maxBytes 是字节数（UTF-8 下中文 1 字符 = 3 字节），
      // 单位不一致，会让刚好读满的响应被误标成 truncated。
      if (total >= maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        finish(resolve, asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes));
      }
    });
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end();
          finish(resolve, sliceByCodePoints(text, maxBytes));
        } else {
          finish(resolve, Buffer.concat(chunks));
        }
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url, ip, { asBinary = false, maxBytes = 50000 } = {}) {  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBounded(res, maxBytes, !asBinary)
        .then((body) => resolve({ statusCode, body, contentType: String(res.headers['content-type'] || '') }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

const MAX_REDIRECTS = 5;

/**
 * 依次尝试解析出的多个 IP，直到有一个连上。
 * 一个 CDN 域名常解析出十几个地址，偶尔会有连不通的节点；
 * 老实现固定用 addresses[0]，那一个不通整次取图/搜索就失败。
 * 注意只在「连接层失败」（requestOnce reject）时换 IP —— HTTP 状态码不算失败。
 * （导出供单测直接构造"第一个 IP 连不通"的场景）
 */
export async function requestWithFallback(url, ips, opts) {
  const list = (Array.isArray(ips) && ips.length ? ips : [ips]).slice(0, MAX_IP_ATTEMPTS);
  let lastError = null;
  for (const ip of list) {
    try {
      return await requestOnce(url, ip, opts);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('请求失败');
}

/** 抓取网页文本（≤50000 字符），SSRF 全防护（不做内网例外）。 */
export async function safeFetch(urlString) {
  let { url, ips } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestWithFallback(url, ips, { asBinary: false, maxBytes: 50000 });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ips } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return { url: url.toString(), statusCode: result.statusCode, truncated: body.length >= 50000, body };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024) {
  const allowPrivate = getConfig().security?.allowPrivateImageHosts === true;
  let { url, ips } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestWithFallback(url, ips, { asBinary: true, maxBytes });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ips } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    return { buffer: result.body, contentType: result.contentType };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}
