// 接话续聊窗口（follow-up）。
//
// 解决的问题：1 档（仅艾特）下，被 @ 之后群里接着聊的几句，它一句都不接会显得
// 很突兀；但不设限又会退化成 4 档那样一直插话。所以给一个**有限的续聊额度**：
// 被真正喊到（@ / 拍一拍 / 关键词命中 / 随机命中 / 4 档 / 私聊）时重置额度，
// 之后没人再喊它，它也允许自己接 maxTurns 次；额度用完或超过 windowMin 分钟
// 就退回"只认 @"。
//
// 注意：续聊本身**不会**重置额度（否则会无限连下去）；也不刷新时间窗
// （时间窗从最后一次"被喊到"算起），这样"接完两三句就停"才有确定性。
//
// 状态只放内存：重启后归零，等于"重新开始认 @"，与直觉一致。
import { getConfig } from './config.js';

/** chatKey -> { lastAt:number, used:number } */
const state = new Map();

function opts() {
  const f = getConfig().store?.followUp || {};
  const maxTurns = Number(f.maxTurns);
  const windowMin = Number(f.windowMin);
  return {
    enabled: f.enabled !== false,
    maxTurns: Number.isFinite(maxTurns) ? Math.max(0, Math.min(10, maxTurns)) : 3,
    windowMs: (Number.isFinite(windowMin) ? Math.max(0, windowMin) : 10) * 60_000
  };
}

/** 被真正喊到时调用：重置续聊额度与时间窗。 */
export function noteSummoned(chatKey, now = Date.now()) {
  const key = String(chatKey || '');
  if (!key) return;
  state.set(key, { lastAt: now, used: 0 });
}

/**
 * 没人喊它、但也许还能再接一句吗？
 * @returns {{used:number,max:number}|null} 占用成功返回第几次，null 表示不该接
 */
export function takeFollowUp(chatKey, now = Date.now()) {
  const o = opts();
  if (!o.enabled || o.maxTurns <= 0) return null;
  const key = String(chatKey || '');
  const s = state.get(key);
  if (!s) return null;
  if (now - s.lastAt > o.windowMs) {
    state.delete(key);
    return null;
  }
  if (s.used >= o.maxTurns) return null;
  s.used += 1;
  return { used: s.used, max: o.maxTurns };
}

/** 给 UI / 日志用：当前群的续聊状态。 */
export function followUpStatus(chatKey, now = Date.now()) {
  const o = opts();
  const s = state.get(String(chatKey || ''));
  if (!s || now - s.lastAt > o.windowMs) return { enabled: o.enabled, max: o.maxTurns, used: 0, left: o.maxTurns };
  return { enabled: o.enabled, max: o.maxTurns, used: s.used, left: Math.max(0, o.maxTurns - s.used) };
}

/** 测试用：清空全部状态。 */
export function resetFollowUpState() {
  state.clear();
}
