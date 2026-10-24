// 〔SSE / 会话视图〕——M9 拆分第 3 段
'use strict';
// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => {
    scheduleListReload();
    refreshStatus();
    // 自动跟随新会话（等待中/运行中）
    if (state.autoFollowRunning) {
      loadSessions({ quiet: true }).then(() => {
        const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
        if (active && active.id !== state.currentSessionId) selectSession(active.id);
      });
    }
  });
  es.addEventListener('session-update', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const id = data.sessionId;
    if (!id) return;
    // SSE 事件本身携带完整会话快照：patch 立即进 state，渲染走合批（见上）
    const patch = {
      id,
      chatKey: data.chatKey || '',
      status: data.status,
      waitUntil: data.waitUntil ?? null,
      activity: data.activity || '',
      webSearchCount: data.webSearchCount || 0,
      rounds: data.rounds || 0,
      usage: data.usage || null,
      messages: data.messages || [],
      triggerSummary: data.triggerSummary ?? '',
      startedAt: data.startedAt ?? 0
    };
    // sent/finishReason 等收尾字段：后端给了才进 patch。
    // 不能无脑写 null —— pending 合并时 null 会把之前已有的值冲掉。
    if (Array.isArray(data.sent)) patch.sent = data.sent;
    if (data.finishReason !== undefined) patch.finishReason = data.finishReason;
    if (data.error !== undefined) patch.error = data.error;
    if (data.endedAt !== undefined) patch.endedAt = data.endedAt;
    const existing = state.sessions.find((s) => s.id === id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.sessions.unshift({ ...patch, trigger: data.trigger || '', triggerSummary: data.triggerSummary || '', startedAt: data.startedAt ?? Date.now() });
      // 上限要大于一次可取的数量，否则新会话一进来就把旧的挤没了
      state.sessions = state.sessions.slice(0, SESSION_KEEP);
    }
    // 详情 patch 合并暂存，渲染合批到每帧一次（不再来一条事件全量重建一次）
    pendingSessionDetail.set(id, { ...pendingSessionDetail.get(id), ...patch });
    scheduleSessionRender();
  });
  es.addEventListener('session-end', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* 数据坏了也照常刷列表 */ }
    scheduleListReload();
    refreshStatus();
    // discarded（档位判定不响应）：后端已把等待会话连同磁盘文件一起删掉，
    // 本地列表要同步摘掉，否则要等下次整页加载它才消失。
    if (data.sessionId && data.status === 'discarded') {
      state.sessions = (state.sessions || []).filter((s) => s.id !== data.sessionId);
      if (state.currentSessionId === data.sessionId) {
        state.currentSessionId = null;
        $('#session-detail') && ($('#session-detail').innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>');
      }
      renderSessionList();
    }
    // ⚠️ 会话刚结束必须主动重拉一次详情：轮询只刷 running/waiting 的会话，
    //    最终态（sent / finishReason / error）之后再也不来 —— 不重拉的话，
    //    "已发送到 QQ"徽标和收尾状态只能等用户手动刷新才出现。
    const id = data.sessionId;
    if (id && id === state.currentSessionId) {
      pendingSessionDetail.delete(id);   // 丢弃残留的过期 patch，防止把刚拉的最终态回闪成旧值
      loadSessionDetail(id, { quiet: true });
    }
  });
  es.addEventListener('chat-update', () => {
    scheduleListReload();
    refreshStatus();
  });
  es.addEventListener('memory-update', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { data = { phase: 'refresh' }; }
    const phase = data.phase || '';
    const chatKey = data.chatKey || '';

    // 状态一律记进 state（不依赖当前 DOM），这样切走页签再切回也能恢复显示。
    // 原先只操作 DOM 且 tab 不对就 return，导致切回来完全看不出整理是否还在跑。
    if (phase === 'consolidate-start') {
      if (chatKey) state.consolidating[chatKey] = { startedAt: Date.now() };
    } else if (phase === 'consolidate-done') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) state.consolidateResult[chatKey] = { note: data.note || '整理完成', at: Date.now() };
    } else if (phase === 'consolidate-error') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) {
        state.consolidateResult[chatKey] = { note: `整理失败：${data.error || '未知错误'}`, at: Date.now(), failed: true };
      }
    }

    // 只有停在记忆页时才操作 DOM / 刷新列表
    if (state.tab !== 'memory') return;

    if (phase === 'consolidate-start') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = true;
      if (status) status.textContent = '整理中…';
      renderMemoryList();
    } else if (phase === 'consolidate-done') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = data.note || '整理完成';
      loadMemoryView();
    } else if (phase === 'consolidate-error') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = `整理失败：${data.error || '未知错误'}`;
      renderMemoryList();
    } else {
      loadMemoryView();
    }
  });
  es.addEventListener('onebot-status', () => {
    refreshStatus();
    if (state.tab === 'snowluma') scheduleSnowlumaReload();
  });
  es.addEventListener('status', () => refreshStatus());
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'snowluma') scheduleSnowlumaReload(); });
  es.addEventListener('qq-portable-status', () => { refreshStatus(); if (state.tab === 'snowluma') scheduleSnowlumaReload(); });
  // 日志事件只刷日志文本，不整页重建（曾经每条日志都 innerHTML 重绘整页）
  es.addEventListener('qq-portable-log', () => { if (state.tab === 'snowluma') refreshSnowlumaLogs(); });
  es.addEventListener('snowluma-log', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { /* 坏数据跳过本条，不断流 */ }
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && state.tab === 'snowluma') {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  // 视觉能力扫描进度：POST /api/vision/scan 是异步的（202），完成后靠这个事件告诉前端。
  // 此前后端会 emit 但全项目没有任何监听者，扫描结果只能在重载页面后才看得到。
  es.addEventListener('vision-scan', async (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { /* ignore */ }
    // 2026-09-19（M9 清理）：扫描入口搬到「模型配置」弹窗（mc-vision-hint 承接进度）。
    const hint = $('#mc-vision-hint');
    if (hint) {
      if (d.phase === 'start') hint.textContent = '扫描中…（会真实请求每个模型，请稍候）';
      else if (d.phase === 'done') hint.textContent = `完成：${d.total ?? 0} 个模型`;
      else if (d.phase === 'error') hint.textContent = `失败：${d.error || '未知错误'}`;
    }
    if (d.phase === 'done' || d.phase === 'error') {
      try {
        const v = await api('/api/vision/results');
        state.visionResults = v.results || {};
        state.visionScanning = !!v.scanning;
        if (state.tab === 'settings') renderSettings();
      } catch { /* 拉结果失败就保持现状 */ }
    }
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    // 一次全取：后端上限 2^20（约等于不限），前端靠分页渲染（SESSION_PAGE）避免卡顿
    const data = await api('/api/sessions?limit=1048576');
    state.sessions = data.sessions || [];
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
      if (active) selectSession(active.id);
    }
    // 当前打开的会话在等待/运行中时，也顺手刷新详情
    if (state.currentSessionId) {
      const cur = state.sessions.find((s) => s.id === state.currentSessionId);
      if (cur && (cur.status === 'running' || cur.status === 'waiting')) {
        loadSessionDetail(state.currentSessionId, { quiet: true });
      }
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」）；此前这里硬编码 4000，
// 配置项从未被读取 —— 用户改了完全没效果。
let listPoller = null;
function refreshIntervalMs() {
  const n = Number(state.config?.ui?.refreshMs);
  // 兜底值必须与后端 DEFAULT_CONFIG.ui.refreshMs 一致（15000），
  // 否则"拿不到配置"时前端按 4 秒轮询、后端默认 15 秒，两边对不上。
  return Number.isFinite(n) && n >= 1000 ? n : 15000;
}

/**
 * 状态栏轮询。用 setTimeout 自续期而不是 setInterval：
 * 每一轮都重新读 ui.refreshMs，用户在设置页改「界面刷新间隔」后立刻生效，
 * 不必刷新页面（此前这里是 setInterval(..., 15000) 写死的，改了设置不生效）。
 */
let statusPollTimer = null;
function startStatusPoller() {
  if (statusPollTimer) { clearTimeout(statusPollTimer); statusPollTimer = null; }
  const tick = async () => {
    try { await refreshStatus(); } catch { /* 单次失败不中断轮询 */ }
    statusPollTimer = setTimeout(tick, refreshIntervalMs());
  };
  statusPollTimer = setTimeout(tick, refreshIntervalMs());
}
// SSE 合批：session-update 非常密（每轮思考开/关 + 每个工具一次），
// 每条都全量重绘列表会把主线程打满、按钮不跟手。200ms 内合并成一次。
let sseListReloadTimer = null;
function scheduleListReload() {
  if (sseListReloadTimer) return;
  sseListReloadTimer = setTimeout(() => {
    sseListReloadTimer = null;
    if (state.tab === 'sessions') loadSessions({ quiet: true });
    if (state.tab === 'chats') loadChats({ quiet: true });
  }, 200);
}
/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：曾经是被节流的事件直接丢弃 —— 快速滚动时
 *      事件密集，"抵达底部"那一下几乎总是落在 120ms 窗口内被扔掉，
 *      用户停手后又不会再有新事件 → 加载永远不触发，表现为
 *      "滚得快会滚不下去，像撞墙"。现在窗口内的事件会留下一个尾随定时器，
 *      停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发（曾经是 100px）：快速甩滚时惯性大，
 *      100px 的提前量太小，内容还没加载出来人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数会被多次调用（渲染一次调一次），
  //    曾经没做防护，结果加载 N 批就挂了 N 个监听器 ——
  //    滚一次会同时触发 N 次 onLoadMore，一次跳好几批，
  //    而且每个监听器各有自己的 last 变量，120ms 节流形同虚设。
  //    这里把状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用 —— 停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/** 会话列表：滚到底部再加载 SESSION_PAGE 条。 */
function initSessionScrollLoader() {
  // 滚动源必须是真正 overflow 的列表容器（#session-items），不是外层 aside
  attachScrollLoader('session-items', () => {
    const all = state.sessions || [];
    if (state.sessionLimit >= all.length) return;   // 已经全显示了
    state.sessionLimit = Math.min(all.length, state.sessionLimit + SESSION_PAGE);
    renderSessionList();
  });
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail —— 它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。曾经在它内部又套了一层 .archive-scroll 想做内层滚动，
 *   结果内层没有高度基准、被内容撑开，滚动事件全发生在外层，
 *   导致监听挂空、"继续滚动没反应"。现在只保留一层滚动容器。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）：
 *   曾经这里调 updateChatMessagesBody(true)，每批都要全量 sort + 全量
 *   innerHTML 重建（行数越滚越多），还有 scrollTop 补偿把视口"吸"在底部
 *   → 连锁触发下一批加载 → 主线程被反复长阻塞，
 *   表现为"滑到临界线继续向下滚动反应迟钝"。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => {
    const total = (state.chatMessages || []).length;
    const prev = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
    if (prev >= total) return;                     // 已经全显示了
    state.chatMsgLimit = Math.min(total, prev + CHAT_MSG_MORE);
    // 行数账本对不上（结构刚被轮询重建过等异常）→ 全量兜底；正常走追加
    if ((state.chatMsgRendered || 0) !== Math.min(prev, total)) {
      updateChatMessagesBody(true);
    } else {
      appendChatMessageRows(prev);
    }
  });
}

function startListPoller() {
  if (listPoller) clearInterval(listPoller);
  listPoller = setInterval(() => {
    // 页面不可见（最小化/被遮挡）时跳过用量页轮询：大数据下 stats 重算
    // 即便有缓存也要几百毫秒，后台一直跑是纯浪费。会话/存档等轻页签不受影响。
    const skipUsage = document.hidden;
    if (state.tab === 'sessions' || state.tab === 'chats') scheduleListReload();
    if (state.tab === 'snowluma') {
      refreshSnowlumaLogs();
      scheduleSnowlumaReload();
    }
    // 用量页不自动刷新：打开/切范围/点「刷新」才请求
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
}

startListPoller();

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  const all = state.sessions || [];
  const shown = all.slice(0, state.sessionLimit);
  const rest = all.length - shown.length;
  box.innerHTML = shown.map((s) => {
    const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
    const waitHtml = s.status === 'waiting' && s.waitUntil
      ? `<span class="session-wait" data-until="${Number(s.waitUntil)}">等待中 · ${fmtWaitRemain(Number(s.waitUntil))}</span>`
      : '';
    const activityHtml = s.status === 'running' && s.activity
      ? `<span class="session-activity">${esc(s.activity)}</span>`
      : '';
    const searchHtml = Number(s.webSearchCount) > 0
      ? `<span class="muted">搜 ${s.webSearchCount}</span>`
      : '';
    const isNew = !state.seenSessionIds.has(s.id);
    // 失败会话的重试按钮：只有 error 状态且没发出过消息的才显示
    // （已发言的重试会导致群里重复内容，后端同样会拒绝）
    const retryHtml = s.status === 'error' && !(s.sent && s.sent.length)
      ? `<button class="btn btn-small session-retry-btn" data-id="${esc(s.id)}" title="把这条会话的触发消息翻回未读并重新处理">重试</button>`
      : '';
    // 运行中/等待中会话的中止按钮：运行中在下一轮请求前安全收尾，等待中直接干净消失
    const abortHtml = (s.status === 'running' || s.status === 'waiting')
      ? `<button class="btn btn-small btn-danger session-abort-btn" data-id="${esc(s.id)}" title="中止这次处理（已发出的消息不受影响）">中止</button>`
      : '';
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''} ${s.status === 'waiting' ? 'session-waiting-row' : ''} ${isNew ? 'new-item' : ''}" data-id="${s.id}">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          ${waitHtml}
          ${activityHtml}
          ${retryHtml}
          ${abortHtml}
          ${s.status !== 'waiting' ? `<span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span><span>${s.rounds || 0} 轮</span>${searchHtml}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  // 底部提示：还有多少条没显示 / 已全部显示
  const more = $('#session-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更多（还有 ${rest} 条）`
      : (all.length > SESSION_PAGE ? `已显示全部 ${all.length} 条` : '');
  }
  // 头部显示总数（已显示 / 总数），便于确认分页是否真的加载完了
  const cnt = $('#session-count');
  if (cnt) {
    cnt.textContent = all.length ? `${shown.length}/${all.length}` : '';
  }
  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
  // 失败会自动重试一次的 api 封装（用于"偶发 failed to fetch"的点击类操作：
  // 中止/重试等）。后端在收尾时会做同步落盘（大会话 JSON 写盘可达几百毫秒），
  // 期间其它请求会在 TCP 队列里排队；偶发的连接抖动/瞬间拒绝会以
  // TypeError: Failed to fetch 冒出来 —— 这类瞬态失败重试一次几乎必成。
  // 只重试网络层失败（TypeError），HTTP 4xx/5xx 是服务器的明确答复，不重试。
  async function apiWithRetry(path, options = {}, retries = 1) {
    try {
      return await api(path, options);
    } catch (err) {
      const transient = err instanceof TypeError || /failed to fetch|network|load failed/i.test(String(err?.message || ''));
      if (!transient || retries <= 0) throw err;
      await new Promise((r) => setTimeout(r, 350));
      return apiWithRetry(path, options, retries - 1);
    }
  }

  // 失败会话的「重试」：把触发消息翻回未读并重新处理。
  // stopPropagation：点了重试就别选中这条会话（用户意图是重跑，不是看详情）
  $$('.session-retry-btn', box).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '重试中…';
      try {
        const r = await apiWithRetry(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/retry`, {
          method: 'POST',
          body: '{}'
        });
        if (!r.ok) throw new Error(r.error || '无法重试');
        // 新会话由唤醒流程创建；列表靠 SSE/轮询刷新，这里立即拉一次
        await loadSessions({ quiet: true });
      } catch (err) {
        alert(`重试失败：${err.message}`);
        btn.disabled = false;
        btn.textContent = '重试';
      }
    });
  });
  // 运行中/等待中的「中止」：请求后端安全收尾这条会话。
  // 中止是"尽快别再继续"，不是立即截断 —— 后端在下一轮 LLM 请求前收尾，
  // 已发出的消息不受影响。列表刷新靠 SSE/轮询，这里立即拉一次。
  $$('.session-abort-btn', box).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '中止中…';
      try {
        const r = await apiWithRetry(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/abort`, {
          method: 'POST',
          body: '{}'
        });
        if (!r.ok) throw new Error(r.error || '无法中止');
        await loadSessions({ quiet: true });
      } catch (err) {
        alert(`中止失败：${err.message}`);
        btn.disabled = false;
        btn.textContent = '中止';
      }
    });
  });
  // 等待中会话的剩余时间按 0.1s 本地刷新（不重新拉列表）
  if ($$('.session-wait[data-until]', box).length) startWaitTicker();
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

let waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(() => {
    const els = $$('.session-wait[data-until]');
    if (!els.length) {
      clearInterval(waitTicker);
      waitTicker = null;
      return;
    }
    for (const el of els) {
      const until = Number(el.dataset.until);
      const remain = until - Date.now();
      el.textContent = remain > 0 ? `等待中 · ${(remain / 1000).toFixed(1)}s` : '等待中 · 启动…';
    }
  }, 100);
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  // json 模式切换也要触发重渲染
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.activity || ''}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};

  const html = [];
  const canDelete = s.status !== 'running';   // 运行中的会话不能删（usage 还在累加）
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}
        <button class="btn btn-small" id="json-mode-btn" style="margin-left:10px">JSON 模式</button>
        ${canDelete ? `<button class="btn btn-small btn-danger" id="session-delete-btn" style="margin-left:6px" title="删除这条会话记录">删除</button>` : ''}
      </h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        <span>${s.rounds || 0} 轮工具</span>
        <span>联网搜索 ${Number(s.webSearchCount) || 0} 次</span>
      </div>
    </div>`);

  const jsonMode = state.sessionJsonMode === s.id;
  if (jsonMode) {
    // JSON 模式：原模原样展示输入给模型的内容 + 模型返回的原始内容
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      inputMessages: (s.inputMessages || []).map((m) => ({ role: m.role, content: m.content })),
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls ?? null,
        raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({
        toolCall: m.toolCall
      })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    html.push(`
      <details class="collapsible" open>
        <summary>JSON 模式（模型输入/输出的原始内容）</summary>
        <div class="coll-body" style="max-height:none">${esc(JSON.stringify(raw, null, 2))}</div>
      </details>`);
  } else {
    if (s.systemPrompt) {
      html.push(`
        <details class="collapsible">
          <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
          <div class="coll-body">${esc(s.systemPrompt)}</div>
        </details>`);
    }
    if (s.userPrompt) {
      html.push(`
        <details class="collapsible">
          <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
          <div class="coll-body">${esc(s.userPrompt)}</div>
        </details>`);
    }
  }

  html.push('<div class="msg-flow">');
  if (!jsonMode) {
    for (const item of s.messages || []) {
      if (item.toolCall) {
        const meta = (typeof TOOL_META === 'object' && TOOL_META) ? TOOL_META[item.toolCall.name] : null;
        const ico = meta?.icon || '⚒';
        const label = meta?.name || item.toolCall.name;
        const err = item.toolCall.isError;
        html.push(`
          <details class="collapsible tool-flow ${err ? 'tool-error' : ''}">
            <summary>
              <span class="tool-ico">${ico}</span>
              <span class="tool-name-flow">${esc(item.toolCall.name)}</span>
              <span class="tool-label">${esc(label)}</span>
              ${err ? '<span class="badge err">失败</span>' : '<span class="badge ok">成功</span>'}
            </summary>
            <div class="coll-body">
              <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
              <div class="tool-result ${err ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
            </div>
          </details>`);
      } else if (item.toolImages) {
        html.push(`
          <details class="collapsible tool-flow">
            <summary>
              <span class="tool-ico">🖼️</span>
              <span class="tool-name-flow">${esc(item.toolImages.tool)}</span>
              <span class="tool-label">${item.toolImages.count} 张图片</span>
            </summary>
            <div class="coll-body muted">已作为图像输入注入模型</div>
          </details>`);
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
        html.push(`
          <details class="collapsible tool-flow think-flow">
            <summary>
              <span class="tool-ico">💭</span>
              <span class="tool-name-flow">思考</span>
              <span class="tool-label">不发送</span>
            </summary>
            <div class="coll-body think-body">${esc(text || '（无文本输出，仅调用工具）')}</div>
          </details>`);
      }
    }
    // 发出的消息
    // 已发送到 QQ：全部合并成一张卡（默认展开），逐条换行展示
    const sentList = s.sent || [];
    if (sentList.length) {
      const sentLines = sentList.map((sent) =>
        `已发送到 QQ${sent.at ? ` · ${esc(sent.at)}` : ''}\n${esc(sent.text)}`
      ).join('\n\n');
      html.push(`
        <details class="collapsible tool-flow sent-flow" open>
          <summary>
            <span class="tool-ico">💬</span>
            <span class="tool-name-flow">已发送到 QQ</span>
            <span class="tool-label">${sentList.length} 条消息</span>
            <span class="badge ok">已送达</span>
          </summary>
          <div class="coll-body sent-body">${sentLines}</div>
        </details>`);
    }
  }
  if (s.error) {
    html.push(`
      <details class="collapsible tool-flow error-flow" open>
        <summary>
          <span class="tool-ico">⚠</span>
          <span class="tool-name-flow">错误</span>
          <span class="tool-label">运行失败</span>
          <span class="badge err">异常</span>
        </summary>
        <div class="coll-body error-body">${esc(s.error)}</div>
      </details>`);
  }
  // finish 收尾：单独一张卡（默认展开）
  if (s.finishReason) {
    html.push(`
      <details class="collapsible tool-flow finish-flow" open>
        <summary>
          <span class="tool-ico">🏁</span>
          <span class="tool-name-flow">finish</span>
          <span class="tool-label">结束本次</span>
        </summary>
        <div class="coll-body finish-body">${esc(s.finishReason)}</div>
      </details>`);
  }
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  // 切换会话（首次渲染）时详情整体淡入；轮询/SSE 的原地刷新不播，避免运行中闪烁
  if (firstRender) uiEnter(detail);
  const jsonBtn = $('#json-mode-btn');
  if (jsonBtn) jsonBtn.addEventListener('click', () => {
    state.sessionJsonMode = state.sessionJsonMode === s.id ? null : s.id;
    lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  // 删除这条会话记录
  const delBtn = $('#session-delete-btn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!(await uiConfirm(`确定删除这条会话记录？\n\n触发：${s.triggerSummary || '-'}\n时间：${fmtClock(s.startedAt)}\n\n删除后不可恢复（不影响用量统计的历史数据）。`))) return;
    try {
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      state.currentSessionId = null;
      state.sessions = (state.sessions || []).filter((x) => x.id !== s.id);
      $('#session-detail').innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
      renderSessionList();
      loadSessions({ quiet: true });
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  // 说明：此处原先有一段"运行中每 2s 自递归拉详情"的兜底轮询，已移除。
  // 原因：renderSessionDetail 会被 SSE 事件和 4s 主轮询反复调用，每次都新起一个
  // setTimeout 且从不取消旧的，切换/高频刷新时 timer 会不断累积；
  // 而下面的 4s 主轮询（loadSessions）已经会对 running/waiting 的会话刷新详情，
  // 功能完全覆盖，2s 递归属于纯重复请求。
}
