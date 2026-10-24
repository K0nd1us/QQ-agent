// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【未读信息】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig, storeConfigForChat, personaForChat } from './config.js';
import { vendorOfConfig } from './model-prices.js';
import { randInt } from './util.js';
import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, isRetryableError } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
import { modelImageVerdict } from './vision-scan.js';
import { currentProviders } from './providers.js';
import { skillManager } from './skills/manager.js';
import { getToolAvailability } from './tool-registry.js';
import { rescueUnsentReply } from './reply-rescue.js';

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, emit = null, reminders = null, videoReader = null }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.reminders = reminders;   // ReminderStore（可选；闹钟/计时功能）
    this.videoReader = videoReader; // VideoReader（可选；视频读取功能）
    // 事件出口：正常情况下由 app.js 注入（转发到 SSE）。
    // 兜底必须是**明确的 no-op** —— 早先用 createEventBus() 兜底，
    // 但那个总线上永远没人订阅，事件会被静默吞掉，排查时看不到任何线索。
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.toolDefs = buildToolDefs();

    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    // 未读兜底定时器（2026-09-18）：1~3 档下"没触发会话"的散消息，
    // 窗口结束后若一直没有新消息来滚动重判，就在一个固定冷却后标为已读，
    // 免得存档页长期挂着一片假"未读"。有会话触发/有新消息时一律取消。
    this.unreadFallbackTimers = new Map(); // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    this.verifiedWakes = new Set();    // 本轮 wake 由 onIncoming 触发判定排定的 chatKey（区别于 drain 等机械重排）
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.sessionAbortMarks = new Set(); // 用户请求中止的 sessionId（abortSession 打标记，#runAgent 每轮检查）
    this.sessionAbortControllers = new Map(); // sessionId -> AbortController（中止时中断在途 LLM 请求）
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    // ── 活跃模式（chatActive）──
    // chatKey -> { topic, until }：活跃期状态（话题锚点 + 到期时间）。
    // 1/2/3 档触发响应且模型 finish 时带回 activeTopic → 进入活跃期：
    // 活跃期内该群的唤醒忽略档位判定（必响应），提示词注入话题锚点让模型
    // 自判"是否仍在话题上"，偏离/结束则 finish("话题结束") 退出活跃期。
    // 到期自动退出兜底（LLM 忘了判断也不会永远活跃）。
    this.activeTopics = new Map();
    // ── 提示词锚点（前缀缓存深化，2026-09-25）──
    // chatKey -> { readIds, readCount, memberIds }：上一轮发给模型的
    // 【记忆】+【已读信息】前缀状态。下一轮 buildUserPrompt 据此判断能否
    // 原样复用该前缀（连续触发时缓存命中）。#runAgent 结束时从
    // session.promptAnchorState 取回新状态。重启丢失 = 回到标准结构，无害。
    this.promptAnchors = new Map();
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.aborted = false;
    this.reminderTimer = null;         // 提醒调度定时器
    this.reminderFiring = new Set();   // 防止同一提醒并发触发
  }

  /**
   * 重新读取工具定义。
   *
   * 为什么需要它：构造函数里 `buildToolDefs()` 抓的是一次快照，
   * 而 Skill 是**启动之后**才加载的（loadPlugins 在 start() 里，晚于 Orchestrator 构造）。
   * 不刷新的话，Skill 注册的工具永远进不了会话的工具列表 —— 表现为
   * "插件加载成功但模型看不见"这种最难查的问题。
   * 热重载之后也要再调一次。
   */
  refreshToolDefs() {
    this.toolDefs = buildToolDefs();
    return this.toolDefs.length;
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
    }
  }

  /**
   * 手动重试一条失败的会话（会话页「重试」按钮）。
   *
   * ⚠️ 原地覆盖语义（2026-09-17 用户需求）：**复用同一个会话对象**，不新开。
   * 之前的做法是把触发消息翻回未读再 scheduleWake —— 那会创建一个全新会话，
   * 用户在会话页看到"旧的失败条目 + 新的成功条目"两条记录，账面（该看哪条）
   * 混乱。现在：直接把原会话重置回 running 状态、原对象重跑，全程同一个 id。
   *
   * 做法：恢复触发批（时间窗内翻回未读后重新 drain，拿到的就是当初那批消息）
   * → 复用与自动重试相同的 #resetSessionForRetry 清状态 → 重新走完整 wake 流程。
   * 唤醒流程里的"把等待会话转运行"分支会接住这个 running 状态的会话对象。
   *
   * ⚠️ 只有满足以下条件才允许重试：
   *   · 会话存在且状态是 error（aborted/noreply 不算失败，done 已成功）
   *   · 会话没有发出过任何消息（session.sent 为空）—— 已经说过话的
   *     重试会导致群里看到两遍一样的内容，宁可不允许
   *   · 该会话当前没有正在跑的新运行
   *
   * @returns {{ok:boolean, reason?:string, restored?:number}}
   */
  retrySession(sessionId) {
    const id = String(sessionId || '');
    // 先查 current（运行中/刚复活的），没有再查磁盘留档 —— finish() 会把会话
    // 从 current 移除，"已结束的失败会话"只在磁盘上。只查 current 的话，
    // 每次手动重试都会报"会话不存在"（2026-09-19 修）。
    const s = this.sessions.current.get(id) || this.sessions.get(id);
    if (!s) return { ok: false, reason: '会话不存在' };
    if (s.status !== 'error') return { ok: false, reason: '只有失败的会话才能重试' };
    if (Array.isArray(s.sent) && s.sent.length > 0) return { ok: false, reason: '该会话已发出过消息，重试会导致重复发言' };
    if (this.runningChats.has(s.chatKey)) return { ok: false, reason: '该会话正在运行中' };
    // 把触发批重新标记为未读（消息本体一直在存档里，只是当初被 drain 置了已读）。
    // triggerText 里的文本可能因改名/截断对不上，按会话起止时间窗恢复更稳。
    const restored = this.store.markUnreadInWindow(s.chatKey, s.startedAt, s.endedAt || s.startedAt);
    if (!restored) return { ok: false, reason: '触发消息已无法定位（时间窗内没有可恢复的消息）' };
    // ⚠️ 必须先从 current 注册表"复活"这个已结束的会话：
    // finish() 会把会话从 current 移除（get() 只剩磁盘读取的副本），
    // 后续 #runAgent / markActivity / abortSession 全都靠 current 里的活对象工作。
    // 复活 = 重新放回 current + 重置状态；磁盘文件会在下一次 update 覆盖。
    this.#resetSessionForRetry(s);
    s.status = 'running';
    s.endedAt = null;
    s.startedAt = Date.now();
    this.sessions.current.set(id, s);
    this.sessions.update(id);
    this.emit('session-update', id);
    this.scheduleWake(s.chatKey, 0, { reuseSessionId: id });
    return { ok: true, restored };
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /**
   * 收到新消息（已通过白名单校验并写入 store）。
   *
   * 触发语义（2026-09-25 重做）：**逐条判定，一次定生死**。
   * 每条消息入库后立即单独判定它是否触发会话（1 档：被@；2 档：被@/关键词；
   * 3 档：被@/关键词/命中概率；4 档：必定触发）：
   *   · 不触发 → 当场标已读（判定是纯本地计算，通常瞬间完成，
   *     表现为"未读一闪即已读"），消息沉入历史成为【已读信息】。
   *   · 触发   → 该消息保持未读，进入"等待中"倒计时（固定时长，不被重置）。
   *     倒计时内后续到达的消息**不再判定**，只入库置未读，到点后与触发消息
   *     一起被 drain 成【未读信息】。
   *
   * 倒计时不重置、不重新判定是刻意设计：触发消息 X 的判定结果代表"这一批
   * 的锚点"，窗口内追加判定会让"批的触发原因"随每条新消息漂移（reason
   * 与 contextLimit 对不上账）。窗口只是聚批，不是判定窗口。
   */
  onIncoming(chatKey, entry = null) {
    if (this.paused || this.aborted) return;
    // 运行中 / 倒计时中：消息保持未读（不判定、不重置），由会话结束的
    // drain 路径补判定（见 wake 末尾的 drain 注释）。
    if (this.runningChats.has(chatKey)) return;
    if (this.pendingWake.has(chatKey)) return;

    const cfg = getConfig();
    // 前置条件（与 wake 的闸门同口径，在这里提前拦截可以少建一次定时器）：
    //   模型未设置 → 消息保留未读，设置后（下一条消息或恢复积压）自动补处理
    if (!String(cfg.api.model || '').trim()) return;
    // 活跃期内的群：必响应，视作触发（与旧版"跳过判定"语义一致）
    const active = this.#activeState(chatKey);
    if (!active) {
      const tierResult = resolveContextTier({
        triggerEntries: entry ? [entry] : (this.store.peekUnread(chatKey, 1) || []),
        selfNickname: cfg.persona?.selfNickname || this.onebot.selfNickname || '',
        botName: cfg.persona?.botName || '',
        selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
        cfg: storeConfigForChat(chatKey),
        isPrivate: String(chatKey).startsWith('private:'),
        // 单条判定当场掷骰、当场出结果 —— 没有"预判/实跑"两阶段了，
        // 骰子结果由 resolveContextTier 的 reason 带回（含当时的值）。
        roll: null
      });
      if (!tierResult.shouldRespond) {
        // 不触发：这条消息立即标已读（只标这一条，不动窗口外已积压的未读——
        // 那些是上一批遗留，由兜底定时器/下一次触发处理）。
        if (entry) {
          this.store.markEntryRead(chatKey, entry.id);
        } else {
          this.store.markAllRead(chatKey);
        }
        this.emit('chat-update', chatKey);
        return;
      }
    }

    // 触发：进入固定的"等待中"倒计时（不重置）。verified 标记让 wake 知道
    // 这一批是"逐条判定出过触发消息"的，批边界可以信任等待会话的起点。
    this.scheduleWake(chatKey, null, { verified: true });
  }

  /**
   * 进入"等待中"倒计时并到点唤醒（2026-09-25 重做）。
   *
   * 旧版是"防抖聚批"：窗口内每来一条消息就重置倒计时、重跑预判。
   * 新版语义：
   *   · 倒计时长度固定（wakeDelayMs），进入后不被任何因素重置；
   *   · 窗口内新消息只入库（onIncoming 里 pendingWake 直接 return）；
   *   · 除非手动中止（abortSession/abortAll）或全局暂停，倒计时必然走完 → wake。
   * reuseSessionId（原地重试）与 drainBacklogAfterResume（恢复积压）仍走本函数，
   * 但它们是"已确定要跑"的调用，直接排定时器即可。
   */
  scheduleWake(chatKey, delay = null, { reuseSessionId = null, verified = false } = {}) {
    const ms = delay ?? Math.max(0, Number(getConfig().wakeDelayMs) || 2000);
    // 不可重置：已在倒计时中就不动它（唯一例外是原地重试——它进来时
    // pendingWake 一定没有该 chatKey，因为 runningChats 刚释放、旧定时器已到期）。
    if (this.pendingWake.has(chatKey)) return;
    this.pendingWake.add(chatKey);
    // verified = 本轮 wake 由 onIncoming 的"触发判定"排定（区别于 drain/积压恢复
    // 等机械重排）。wake 里据此决定是信任等待会话的批边界，还是对未读补判定 ——
    // 机械排定的批没有"触发过"的保证，必须重新逐条判定。
    if (verified) this.verifiedWakes.add(chatKey);

    const waitUntil = Date.now() + ms;
    // 创建/复用"等待中"会话（UI 可见）：触发摘要取当前未读第一条
    if (!reuseSessionId && !this.runningChats.has(chatKey)) {
      const unread = this.store.peekUnread(chatKey, 3);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        /* ⚠️ 必须用 current.get（活对象），不能用 get() ——
           get() 返回 structuredClone 副本，改副本后 update() 持久化的是
           未修改的活对象，等待会话的触发摘要将永远停留在第一条消息。 */
        const s = this.sessions.current.get(existing);
        if (s && s.status === 'waiting') {
          s.waitUntil = waitUntil;
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        const session = this.sessions.create({
          chatKey,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      this.emit('chat-update', chatKey);
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      const waitingId = this.pendingSessions.get(chatKey);
      this.pendingSessions.delete(chatKey);
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        this.verifiedWakes.delete(chatKey);
        return;
      }
      this.wake(chatKey, { waitingSessionId: waitingId ?? null, reuseSessionId: reuseSessionId ?? null })
        .catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error))
        .finally(() => this.verifiedWakes.delete(chatKey));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /**
   * 活跃模式：取某个会话的活跃期状态；到期/开关关闭时清理并返回 null。
   * 返回 { topic, until } 或 null。
   */
  #activeState(chatKey) {
    const cfg = getConfig();
    if (cfg.chatActive?.enabled !== true) {
      if (this.activeTopics.size) this.activeTopics.delete(chatKey);
      return null;
    }
    const st = this.activeTopics.get(chatKey);
    if (!st) return null;
    if (Date.now() > Number(st.until) || !String(st.topic || '').trim()) {
      this.activeTopics.delete(chatKey);
      return null;
    }
    return st;
  }


  // ── 未读兜底（已随 2026-09-25 触发链路重做移除）────────────────────────
  // 旧语义：1~3 档下"没触发会话"的散消息在防抖窗口后由定时器批量标已读。
  // 新语义：每条消息入库时当场判定，不触发的当场标已读（onIncoming），
  // 不存在"挂着的假未读"，兜底定时器失去存在意义。
  // 保留 #cancelUnreadFallback 的空实现以兼容 abortSession 等旧调用点。
  #cancelUnreadFallback(chatKey) {
    const t = this.unreadFallbackTimers.get(chatKey);
    if (t) { clearTimeout(t); this.unreadFallbackTimers.delete(chatKey); }
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用于档位判定"这次不响应"的场景 —— 用户看到的应该是"什么都没发生"，
   * 而不是一条等了半天最后标着"中止"的条目（那会让人以为机器人坏了）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #discardWaiting(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  #finishWaiting(sessionId, status, error = '') {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /** 手动触发一次处理（UI 按钮）。 */
  // （「唤醒一次处理」按钮及其 force 唤醒链路已按需求移除：
  //   不触发的消息现在立即标已读，无需手动补处理。）

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, waitingSessionId = null, reuseSessionId = null } = {}) {
    if (this.aborted) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.paused && !proactive) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.runningChats.has(chatKey)) return;

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return;
    }

    // ── 会话创建前检测禁言状态：机器人被禁言时不创建会话，消息标记已读 ──
    // 背景：机器人在群里被禁言（shut_up）时，发不出消息。此时创建会话、调模型、
    // 生成回复全是白烧 token —— 最后发送必然失败。提前检测：被禁言则把未读标记
    // 已读（不丢消息，解除后还能作为历史上下文），直接返回，不创建会话。
    if (String(chatKey).startsWith('group:')) {
      const muted = await this.#checkSelfMuted(chatKey);
      if (muted) {
        const marked = this.store.markAllRead(chatKey);
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '机器人被禁言');
        this.emit('chat-update', chatKey);
        return;
      }
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      if (waitingSessionId) {
        const s = this.sessions.get(waitingSessionId);
        // sessions.get 判过 status 后 current.get 仍可能是 undefined
        // （等待会话恰好在两次读取之间被 discard），必须再判一层再写属性
        const live = s && s.status === 'waiting' ? this.sessions.current.get(waitingSessionId) : null;
        if (live) {
          live.waitUntil = Date.now() + 3000;
          this.sessions.update(waitingSessionId);
          this.emit('session-update', waitingSessionId);
        }
      }
      // ⚠️ 3 秒重排定时器必须被跟踪（2026-09-26 审查）：原先裸 setTimeout 不记句柄，
      // stop()/abortAll() 清不掉它 —— 应用退出后它仍会把 pendingWake 重新排上，
      // 测试环境里表现为进程挂着不退（unref 让它不阻塞退出，但运行期它照样会在
      // 停止后又拉起一次唤醒）。与 wakeTimers 同一张表管理，abortAll 时一并清掉。
      const retryTimer = setTimeout(() => {
        this.wakeTimers.delete(chatKey);
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      retryTimer.unref?.();
      this.wakeTimers.set(chatKey, retryTimer);
      return;
    }

    // ── 取走触发批 ──
    // 触发判定已在 onIncoming 里逐条完成（进入倒计时 = 必定运行），
    // wake 不再做档位终审 —— 倒计时既然未被中止地走到了这里，就直接运行。
    //
    // ⚠️ 批的边界（2026-09-25 补丁 ×2）：未读消息可能有三种来源——
    //   a) 倒计时窗口内的（触发消息 + 聚批追加）→ 进批；
    //   b) 磁盘遗留的旧积压（旧进程/停机期间攒的，从未判定）→ 标已读沉历史；
    //   c) **运行期间进来的**（上个会话 runningChats 占位时 onIncoming 直接
    //      return，从未判定）→ 逐条补判定：
    //        · 有触发消息（@/关键词/概率命中）→ 从最早的触发消息起组批运行；
    //        · 全都不触发 → 全部标已读、不建会话、不调 LLM。
      //      （补丁前的行为：drain 无差别吃掉全部未读 → 大量 tier 0"未触发"
    //       会话 + 【已读信息】为空 + 白烧一次 LLM 调用。）
    const cfgForJudge = getConfig();
    let triggerEntries = [];
    if (!proactive) {
      const probe = this.store.peekUnread(chatKey, 500) || [];
      if (probe.length === 0 && waitingSessionId) {
        this.#finishWaiting(waitingSessionId, 'aborted');
        return;
      }

      // 判定锚点：
      //   · **verified 批**（onIncoming 判定过触发 → scheduleWake(verified)）→
      //     倒计时起点之后的消息天然在批内，起点之前的旧积压归档；
      //   · **机械批**（drain / drainBacklogAfterResume / 重试排的，无 verified）→
      //     未读从未判定（运行期/停机期间进来的），逐条补判定找最早的触发消息，
      //     它之前的一律归档；全部不触发 → 标已读不建会话。
      //     ⚠️ 不能用"有没有等待会话"区分 —— 机械排定也会建等待会话（UI 可见性
      //     需要它），否则 drain 进来的闲聊会被误当成"触发过"整批塞进唤醒
      //     （2026-09-25 晚的 tier 0 垃圾会话事故就是它）。
      let batchFloorTs = Infinity;
      let hasTrigger = false;
      const active = this.#activeState(chatKey);
      if (this.verifiedWakes.has(chatKey)) {
        if (waitingSessionId) {
          const waiting = this.sessions.current.get(waitingSessionId);
          if (waiting?.startedAt) batchFloorTs = Math.min(batchFloorTs, Number(waiting.startedAt) - 60_000);
        }
        hasTrigger = true;   // onIncoming 判定过"触发"，批内必然有触发消息
      } else if (!active) {
        // 补判定：对每条未读单独跑 resolveContextTier（与 onIncoming 同口径）
        for (const m of probe) {
          const r = resolveContextTier({
            triggerEntries: [m],
            selfNickname: cfgForJudge.persona?.selfNickname || this.onebot.selfNickname || '',
            botName: cfgForJudge.persona?.botName || '',
            selfId: cfgForJudge.onebot?.selfId || this.onebot.selfId || '',
            cfg: storeConfigForChat(chatKey),
            isPrivate: String(chatKey).startsWith('private:'),
            roll: null
          });
          if (r.shouldRespond) { batchFloorTs = m.ts; hasTrigger = true; break; }   // 最早的触发消息定边界
        }
      } else {
        // 活跃期：必响应，边界 = 最早的未读
        if (probe.length) { batchFloorTs = probe[0].ts; hasTrigger = true; }
      }

      if (!hasTrigger) {
        // 全部未读都不触发：标已读沉历史，不建会话、不调 LLM。
        // 机械批带的等待会话也要干净消失（它只是倒计时的 UI 壳，从未消耗 token）。
        const archived = this.store.markAllRead(chatKey);
        if (archived > 0) {
          console.log(`[orchestrator] ${chatKey} ${archived} 条未读经补判定均未触发，已标已读沉入历史`);
          this.emit('chat-update', chatKey);
        }
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        return;
      }

      if (Number.isFinite(batchFloorTs)) {
        const inWindow = probe.filter((m) => m.ts >= batchFloorTs);
        if (inWindow.length === 0) {
          // 理论不可达（触发消息自身就在窗口内）；防御性归档
          const archived = this.store.markAllRead(chatKey);
          if (archived > 0) console.log(`[orchestrator] ${chatKey} ${archived} 条旧积压未读（触发消息已缺失）已标已读归档`);
          if (waitingSessionId) this.#discardWaiting(waitingSessionId);
          this.emit('chat-update', chatKey);
          return;
        }
        batchFloorTs = Math.min(...inWindow.map((m) => m.ts));
      }

      // 确定要响应：兜底定时器没有存在意义了
      this.#cancelUnreadFallback(chatKey);

      // 取走触发批：边界之后的进批，边界之前的旧积压标已读沉入历史
      const { batch, archived } = Number.isFinite(batchFloorTs)
        ? this.store.drainUnreadFrom(chatKey, batchFloorTs)
        : { batch: this.store.drainUnread(chatKey), archived: 0 };
      triggerEntries = batch;
      if (archived > 0) {
        console.log(`[orchestrator] ${chatKey} ${archived} 条旧积压未读已标已读沉入历史（未进本次唤醒）`);
        this.emit('chat-update', chatKey);
      }
      if (triggerEntries.length === 0) {
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
        return; // 没有未读就不空跑
      }
    } else {
      // 主动机会：不打扰、无触发批，只带状态
      this.store.drainUnread(chatKey); // 把可能的零星未读一并处理掉
    }

    // ── 档位：响应时带多少条已读历史 ──
    // 在唤醒时算一次并固定下来（尤其是随机档的骰子结果），
    // 否则后续每次渲染提示词都会重新掷，会话记录与提示词会对不上。
    // 触发批的"触发原因"以**触发消息 X**的判定为准（onIncoming 里逐条判定时
    // 已出结果，这里对同一批 drain 出来的消息重算一次 resolveContextTier——
    // 判定输入相同（就是这批消息），结果一致；随机档不传 roll、重掷一次并
    // 固定在本次运行里，会话记录（session.contextReason）记录的就是这里的值。
    const cfgNow = getConfig();
    const tierResult = proactive
      ? { tier: 4, count: Math.max(0, Number(storeConfigForChat(chatKey).historyCount) || 80), reason: '主动机会（带历史）', shouldRespond: true }
      : resolveContextTier({
        triggerEntries,
        selfNickname: cfgNow.persona?.selfNickname || this.onebot.selfNickname || '',
        botName: cfgNow.persona?.botName || '',
        selfId: cfgNow.onebot?.selfId || this.onebot.selfId || '',
        cfg: storeConfigForChat(chatKey),
        isPrivate: String(chatKey).startsWith('private:'),   // 私聊恒响应
        roll: null
      });
    // 活跃期覆盖：必响应，读取条数与其余档位一致（统一 historyCount），
    // reason 标注活跃来源，会话页可解释"为什么 1 档设置却响应了"。
    const activeState = this.#activeState(chatKey);
    const effectiveTier = activeState
      ? { tier: 3, count: Math.max(0, Number(storeConfigForChat(chatKey).historyCount) || 80), reason: `活跃期（话题：${activeState.topic}）`, shouldRespond: true }
      : tierResult;

    this.runningChats.add(chatKey);
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);
    const [kind, chatId] = String(chatKey).split(':');

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒/原地重试）才走别的分支
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    if (session && session.status === 'waiting') {
      this.sessions.current.get(waitingSessionId).status = 'running';
      this.sessions.current.get(waitingSessionId).waitUntil = null;
      this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
      this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
      this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(waitingSessionId);
      this.emit('session-update', waitingSessionId);
      session = this.sessions.current.get(waitingSessionId);
    } else if (reuseSessionId) {
      // 原地重试（retrySession）：复用同一个会话对象，不新开条目。
      // retrySession 已把它重置回 running 并放回 current；这里补触发批信息。
      const reused = this.sessions.current.get(reuseSessionId);
      if (!reused) {
        // 理论不可达：会话在唤醒前被清理。退回新建，别让消息丢掉。
        session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
        this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
      } else {
        reused.trigger = triggerEntries;
        reused.triggerSummary = triggerSummary;
        reused.triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
        this.sessions.update(reuseSessionId);
        this.emit('session-update', reuseSessionId);
        session = reused;
      }
    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
      this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    }
    this.activeRuns.set(chatKey, session.id);
    this.emit('chat-update', chatKey);

    // ── 会话级重试 ──
    // 单次 API 请求内部已经会重试（见 chatCompletionWithRetry），
    // 这里处理的是"整轮都救不回来"的情况：清干净上下文从头再来一次。
    //
    // ⚠️ 只在**一次都没发出过消息**时才重试 —— 否则重试会导致重复发言。
    // 已经说过话的会话宁可记为 error，也不能让群里看到两遍同样的话。
    // 次数可在设置里配（sessionRetryAttempts，默认 2 = 最多 3 次尝试）；
    // 0 = 关闭自动重试（失败会话仍可在会话页手动重试）。
    const MAX_SESSION_ATTEMPTS = Math.max(1, 1 + (Math.min(5, Math.max(0, Number(getConfig().sessionRetryAttempts) ?? 0) || 0)));
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
        try {
          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit: effectiveTier.count, tierInfo: effectiveTier, activeTopic: activeState ? activeState.topic : null });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !this.aborted;
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${error?.message ?? error}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        // 用户手动中止（「中止」按钮）打断在途请求时，错误从 #runAgent 一路上抛
        // 到这里 —— 不能记成 error：那会让 UI 亮出"重试"按钮（中止不该重试），
        // 也会让会话账面状态与实际发生的事对不上。按 aborted 收尾（2026-09-19 修）。
        if (this.sessionAbortMarks.has(session.id)) {
          this.sessionAbortMarks.delete(session.id);
          this.sessionAbortControllers.delete(session.id);
          session.error = null;
          this.sessions.finish(session.id, 'aborted');
          this.emit('session-end', { sessionId: session.id, chatKey, status: 'aborted', sent: session.sent.length, usage: session.usage });
          console.log(`[orchestrator] 会话 ${session.id} 被用户中止（错误上抛路径收尾）`);
        } else {
          session.error = String(lastError?.message ?? lastError);
          this.sessions.finish(session.id, 'error');
          this.emit('session-end', { sessionId: session.id, chatKey, status: 'error', error: session.error });
          console.error(`[orchestrator] 运行 ${session.id} 出错:`, lastError);
        }
      }
    } finally {
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   *
   * ⚠️ 手动重试（retrySession）复用此函数时注意：已结束会话不在 current 里，
   *    `live` 会回退成传入的 session 对象本身 —— 调用方随后要自己把它放回
   *    current（retrySession 就是这么做的），否则后续 update/finish 找不到活对象。
   */
  #resetSessionForRetry(session) {
    const live = this.sessions.current.get(session.id) || session;
    live.messages = [];
    live.sent = [];
    live.feedbacks = [];
    live.rounds = 0;
    live.error = null;
    live.finishReason = null;
    live.activity = '';
    live.inputMessages = [];
    live.usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
  }

  // ── 回复安全网（reply-safety 插件）─────────────────────────────────────
  //
  // 这一整套只为**不遵守工具协议**的模型准备（尤其是本地小模型）：它们有时把要说的话
  // 直接写在正文里。正文按设计不会发到 QQ，于是群友什么都没收到 —— 用户看到的就是
  // "机器人不理我了"。下面几个方法就是那条兜底路径。
  //
  // 全部通过能力名取用：插件没装/没启用时 `#capFirst` 一律返回 null，所有分支都是空操作，
  // 行为与没有这套机制时**完全一致**。这是"关掉插件就退回原行为"的硬约束。

  /** 取某个能力的第一提供者函数；没有提供者（插件未启用）时返回 null。 */
  #capFirst(name, context = {}) {
    try {
      return skillManager.getCapabilityProviders(name, context)[0]?.fn || null;
    } catch {
      return null;
    }
  }

  /** 给"正文裁判"用的模型参数：沿用当前聊天的主模型，不另开一份配置。 */
  #judgeApi() {
    const api = getConfig().api || {};
    // 密钥解析：模型走 providers 目录时顶层 api.apiKey 常为空 —— 直接取会 401。
    // 从已解析密钥的目录里找当前 provider 的真实 Key（与主调用路径同源）。
    let apiKey = api.apiKey;
    if (!apiKey && api.provider) {
      const p = currentProviders().find((x) => x.id === api.provider);
      apiKey = p?.apiKey || '';
    }
    return { baseUrl: api.baseUrl, apiKey, model: api.model, provider: api.provider };
  }

  /** 触发批的文本（裁判要知道"这轮收到了什么"，才能判断正文是对它的回复）。 */
  #triggerText(triggerEntries) {
    return (triggerEntries || []).map((e) => String(e?.text || '')).filter(Boolean).join('\n').slice(0, 400);
  }

  /**
   * 把"写在正文里、但没通过工具发出去"的成稿抢救成一条 send_message 调用。
   *
   * 判定逻辑本身在 src/reply-rescue.js（纯逻辑、可被测试直接驱动 —— 这条链路
   * 判错就是把内心戏发进群，必须能逐条验证）。这里只负责注入依赖：
   * 能力取用、裁判用的模型参数、触发批文本。
   *
   * @returns {Promise<Array>} 合成的 tool_call 数组；[] = 什么都别发
   */
  async #rescueUnsentReply({ rawContent, triggerEntries, session, skillContext }) {
    return rescueUnsentReply({
      text: rawContent,
      trigger: this.#triggerText(triggerEntries),
      sent: session.sent || [],
      api: this.#judgeApi(),
      cap: (name) => this.#capFirst(name, skillContext),
      log: (message) => skillManager.recordError('reply-safety', message)
    });
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null, activeTopic = null }) {
    const cfg = getConfig();
    // 开一轮新运行：清空回复安全网的候选草稿池（草稿只在"这一次运行"内有意义，
    // 跨运行留着会把上一次的句子当成这次可以发的原句）。
    this.#capFirst('reply.grounded-select')?.({ reset: true });
    // 会话级中止的请求中断器：本次运行的每次 LLM 请求都带这个 signal。
    // abortSession 中止会话时直接 abort —— 在途请求立刻断开（不用等 180 秒
    // 超时），这是"中止按钮停不住"的根治。运行结束必须清理（见 finally），
    // 否则 Map 随会话数无限增长。
    const abortController = new AbortController();
    this.sessionAbortControllers.set(session.id, abortController);
    const abortSignal = abortController.signal;
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || this.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;

    // （原"上下文统计"三件套 —— 最近消息密度/上次发言时间/最后消息时间 ——
    //  只喂【此刻状态】段，该段 2026-09-25 删除后不再计算。）

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // ── 统一可用性上下文 ──
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    const searchEnabled = cfg.webSearch?.enabled !== false;
    const toolsCfg = cfg.tools || {};
    const skillContext = {
      chatKey, kind, chatId, chatName,
      model: cfg.api.model,
      provider: cfg.api.provider,
      visionEnabled,
      searchEnabled,
      proactive,
      sessionId: session.id
    };

    // Skill 生命周期：提示词组装之前先跑 before-context。
    // 注意 hook 只能**追加/加工上下文**；安全规则、工具协议等核心提示词由 prompt.js 独占，
    // Skill 无法覆盖（manifest priority 上限 99）。
    try {
      await skillManager.runHook('before-context', {
        ...skillContext,
        triggerEntries,
        store: this.store,
        memory: this.memory
      });
    } catch (error) {
      skillManager.recordError('before-context', error);
    }

    // ── 主人识别（owner-identity Skill）──
    // 通过能力名问"这批消息里有没有主人在跟机器人说话"，再据此决定这次用哪套人设。
    // 做成能力而不是硬编码：关了主人 Skill 就自动回到全局人设，行为与没有该功能时一致。
    // 判定**只按 QQ 号**（Skill 内部保证），名字/自称一律不参与 —— 详见该 Skill 注释。
    let ownerPersona = null;
    let ownerRules = '';
    try {
      for (const p of skillManager.getCapabilityProviders('message.owner-check', skillContext)) {
        const r = p.fn({
          triggerEntries,
          kind,
          selfId: this.onebot.selfId,
          // 主人模式的"基准人设"用本会话独立人设：主人覆盖发生在会话人设之上，
          // 没配置会话人设时 personaForChat 原样返回全局 persona，行为不变。
          persona: personaForChat(chatKey)
        });
        if (r) { ownerPersona = r.persona || null; ownerRules = r.rules || ''; }
        break;
      }
    } catch (error) {
      skillManager.recordError('owner-identity', error);
    }

    // 组装提示词（无 LLM 历史）
    // 人设优先级（逐层收窄，命中即用）：
    //   1. 主人专属人设（owner-identity Skill 判定"主人在叫你"）
    //   2. 本会话独立人设（personaByChat[群号/QQ号]，白名单设置里按会话配置）
    //   3. 全局人设（cfg.persona）
    // 名字（botName/selfNickname）在任何层都保持全局值 —— 那是账号身份，
    // 换了会和 @ 判定对不上（personaForChat 在结构上就不允许覆盖这两个字段）。
    const systemPrompt = buildSystemPrompt({
      skillContext,
      persona: ownerPersona || personaForChat(chatKey),
      extraSections: ownerRules
        ? [{ id: 'owner-rules-run', title: '', priority: 72, content: ownerRules }]
        : []
    });
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      selfNickname,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      contextLimit,
      tierInfo,
      skillContext,
      // 活跃模式：注入当前话题锚点（buildUserPrompt 据此渲染【活跃模式】段）
      activeTopic,
      // 提示词锚点：传入上一轮的前缀状态；新状态经 session.promptAnchorState 带回
      promptAnchor: { prev: this.promptAnchors.get(chatKey) || null },
      session
    });

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length;
    session.model = cfg.api.model;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    // 提示词锚点状态存回 chatKey 级 Map（下一轮 buildUserPrompt 复用前缀）。
    // buildUserPrompt 已把新状态写进 session.promptAnchorState；失败重试会
    // 重置该字段（#resetSessionForRetry），届时旧锚点继续生效（幂等：同一批
    // 消息重新锚定出相同前缀）。
    if (session.promptAnchorState) this.promptAnchors.set(chatKey, session.promptAnchorState);
    else this.promptAnchors.delete(chatKey);
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: proactive
        ? `${userPrompt}\n\n【未读信息】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`
        : userPrompt }
    ];

    // 让 Skill 加工即将发给模型的消息（如补充知识库片段）。
    // hook 拿到的是同一个数组引用，允许原地修改，返回值忽略。
    try {
      await skillManager.runHook('before-llm-messages', { ...skillContext, messages });
    } catch (error) {
      skillManager.recordError('before-llm-messages', error);
    }

    // JSON 模式需要看到输入给模型的完整 messages（去工具之前）
    session.inputMessages = structuredClone(messages.map((m) => ({ role: m.role, content: m.content })));
    this.sessions.update(session.id);

    // ── 工具集过滤：唯一口径 ──
    // 以前这里手写五层条件，加 Skill 后如果继续手写就会变成六层、两处各判一半。
    // 现在统一交给 getToolAvailability()，并把不可用原因写进会话（UI 可解释）。
    const availability = new Map();
    const toolDefs = this.toolDefs.filter((d) => {
      const st = getToolAvailability(d.id, {
        skills: skillManager,
        toolsCfg,
        visionEnabled,
        searchEnabled,
        runtimeContext: skillContext
      });
      availability.set(d.id, st);
      return st.enabled;
    });
    // 排障面板：本次因为什么原因少了哪些工具
    const excluded = [...availability.entries()]
      .filter(([, st]) => !st.enabled)
      .map(([id, st]) => ({ id, code: st.code, reason: st.reason }));
    session.excludedTools = excluded;
    const openAiTools = toOpenAiTools(toolDefs);

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      session,
      reminders: this.reminders,
      videoReader: this.videoReader,
      emit: (type, payload) => this.emit(type, payload)
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      // 会话级中止（会话页「中止」按钮）：与全局 abort 同一条收尾路径。
      // 两个入口都会到这里：abortController 中断了在途请求（异常上抛后被
      // wake 的会话级重试判为不可重试 → #runAgent 正常返回 → 无需再拦），
      // 以及"中止时正处在工具执行/退避等待"（没有在途请求可中断）→ 这里拦住。
      // 收尾后清掉两套标记；abortAll 场景下不清（进程即将停止）。
      if (this.sessionAbortMarks.has(session.id)) {
        this.sessionAbortMarks.delete(session.id);
        this.sessionAbortControllers.delete(session.id);
        this.sessions.finish(session.id, 'aborted');
        this.emit('session-end', {
          sessionId: session.id,
          chatKey,
          status: 'aborted',
          sent: session.sent.length,
          usage: session.usage
        });
        return;
      }
      // 中途补一次检查：abortSignal 在上一轮工具执行期间被置位（例如模型
      // 正在跑一个长搜索时用户点了中止）。不等下一轮请求，当场收尾。
      if (abortSignal.aborted) {
        this.sessionAbortControllers.delete(session.id);
        this.sessions.finish(session.id, 'aborted');
        this.emit('session-end', {
          sessionId: session.id,
          chatKey,
          status: 'aborted',
          sent: session.sent.length,
          usage: session.usage
        });
        return;
      }
      if (this.aborted) {
        // 与其它终态（error / done / noreply / #finishWaiting）保持一致：必须 emit session-end。
        // 漏掉的话 UI 里这条会话会一直停在"运行中"，pendingSessionDetail 也不清，
        // 要等下一次轮询才恢复 —— 这正是"点了暂停后会话页像卡住"的成因。
        this.sessionAbortControllers.delete(session.id);
        this.sessions.finish(session.id, 'aborted');
        this.emit('session-end', {
          sessionId: session.id,
          chatKey,
          status: 'aborted',
          sent: session.sent.length,
          usage: session.usage
        });
        return;
      }
      markActivity('正在思考…');
      // ── 剩余轮次提醒：防止"工具轮次耗尽导致想说的话发不出去"──
      // 进入最后 3 轮且还一条消息都没发时，往对话里注入一条系统提醒，
      // 明确告诉模型"轮次快用完了，现在就该用 send_message 把话说出来"。
      // 没有这个提醒时，模型常把轮次花在搜索/看图上，循环一断消息就丢了。
      // 已发出过消息则不打扰（模型可能只是收尾查询，别催它重复发言）。
      const roundsLeft = maxRounds - round;
      if (roundsLeft <= 3 && roundsLeft > 0 && session.sent.length === 0
          && messages[messages.length - 1]?.role !== 'system') {
        messages.push({
          role: 'user',
          content: `【系统提醒】工具调用轮次只剩 ${roundsLeft} 轮。如果你打算回应本次消息，请立刻调用 send_message 把要说的话发出去，不要再调用其它工具 —— 轮次耗尽后你将没有机会发言，群友会收不到任何内容。`
        });
      }
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）。
      // abortSignal：会话级中止时在途请求立即断开 —— isRetryableError 把
      // "中止"判为不可重试，chatCompletionWithRetry 不再打下一发，直接上抛。
      const response = await chatCompletionWithRetry({ messages, tools: openAiTools, skillContext, signal: abortSignal });
      session.model = response.model || session.model;
      // 渠道与模型必须同源：fallback 可以配另一个 provider，只更新 model 会把
      // 这次调用记到主渠道名下，导致按渠道拆分的成本报表误导用户。
      if (response._usedApi) {
        session.vendor = vendorOfConfig({ api: response._usedApi, providers: getConfig().providers }) || session.vendor;
      }
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;
      // Skill 附加统计（如 reasoning tokens）——单独累加，不混进成本口径
      if (response.extraUsage) {
        session.usage.extra = { ...(session.usage.extra || {}) };
        for (const [k, v] of Object.entries(response.extraUsage)) {
          session.usage.extra[k] = (session.usage.extra[k] || 0) + (Number(v) || 0);
        }
      }
      // 取到响应后让 Skill 加工（提取 reasoning / 记录降级等）
      try {
        await skillManager.runHook('after-response', { ...skillContext, response, session });
      } catch (error) {
        skillManager.recordError('after-response', error);
      }

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const assistantEntry = {
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        raw: response.raw ?? null
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
        // 回复安全网（reply-safety 插件）的解析器覆盖更多书写格式，且可配置关闭。
        // **合并**而不是替换：核心解析器已覆盖标准 <tool_call> 写法，插件多认出来的
        // 那些补进来 —— 两边都不丢，且插件没启用时这段是空操作。
        const inlineFn = this.#capFirst('reply.inline-calls', skillContext);
        if (inlineFn) {
          try {
            const extra = inlineFn({ text: rawContent })?.calls || [];
            for (const c of extra) {
              if (!c?.name) continue;
              const same = inlineCalls.some((x) => x.name === c.name
                && JSON.stringify(x.args ?? {}) === JSON.stringify(c.args ?? {}));
              if (!same) inlineCalls.push(c);
            }
          } catch (error) { skillManager.recordError('reply-safety', error); }
        }
        // 正文顺势记成候选草稿：后面 grounded-select 只允许"从草稿里挑原句"，
        // 没有这一步，筛选会把所有候选都判成"无出处"而全部丢掉。
        const rememberFn = this.#capFirst('reply.grounded-select', skillContext);
        if (rememberFn) {
          try { rememberFn({ remember: rawContent }); } catch { /* 记不进就算了 */ }
        }
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有原生工具调用。两种可能：
        //   · 模型真的说完了（文本只是思考，按设计不发 QQ）→ 正常结束
        //   · 模型不遵守工具协议，把要说的话写在了正文里 → 群友什么都收不到
        // 给回复安全网一次机会抢救后者（插件未启用时立刻返回空，行为完全不变）。
        const rescued = await this.#rescueUnsentReply({
          rawContent, triggerEntries, session, skillContext
        });
        if (!rescued.length) break;

        toolCalls = rescued;
        // 与上面的 inline 分支同理：把 assistant 条目改成 tool_calls 形态。
        // 不这么做的话，下面 push 进去的 tool 消息就没有对应的 tool_call，
        // 下一轮请求会被 OpenAI 兼容端点判为非法消息序列。
        const lastRescue = messages[messages.length - 1];
        if (lastRescue?.role === 'assistant') {
          lastRescue.content = null;
          lastRescue.tool_calls = toolCalls;
        }
        const liveRescue = this.sessions.current.get(session.id);
        const uiRescue = liveRescue?.messages?.[liveRescue.messages.length - 1];
        if (uiRescue?.role === 'assistant') {
          uiRescue.content = null;
          uiRescue.tool_calls = structuredClone(toolCalls);
          uiRescue.inlineParsed = true;
          uiRescue.rescued = true;
        }
        markActivity('正在抢救未发出的回复…');
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      // 记下这批工具的起点：下面要用"本批新增了哪些发送记录"判断本地模型能不能收尾
      const sentBeforeBatch = session.sent.length;
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        // ── 工具执行前后钩子 ──
        // before-tool 可以**否决**一次调用（返回 {block:true, reason}）——
        // 用于"Skill 运行期发现不该执行"的场景（如知识库索引未就绪）。
        // 注意：否决只是拒绝这一次调用，不会绕过发送队列/限频/存档。
        let blocked = null;
        try {
          const hookResults = await skillManager.runHook('before-tool', {
            ...skillContext, toolName: name, argsRaw, session
          });
          blocked = hookResults.map((r) => r.value).find((v) => v && v.block) || null;
        } catch (error) {
          skillManager.recordError('before-tool', error);
        }
        const result = blocked
          ? { content: `错误：${blocked.reason || '该工具调用被 Skill 拒绝'}`, isError: true }
          : await executeTool(toolDefs, ctx, name, argsRaw);
        try {
          await skillManager.runHook('after-tool', {
            ...skillContext, toolName: name, argsRaw, result, session
          });
        } catch (error) {
          skillManager.recordError('after-tool', error);
        }
        // 工具结果：文本走 tool 消息；媒体（parts 数组）不能塞进 tool 消息 ——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，媒体随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'|'video_url'}]），这是兼容面最广的多模态输入方式。
        //
        // ⚠️ 媒体一律走 parts，**绝不能**混进 contentStr：
        //    base64 图片当文本送进去，模型看不到图却要为几十万 token 付钱。
        let contentStr = '';
        let media = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          // image_url 与 video_url 都要收：视频抽帧走前者，全模态原生读视频走后者。
          // 以前只 filter image_url，video_url 会被静默丢掉（模型只拿到「已发送视频输入」的说明文字）。
          media = result.content.filter((p) => p.type === 'image_url' || p.type === 'video_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (media.length) {
          const imgCount = media.filter((p) => p.type === 'image_url').length;
          const vidCount = media.filter((p) => p.type === 'video_url').length;
          const what = [
            imgCount ? `${imgCount} 张图片` : '',
            vidCount ? `${vidCount} 段视频` : ''
          ].filter(Boolean).join(' + ');
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${what}，请直接"看"了回应]` },
              ...media
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: media.length, images: imgCount, videos: vidCount } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') {
          finish = true;
          // ── 活跃模式状态机 ──
          // 模型 finish 时带回的 activeTopic / "话题结束" 决定活跃期走向：
          //   · 带回 activeTopic 且本次 tier 是 1/2/3（被召唤后才可能开活跃）→ 开启活跃期
          //   · 活跃期中 finish("话题结束") → 退出活跃期（回到正常档位）
          //   · 活跃期中 finish 且没带新 topic → 话题延续，刷新到期时间
          if (!proactive) {
            const cfgA = getConfig();
            const enabled = cfgA.chatActive?.enabled === true;
            const t = tierInfo?.tier;
            const eligibleTier = Number.isFinite(Number(t)) && t >= 1 && t <= 3;
            const topic = String(session.activeTopic ?? '').trim();
            const reason = String(session.finishReason ?? '');
            const st = this.#activeState(chatKey);
            if (enabled && topic && eligibleTier) {
              const ttlMs = Math.max(60000, Number(cfgA.chatActive?.ttlMinutes) || 30) * 60000;
              this.activeTopics.set(chatKey, { topic: topic.slice(0, 60), until: Date.now() + ttlMs });
              console.log(`[orchestrator] ${chatKey} 进入活跃期（话题：${topic.slice(0, 60)}，${Math.round(ttlMs / 60000)} 分钟）`);
            } else if (st && /话题(结束|终止|偏离)/.test(reason)) {
              this.activeTopics.delete(chatKey);
              console.log(`[orchestrator] ${chatKey} 活跃期结束（模型判断话题结束）`);
            } else if (st && !topic) {
              // 活跃期内的普通 finish：话题仍在，刷新到期
              const ttlMs = Math.max(60000, Number(cfgA.chatActive?.ttlMinutes) || 30) * 60000;
              this.activeTopics.set(chatKey, { ...st, until: Date.now() + ttlMs });
            }
          }
        }
      }

      // ── 本地小模型的收尾策略（reply-safety 插件，默认关闭）──
      // 一批"只发送、不遗留待办"的工具结果之后允许提前结束，省掉没有意义的下一轮
      // （本地小模型多跑一轮既慢又容易把已说好的话改坏）。
      // 判定规则本身在插件里（canEndReplyBatch：失败发送 / 预告式结尾 / 该发图却没发
      // 等等都保留正常循环），这里只负责把现场信息递过去。
      // 插件没启用 / localPolicy 没开时该项为 false，行为与没有这套机制一致。
      if (!finish) {
        const policyFn = this.#capFirst('reply.local-policy', skillContext);
        if (policyFn) {
          try {
            const r = policyFn({
              api: cfg.api || {},
              entries: triggerEntries,
              batch: {
                calls: toolCalls,
                results: toolResults,
                newSent: session.sent.slice(sentBeforeBatch),
                allSent: session.sent,
                searched: webSearchCount > 0
              }
            });
            if (r?.shouldEnd) {
              finish = true;
              session.finishReason = session.finishReason || '本地收尾策略判定：本批已交付完毕';
            }
          } catch (error) { skillManager.recordError('reply-safety', error); }
        }
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 媒体消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    this.sessionAbortControllers.delete(session.id);
    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 提醒（闹钟/计时）调度 ─────────────────────────────────────────────

  /** 启动提醒调度循环：每 20 秒检查一次到点的提醒并触发。 */
  startReminderLoop() {
    this.stopReminderLoop();
    if (!this.reminders) return;
    const tick = async () => {
      if (this.aborted) return;
      try {
        const dueList = this.reminders.due(Date.now());
        for (const r of dueList) {
          if (this.reminderFiring.has(r.id)) continue;
          this.reminderFiring.add(r.id);
          try {
            // 发送成功后才标记 fired；失败保留未触发状态，下一轮重试。
            // （反过来"先标记再发"会让 OneBot 断线/进程崩溃时的提醒永久丢失）
            await this.#fireReminder(r);
            this.reminders.markFired(r.id);
          } catch (error) {
            console.error('[reminder] 触发失败，将在下一轮重试:', error?.message ?? error);
          } finally {
            this.reminderFiring.delete(r.id);
          }
        }
        if (dueList.length) this.reminders.prune();
      } catch (error) {
        console.error('[reminder] 调度出错:', error?.message ?? error);
      }
      this.reminderTimer = setTimeout(() => { tick().catch(() => {}); }, 20000);
    };
    this.reminderTimer = setTimeout(() => { tick().catch(() => {}); }, 5000);   // 启动 5s 后第一次检查
  }

  stopReminderLoop() {
    if (this.reminderTimer) { clearTimeout(this.reminderTimer); this.reminderTimer = null; }
  }

  /** 触发一条提醒：往对应群/私聊发一条提醒消息（走正常发送管道，留档）。 */
  async #fireReminder(r) {
    const [kind, id] = String(r.chatKey || '').split(':');
    if (!kind || !id) return;
    const text = `⏰ 提醒：${r.text}`;
    // 走统一发送管道（SendQueue）：与机器人发言共享限频 / 去重 / 超长切分 / CQ 转义，
    // 并自带留档（appendSelf）。原先直接调 onebot.sendText 会绕过这四项 ——
    // 表现为提醒与正常发言并发抢发、限频计数不到它、超长提醒被协议端截断。
    // 失败必须向上抛，让调度循环保留未触发状态以便重试。
    await this.sender.sendTextBatch(r.chatKey, [text]).then((result) => {
      // 极端边界：同一会话 8 秒窗口内两条文本完全相同的提醒，第二条会被发送去重
      // 拦下（sendTextBatch 正常返回但 deduped）。留个日志，别无声消失。
      if (result?.sent?.some((s) => s?.deduped)) {
        console.warn(`[reminder] 提醒文本与刚发送的内容完全相同，被去重跳过（${r.chatKey}）`);
      }
    });
    this.emit('chat-update', r.chatKey);
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // ── 机器人被禁言检测（会话创建前）──
  // 缓存每个群的禁言状态，避免每条消息都打一次 OneBot。
  #muteCache = new Map();   // chatKey -> { muted: boolean, checkedAt: number }

  /**
   * 检测机器人在该群是否被禁言（shut_up）。
   * 用 get_group_member_info 查自己的 shut_up_timestamp；> 当前时间 = 禁言中。
   * 结果缓存 60 秒（禁言状态不会秒级变化，频繁查询浪费 OneBot 调用）。
   * 查询失败（网络/权限）时返回 false —— 宁可放行让发送时报错，也不误判阻塞正常回复。
   */
  async #checkSelfMuted(chatKey) {
    // ── 快路径：问 ban-state Skill「有没有明确通知过被禁言」──
    // Skill 记录的是 OneBot group_ban 通知与发送被拒这两条真实事件，
    // 有记录就是确定的，可以省掉一次 OneBot 查询 + 一整轮 token。
    // 没有记录**不代表没被禁言**（通知会丢），所以继续往下走查询兜底。
    // 两者互补：事件快、查询准。
    try {
      for (const p of skillManager.getCapabilityProviders('chat.ban-state', { chatKey, kind: 'group' })) {
        const r = p.fn({ chatKey, action: 'check' });
        if (r?.known && r.muted) {
          this.#muteCache.set(chatKey, { muted: true, checkedAt: Date.now() });
          return true;
        }
      }
    } catch { /* Skill 坏了不影响禁言判断，继续走查询 */ }

    const now = Date.now();
    const cached = this.#muteCache.get(chatKey);
    if (cached && now - cached.checkedAt < 60000) return cached.muted;
    let muted = false;
    try {
      const groupId = String(chatKey).split(':')[1];
      const selfId = this.onebot.selfId;
      if (groupId && selfId) {
        const info = await this.onebot.call('get_group_member_info', {
          group_id: Number(groupId),
          user_id: Number(selfId),
          no_cache: false
        });
        const shutUp = Number(info?.shut_up_timestamp ?? info?.shutUpTimestamp ?? 0);
        // shut_up_timestamp 是「到期时刻」（epoch 秒），不是时长，而且解禁后 QQ 不会清零。
        // 判据必须是「到期时刻在未来」。写成 shutUp > 0 会把早就解禁的群当成禁言中，
        // 那个群就再也不回复了（社区版踩过：负数差值被 Math.max(1,...) 夹成 1 秒，永久卡在"剩余 1 秒"）。
        muted = shutUp > 0 && shutUp * 1000 > now;
      }
    } catch {
      muted = false;   // 查询失败放行（发送时若真被禁言会报错，那时再处理）
    }
    this.#muteCache.set(chatKey, { muted, checkedAt: now });
    return muted;
  }

  // ── 群友印象自动整理 ──
  // 触发条件（二者同时满足）：印象条数超过阈值，且距上次整理超过冷却时间。
  //
  // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
  // → 自动整理永远不触发。改为可配置（config.memory.consolidateMinImpressions），
  // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || Orchestrator.MEMORY_THRESHOLDS.memberImpression);
      // 触发条件二选一：
      //   A. 全群印象总数超过阈值
      //   B. 任一成员的印象条数超过上限
      // 只看总数会在"人少"的群里彻底失灵 —— 比如 3 位成员各 1 条，
      // 总数 3 永远够不到阈值，自动整理形同虚设。
      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 5);
      const anyMemberOverloaded = st.members.some((m) => m.count > maxPerMember);
      if (!(st.counts.memberImpression > minImpressions) && !anyMemberOverloaded) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  /**
   * 整理群友印象 —— 唯一入口。
   * 手动按钮、自动整理、针对特定群友，三种用法都走这里，避免逻辑分叉走样。
   *
   * @param {string} chatKey  会话 key
   * @param {object} [opts]
   * @param {string[]} [opts.userIds]  只整理这些人（指定群友时用）；不传 = 按规则筛选全部
   * @param {boolean} [opts.force]     跳过冷却/门槛检查（手动触发时用）
   * @returns {Promise<{ok, note, changed, results, skipped, failed}>}
   *
   * 身份识别（"同一个人"的判定）：
   *   1) 优先用记忆里的 userId（QQ 号）匹配聊天记录 senderId；
   *   2) 匹配不到时，用备注名/记忆名反查 senderName，命中后把 QQ 号回写进记忆；
   *   3) 仍匹配不到但有名字 → 允许整理（历史遗留的"按名字存"条目不能永远排队）；
   *   4) 既无名也无号 → 跳过。
   */
  async consolidateMemoryForChat(chatKey, { userIds = null, force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);

    // ── 选出要整理的人 ──
    const targets = [];
    const skipped = [];

    // 指定群友但记忆里还没有 → 也要能"新建"印象（这是本功能的关键价值：
    // 聊了 200 条却零印象的人，可以手动让他被分析一次）
    if (only) {
      for (const uid of only) {
        const found = existing.find((m) => String(m.userId || '') === uid);
        if (found) {
          const resolved = this.#resolveIdentity(chatKey, found, stats, notes);
          targets.push({ ...resolved, isNew: false });
          continue;
        }
        // 记忆里没有这个人：用聊天记录里的名字兜底，允许新建
        const name = stats.uidToName.get(uid) || notes[uid] || '';
        if (!name && !stats.memberMsgCount.get(uid)) {
          skipped.push({ userId: uid, name: '', reason: '聊天记录里没有此人发言' });
          continue;
        }
        targets.push({
          userId: uid,
          name: name || `QQ ${uid}`,
          impressions: [],
          isNew: true
        });
      }
    } else {
      // 先整理记忆里已有的人
      const knownUserIds = new Set();
      for (const mem of existing) {
        const resolved = this.#resolveIdentity(chatKey, mem, stats, notes);
        if (String(resolved.userId || '')) knownUserIds.add(String(resolved.userId));
        if (this.#shouldSkip(resolved, force)) {
          skipped.push({
            userId: resolved.userId,
            name: resolved.name,
            reason: this.#skipReason(resolved)
          });
          continue;
        }
        targets.push({ ...resolved, isNew: false });
      }

      // 再"发现"聊天记录里的活跃群友：他们发言很多却没有任何印象。
      // 没有这一步，记忆为空的群（如刚启用记忆的群）点整理只会得到
      // "没有可整理的群友"，功能形同虚设。
      const discoverMin = Math.max(1,
        Number(cfg.memory?.discoverMinMessages) || Orchestrator.DISCOVER_MIN_MESSAGES);
      const discoverMax = Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || Orchestrator.DISCOVER_MAX_MEMBERS);
      const discovered = [...stats.memberMsgCount.entries()]
        .filter(([uid, n]) => n >= discoverMin && !knownUserIds.has(uid))
        .sort((a, b) => b[1] - a[1])
        .slice(0, discoverMax);
      for (const [uid, n] of discovered) {
        targets.push({
          userId: uid,
          name: stats.uidToName.get(uid) || notes[uid] || `QQ ${uid}`,
          impressions: [],
          isNew: true,
          discoveredFrom: n
        });
      }
    }

    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';

    if (!targets.length) {
      return {
        ok: true,
        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,
        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }

    // ── 逐个整理 ──
    const results = [];
    const failed = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.aborted) break;
      const before = mem.impressions.map((e) => e.content);
      try {
        const next = await this.#consolidateOneMember(chatKey, mem, { force, stats });
        if (!next) { failed.push({ userId: mem.userId, name: mem.name, reason: '模型返回无法解析' }); continue; }
        const after = next.impressions.map((e) => e.content);
        const isChanged = after.length !== before.length || after.some((c, i) => c !== before[i]);
        if (isChanged) changed += 1;
        results.push({
          userId: mem.userId,
          name: mem.name,
          before: before.length,
          after: after.length,
          changed: isChanged,
          isNew: !!mem.isNew
        });
      } catch (error) {
        failed.push({ userId: mem.userId, name: mem.name, reason: String(error?.message ?? error) });
      }
    }

    const discoveredCount = targets.filter((t) => t.isNew).length;
    const note = this.#buildConsolidateNote({
      total: targets.length, changed, failed, skipped, only, discoveredCount
    });
    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    return { ok: true, note, changed, results, skipped, failed };
  }

  /** 统计会话里各成员的出现次数与名字（用于身份识别与"新建印象"）。 */
  #scanChatActivity(chatKey) {
    const memberMsgCount = new Map();
    const nameMsgCount = new Map();
    const nameToUserId = new Map();
    const uidToName = new Map();
    for (const m of this.store.recent(chatKey, { limit: 2000 })) {
      if (m.self || !m.senderId) continue;
      const uid = String(m.senderId);
      memberMsgCount.set(uid, (memberMsgCount.get(uid) || 0) + 1);
      const nm = String(m.senderName || '').trim();
      // 跳过占位名（历史脏数据：拍一拍事件曾把 senderName 写成"（拍一拍事件）"）
      if (nm && !PLACEHOLDER_NAMES.has(nm)) {
        nameMsgCount.set(nm, (nameMsgCount.get(nm) || 0) + 1);
        if (!nameToUserId.has(nm)) nameToUserId.set(nm, uid);
        if (!uidToName.has(uid)) uidToName.set(uid, nm);
      }
    }
    return { memberMsgCount, nameMsgCount, nameToUserId, uidToName };
  }

  /** 确定一个记忆条目的 QQ 号（必要时反查名字并回写记忆文件）。 */
  #resolveIdentity(chatKey, mem, stats, notes) {
    let userId = String(mem.userId || '').trim();
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    if (msgCount < Orchestrator.MEMBER_MIN_MESSAGES) {
      const candidates = [notes[userId], mem.name, userId].filter(Boolean);
      for (const name of candidates) {
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName >= Orchestrator.MEMBER_MIN_MESSAGES) {
          const matched = stats.nameToUserId.get(name) || '';
          if (matched) {
            userId = matched;
            msgCount = byName;
            try {
              this.memory.replaceMember(chatKey, userId, mem.name, mem.impressions.map((e) => e.content));
            } catch { /* 回写失败不阻塞整理 */ }
          }
          break;
        }
      }
    }
    return { ...mem, userId, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved, force) {
    if (force) return false;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved) {
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }) {
    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';
    const head = only ? '已整理指定群友' : '已整理';
    const discoverNote = discoveredCount > 0 ? `（其中 ${discoveredCount} 位是新建印象）` : '';
    const body = changed > 0
      ? `${head} ${total} 位${discoverNote}，其中 ${changed} 位印象有更新`
      : `${head} ${total} 位${discoverNote}，内容无需改动（印象已足够精简）`;
    const failNote = failed.length
      ? `；${failed.length} 位失败（已保留原印象）`
      : '';
    return body + failNote + skippedNote;
  }

  /** 记录整理时间，供冷却判断使用。 */
  #markConsolidated(chatKey, userIds) {
    const now = Date.now();
    try {
      this.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      console.warn('[memory] 记录整理时间失败:', error?.message ?? error);
    }
  }

  /**
   * 整理单个群友的印象。
   *
   * 两种模式：
   *   - 整理模式（已有印象）：合并重复、删过时，只减不增，绝不发明新事实
   *   - 新建模式（isNew，针对零印象的活跃群友）：读他最近的发言，提炼长期印象
   *
   * 新建模式是本功能的关键补充：实测有群友聊了 200+ 条却零印象，
   * 而模型日常几乎不主动调 memory_append —— 没有这个入口就永远补不上。
   */
  async #consolidateOneMember(chatKey, mem, { force = false, stats = null } = {}) {
    const existing = mem.impressions || [];
    const isNew = !!mem.isNew || (!existing.length && !!force);

    const { system, user } = isNew
      ? this.#buildNewImpressionPrompt(chatKey, mem, stats)
      : this.#buildConsolidatePrompt(mem);

    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      console.warn(`[memory] ${isNew ? '新建' : '整理'} ${chatKey}/${mem.userId || mem.name} 结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_MEMORY) {
        console.warn('[memory][debug] 原始返回 =', JSON.stringify(String(res?.message?.content ?? '')).slice(0, 1500));
      }
      return null;
    }

    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;

    // 整理模式：条数变多 = 疑似幻觉，放弃（保留原印象）
    if (!isNew && raw.length > existing.length) {
      console.warn(`[memory] 整理 ${chatKey}/${mem.userId} 结果条数变多（${existing.length}→${raw.length}），疑似幻觉，放弃`);
      return null;
    }

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content) => content.slice(0, 120));

    return this.memory.replaceMember(chatKey, mem.userId, mem.name, clean);
  }

  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`群友 QQ：${mem.userId}`, `当前名字：${mem.name}`];
    for (const e of mem.impressions) lines.push(`- ${e.content} (${fmtTs(e.createdAt)})`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 把同义/重复的印象合并成一条，以最新的观感为准。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        `3. 最多保留 ${maxKeep} 条，每条不超过 120 字。`,
        '原则：所有信息只能来自原文，语义不变，宁少勿错；没有可保留的时输出空数组。',
        '',
        ...lines
      ].join('\n')
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey, mem, stats) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    const uid = String(mem.userId || '');
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);

    return {
      system: '你是聊天机器人的记忆模块，负责从聊天记录里提炼对某一位群友的长期印象。只提炼"以后跟这个人打交道用得上"的稳定特征，严格依据给定的发言，不要编造。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        `下面是群友（QQ ${uid}${(mem.name && `，名字 ${mem.name}`) || ''}）最近的部分发言，请提炼对他的长期印象：`,
        '1. 只保留稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。',
        '2. 不要记一次性事件、临时话题，也不要记录流水账。',
        `3. 最多 ${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。`,
        '4. 宁少勿错：信息不足就少写，不要脑补。',
        '5. 若实在提炼不出任何稳定特征，输出空数组。',
        '',
        sample.length ? sample.join('\n') : '（没有抓到该群友的发言）'
      ].join('\n')
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      return chatCompletion({ messages, temperature: 0.2 });
    }    const providers = currentProviders();
    const p = providers.find((x) => x.id === mem.provider);
    if (!p?.baseURL || !p?.apiKey || !mem.model) {
      throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    return chatCompletion({
      messages,
      temperature: 0.2,
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  /**
   * 中止单个运行中的会话（会话页「中止」按钮）。
   *
   * 与 abortAll（全局暂停用）不同：只针对一条会话，其它会话与调度不受影响。
   * 两层机制：
   *   1. **请求级中断（真正停住）**：给运行挂一个 AbortController，
   *      #runAgent 的每次 LLM 请求都带上它的 signal —— 正在途中的请求立刻
   *      中断（不再等 180 秒超时/响应读完），这是"停不住"的根治。
   *      fetch abort 抛 AbortError，chatCompletionWithRetry 里 isRetryableError
   *      判为不可重试（aborted），会话随即收尾，不会再打下一发请求。
   *   2. 轮次级检查（兜底）：工具循环每轮开始时检查标记并走标准收尾路径。
   *
   * 等待中（waiting）的会话也可以中止：撤掉防抖定时器，让等待会话干净消失
   * （从未消耗过 token 的等待会话不该留一条"中止"记录）。
   *
   * @returns {{ok:boolean, reason?:string}}
   */
  abortSession(sessionId) {
    const id = String(sessionId || '');
    if (!id) return { ok: false, reason: '缺少会话 id' };
    // 等待中：撤掉防抖定时器，让等待会话干净消失（不算"中止"，没花过 token）
    for (const [chatKey, waitingId] of this.pendingSessions.entries()) {
      if (waitingId === id) {
        if (this.wakeTimers.has(chatKey)) {
          clearTimeout(this.wakeTimers.get(chatKey));
          this.wakeTimers.delete(chatKey);
        }
        this.#cancelUnreadFallback(chatKey);
        this.pendingWake.delete(chatKey);
        this.pendingSessions.delete(chatKey);
        this.#discardWaiting(waitingId);
        return { ok: true };
      }
    }
    // 运行中：打标记 + 立刻中断在途请求
    for (const [chatKey, runId] of this.activeRuns.entries()) {
      if (runId === id) {
        this.sessionAbortMarks.add(id);
        // 在途的 LLM 请求立即中断。abort 的 reason 会一路抛到 #runAgent 的
        // catch —— isRetryableError 视为不可重试，直接走到轮次级检查收尾。
        const ctrl = this.sessionAbortControllers.get(id);
        if (ctrl) {
          try { ctrl.abort(new Error('会话已被用户中止')); } catch { /* 已中止过 */ }
        }
        // 会话级重试的退避等待中：没有在途请求可中断，靠标记在下一轮检查时拦住。
        return { ok: true };
      }
    }
    return { ok: false, reason: '该会话不在运行/等待中，无法中止' };
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    for (const timer of this.unreadFallbackTimers.values()) clearTimeout(timer);
    this.unreadFallbackTimers.clear();
    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.stopProactiveLoop();
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      consolidating: [...this.consolidating],
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 聊天记录里可能出现的占位名（非真实昵称）。
 * 来源：历史版本的拍一拍事件把 senderName 硬编码成"（拍一拍事件）"。
 * 取名字时必须跳过，否则记忆里会出现"某人的名字叫（拍一拍事件）"。
 */
const PLACEHOLDER_NAMES = new Set([
  '（拍一拍事件）',
  '(拍一拍事件)',
  '未知',
  '某人'
]);

/**
 * 从模型输出里稳健提取 JSON 对象。
 *
 * 模型并不总会乖乖只吐 JSON，常见变体：
 *   1) ```json\n{...}\n```            —— Markdown 代码块
 *   2) "好的，这是整理结果：\n{...}"   —— 前后带解释文字
 *   3) '{"impressions":[...]}'        —— 用了单引号
 *   4) 结尾多了个逗号                  —— 尾随逗号
 * 原实现只会剥掉"整段被 ``` 包裹"这一种，其余全部解析失败 → 整理静默放弃。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 1) 先尝试直接解析
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }

  // 2) 剥掉 ``` 代码块（可能在中间任意位置）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());

  // 3) 取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    // 修正常见瑕疵后重试：尾随逗号、单引号
    try {
      const fixed = cand
        .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
        .replace(/'/g, '"');                     // 单引号 → 双引号
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
    // 兜底：只抽 impressions 数组
    const arrMatch = cand.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrMatch) {
      try {
        const items = JSON.parse('[' + arrMatch[1].replace(/,\s*$/, '') + ']');
        return { impressions: items };
      } catch { /* 继续 */ }
    }
  }
  return null;
}
