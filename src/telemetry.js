// 匿名用量遥测：周期性把"调用次数 + token 用量"快照发到 kondius.cn，供官网做总览统计。
//
// 隐私红线：payload 只有 随机 installId + 版本号 + 四个计数器。
//   不含 QQ 号、群号、昵称、聊天内容、机器信息、IP（IP 只在服务器内存里做限流，不落库）。
// 去重原理：服务器按 installId 覆盖式 upsert —— 同一客户端无论发多少次都只算一份，
//   彻底避免"一个用户的客户端发送多份"。覆盖安装/重装系统后 data 目录还在 → installId 不变。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ROOT } from './config.js';

const REPORT_URL = 'https://kondius.cn/qq-agent/api/telemetry';
const INTERVAL_MS = 6 * 3600 * 1000;   // 之后每 6 小时一次
const FIRST_DELAY_MS = 90 * 1000;      // 启动 90 秒后发第一次（避开启动高峰）

const ID_FILE = path.join(DATA_DIR, 'telemetry.json');
const TOTALS_FILE = path.join(DATA_DIR, 'telemetry-totals.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

/** 一个会话里的 LLM 调用次数（与用量页同口径：带 token 用量的 raw 条目数）。 */
function countLlmCalls(s) {
  let n = 0;
  for (const m of (s?.messages || [])) {
    const ru = m?.raw?.usage || {};
    if ((Number(ru.prompt_tokens) || 0) + (Number(ru.completion_tokens) || 0) > 0) n += 1;
  }
  return n;
}

/**
 * 读累计总量；文件不存在（老用户升级后首次上报）就从历史会话文件重建一次。
 * 重建结果写回文件，之后的会话结束累加（sessions.js）会接着这个基数走。
 */
function loadTotals() {
  try { return JSON.parse(fs.readFileSync(TOTALS_FILE, 'utf8')); } catch { /* 需要重建 */ }
  const t = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} };
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((x) => x.endsWith('.json'))) {
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { continue; }
      const u = s.usage || {};
      t.calls += countLlmCalls(s);
      t.promptTokens += Number(u.promptTokens) || 0;
      t.completionTokens += Number(u.completionTokens) || 0;
      t.totalTokens += Number(u.totalTokens) || 0;
      for (const m of (s.messages || [])) {
        const name = m?.toolCall?.name;
        if (name) t.toolCounts[String(name)] = (t.toolCounts[String(name)] || 0) + 1;
      }
    }
  } catch { /* 目录都没有 */ }
  if (!t.calls) return null;
  try { fs.writeFileSync(TOTALS_FILE, JSON.stringify(t), 'utf8'); } catch { /* 下次再试 */ }
  return t;
}

/** 匿名安装 ID：随机 UUID，首次运行时生成并持久化，重装/覆盖安装不丢。 */
function installId() {
  try {
    const d = JSON.parse(fs.readFileSync(ID_FILE, 'utf8'));
    if (d?.installId) return String(d.installId);
  } catch { /* 首次运行 */ }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ID_FILE, JSON.stringify({ installId: id, createdAt: Date.now() }), 'utf8');
  } catch { /* 写失败就下次再试 */ }
  return id;
}

function appVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '');
  } catch { return ''; }
}

export async function report(log) {
  const totals = loadTotals();   // 没有用量（含重建后仍为空）就不报
  if (!totals || !Number(totals.calls)) return;
  // 工具调用明细：只留 [a-z0-9_] 形态的键、整数次数，最多 50 个键
  const toolCounts = {};
  for (const [k, v] of Object.entries(totals.toolCounts || {})) {
    const key = String(k).slice(0, 40);
    const n = Math.max(0, Number(v) | 0);
    if (/^[\w-]+$/.test(key) && n > 0 && Object.keys(toolCounts).length < 50) toolCounts[key] = n;
  }
  try {
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installId: installId(),
        version: appVersion(),
        calls: Math.max(0, Number(totals.calls) || 0),
        inputTokens: Math.max(0, Number(totals.promptTokens) || 0),
        outputTokens: Math.max(0, Number(totals.completionTokens) || 0),
        totalTokens: Math.max(0, Number(totals.totalTokens) || 0),
        tools: toolCounts
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) log(`[遥测] 上报返回 HTTP ${res.status}（不影响使用）`);
  } catch (e) {
    log(`[遥测] 上报失败（不影响使用）: ${e?.message ?? e}`);
  }
}

export function startTelemetryLoop(log = console.log) {
  const first = setTimeout(() => {
    report(log);
    const timer = setInterval(() => report(log), INTERVAL_MS);
    timer.unref?.();
  }, FIRST_DELAY_MS);
  first.unref?.();
}
