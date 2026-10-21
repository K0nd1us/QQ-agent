// QQ 在线状态（在线 / 请勿打扰 …）的设置与记账。
//
// 为什么需要"记账"：SnowLuma 只实现了 `set_online_status`，**没有** `get_online_status`
// （实测 1404 unknown action），所以"启动时检测到是请勿打扰"没法问协议端 —— 只能自己记：
// 我们设过 DND 就写进 data/presence.json，下次启动读到 dnd=true 再改回在线。
//
// 状态码是 QQ 协议里的整数（NapCat 约定）：
//   10 在线 / 30 离开 / 40 隐身 / 50 忙碌 / 60 Q我吧 / 70 请勿打扰
// 具体值可在 config.presence 里改。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

const FILE = path.join(DATA_DIR, 'presence.json');
const AUDIT = path.join(DATA_DIR, 'presence.log');

/**
 * 审计一行到 data/presence.log。
 * 为什么要这个文件：插件的 api.log 走 console.log，而宿主**不落盘**插件的 console 输出
 * （只有核心的 logger 会写 data/logs/），所以"关闭前设 DND 了吗 / 上线恢复了吗"没有持久证据。
 * 这里自己追加一行，任何一条链路都可事后追溯。
 */
function audit(line) {
  try {
    const stamp = new Date().toLocaleString('sv-SE');   // yyyy-MM-dd HH:mm:ss（本地时区）
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT, `${stamp}  ${line}\n`, 'utf8');
  } catch { /* 审计失败不影响功能 */ }
}

// ── 失败去重：连续同因失败只记第一条，重复次数折进下一条日志 ──────────────────────
// 为什么需要：插件上线恢复要重试（app 常比 SnowLuma 先就绪），原来每次重试都写一行，
// 一次启动能刷十几到二十行 FAIL，把审计刷得没法看。现在一次失败潮只留两行：
//   08:16:43  FAIL status=10 source=plugin-activate → ECONNREFUSED …
//   08:17:25  OK   status=10（在线） source=plugin-activate（此前相同失败重复 13 次，约 42 秒，已省略）
const FAIL_WINDOW_MS = 10 * 60 * 1000;
let failStreak = { key: '', count: 0, at: 0 };

/** 取出上一串失败的"折叠说明"（超过 10 分钟就不再挂到新日志上，免得张冠李戴） */
function takeFailNote() {
  const { count, at } = failStreak;
  failStreak = { key: '', count: 0, at: 0 };
  if (count > 1 && at && Date.now() - at < FAIL_WINDOW_MS) {
    return `（此前相同失败重复 ${count - 1} 次，约 ${Math.round((Date.now() - at) / 1000)} 秒，已省略）`;
  }
  return '';
}

/** 记一次失败：同因连续失败只累计不写盘，换原因时才把上一串的计数折进新行 */
function noteFailure(key, statusCode, source, message) {
  if (failStreak.key === key) {
    failStreak.count += 1;
    return;
  }
  const note = takeFailNote();
  audit(`FAIL status=${statusCode} source=${source || '-'} → ${message}${note}`);
  failStreak = { key, count: 1, at: Date.now() };
}


/** 由 app.js 在启动时注入 OneBot 客户端（避免这个模块反向依赖 app）。 */
let client = null;
export function setPresenceClient(onebot) {
  client = onebot || null;
}

export function presenceFile() {
  return FILE;
}

function cfg() {
  return getConfig()?.presence || {};
}

function codes() {
  const c = cfg();
  return {
    dnd: Number.isFinite(Number(c.dndStatus)) ? Number(c.dndStatus) : 70,
    online: Number.isFinite(Number(c.onlineStatus)) ? Number(c.onlineStatus) : 10
  };
}

/** 读记账；没有文件/解析失败都返回 null。 */
export function getPresence() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writePresence(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function clearPresence() {
  try {
    fs.rmSync(FILE, { force: true });
  } catch { /* 删不掉也不影响 */ }
}

async function applyStatus(statusCode, source) {
  if (!client || typeof client.call !== 'function') {
    const message = 'OneBot 客户端不可用（还没注入或连接已断）';
    noteFailure(`${statusCode}|${source}|${message}`, statusCode, source, message);
    return { ok: false, error: message };
  }
  try {
    await client.call('set_online_status', { status: statusCode, ext_status: 0, battery_status: 100 }, 8000);
    const isDnd = statusCode === codes().dnd;
    writePresence({ status: statusCode, dnd: isDnd, at: Date.now(), source: source || '' });
    audit(`OK   status=${statusCode}${isDnd ? '（请勿打扰）' : statusCode === codes().online ? '（在线）' : ''} source=${source || '-'}${takeFailNote()}`);
    return { ok: true, status: statusCode };
  } catch (error) {
    const message = String(error?.message ?? error);
    noteFailure(`${statusCode}|${source}|${message}`, statusCode, source, message);
    return { ok: false, error: message };
  }
}

/**
 * 设置在线状态。`which` 可以是 'dnd' | 'online' | 具体数字。
 * dnd=true 时会写记账文件，供下次启动恢复用。
 */
export async function setPresence(which, { source = '' } = {}) {
  const c = codes();
  const num = which === 'dnd' ? c.dnd : which === 'online' ? c.online : Number(which);
  if (!Number.isFinite(num) || num === 0) {
    return { ok: false, error: `无效的状态值：${which}（用 'dnd' / 'online' / 协议整数）` };
  }
  return applyStatus(num, source);
}

/**
 * 启动时用：如果上次是"我们设的请勿打扰"，就改回在线。
 * 不是 DND（或没有记账）时什么都不做 —— 绝不去动用户手动设的状态。
 */
export async function restoreIfDnd({ source = 'startup' } = {}) {
  const st = getPresence();
  if (!st || st.dnd !== true) return { restored: false, reason: st ? 'not-dnd' : 'no-record' };
  const c = codes();
  const r = await applyStatus(c.online, source);
  if (r.ok) {
    // 恢复成功后清掉记账：下次启动不再重复恢复
    clearPresence();
    return { restored: true, from: st.status ?? null, to: c.online };
  }
  return { restored: false, reason: r.error };
}

/** 现在的"应该是什么状态"（给界面/接口看） */
export function presenceSummary() {
  const c = codes();
  return { config: { ...cfg(), dndStatus: c.dnd, onlineStatus: c.online }, record: getPresence(), file: FILE, audit: AUDIT };
}
