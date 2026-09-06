// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.#loadIndex();
  }

  #loadIndex() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // keepFiles=0 表示不限制，全部加载
      const pick = this.keepFiles > 0 ? files.slice(0, this.keepFiles) : files;
      for (const f of pick) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          if (data?.id) this.index.push(this.#summary(data));
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    if (this.keepFiles > 0) this.index = this.index.slice(0, this.keepFiles);
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    // 清理超出保留数的旧文件
    try {
      if (this.keepFiles > 0) {
        const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
        if (files.length > this.keepFiles) {
          for (const f of files.slice(0, files.length - this.keepFiles)) {
            try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
    return s;
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    return this.index.length < before;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    let webSearchCount = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
        webSearchCount = data.webSearchCount || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount };
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    const dayKey = localDayKey(s.startedAt);
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    data.promptTokens += s.usage.promptTokens;
    data.completionTokens += s.usage.completionTokens;
    data.totalTokens += s.usage.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + (Number(s.usage.cachedTokens) || 0);
    data.runs += 1;
    data.webSearchCount = (data.webSearchCount || 0) + (Number(s.webSearchCount) || 0);
    const tmp = path.join(DATA_DIR, 'usage-today.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));

    // 累计总量（匿名遥测的唯一数据源：调用次数 + 三档 token 数，无任何身份信息）
    try {
      const tPath = path.join(DATA_DIR, 'telemetry-totals.json');
      let t = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} };
      try { t = { ...t, ...JSON.parse(fs.readFileSync(tPath, 'utf8')) }; } catch { /* 首次 */ }
      // ⚠️ calls 的口径是「LLM 调用次数」（与用量页一致：带 token 用量的 raw 条目数），
      //    不是会话数；与 telemetry.js 的重建逻辑保持同一算法。
      let llmCalls = 0;
      for (const m of (s.messages || [])) {
        const ru = m?.raw?.usage || {};
        if ((Number(ru.prompt_tokens) || 0) + (Number(ru.completion_tokens) || 0) > 0) llmCalls += 1;
      }
      t.calls += llmCalls;
      t.promptTokens += s.usage.promptTokens;
      t.completionTokens += s.usage.completionTokens;
      t.totalTokens += s.usage.totalTokens;
      // 工具调用明细：会话结束时按消息里的 toolCall 逐个点名一次（与用量页同一口径）
      if (!t.toolCounts || typeof t.toolCounts !== 'object') t.toolCounts = {};
      for (const m of (s.messages || [])) {
        const name = m?.toolCall?.name;
        if (name) t.toolCounts[String(name)] = (t.toolCounts[String(name)] || 0) + 1;
      }
      fs.writeFileSync(tPath, JSON.stringify(t), 'utf8');
    } catch { /* 遥测记账失败不影响主流程 */ }
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < 2000) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  #persist(s) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
      fs.renameSync(tmp, sessionFile(s.id));
      if (s.status !== 'running' && s.status !== 'waiting') this.#bumpTodayUsage(s);
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
