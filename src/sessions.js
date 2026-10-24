// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
// 索引缓存：启动加速的关键。没有它时 #loadIndex 要逐个 readFileSync+JSON.parse
// 全部会话文件（用户实测 2277 个文件 / 178MB 要 25 秒）；有了它启动只读这一个
// ~0.5MB 的单文件（3ms 级）。缓存与磁盘文件的增量校验在后台异步做（见
// reconcileInBackground），所以缓存缺失/过期都只是"首次启动慢"，不会错。
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'session-index-cache.json');
const INDEX_CACHE_VERSION = 1;
// 僵尸回收窗口：上次进程异常退出遗留的 running/waiting 会话只会出现在
// **最近修改**的文件里（运行中的会话每 2 秒节流落盘一次）。启动时只扫
// 最近 ZOMBIE_SCAN_WINDOW_DAYS 天的文件就足够，老文件几乎不可能是僵尸——
// 全量扫 2000+ 文件只为找几个僵尸太亏。
const ZOMBIE_SCAN_WINDOW_DAYS = 3;
// 变更后写缓存的防抖间隔：写缓存本身也是 ~0.5MB 的同步 IO，不值得每次
// update 都写。掉电最坏情况 = 缓存落后几秒，下次启动靠后台对账/补读修正。
const INDEX_CACHE_WRITE_DEBOUNCE_MS = 5000;

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

  /**
   * 运行时改保留上限（配置里改了 keepSessionFiles 要立即生效）。
   * 原来是"只在构造时读一次"，导致用户在设置页改了这个值后，
   * 要重启才生效 —— 磁盘上的会话文件会一直按旧值（默认 0 = 不限）增长。
   */
  setKeepFiles(keepFiles) {
    const next = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.keepFiles = next;
    if (next > 0) {
      this.index = this.index.slice(0, next);
      this.#pruneFiles();
    }
    this.#scheduleIndexCacheWrite(0);
  }

  /** 按 keepFiles 清理磁盘上的旧会话文件（保留最新 N 个）。 */
  #pruneFiles() {
    if (!(this.keepFiles > 0)) return;
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // 运行中/等待中的会话文件不在删除范围：UI 还指着它，删了会出现"详情 404"
      const activeIds = new Set(
        [...(this.current?.values?.() ?? [])].map((s) => String(s?.id ?? '')).filter(Boolean)
      );
      for (const f of files.slice(this.keepFiles)) {
        if (activeIds.has(f.replace(/\.json$/, ''))) continue;
        try { fs.rmSync(path.join(SESSIONS_DIR, f), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  #loadIndex() {
    // ── 快路径：读索引缓存（单文件，毫秒级）──
    // 缓存条目 = 磁盘上全部会话的 summary；启动直接用它当 this.index，
    // 后台再异步对账（#rebuildIndexInBackground）修正差异（外部删文件/
    // 缓存写坏/版本变更）。任何缓存问题都会在几秒后被真值覆盖。
    let diskFiles = null;
    try {
      diskFiles = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch { /* 目录还没建 */ }
    if (diskFiles) {
      const cached = this.#readIndexCache();
      if (cached && Array.isArray(cached.entries)) {
        const cachedIds = new Set(cached.entries.map((e) => e?.id).filter(Boolean));
        // 只保留磁盘上确实存在的条目（外部删了文件/清理脚本跑过）
        this.index = cached.entries.filter((e) => diskFiles.includes(`${e.id}.json`));
        // 磁盘上有、缓存里没有的文件（缓存之后新产生的）→ 同步补读
        // 通常很少（上次运行结束到缓存写入之间的窗口），大量缺失走后台
        const missing = diskFiles.filter((f) => !cachedIds.has(f.replace(/\.json$/, '')));
        if (missing.length > 0 && missing.length <= 200) {
          for (const f of missing) this.#loadOne(f, /* zombieScan */ false);
          this.#sortIndex();
        } else if (missing.length > 200) {
          // 大量缺失（换数据目录/缓存超老）：直接走慢路径全量读
          this.index = [];
          this.#loadAll(diskFiles);
        } else {
          this.#sortIndex();
        }
        // 僵尸回收单独小窗口扫（见 ZOMBIE_SCAN_WINDOW_DAYS 注释）
        this.#reclaimZombies(diskFiles);
        this.#writeIndexCache();
        return;
      }
    }
    // ── 慢路径：无缓存（首次/缓存损坏）── 全量读 + 写缓存
    if (diskFiles) this.#loadAll(diskFiles);
    this.#writeIndexCache();
  }

  /** 全量读磁盘文件建索引（慢路径，与旧版 #loadIndex 行为一致）。 */
  #loadAll(diskFiles) {
    for (const f of diskFiles) this.#loadOne(f, /* zombieScan */ false);
    this.#reclaimZombies(diskFiles);
    this.#sortIndex();
  }

  /** 读单个会话文件进索引。zombieScan=true 时顺带做僵尸回收写回。 */
  #loadOne(file, zombieScan) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      if (!data?.id) return;
      if (zombieScan && (data.status === 'running' || data.status === 'waiting')) {
        // 僵尸会话回收：进程上次退出时正在运行/等待的会话，运行循环已不存在，
        // 状态却停留在 running/waiting —— UI 里既不结束也无法中止（中止按钮
        // 找不到活对象）。这里启动即改判 aborted 并写回文件，让会话页能看到
        // 真实状态。不改内存 current（启动时它是空的，这些会话本来就不在其中）。
        data.status = 'aborted';
        data.endedAt = data.endedAt ?? Date.now();
        data.abortedOnBoot = true;   // 标记来源，UI/排障能分清"用户中止"和"重启遗留"
        try { fs.writeFileSync(path.join(SESSIONS_DIR, file), JSON.stringify(data)); } catch { /* 写不回就只改内存视图 */ }
      }
      this.index.push(this.#summary(data));
    } catch { /* 跳过坏文件 */ }
  }

  /** 僵尸回收：只扫最近 ZOMBIE_SCAN_WINDOW_DAYS 天改过的文件。 */
  #reclaimZombies(diskFiles) {
    const cutoff = Date.now() - ZOMBIE_SCAN_WINDOW_DAYS * 86400000;
    for (const f of diskFiles) {
      try {
        const st = fs.statSync(path.join(SESSIONS_DIR, f));
        if (st.mtimeMs >= cutoff) {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          if (data?.id && (data.status === 'running' || data.status === 'waiting')) {
            data.status = 'aborted';
            data.endedAt = data.endedAt ?? Date.now();
            data.abortedOnBoot = true;
            try { fs.writeFileSync(path.join(SESSIONS_DIR, f), JSON.stringify(data)); } catch { /* ignore */ }
            // 索引里对应条目同步改状态（可能已因 #loadOne 进表）
            const idx = this.index.findIndex((e) => e.id === data.id);
            if (idx >= 0) this.index[idx] = this.#summary(data);
            else this.index.push(this.#summary(data));
          }
        }
      } catch { /* 跳过 */ }
    }
  }

  #sortIndex() {
    this.index.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  /** 读索引缓存；版本不匹配/损坏返回 null。 */
  #readIndexCache() {
    try {
      const data = JSON.parse(fs.readFileSync(INDEX_CACHE_FILE, 'utf8'));
      if (data?.version === INDEX_CACHE_VERSION && Array.isArray(data.entries)) return data;
    } catch { /* 无缓存/坏缓存 */ }
    return null;
  }

  /** 写索引缓存（写前剔除运行中的：它们还没落成最终态，写进去是过期视图）。 */
  #writeIndexCache() {
    try {
      const currentIds = new Set(this.current.keys());
      const entries = this.index.filter((e) => !currentIds.has(e.id));
      const tmp = `${INDEX_CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: INDEX_CACHE_VERSION, savedAt: Date.now(), entries }), 'utf8');
      fs.renameSync(tmp, INDEX_CACHE_FILE);
    } catch { /* 写缓存失败不影响功能 */ }
  }

  /**
   * 防抖写缓存：索引有变动时调这个，而不是直接 #writeIndexCache ——
   * 运行中的会话每次 update 都会改索引条目，逐次写 0.5MB 同步 IO 太亏。
   * flushIndexCache()（进程退出前）会立刻落盘。
   */
  #scheduleIndexCacheWrite(delay = INDEX_CACHE_WRITE_DEBOUNCE_MS) {
    if (this.#indexCacheTimer) clearTimeout(this.#indexCacheTimer);
    this.#indexCacheTimer = setTimeout(() => {
      this.#indexCacheTimer = null;
      this.#writeIndexCache();
    }, delay);
    this.#indexCacheTimer.unref?.();
  }
  #indexCacheTimer = null;

  /** 立即落盘缓存（stop() 调用；清掉防抖定时器当场写）。 */
  flushIndexCache() {
    if (this.#indexCacheTimer) { clearTimeout(this.#indexCacheTimer); this.#indexCacheTimer = null; }
    this.#writeIndexCache();
  }

  /**
   * 后台对账：异步全量重扫磁盘，修正缓存路径可能漏掉的差异
   * （运行中被外部删文件、缓存写入竞态等）。启动毫秒级返回，对账在
   * 事件循环空闲时进行，不阻塞请求。
   * @returns {Promise<void>} 完成时 resolve（供测试等待）
   */
  reconcileInBackground() {
    if (this.#reconcileStarted) return Promise.resolve();
    this.#reconcileStarted = true;
    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          const diskFiles = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
          const known = new Set(this.index.map((e) => `${e.id}.json`));
          let changed = false;
          for (const f of diskFiles) {
            if (known.has(f)) continue;
            // 缓存里没有的新文件（上一进程运行后期产生的）
            this.#loadOne(f, /* zombieScan */ true);
            changed = true;
          }
          // 缓存里有、磁盘上没有的（外部删除）→ 摘掉
          const diskSet = new Set(diskFiles);
          const filtered = this.index.filter((e) => diskSet.has(`${e.id}.json`));
          if (filtered.length !== this.index.length) { this.index = filtered; changed = true; }
          if (changed) {
            this.#sortIndex();
            this.#writeIndexCache();
          }
        } catch { /* 对账失败保持现状 */ }
        resolve();
      });
    });
  }
  #reconcileStarted = false;

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
    this.#scheduleIndexCacheWrite();
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
    this.#scheduleIndexCacheWrite();
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
    this.#scheduleIndexCacheWrite();
    return this.index.length < before;
  }

  /**
   * 主动删除一条会话记录（含已结束的）。
   * 与 discard 的区别：discard 只允许删"等待中"的（保护用量记录）；
   * remove 是用户主动清理历史，允许删任何状态，但**不删正在运行的**（那会丢账）。
   * @returns {boolean} 是否真的删了
   */
  remove(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 正在运行的会话不能删（usage 还在累加，删了账就乱了）；等待中的可以
    if (s && s.status === 'running') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    this.#scheduleIndexCacheWrite();
    return this.index.length < before;
  }

  /**
   * 清空全部已结束的会话记录（保留正在运行/等待的）。
   * @returns {number} 删掉了多少条
   */
  clearFinished() {
    const keepIds = new Set();
    for (const [id, s] of this.current) {
      if (s && (s.status === 'running' || s.status === 'waiting')) keepIds.add(id);
    }
    let removed = 0;
    const remaining = [];
    for (const e of this.index) {
      if (keepIds.has(e.id)) { remaining.push(e); continue; }
      removed++;
      try {
        const f = path.join(SESSIONS_DIR, `${e.id}.json`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
    this.index = remaining;
    this.#scheduleIndexCacheWrite();
    return removed;
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
    /* 零消耗会话（aborted 的等待会话：从未调用模型、token 全 0）不计 runs，
       否则"今日运行次数"会被暂停/未命中等中止事件虚增，与 LLM 调用次数脱节。 */
    if ((Number(s.usage?.calls) || 0) === 0 && (Number(s.usage?.totalTokens) || 0) === 0) return;
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
