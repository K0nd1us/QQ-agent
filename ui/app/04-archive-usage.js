// 〔存档 / 用量〕——M9 拆分第 5 段
'use strict';
// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  box.innerHTML = state.chats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  if (state.quoteMode) state.quoteSelected = new Set();   // 金句按单段对话收录，换会话清空勾选
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  // 请求序号：只认最后一次请求的回包。标已读/切会话时并发拉取会互相覆盖，
  // 旧回包把乐观更新的"已读"冲回"未读"，表现为闪一下再变。
  const reqId = (state.chatMsgReqId = (state.chatMsgReqId || 0) + 1);
  try {
    // 只取最近 3000 条：10 万条全量拉取 + JSON.parse 是帧率杀手。
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=3000`);
    // 期间用户可能切走了会话，或已有更新的请求发出 —— 别覆盖当前视图
    if (state.currentChatKey !== key || reqId !== state.chatMsgReqId) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key || reqId !== state.chatMsgReqId) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span><span data-field="chat-continuation"></span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-newconv-btn" title="丢弃机器人对这段对话的上下文（LLM 侧历史），下一句从全新会话开始；不影响消息存档与群友印象">重开会话</button>
      <button class="btn btn-small" id="chat-del-mode-btn" title="选择部分消息删除">选择删除</button>
      <button class="btn btn-small btn-danger" id="chat-clear-btn" title="清空这个会话的全部消息存档">清空存档</button>
      <input type="text" id="test-send-text" class="inp" placeholder="手动发一条测试消息" style="flex:1;min-width:120px" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <div class="chat-toolbar chat-del-bar" id="chat-del-bar" style="display:none">
      <span class="muted" id="chat-del-count">已选 0 条</span>
      <button class="btn btn-small btn-danger" id="chat-del-confirm-btn">删除选中</button>
      <button class="btn btn-small" id="chat-del-cancel-btn">取消</button>
    </div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;
  // 切换会话（整页骨架重建）时详情淡入；滚动加载/原地刷新（keepView）不播
  uiEnter(detail);

  // 工具栏事件：只在这里绑一次
  // （「全部标为已读 / 仅屏蔽」已移除：不触发的消息现在自动立即标已读）
  // 延续状态（异步填充；失败静默 —— 它只是个提示，不该影响存档页可用性）
  api(`/api/chats/${key.replace(':', '_')}/continuation`)
    .then((d) => {
      if (state.currentChatKey !== key) return;
      const el = detail.querySelector('[data-field="chat-continuation"]');
      if (el) el.textContent = d.continuation ? `· 会话延续中：${d.continuation.turns} 轮` : '';
    })
    .catch(() => { /* ignore */ });
  // 重开会话（二次确认）：丢弃 LLM 侧的对话历史 —— 机器人"忘掉自己想过什么"，
  // 下一句从全新会话开始。与「清空存档」的区别：消息存档与群友印象都不动。
  $('#chat-newconv-btn').addEventListener('click', async () => {
    let info = null;
    try { info = (await api(`/api/chats/${key.replace(':', '_')}/continuation`)).continuation; } catch { /* 拿不到就按"无延续"提示 */ }
    const detailLine = info
      ? `当前这段对话已延续 ${info.turns} 轮（上下文约 ${info.messages} 条消息）。\n\n`
      : '当前没有进行中的延续会话（重开仍然安全，只是没有可丢弃的上下文）。\n\n';
    if (!(await uiConfirm(
      `${detailLine}重开会话后，机器人会忘掉这段对话里自己想过、说过什么，下一句将从全新会话开始。\n消息存档与群友印象不受影响。\n\n确定重开吗？`,
      { okText: '重开会话' }
    ))) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/new-conversation`, { method: 'POST', body: '{}' });
      const el = detail.querySelector('[data-field="chat-continuation"]');
      if (el) el.textContent = '';
      alert('已重开会话：下一句将从全新会话开始。');
    } catch (e) {
      alert(`重开会话失败：${e.message}`);
    }
  });
  // 清空存档：删除这个会话的全部消息（不可恢复）
  $('#chat-clear-btn').addEventListener('click', async () => {
    const meta = state.chats.find((c) => c.key === key) || {};
    if (!(await uiConfirm(`确定清空「${name}」的全部消息存档？\n\n共 ${meta.total ?? '?'} 条消息，删除后不可恢复。\n（机器人之后来新消息会重新记录）`))) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/clear`, { method: 'POST', body: '{}' });
      loadChats();
      loadChatMessages(key);
    } catch (e) {
      alert(`清空失败：${e.message}`);
    }
  });
  // ── 选择删除（部分消息）──
  state.chatDeleteMode = state.chatDeleteMode || false;
  state.chatDeleteSelected = state.chatDeleteSelected || new Set();
  const delBar = $('#chat-del-bar');
  const detailPane = $('#chat-detail');
  // 显示/隐藏删除条时按高度差补偿 scrollTop：
  // 条在表格上方，直接 toggle 会把下方内容顶下去，视口看起来"往上弹"。
  // 补偿后视觉上是操作条向下展开、正文原地不动。
  const setDelBarVisible = (show) => {
    const prevTop = detailPane?.scrollTop || 0;
    // 显隐过渡：出现=淡入、消失=淡出后落实 display:none；
    // 高度差补偿挪进 apply 里做，保证量到的是落定后的高度（消失是延迟落定的）。
    const apply = (setFn) => {
      const prevH = delBar.offsetHeight;
      setFn();
      const nextH = delBar.offsetHeight;
      if (detailPane) detailPane.scrollTop = prevTop + (nextH - prevH);
    };
    if (show) uiShow(delBar, () => apply(() => { delBar.style.display = 'flex'; }));
    else uiHide(delBar, () => apply(() => { delBar.style.display = 'none'; }));
  };
  const updateDelBar = () => {
    $('#chat-del-count').textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    setDelBarVisible(state.chatDeleteMode);
  };
  $('#chat-del-mode-btn').addEventListener('click', () => {
    state.chatDeleteMode = !state.chatDeleteMode;
    if (!state.chatDeleteMode) state.chatDeleteSelected.clear();
    updateDelBar();
    updateChatMessagesBody(true);   // 重渲染出行首勾选框
  });
  $('#chat-del-cancel-btn').addEventListener('click', () => {
    state.chatDeleteMode = false;
    state.chatDeleteSelected.clear();
    updateDelBar();
    updateChatMessagesBody(true);
  });
  // 拖动批量选择：按住左键扫过行 = 勾选/取消（跟随起点状态取反）。
  // 监听器必须只绑定一次且挂在详情容器上；切换会话会反复重建内部 HTML，
  // 若绑定到 document 会不断累积，导致一次拖动触发几十次处理。
  if (!detail.__chatDragBound) {
    detail.__chatDragBound = true;
    let dragSelect = false;
    let dragValue = false;
    const setRowSelected = (id, on) => {
      if (on) state.chatDeleteSelected.add(id); else state.chatDeleteSelected.delete(id);
      const tr = detail.querySelector(`tr[data-midrow="${id}"]`);
      const chk = tr?.querySelector('.chat-del-check');
      if (chk) chk.checked = on;
      tr?.classList.toggle('chat-del-selected', on);
      const cnt = detail.querySelector('#chat-del-count');
      if (cnt) cnt.textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    };
    const rowIdFromEvent = (e) => {
      const tr = e.target.closest?.('tr[data-midrow]');
      return tr && detail.contains(tr) ? Number(tr.dataset.midrow) : null;
    };
    detail.addEventListener('pointerdown', (e) => {
      if (!state.chatDeleteMode) return;
      const id = rowIdFromEvent(e);
      if (id == null) return;
      dragSelect = true;
      dragValue = !state.chatDeleteSelected.has(id);
      setRowSelected(id, dragValue);
    });
    detail.addEventListener('pointermove', (e) => {
      if (!dragSelect || !state.chatDeleteMode) return;
      const id = rowIdFromEvent(e);
      if (id == null) return;
      if (state.chatDeleteSelected.has(id) !== dragValue) setRowSelected(id, dragValue);
    });
    detail.addEventListener('pointerup', () => { dragSelect = false; });
    detail.addEventListener('pointercancel', () => { dragSelect = false; });
  }
  $('#chat-del-confirm-btn').addEventListener('click', async () => {
    const ids = [...state.chatDeleteSelected];
    if (!ids.length) { alert('请先勾选要删除的消息'); return; }
    if (!(await uiConfirm(`确定删除选中的 ${ids.length} 条消息？删除后不可恢复。`))) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/delete-messages`, {
        method: 'POST', body: JSON.stringify({ ids })
      });
      state.chatDeleteMode = false;
      state.chatDeleteSelected.clear();
      updateDelBar();
      loadChats();
      loadChatMessages(key, { keepView: true });
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
  // 删除勾选框（事件委托，tbody 会被重建）
  if (!detail.__chatDelBound) {
    detail.__chatDelBound = true;
    detail.addEventListener('change', (e) => {
      const chk = e.target.closest?.('.chat-del-check');
      if (!chk) return;
      const id = Number(chk.dataset.mid);
      if (chk.checked) state.chatDeleteSelected.add(id); else state.chatDeleteSelected.delete(id);
      const cnt = $('#chat-del-count');
      if (cnt) cnt.textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    });
  }
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
      method: 'POST', body: JSON.stringify({ text })
    });
    input.value = '';
    // 同理，保持当前分页与滚动位置
    loadChatMessages(key, { keepView: true });
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  // 防御：02 模块若加载失败，这里不要把整个存档详情打成「加载失败」
  try { if (typeof initChatScrollLoader === 'function') initChatScrollLoader(); } catch (_) { /* 滚动加载缺失不影响看消息 */ }
  // 金句勾选：事件委托挂在容器上（tbody 会被轮询重建，委托不受影响的）。
  // 防重复：renderChatMessages 每次切会话都会跑，容器只绑一次。
  if (!detail.__quoteBound) {
    detail.__quoteBound = true;
    detail.addEventListener('change', (e) => {
      const cb = e.target.closest?.('.quote-check');
      if (!cb) return;
      const mid = Number(cb.dataset.mid);
      if (cb.checked) state.quoteSelected.add(mid); else state.quoteSelected.delete(mid);
      cb.closest('tr')?.classList.toggle('quote-selected', cb.checked);
    });
  }
}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  // 金句勾选模式：行首加勾选框；选中态存 state.quoteSelected（按消息 id），
  // 轮询重建行时勾选状态不丢
  const q = state.quoteMode
    ? `<td class="q-check"><input type="checkbox" class="quote-check" data-mid="${m.id}" ${state.quoteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  // 删除勾选模式：行首加删除勾选框（与金句勾选互斥）
  const d = state.chatDeleteMode
    ? `<td class="q-check"><input type="checkbox" class="chat-del-check" data-mid="${m.id}" ${state.chatDeleteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  const sel = state.quoteMode && state.quoteSelected.has(m.id) ? ' quote-selected' : '';
  const dsel = state.chatDeleteMode && state.chatDeleteSelected.has(m.id) ? ' chat-del-selected' : '';
  return `
    <tr class="${m.read ? '' : 'unread'}${sel}${dsel}" data-midrow="${m.id}">${q}${d}
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || total || 0;
    cnt.textContent = t
      ? `共 ${t} 条 · 已显示 ${shownCount} 条 · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

function renderUsageSkeleton() {
  const card = '<div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
  const row = '<div class="sk-row"></div>';
  // 五张卡一行（与正式页面一致），加载完成时布局不跳
  return `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <div class="usage-days"><span class="sk-line" style="width:180px"></span></div>
      </div>
      <div class="usage-cards">${card.repeat(5)}</div>
      <div class="sk-block">${row.repeat(5)}</div>
      <div class="sk-block">${row.repeat(4)}</div>
    </div>`;
}

/** 建骨架（只建一次，轮询走 updateUsagePage 以免滚动位置丢失）。 */
function renderUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;

  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <div class="usage-days">
          ${USAGE_RANGES.map(([v, label]) => `<button class="btn btn-small" data-range="${v}">${label}</button>`).join('')}
          <button class="btn btn-small" id="usage-refresh-btn" title="立即刷新">刷新</button>
        </div>
      </div>

      <!-- 估算成本放第一张：它是这张页的主指标（accent 描边/底色突出）。
           五张卡固定一行（曾经第一张跨两列、整体占两行，已按需求改单行）。 -->
      <div class="usage-cards">
        <div class="usage-card accent">
          <div class="uc-label">估算成本</div>
          <div class="uc-value" data-field="cost">-</div>
          <div class="uc-sub" data-field="cost-sub">-</div>
          <div class="spark" data-spark="0,0,0,0,0,0,0" data-spark-key="cost"></div>
        </div>
        <div class="usage-card clickable" id="runs-card" title="点击查看各类工具分别调用了多少次">
          <div class="uc-label">调用次数 <span class="uc-more">明细 ›</span></div>
          <div class="uc-value" data-field="runs">-</div>
          <div class="uc-sub" data-field="runs-sub">-</div>
          <div class="spark" data-spark="0,0,0,0,0,0,0" data-spark-key="runs"></div>
        </div>
        <div class="usage-card">
          <div class="uc-label">搜索次数 <span class="uc-tag">不计入成本</span></div>
          <div class="uc-value" data-field="search">-</div>
          <div class="uc-sub" data-field="search-sub">-</div>
          <div class="spark" data-spark="0,0,0,0,0,0,0" data-spark-key="search"></div>
        </div>
        <div class="usage-card">
          <div class="uc-label">输入 token</div>
          <div class="uc-value" data-field="prompt">-</div>
          <div class="uc-sub" data-field="prompt-sub">-</div>
          <div class="spark" data-spark="0,0,0,0,0,0,0" data-spark-key="promptTokens"></div>
        </div>
        <div class="usage-card">
          <div class="uc-label">缓存命中率</div>
          <div class="uc-value" data-field="rate">-</div>
          <div class="uc-sub" data-field="rate-sub">-</div>
          <div class="spark" data-spark="0,0,0,0,0,0,0" data-spark-key="cacheHitRate"></div>
        </div>
      </div>

      <div data-block="days">
        <h3 class="usage-h3">按天</h3>
        <table class="usage-table clickable" data-table="days">
          <thead><tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div data-block="chats">
        <h3 class="usage-h3">按会话</h3>
        <table class="usage-table clickable" data-table="chats">
          <thead><tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div data-block="models">
        <h3 class="usage-h3">按模型
          <button class="btn btn-small ub-expand" id="models-expand" style="display:none">展开全部</button>
        </h3>
        <table class="usage-table clickable" data-table="models">
          <thead><tr><th>模型（渠道：模型 id）</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  // 「调用次数」卡片可点开明细（骨架重建后重新绑定，所以放在 renderUsagePage 里）
  const runsCard = $('#usage-page #runs-card');
  if (runsCard) runsCard.addEventListener('click', () => openToolBreakdown());

  $$('#usage-page [data-range]').forEach((el) => {
    el.addEventListener('click', () => {
      usageRange = el.dataset.range;
      loadUsageView({ force: true });
    });
  });
  $('#usage-refresh-btn')?.addEventListener('click', () => loadUsageView({ force: true }));

  // 行点击 → 弹明细
  box.querySelector('[data-table="days"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('day', tr.dataset.key);
  });
  box.querySelector('[data-table="chats"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('chat', tr.dataset.key);
  });
  box.querySelector('[data-table="models"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('model', tr.dataset.key);
  });

  // 「展开全部 / 收起」按钮：显隐与文案由 updateUsagePage 里的 fill() 负责，
  // 但此前**没有任何地方监听它的点击**，也没有代码把 tbody.dataset.expanded 置为 '1' ——
  // 结果是：模型超过 20 行时按钮会出现、写着「展开全部（还有 N 行）」，点下去却毫无反应，
  // 剩下的行永远看不到。这里补上开合逻辑（复用 updateUsagePage 重绘，不重新请求接口）。
  const modelsExpandBtn = box.querySelector('#models-expand');
  if (modelsExpandBtn) {
    modelsExpandBtn.addEventListener('click', () => {
      const tb = box.querySelector('[data-table="models"] tbody');
      const args = state.usageRenderArgs;
      if (!tb || !args) return;
      tb.dataset.expanded = tb.dataset.expanded === '1' ? '0' : '1';
      updateUsagePage(args.stats, args.st, args.prices);
    });
  }

  updateUsagePage(stats, st, prices);
  // 整页重建（切页签 / 换时间范围）时内容淡入；轮询走 updateUsagePage 不播
  uiEnter(box);
}

/** 只更新数值与表格行，不碰骨架。 */
function updateUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;
  // 记住最近一次渲染参数：供「展开全部/收起」按钮原地重绘（不重新请求接口）
  state.usageRenderArgs = { stats, st, prices };
  const t = stats?.totals || {};
  const cfg = state.config || {};

  // 统一存字符串：曾经这里把数字直接赋给 textContent（如 runs=0 时存的是数字 0
  // 而非 '0'）。浏览器会隐式转换所以显示没问题，但类型不一致会在别处埋雷
  // （比较、测试断言、序列化时都可能踩到）。这里显式转成字符串。
  const set = (f, v) => {
    const el = box.querySelector(`[data-field="${f}"]`);
    if (!el) return;
    const s = String(v);
    if (el.textContent !== s) el.textContent = s;
  };

  // 价格口径说明（不再显示"当前模型" —— 全天可能换过多个模型）
  const today = st?.usage || {};
  set('runs', t.runs || 0);
  set('runs-sub', `今日 ${today.runs ?? 0} 次`);
  // 搜索次数：只列数量，不参与成本计算（搜索通常是资源包或免费的）
  const searches = Number(stats?.searchCount) || 0;
  set('search', fmtTok(searches));
  // 拆开显示搜索与抓取的构成（曾经三元两分支文案相同，判定是死逻辑）
  {
    const nSearch = Number(stats?.toolCounts?.web_search) || 0;
    const nFetch = Number(stats?.toolCounts?.web_fetch) || 0;
    set('search-sub', searches
      ? `搜索 ${nSearch} · 抓网页 ${nFetch}`
      : '本区间没有联网');
  }
  set('prompt', fmtTok(t.promptTokens));
  set('prompt-sub', `输出 ${fmtTok(t.completionTokens)}`);
  set('rate', `${((t.cacheHitRate || 0) * 100).toFixed(1)}%`);
  // 只报命中量：「输入」已是独立卡片（输入 token），再写一遍会把副标题撑成两行，
  // 五张卡的副标题高度就对不齐了
  set('rate-sub', `命中 ${fmtTok(t.cachedTokens)}`);
  set('cost', fmtYuan(t.cost));
  set('cost-sub', stats?.rangeLabel || '');

  // spark 柱图：今日按小时 0~23，近 7 天 / 近 30 天 / 全部按天。
  // 悬停就地改写卡片头部（见 bindSparkHover）。
  {
    const mode = stats?.mode;
    const days = stats?.days || [];
    const hours = stats?.hours || [];
    let labels = [];
    let valsByKey;
    if (mode === 'today' && hours.length) {
      labels = hours.map((h) => `${String(h.hour).padStart(2, '0')}:00`);
      valsByKey = {
        cost: hours.map((h) => Number(h.cost) || 0),
        runs: hours.map((h) => Number(h.runs) || 0),
        search: hours.map((h) => Number(h.searchCount) || 0),
        promptTokens: hours.map((h) => Number(h.promptTokens) || 0),
        cacheHitRate: hours.map((h) => Number(h.cacheHitRate) || 0)
      };
    } else {
      // 前导全 0 的日子直接裁掉：30 天窗口会从 30 天前逐日枚举，
      // 没用量的开头几天占着柱图毫无信息量
      let list = mode === 'all' ? days.slice(-30) : days.slice();
      const dayEmpty = (d) => !(Number(d?.runs) || 0)
        && !(Number(d?.cost) || 0)
        && !(Number(d?.promptTokens) || 0)
        && !(Number(d?.searchCount) || 0);
      while (list.length > 1 && dayEmpty(list[0])) list = list.slice(1);
      labels = list.map((d) => String(d.day || d.date || ''));
      const pick = (key) => list.map((d) => {
        if (key === 'cacheHitRate') return Number(d?.cacheHitRate) || 0;
        if (key === 'search') return Number(d?.searchCount) || 0;
        return Number(d?.[key]) || 0;
      });
      valsByKey = {
        cost: pick('cost'), runs: pick('runs'),
        search: pick('search'),
        promptTokens: pick('promptTokens'), cacheHitRate: pick('cacheHitRate')
      };
      if (!list.length) {
        valsByKey = {
          cost: [t.cost || 0], runs: [t.runs || 0],
          search: [Number(stats?.searchCount) || 0],
          promptTokens: [t.promptTokens || 0], cacheHitRate: [t.cacheHitRate || 0]
        };
        labels = [stats?.rangeLabel || ''];
      }
    }
    box.querySelectorAll('.spark[data-spark-key]').forEach((sp) => {
      const key = sp.dataset.sparkKey;
      const vals = valsByKey[key] || [0];
      sp.dataset.spark = vals.join(',');
      if (typeof renderSpark === 'function') renderSpark(sp, vals, labels);
    });
  }
  if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);

  // 范围按钮高亮
  $$('#usage-page [data-range]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.range === String(usageRange));
  });

  // 单日/24小时 → 隐藏"按天"
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.style.display = (stats?.mode === 'days') ? '' : 'none';

  // 行数很多时（按模型常有几十行）默认只显示前 N 行，点"展开全部"再看全部。
  // 注意：后端不截断（保证求和一致），这里只是前端显示层面的折叠。
  const COLLAPSE_AT = 20;
  const fill = (name, list, build, opts = {}) => {
    const tbody = box.querySelector(`[data-table="${name}"] tbody`);
    if (!tbody) return;
    const wanted = list || [];
    const collapsed = Boolean(opts.collapsible) && wanted.length > COLLAPSE_AT
      && tbody.dataset.expanded !== '1';
    const shown = collapsed ? wanted.slice(0, COLLAPSE_AT) : wanted;
    const moreBtn = opts.expandBtn ? box.querySelector(opts.expandBtn) : null;
    if (moreBtn) {
      if (wanted.length > COLLAPSE_AT) {
        moreBtn.style.display = '';
        moreBtn.textContent = collapsed
          ? `展开全部（还有 ${wanted.length - COLLAPSE_AT} 行）`
          : '收起';
      } else {
        moreBtn.style.display = 'none';
      }
    }
    if (!wanted.length) {
      if (tbody.dataset.empty !== '1') {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">无</td></tr>';
        tbody.dataset.empty = '1';
      }
      return;
    }
    tbody.dataset.empty = '0';
    const html = shown.map(build).join('');
    if (tbody.dataset.sig !== html) {
      const prev = tbody.dataset.sig || '';
      // 展开时新 HTML 是旧 HTML 的前缀扩展：只追加尾部，避免整表重建掉帧
      if (prev && html.startsWith(prev) && html.length > prev.length) {
        tbody.insertAdjacentHTML('beforeend', html.slice(prev.length));
      } else {
        tbody.innerHTML = html;
      }
      tbody.dataset.sig = html;
    }
  };

  fill('days', stats?.days, (d) => `
    <tr data-key="${esc(d.day)}">
      <td>${esc(d.day)}</td>
      <td class="r">${d.runs}</td>
      <td class="r">${fmtTok(d.promptTokens)}</td>
      <td class="r">${fmtTok(d.completionTokens)}</td>
      <td class="r">${fmtTok(d.cachedTokens)}</td>
      <td class="r">${((d.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(d.cost)}</td>
    </tr>`);

  fill('chats', stats?.chats, (c) => `
    <tr data-key="${esc(c.key)}">
      <td>${esc(formatChatTitle(c.key, chatNameOf(c.key)))}</td>
      <td class="r">${c.runs}</td>
      <td class="r">${fmtTok(c.promptTokens)}</td>
      <td class="r">${fmtTok(c.completionTokens)}</td>
      <td class="r">${((c.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(c.cost)}</td>
    </tr>`);

  // 模型与供应商分两列显示：同一个 id 走不同渠道是不同的"商品"，
  // 价格可能差很多（中转站加价、:free 版本等），必须能区分开。
  fill('models', stats?.models, (m) => `
    <tr data-key="${esc(m.key)}">
      <td>${esc(m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key))}</td>
      <td class="r">${m.runs}</td>
      <td class="r">${fmtTok(m.promptTokens)}</td>
      <td class="r">${fmtTok(m.completionTokens)}</td>
      <td class="r">${((m.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(m.cost)}</td>
    </tr>`, { collapsible: true, expandBtn: '#models-expand' });
}

/** 峰谷拆分条（弹窗外部上方展示；没用到分时段计价的模型则不显示）。 */
/**
 * 加载用量页。
 *
 * @param {boolean} force  true = 重建整个页面骨架（切换页签、切换时间范围、点刷新）；
 *                         false = 轮询刷新，只更新数值与表格行，不重建 DOM。
 *
 * ── 为什么要分开 ──
 * 轮询每 15 秒一次，如果每次都重建 DOM，用户正在看的行会被重新渲染、
 * 滚动位置也会丢。所以轮询走"只更新数值"这条路。
 *
 * ── 加载为什么快 ──
 * 1. 三个接口用 Promise.all **并行**请求（串行会慢 3 倍）
 * 2. 骨架屏**立即**显示，不等数据回来 —— 用户切过去马上看到布局，不会"黑一会"
 * 3. 竞态防护：请求期间用户可能切走或改了时间范围，回来时丢弃过期结果
 */
let usageLoadToken = 0;          // 每次加载递增，用于丢弃过期结果
let usageLastData = null;        // 上一次加载成功的数据：{ range, stats, st, prices }
                                 // 用于切回用量页时先立即画出旧内容，避免"黑一下"

async function loadUsageView({ force = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;

  // ── 轮询刷新：只更新数值，不重建 DOM ──
  if (!force) {
    try {
      const [stats, st] = await Promise.all([
        api(`/api/usage/stats?range=${usageRange}`),
        api('/api/status')
      ]);
      // 用户可能已经切走页签了，那就别动了
      if (state.tab !== 'usage') return;
      state.usageStats = stats;
      // ⚠️ 价格不用再请求：启动时已加载进 state.modelPrices（/api/model-prices），
      //    更新时按需拉取即可。曾经这里请求了一个**不存在的** /api/usage/prices，
      //    404 会让整个 Promise.all reject → 用量页永远加载失败。
      updateUsagePage(stats, st, state.modelPrices || {});
    } catch (e) { /* 轮询失败静默，不打扰用户 */ }
    return;
  }

  // ── 强制重建 ──
  const token = ++usageLoadToken;
  const range = usageRange;

  // ★ 先用上一次的数据立即渲染（如果有的话），而不是先画骨架等网络。
  //   后端统计的冷启动实测约 200ms（要遍历全部会话文件），热数据只要 24ms；
  //   但缓存 TTL 只有 5 秒、轮询 4 秒一次，切回用量页时缓存经常已经过期，
  //   于是每次都要等那 200ms —— 表现就是"点过去黑一下"。
  //   有旧数据时直接先画出来（0ms 可见），再在后台拉新的覆盖。
  const cached = usageLastData && usageLastData.range === range ? usageLastData : null;
  if (cached) {
    state.usageStats = cached.stats;
    renderUsagePage(cached.stats, cached.st, cached.prices);
  } else {
    box.innerHTML = renderUsageSkeleton();
  }

  try {
    const [stats, st] = await Promise.all([
      api(`/api/usage/stats?range=${range}`),
      api('/api/status')
    ]);
    const prices = state.modelPrices || {};   // 启动时已加载，无需再请求
    // 竞态：期间用户切走了页签、或又点了别的时间范围 → 这次结果作废
    if (token !== usageLoadToken) return;
    if (state.tab !== 'usage' || usageRange !== range) return;

    state.usageStats = stats;
    usageLastData = { range, stats, st, prices };

    if (cached) {
      // 已有页面：只更新数值，不重建（避免打断用户的滚动/交互）
      updateUsagePage(stats, st, prices);
    } else {
      // ⚠️ renderUsagePage 不返回字符串 —— 它内部自己写 box.innerHTML、
      //    绑定事件、并调用 updateUsagePage 填数值。
      //    所以这里只能"直接调用"，不能再赋值（赋 undefined 会把页面清空）。
      renderUsagePage(stats, st, prices);
    }
  } catch (e) {
    if (token !== usageLoadToken) return;
    // 旧数据还在页面上就别用错误覆盖它（用户至少能看到上一次的数字）
    if (!cached) box.innerHTML = `<div class="empty-hint">用量加载失败：${esc(e?.message || e)}</div>`;
  }
}

function peakSplitHtml(sum) {
  if (!sum || !sum.hasPeakModel) return '';
  if (!(sum.peakCost > 0 || sum.offPeakCost > 0)) return '';
  const ratio = sum.peakRatio || 0;
  return `
    <div class="usage-peak">
      <div class="up-title">峰谷拆分</div>
      <div class="up-row">
        <span class="up-dot peak"></span>
        <span class="up-label">峰时</span>
        <span class="up-val">${fmtYuan(sum.peakCost)}</span>
        <span class="up-bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${(ratio * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-row">
        <span class="up-dot off"></span>
        <span class="up-label">闲时</span>
        <span class="up-val">${fmtYuan(sum.offPeakCost)}</span>
        <span class="up-bar"><i class="off" style="width:${((1 - ratio) * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${((1 - ratio) * 100).toFixed(0)}% token</span>
      </div>
    </div>`;
}

/**
 * 点表格行 → 弹明细。
 * dim 决定可选的第二个维度：
 *   chat  → 按模型 / 按天
 *   model → 按会话 / 按天
 *   day   → 按模型 / 按会话
 */
function openUsageBreakdown(dim, key) {
  const tabs = {
    chat: [['model', '各模型'], ['day', '各天']],
    model: [['chat', '各群聊'], ['day', '各天']],
    day: [['model', '各模型'], ['chat', '各群聊']]
  }[dim] || [['model', '各模型']];

  const dimLabel = { chat: '会话', model: '模型', day: '日期' }[dim] || '';
  let activeBy = tabs[0][0];

  const overlay = modelModalShell({
    head: `明细：${dimLabel} ${esc(key)}`,
    body: `
      <div class="ub-wrap">
        <div class="ub-tabs" id="ub-tabs">${tabs.map(([v, l]) => `<button class="btn btn-small" data-by="${v}">${l}</button>`).join('')}</div>
        <div id="ub-peak"></div>
        <div class="ub-scroll">
          <table class="usage-table">
            <thead><tr><th id="ub-col">项目</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody id="ub-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>`,
    foot: `<button class="btn" id="ub-close">关闭</button>`
  });

  const bodyEl = overlay.querySelector('#ub-body');
  const peakEl = overlay.querySelector('#ub-peak');
  const colEl = overlay.querySelector('#ub-col');

  async function load() {
    bodyEl.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
    try {
      const r = await api(`/api/usage/breakdown?range=${encodeURIComponent(usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${activeBy}`);
      peakEl.innerHTML = peakSplitHtml(r.totals);
      colEl.textContent = { model: '模型', chat: '会话', day: '日期' }[activeBy] || '项目';
      bodyEl.innerHTML = (r.rows || []).length
        ? r.rows.map((x) => `
            <tr>
              <td>${esc(activeBy === 'chat'
                ? formatChatTitle(x.key, chatNameOf(x.key))
                : (x.vendor ? `${x.vendor}：${x.model}` : (x.model ?? x.key)))}</td>
              <td class="r">${x.runs}</td>
              <td class="r">${fmtTok(x.promptTokens)}</td>
              <td class="r">${fmtTok(x.completionTokens)}</td>
              <td class="r">${((x.cacheHitRate || 0) * 100).toFixed(0)}%</td>
              <td class="r">${fmtYuan(x.cost)}</td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="muted">无数据</td></tr>';
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="6" class="muted">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((el) => {
    el.addEventListener('click', () => {
      activeBy = el.dataset.by;
      overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
      load();
    });
  });
  overlay.querySelector('#ub-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
  load();
}
