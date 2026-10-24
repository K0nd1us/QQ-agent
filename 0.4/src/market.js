// 社区市场客户端：账号凭据管理、发布代理、口令安装。
//
// ── 为什么本地要存凭据、又要走代理 ──
//   · 凭据：账号系统"不需要频繁使用"，登录一次后 token 存在 data/account.json
//     （支持多条，UI 可以列出并选择）。绝不进 config.json —— 那玩意会被
//     GET /api/config 脱敏回传，塞进去等于自造一个泄露面。
//   · 代理：浏览器直连 kondius.cn 会被 CORS 拦（官网没开跨域），应用内所有
//     市场操作（登录/发布/口令校验/下载安装）都由 Node 端转发。
//
// ── 口令安装的安全边界 ──
//   · 下载的 zip 解压前先过与后端同款的结构校验（路径穿越/可执行文件/体积）
//   · 解压目标强制收在 skills/ 或 plugins/ 之下（type 由服务器 entry 决定，
//     前端传什么都没用 —— 这是"技能页输插件口令也装进插件目录"的保证）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, getConfig } from './config.js';
import { logger } from './logger.js';

export const MARKET_API_BASE = 'https://www.kondius.cn/api/community';
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.json');
const FETCH_TIMEOUT_MS = 30000;
// 安装包下载上限与后端 MAX_UPLOAD 对齐
const MAX_ZIP_BYTES = 8 * 1024 * 1024;

const log = (fn, ...args) => logger[fn]('market', ...args);

/** 读本地凭据列表：[{ username, token, savedAt }]。 */
export function listAccounts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    if (Array.isArray(parsed?.accounts)) {
      return parsed.accounts.filter((a) => a && typeof a === 'object' && a.token && a.username);
    }
  } catch { /* 还没有凭据文件 */ }
  return [];
}

function saveAccounts(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${ACCOUNT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  fs.renameSync(tmp, ACCOUNT_FILE);
}

/** 保存/更新一条凭据（按 username 去重）。 */
export function saveAccount({ username, token }) {
  const list = listAccounts().filter((a) => a.username !== username);
  list.push({ username: String(username), token: String(token), savedAt: Date.now() });
  saveAccounts(list);
  return list;
}

/** 删除一条凭据（登出：本地删 + 远端吊销，远端失败不阻塞本地删除）。 */
export async function removeAccount(username, { revoke = true } = {}) {
  const list = listAccounts();
  const hit = list.find((a) => a.username === username);
  if (revoke && hit) {
    try {
      await marketFetch('/auth/logout', { method: 'POST', token: hit.token });
    } catch (error) {
      log('warn', `吊销凭据失败（不影响本地删除）：${error?.message ?? error}`);
    }
  }
  saveAccounts(list.filter((a) => a.username !== username));
  return list;
}

/**
 * 把 nginx/网关层的拦截翻译成人话。
 * 应用层（community_app.py）报错时总带 JSON error；返回 HTML 错误页的一定是
 * 反代/防火墙层 —— 2026-09-26 实测：GET 能进应用，POST/PUT/… 被 nginx 403
 * （同域名下 / 与 /qq-agent/ 的 POST 都能到达应用，只有 /api/community 被拦），
 * 属于服务器对这个 location 的方法限制，客户端怎么改都绕不过。
 */
function friendlyMarketError(res) {
  if (res.status === 403) {
    return '市场服务拒绝访问（403，来自服务器 nginx 层而非应用）：'
      + '请检查服务器对 /api/community 的方法限制（limit_except / 站点防火墙"禁用 POST"之类），应用本身是好的';
  }
  if (res.status >= 500) return `市场服务故障（HTTP ${res.status}），请稍后再试`;
  return `市场服务 HTTP ${res.status}`;
}

/**
 * 官网市场 API 代理。返回解析后的 JSON；HTTP 非 2xx 抛错（带服务器给的 error 文案）。
 * @param {string} pathname 以 / 开头，拼在 MARKET_API_BASE 后
 * @param {object} options { method, token, json, body(headers 自动), timeoutMs }
 */
export async function marketFetch(pathname, { method = 'GET', token = '', json = null, body = null, headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetch(`${MARKET_API_BASE}${pathname}`, {
    method,
    headers: {
      ...(json !== null ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'X-Account-Token': token } : {}),
      ...headers
    },
    body: json !== null ? JSON.stringify(json) : body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error || friendlyMarketError(res));
    e.status = res.status;
    throw e;
  }
  return data;
}

/**
 * 账号登录/注册：成功则自动保存凭据并返回账号信息。
 * mode: 'login' | 'register'。注册三要素：登录 ID + 展示用户名 + 密码（确认密码由前端本地比对）。
 */
export async function loginAccount({ loginId, displayName = '', password, mode = 'login' }) {
  const payload = mode === 'register'
    ? { loginId, displayName, password }
    : { loginId, password };
  const data = await marketFetch(mode === 'register' ? '/auth/register' : '/auth/login', {
    method: 'POST', json: payload
  });
  const name = data?.account?.displayName || data?.account?.username || data?.account?.loginId;
  if (!data?.ok || !data?.token || !name) throw new Error(mode === 'register' ? '注册失败（服务器响应异常）' : '登录失败（服务器响应异常）');
  saveAccount({ username: name, token: data.token });
  return { account: data.account, accounts: listAccounts() };
}

/** 校验一条凭据是否仍有效（whoami）。 */
export async function verifyAccount(token) {
  try {
    const data = await marketFetch('/auth/whoami', { token });
    return data?.ok ? data.account : null;
  } catch {
    return null;
  }
}

/**
 * 发布一个 skill/plugin 目录到市场（待审核）。
 * @param {object} o { kind: 'skill'|'plugin', id, displayName, description, token, captchaVerifyParam? }
 * @returns 服务器响应 { ok, item, renamedTo? }
 */
export async function publishModule({ kind, id, displayName, description, token, captchaVerifyParam = '', update = false }) {
  const dir = path.join(ROOT, kind === 'plugin' ? 'plugins' : 'skills', id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`目录不存在：${dir}`);
  }
  const zipBuffer = await zipDirectory(dir);
  // FormData（Node 18+ 原生）：zip 用 Blob 传，文件名服务端不敏感
  const form = new FormData();
  form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), `${id}.zip`);
  if (displayName) form.append('name', String(displayName));
  if (description) form.append('description', String(description));
  // 阿里云验证码验签：远端强制校验，一次性 token（前端弹出人机验证后拿到）
  if (captchaVerifyParam) form.append('captchaVerifyParam', String(captchaVerifyParam));
  // 更新已有条目走另一条路：/market/{plugins|skills}/<id>/update
  // （首次发布才用 /market/publish；同 id 重复发布会报“市场上已存在同 id 的条目”）
  const kindPath = kind === 'plugin' ? 'plugins' : 'skills';
  const url = update
    ? `${MARKET_API_BASE}/market/${kindPath}/${encodeURIComponent(id)}/update`
    : `${MARKET_API_BASE}/market/publish`;
  const res = await fetch(url, {
    method: 'POST',
    headers: token ? { 'X-Account-Token': token } : {},
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `发布失败：HTTP ${res.status}`);
  return data;
}

/** 把目录打成 zip（Buffer）。entry.json 不存在于本地目录，无需剔除。 */
async function zipDirectory(dir) {
  const files = [];
  const walk = (d, rel = '') => {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp, rel ? `${rel}/${name}` : name);
      else files.push({ fp, rel: rel ? `${rel}/${name}` : name });
    }
  };
  walk(dir);
  // 前置校验（与后端 validate_zip 同款）：本地先拦，省一次上传
  if (files.length > 100) throw new Error('文件数量过多（>100）');
  let total = 0;
  for (const f of files) {
    total += fs.statSync(f.fp).size;
    if (/\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i.test(f.rel)) throw new Error(`禁止打包可执行文件：${f.rel}`);
  }
  if (total > 32 * 1024 * 1024) throw new Error('解压后总大小超过 32MB');

  // zip 打包：无外部依赖，用最简 STORED（无压缩）实现足够（8MB 上限内可控）
  // —— 但 ZIP_STORED 手写 CRC 代码量大；改走系统 PowerShell？不行（跨平台）。
  // 实际方案：借 node:zlib 的 deflateRaw 打 deflate 条目（本地自实现 zip writer）。
  const { deflateRawSync } = await import('node:zlib');
  const chunks = [];
  const central = [];
  let offset = 0;
  const crc32 = makeCrc32();
  for (const f of files) {
    const data = fs.readFileSync(f.fp);
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 6 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    // local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);            // version needed
    lfh.writeUInt16LE(0, 6);             // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);            // time
    lfh.writeUInt16LE(0x21, 12);         // date（固定合法值即可）
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, payload);

    central.push({ nameBuf, crc, method, compSize: payload.length, rawSize: data.length, offset });
    offset += lfh.length + nameBuf.length + payload.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);            // version made by
    cdh.writeUInt16LE(20, 6);            // version needed
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(c.method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(c.crc, 16);
    cdh.writeUInt32LE(c.compSize, 20);
    cdh.writeUInt32LE(c.rawSize, 24);
    cdh.writeUInt16LE(c.nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);            // extra len
    cdh.writeUInt16LE(0, 32);            // comment len
    cdh.writeUInt16LE(0, 34);            // disk number
    cdh.writeUInt16LE(0, 36);            // internal attrs
    cdh.writeUInt32LE(0, 38);            // external attrs
    cdh.writeUInt32LE(c.offset, 42);
    chunks.push(cdh, c.nameBuf);
    offset += cdh.length + c.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  const out = Buffer.concat(chunks);
  if (out.length > MAX_ZIP_BYTES) throw new Error(`压缩包超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB 上限（当前 ${Math.round(out.length / 1024 / 1024)}MB）`);
  return out;
}

/** CRC32（IEEE）—— zip 条目必需。 */
function makeCrc32() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
}

/**
 * 口令校验（批量）：codes → [{ code, ok, name, author, type, ... }]。
 */
export async function verifyInstallCodes(codes) {
  const data = await marketFetch('/install/verify', { method: 'POST', json: { codes } });
  if (!Array.isArray(data?.results)) throw new Error('口令校验响应异常');
  return data.results;
}

/**
 * 按口令下载并安装到本地 skills/ 或 plugins/。
 * 类型路由由**服务器返回的 type** 决定（skill.json→skill / plugin.json→plugin），
 * 前端/调用方无法干预 —— 即使在技能页输入了插件的口令，也装进 plugins/。
 *
 * @param {object} o { code, verified(校验阶段拿到的条目信息) }
 * @returns {Promise<{ok, kind, id, dir}>}
 */
export async function installByCode({ code, verified }) {
  const entry = verified && verified.ok ? verified : null;
  const type = String(entry?.type || '').toLowerCase() === 'plugin' ? 'plugin' : 'skill';
  // 先下载（没传 verified 也重新校验一次拿 type —— 不信任何本地猜测）
  const ident = entry?.id;
  const res = await fetch(`${MARKET_API_BASE}/install/${encodeURIComponent(String(code).trim().toUpperCase())}/download`, {
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // HTML 错误页 = nginx/网关层拦截（应用层错误是 JSON）；给出可排查的提示
    const why = /<\/?[a-z][^>]*>/i.test(text) ? friendlyMarketError(res) : (text.slice(0, 120) || `HTTP ${res.status}`);
    throw new Error(`下载失败：${why}`);
  }
  const zipBuffer = Buffer.from(await res.arrayBuffer());
  if (zipBuffer.length > MAX_ZIP_BYTES) throw new Error('安装包超过 8MB 上限');
  const { unzipToModuleDir, validateZipStructure } = await import('./zip-install.js');
  validateZipStructure(zipBuffer);
  const dirName = await unzipToModuleDir(zipBuffer, { root: ROOT, type, preferId: ident });
  log('info', `口令 ${code} 安装完成：${type}s/${dirName}`);
  return { ok: true, kind: type, id: dirName, dir: path.join(ROOT, type === 'plugin' ? 'plugins' : 'skills', dirName) };
}
