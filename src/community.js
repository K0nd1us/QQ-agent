// QQ Agent 社区能力：固定远程价格表、云端共享屏蔽名单。
// 云端名单失败时回退本地配置，避免网络抖动让机器人失去屏蔽能力。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, getConfig, updateConfig, FIXED_PRICE_REMOTE_URL } from './config.js';

export const FIXED_PRICE_FEED_URL = FIXED_PRICE_REMOTE_URL;
const COMMUNITY_KEY_FILE = path.join(ROOT, 'community.key');
export const COMMUNITY_API_BASE = 'https://www.kondius.cn/api/community';
/**
 * 云端名单写入密钥（只有"删除/整体覆盖"用得到）。
 * 优先级：环境变量 QQ_AGENT_COMMUNITY_KEY（显式设为空 = 明确不用密钥）> 项目根 community.key。
 * 注意：这份密钥只给管理员本机用，绝不能打进分发给别人的安装包。
 */
function communityWriteKey() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'QQ_AGENT_COMMUNITY_KEY')) {
    return String(process.env.QQ_AGENT_COMMUNITY_KEY || '').trim();
  }
  try { return fs.readFileSync(COMMUNITY_KEY_FILE, 'utf8').trim(); } catch { return ''; }
}
const BLOCKLIST_CACHE_FILE = path.join(DATA_DIR, 'cloud-global-blocklist.json');
const FETCH_TIMEOUT_MS = 8000;
let blocklist = new Set();
let loaded = false;
let syncPromise = null;

/**
 * 规范化 QQ 号列表。
 * ⚠️ 用 1~12 位宽松校验，不要收紧成"真实 QQ 号 5 位起"：
 *   配置/接口里出现的短号码也必须照样生效，收紧了会静默丢掉屏蔽项。
 *   服务端对共享名单另有 5~12 位校验（真实 QQ 号范围）。
 */
function normalizeIds(value) {
  const input = Array.isArray(value) ? value : [];
  return [...new Set(input.map((x) => String(x ?? '').trim()).filter((x) => /^\d{1,12}$/.test(x)))].slice(0, 20000);
}

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BLOCKLIST_CACHE_FILE, 'utf8'));
    const ids = normalizeIds(parsed?.ids);
    if (ids.length || Array.isArray(parsed?.ids)) blocklist = new Set(ids);
  } catch { /* 首次运行没有缓存 */ }
}

function writeCache(ids) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${BLOCKLIST_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ids, fetchedAt: Date.now() }), 'utf8');
    fs.renameSync(tmp, BLOCKLIST_CACHE_FILE);
  } catch { /* 缓存失败不影响在线名单 */ }
}

async function request(pathname, options = {}) {
  const key = communityWriteKey();
  const headers = { accept: 'application/json', 'content-type': 'application/json', ...(options.headers || {}) };
  if (key && options.method && options.method !== 'GET') headers['X-Community-Key'] = key;
  const res = await fetch(`${COMMUNITY_API_BASE}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* below */ }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/**
 * 本机豁免名单：无管理密钥时"本机解除屏蔽"的持久化载体。
 *
 * ⚠️ 为什么需要：keyless 解除只改本地，云端名单仍含该 id。曾经直接把
 *   config.globalBlocklist 改成"移除后的集合"，但 5 分钟一次的
 *   syncGlobalBlocklist({pushLocal}) 发现它与云端不一致就用云端整体覆盖 ——
 *   本机解除被悄悄回滚。豁免名单存在独立字段 communityExemptions，
 *   同步流程不写它，解除因此能跨同步存活。
 */
function getCommunityExemptions() {
  return normalizeIds(getConfig().communityExemptions);
}

export function getCommunityExemptionsForTest() {
  return getCommunityExemptions();
}

/**
 * 当前生效的全局屏蔽名单 = （云端集合 ∪ 当前配置里的 globalBlocklist） − 本机豁免。
 *
 * ⚠️ 必须每次都读一遍当前配置，不能只在首次加载时快照：
 *   运行中通过控制台/接口改 globalBlocklist（以及测试里改配置）必须立即生效，
 *   否则会出现"设置里明明拉黑了、消息还是被处理"的回归。
 *   取并集（而非云端覆盖本地）是刻意的 fail-closed：云端拉不到时宁可多拦。
 */
export function getGlobalBlocklist() {
  if (!loaded) {
    readCache();
    loaded = true;
  }
  const fromConfig = normalizeIds(getConfig().globalBlocklist);
  const exemptions = new Set(getCommunityExemptions());
  const merged = fromConfig.length
    ? [...new Set([...blocklist, ...fromConfig])]
    : [...blocklist];
  return merged.filter((id) => !exemptions.has(id));
}

export function isGloballyBlocked(userId) {
  return getGlobalBlocklist().includes(String(userId ?? ''));
}

export async function syncGlobalBlocklist({ pushLocal = true } = {}) {
  const local = getGlobalBlocklist();
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const remote = await request('/blocklist');
    let ids = normalizeIds(remote?.ids);
    // 首次部署时云端可能为空，而本地已有用户维护的名单：优先尝试把它迁移上云。
    if (!ids.length && local.length) {
      try {
        // 首次部署迁移：把本机已有名单追加进云端（公开接口即可，无需密钥）。
        const seeded = await request('/blocklist/add', { method: 'POST', body: JSON.stringify({ ids: local }) });
        ids = normalizeIds(seeded?.ids ?? local);
      } catch { ids = local; }
    }
    // 没有写入密钥时，空云端名单不能抹掉本地已有名单。
    if (!ids.length && local.length && !communityWriteKey()) ids = local;
    blocklist = new Set(ids);
    writeCache(ids);
    // 本地配置只作兼容缓存；主数据源是云端。
    if (pushLocal) {
      const old = normalizeIds(getConfig().globalBlocklist);
      if (old.join(',') !== ids.join(',')) updateConfig({ globalBlocklist: { __replace__: ids } });
    }
    return ids;
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

/**
 * 更新云端共享屏蔽名单。
 *
 * 分工（重要）：
 *   · 追加屏蔽走公开接口 POST /blocklist/add —— 每个安装实例都能举报骚扰者，
 *     共享名单才真的"一个群拉黑，所有群生效"。
 *   · 删除/整体覆盖必须带管理密钥 PUT /blocklist —— 否则任何访客都能清空名单。
 *   · 没有密钥时，删除只在本机生效，并返回 warning 让上层提示用户。
 */
export async function updateGlobalBlocklist(ids, { mode = 'replace' } = {}) {
  const local = getGlobalBlocklist();
  const next = normalizeIds(ids);
  const key = communityWriteKey();

  let desired;
  if (mode === 'add') desired = [...new Set([...local, ...next])];
  else if (mode === 'remove') { desired = new Set(local); for (const id of next) desired.delete(id); desired = [...desired]; }
  else desired = next;

  const desiredSet = new Set(desired);
  const toAdd = desired.filter((id) => !local.includes(id));
  const toRemove = local.filter((id) => !desiredSet.has(id));

  let actual = local;
  if (toAdd.length) {
    const res = await request('/blocklist/add', { method: 'POST', body: JSON.stringify({ ids: toAdd }) });
    actual = normalizeIds(res?.ids ?? [...new Set([...local, ...toAdd])]);
  }
  let warning = '';
  if (toRemove.length) {
    // 密钥缺失或无效时**不报错中断**：本机照常解除，但要说清云端仍会屏蔽这些号码。
    try {
      if (!key) throw new Error('no-key');
      const res = await request('/blocklist', { method: 'PUT', body: JSON.stringify({ ids: desired }) });
      actual = normalizeIds(res?.ids ?? desired);
    } catch {
      actual = actual.filter((id) => !toRemove.includes(id));
      warning = '本机已解除屏蔽，但云端移除需要有效的社区管理密钥，其它实例仍会屏蔽这些号码';
      // keyless 解除写进持久化豁免名单（独立字段，不会被 5 分钟一次的
      // 云端同步覆盖 —— 曾经写 globalBlocklist，下个同步周期就被回滚）
      const exemptions = new Set(getCommunityExemptions());
      for (const id of toRemove) exemptions.add(id);
      updateConfig({ communityExemptions: { __replace__: [...exemptions] } });
    }
  }

  blocklist = new Set(actual);
  writeCache(actual);
  updateConfig({ globalBlocklist: { __replace__: actual } });
  if (warning) console.warn(`[community] ${warning}`);
  return { ids: actual, warning };
}

export function startCommunitySync(log = console.warn) {
  getGlobalBlocklist();
  syncGlobalBlocklist({ pushLocal: true }).catch((e) => log('[community] 云端屏蔽名单同步失败:', e?.message ?? e));
  return setInterval(() => {
    syncGlobalBlocklist({ pushLocal: true }).catch((e) => log('[community] 云端屏蔽名单同步失败:', e?.message ?? e));
  }, 5 * 60 * 1000);
}

export function setCommunityApiBaseForTest() { return COMMUNITY_API_BASE; }
