// 会话缓冲（"沉默为界"的思考链延续，2026-10-03 ②P1）。
//
// 背景：本项目原本是"每次触发 = 全新会话"，LLM 层面零历史 —— 单次成本恒定，
// 但机器人**自己的思考/私有状态**也随每轮蒸发（海龟汤这类"暗牌"任务完全不可用）。
//
// 本模块提供一个按 chatKey 维护的"活跃会话缓冲"：
//   · 群里消息连续（两次交互间隔 < 沉默阈值）→ 继续同一会话：在已存 messages 上
//     **追加**增量，思考链天然留在上下文里；成本靠前缀缓存压住（追加 = 前缀
//     字节不变，命中缓存的部分按缓存价计费）。
//   · 沉默超阈值 / 系统提示或工具集变化 / 超轮次或体积上限 → 关闭缓冲，下次走
//     fresh（全新会话，行为与改动前完全一致）。
//
// ⚠️ 必须落盘：不能像 activeTopics 那样只放内存 —— 重启即丢会让"沉默为界"
//    在每次重启后退化成"每次全新会话"，白做。
//
// ⚠️ 前缀稳定的四个前提（任何一个破了，缓存收益就没了，甚至更贵）：
//    1. systemPrompt **逐字节复用**（存字符串、重发同一份）；
//    2. 工具集不变（工具定义在请求体里排在 messages 之前，一变全废）；
//    3. 只在数组尾部追加，绝不改写历史字节；
//    4. 历史条目里不带 `raw` 这类每轮都变的字段（见 orchestrator 的剥离逻辑）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { detectDialect } from './thinking.js';

const CONV_DIR = path.join(DATA_DIR, 'conversations');
// 陈旧缓冲的兜底清理：超过这个时长没有任何交互就直接丢弃（防文件无限堆积）。
// 注意这与"沉默阈值"是两回事 —— 沉默阈值决定"下次触发时是否续用"，这里只是
// 把永远不会再被用到的文件删掉。
const STALE_MS = 24 * 60 * 60 * 1000;
// sweep 的最小间隔（避免每轮都 readdir）。
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 各家前缀缓存的 TTL 口径（2026-10 查证），单位：分钟。
 * 沉默阈值应当贴着它取 —— 超过 TTL 之后缓存已经失效，"继续扛长上下文"严格劣于
 * "关会话重开"，所以阈值给到 TTL 就够，再长只是烧钱。
 *   Anthropic 5 分钟（命中刷新）、Qwen 显式 5 分钟、OpenAI ~5–10 分钟、
 *   DeepSeek 官方"数小时到数天"（不承诺固定 TTL，第三方实测报 ~10 分钟）、
 *   Gemini 隐式 24 小时（不保证命中）。
 * anthropic 取 4 而不是 5：TTL 从"发起请求"起算、**生成耗时也计入**，
 * 留 1 分钟余量才不会在长回复后刚好踩空。
 */
const SILENCE_MIN_BY_DIALECT = {
  anthropic: 4,
  qwen: 5,
  'openai-o': 8,
  deepseek: 60,
  gemini: 60
};
const DEFAULT_SILENCE_MIN = 5;   // 兜底：贴住最保守的主流 TTL

/**
 * 求本次生效的沉默阈值（毫秒）。
 *   continuation.silenceMinutes === 0      → 0（不按沉默切分，只靠轮次/体积上限兜底）
 *   continuation.silenceMinutes > 0        → 强制该值（分钟）
 *   未设 / null                            → 按渠道自动取值（见上表）
 */
export function resolveSilenceMs(cont = {}, api = {}) {
  const raw = cont?.silenceMinutes;
  if (raw === 0 || raw === '0') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n * 60_000;
  const det = detectDialect({ baseUrl: api?.baseUrl || '', model: api?.model || '' });
  const min = SILENCE_MIN_BY_DIALECT[det.dialect] ?? DEFAULT_SILENCE_MIN;
  return min * 60_000;
}

function safeName(chatKey) {
  return String(chatKey ?? '').replace(/[^a-z0-9_]/gi, '_');
}

function fileOf(chatKey) {
  return path.join(CONV_DIR, `${safeName(chatKey)}.json`);
}

/** 消息序列的字符数（体积预算的近似口径 —— 不引 tokenizer，够用）。 */
function countChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    const c = m?.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part?.text === 'string') n += part.text.length;
        else if (part?.image_url) n += 200;    // 图片按固定成本粗估
      }
    }
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) n += String(tc?.function?.arguments ?? '').length;
    }
  }
  return n;
}

export class ConversationStore {
  constructor() {
    /** chatKey -> buffer */
    this.cache = new Map();
    this.lastSweepAt = 0;
    try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch { /* 目录建不出来就算了 */ }
  }

  #load(chatKey) {
    try {
      const raw = JSON.parse(fs.readFileSync(fileOf(chatKey), 'utf8'));
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) return null;
      return {
        chatKey,
        systemPrompt: String(raw.systemPrompt ?? ''),
        toolNames: Array.isArray(raw.toolNames) ? raw.toolNames.map(String) : [],
        messages: raw.messages,
        turns: Number(raw.turns) || 0,
        chars: Number(raw.chars) || countChars(raw.messages),
        startedAt: Number(raw.startedAt) || 0,
        lastTurnAt: Number(raw.lastTurnAt) || 0
      };
    } catch {
      return null;   // 文件不存在 / 读坏 → 视为无缓冲
    }
  }

  /** 取某会话的活跃缓冲（没有则 null）。 */
  get(chatKey) {
    const key = String(chatKey ?? '');
    if (!key) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    const loaded = this.#load(key);
    if (loaded) this.cache.set(key, loaded);
    return loaded;
  }

  /**
   * 写入/更新缓冲。
   * @param {string} chatKey
   * @param {object} p
   * @param {string} p.systemPrompt  本轮实际使用的系统提示（下一轮要逐字节比对）
   * @param {string[]} p.toolNames   本轮实际可用的工具 id 列表
   * @param {Array} p.messages       **不含 system** 的消息序列（已剥 raw）
   * @param {number} p.turns         累计的用户轮数
   */
  save(chatKey, { systemPrompt, toolNames, messages, turns }) {
    const key = String(chatKey ?? '');
    if (!key) return null;
    const prev = this.cache.get(key) || this.#load(key);
    const buf = {
      chatKey: key,
      systemPrompt: String(systemPrompt ?? ''),
      toolNames: Array.isArray(toolNames) ? toolNames.map(String) : [],
      messages: Array.isArray(messages) ? messages : [],
      turns: Math.max(0, Number(turns) || 0),
      chars: countChars(messages),
      startedAt: Number(prev?.startedAt) || Date.now(),
      lastTurnAt: Date.now()
    };
    this.cache.set(key, buf);
    try {
      fs.mkdirSync(CONV_DIR, { recursive: true });
      const tmp = `${fileOf(key)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(buf), 'utf8');
      fs.renameSync(tmp, fileOf(key));
    } catch (error) {
      // 落盘失败不能让聊天主流程挂掉：内存里还有，只是重启后不续
      console.warn('[conversation] 会话缓冲落盘失败:', error?.message ?? error);
    }
    this.sweep();
    return buf;
  }

  /** 丢弃某会话的缓冲（手动「重开会话」/ 沉默关闭 / 任一前提不满足时调用）。 */
  clear(chatKey) {
    const key = String(chatKey ?? '');
    if (!key) return false;
    const had = this.cache.delete(key);
    try {
      fs.rmSync(fileOf(key), { force: true });
      return true;
    } catch {
      return had;
    }
  }

  /** 列出全部活跃缓冲（供 UI / 排障）。只读缓存 + 磁盘，不建索引。 */
  list() {
    const out = [];
    const seen = new Set();
    for (const [key, buf] of this.cache.entries()) {
      seen.add(key);
      out.push(this.#summary(buf));
    }
    try {
      for (const f of fs.readdirSync(CONV_DIR)) {
        if (!f.endsWith('.json')) continue;
        const key = f.replace(/\.json$/, '');
        if (seen.has(key)) continue;
        const buf = this.#load(key);
        if (buf) out.push(this.#summary(buf));
      }
    } catch { /* 目录不存在 */ }
    out.sort((a, b) => b.lastTurnAt - a.lastTurnAt);
    return out;
  }

  #summary(buf) {
    return {
      chatKey: buf.chatKey,
      turns: buf.turns,
      chars: buf.chars,
      messages: buf.messages.length,
      startedAt: buf.startedAt,
      lastTurnAt: buf.lastTurnAt
    };
  }

  /** 清理长时间未交互的缓冲文件（节流：最多每 SWEEP_INTERVAL_MS 跑一次）。 */
  sweep(now = Date.now(), maxIdleMs = STALE_MS) {
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return 0;
    this.lastSweepAt = now;
    let removed = 0;
    try {
      for (const f of fs.readdirSync(CONV_DIR)) {
        if (!f.endsWith('.json')) continue;
        const key = f.replace(/\.json$/, '');
        const buf = this.cache.get(key) || this.#load(key);
        if (!buf) continue;
        if (now - (Number(buf.lastTurnAt) || 0) < maxIdleMs) continue;
        this.cache.delete(key);
        try { fs.rmSync(path.join(CONV_DIR, f), { force: true }); removed += 1; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return removed;
  }
}

/** 工具集是否一致（顺序无关，但集合必须完全相同）。 */
export function sameToolNames(a, b) {
  const x = Array.isArray(a) ? a.map(String).slice().sort() : [];
  const y = Array.isArray(b) ? b.map(String).slice().sort() : [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
