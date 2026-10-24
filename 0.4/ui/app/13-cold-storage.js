// 〔冷储存视图〕—— 快照列表 / 关键词检索 / 还原
'use strict';
//
// 为什么要有这一页：清空会话、删消息、删记忆、清理已结束会话、重置数据目录，全都是**真删**。
// 后端虽然会在这些动作之前自动打快照（见 src/cold-storage.js），但"到底存了没有、能不能
// 找回来"必须让人能自己看见 —— 否则等于没有。这一页只做三件事：
//   1. 看有哪些快照（时间 / 原因 / 多大 / 存了几条印象）；
//   2. 按关键词翻旧账（记忆、消息、会话留档都能命中）；
//   3. 把记忆还原回去（只并回缺的，可重复点）。
//
// 所有数据都走 /api/cold-storage/*，页面自身不碰文件系统。

/** 页面级状态（懒建，避免与 00-core 的 state 初始化顺序耦合）。 */
function coldState() {
  if (!state.cold) {
    state.cold = { status: null, snapshots: [], hits: null, query: '', chat: '', openId: '', busy: false, note: '' };
  }
  return state.cold;
}

function coldFmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function coldFmtIso(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 快照 id 形如 20261024-205446-107_手动测试：取时间部分给人看，原因单独显示。 */
function coldSnapTitle(id) {
  const raw = String(id || '');
  const m = raw.match(/^(\d{8})-(\d{6})-(\d{3})_(.*)$/);
  if (!m) return raw;
  const [, ymd, hms, , reason] = m;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} ${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}${reason ? ` · ${reason}` : ''}`;
}

async function loadColdStorageView() {
  const box = $('#storage-page');
  if (!box) return;
  const s = coldState();
  try {
    const [status, list, chats] = await Promise.all([
      api('/api/cold-storage/status'),
      api('/api/cold-storage/list'),
      api('/api/chats').catch(() => ({ chats: [] }))
    ]);
    s.status = status;
    s.snapshots = list.snapshots || [];
    if (Array.isArray(chats?.chats) && chats.chats.length) state.chats = chats.chats;
    // 选中的快照可能已经被轮转删掉了：清掉悬空选中，避免详情显示一份不存在的快照。
    if (s.openId && !s.snapshots.some((x) => x.id === s.openId)) s.openId = '';
    renderColdStoragePage();
  } catch (e) {
    box.innerHTML = `<div class="empty-hint">加载冷储存失败：${esc(e && e.message ? e.message : e)}</div>`;
  }
}

function renderColdStoragePage() {
  const box = $('#storage-page');
  if (!box) return;
  const s = coldState();
  const st = s.status || {};
  const running = st.running
    ? `<span class="badge" style="background:var(--orange);color:#1b1b1b">应用运行中（PID ${esc(String(st.pid ?? ''))}）</span>`
    : '<span class="badge">应用未运行</span>';

  // 检索作用域下拉：默认全部会话；选了某个会话就只搜它自己的消息/记忆/留档。
  const chatOptions = [`<option value="">全部会话</option>`]
    .concat((state.chats || []).map((c) => {
      const title = (() => {
        try { return formatChatTitle(c.key, chatNameOf(c.key)); } catch { return c.key; }
      })();
      return `<option value="${esc(c.key)}"${s.chat === c.key ? ' selected' : ''}>${esc(title)}</option>`;
    }))
    .join('');

  const note = s.note ? `<div class="cold-note">${esc(s.note)}</div>` : '';
  const hits = s.hits;

  box.innerHTML = `
    <section class="cold-card">
      <div class="cold-row">
        <div class="cold-heading">长期冷储存</div>
        <div class="cold-badges">
          <span class="badge">${esc(String(st.count ?? s.snapshots.length))} 份快照</span>
          <span class="badge">占用 ${esc(coldFmtBytes(st.totalBytes))}</span>
          ${running}
        </div>
      </div>
      <div class="muted cold-hint">
        清空会话、删除消息、删除记忆、清理已结束会话、重置数据目录之前都会自动存档；
        归档放在数据目录隔壁的 <code>cold-storage/</code>，重置数据目录也删不到它。
      </div>
      <div class="cold-actions">
        <button class="btn btn-small" id="cold-snapshot-btn">立即快照</button>
        <button class="btn btn-small" id="cold-prune-btn">只留最近 50 份</button>
        <button class="btn btn-small" id="cold-refresh-btn">刷新</button>
        ${st.running ? '<span class="muted cold-hint">还原前请先退出应用：内存态会覆盖磁盘。</span>' : ''}
      </div>
      ${note}
    </section>

    <section class="cold-card">
      <div class="cold-heading">翻旧账</div>
      <div class="cold-search-row">
        <input type="search" class="module-search" id="cold-search-input"
               placeholder="关键词，例如某个群友的名字、聊过的梗…" value="${esc(s.query)}" />
        <select class="module-search cold-select" id="cold-search-chat">${chatOptions}</select>
        <button class="btn btn-small" id="cold-search-btn">检索</button>
        <button class="btn btn-small" id="cold-clear-search-btn">清空</button>
      </div>
      <div id="cold-search-result">${renderColdSearchResult(hits)}</div>
    </section>

    <section class="cold-card">
      <div class="cold-heading">快照</div>
      <div id="cold-snapshot-list">${renderColdSnapshotList()}</div>
    </section>
  `;

  bindColdStorageEvents();
}

function renderColdSearchResult(hits) {
  if (!hits) return '<div class="muted cold-hint">输入关键词后点「检索」。检索的是**所有历史快照**（可按会话限定）。</div>';
  if (!hits.total) return `<div class="muted cold-hint">没有命中「${esc(hits.q)}」—— 可能重置前也没聊过，或那段还没存档。</div>`;
  const rows = hits.items.map((h) => `
    <div class="cold-hit">
      <div class="cold-hit-label">${esc(h.label)}</div>
      <div class="cold-hit-snippet">${esc(h.snippet)}</div>
      <div class="cold-hit-meta muted">${esc(coldSnapTitle(h.snapshot))} · ${esc(coldFmtIso(h.at))}</div>
    </div>`).join('');
  return `<div class="muted cold-hint">命中 ${esc(String(hits.total))} 条，来自 ${esc(String(hits.snapshots))} 份快照：</div>${rows}`;
}

function renderColdSnapshotList() {
  const s = coldState();
  if (!s.snapshots.length) {
    return '<div class="muted cold-hint">还没有任何快照。清空/删除/重置之前会自动打一份，也可以点上面的「立即快照」。</div>';
  }
  return s.snapshots.map((snap) => {
    const open = snap.id === s.openId;
    const mem = Object.values(snap.memoryCounts || {}).reduce(
      (acc, c) => ({ m: acc.m + (Number(c.members) || 0), i: acc.i + (Number(c.impressions) || 0) }),
      { m: 0, i: 0 }
    );
    const memText = mem.m ? ` · 群友 ${mem.m} · 印象 ${mem.i}` : '';
    const detail = open ? renderColdSnapshotDetail(snap) : '';
    return `
      <div class="cold-snap${open ? ' open' : ''}" data-id="${esc(snap.id)}">
        <div class="cold-snap-head">
          <span class="cold-snap-title">${esc(coldSnapTitle(snap.id))}</span>
          <span class="badge">${esc(coldFmtBytes(snap.totalBytes))}</span>
        </div>
        <div class="cold-snap-sub muted">
          ${esc(coldFmtIso(snap.createdAt))} · 原因 ${esc(snap.reason || '-')}${snap.note ? ` · ${esc(snap.note)}` : ''}${esc(memText)}
        </div>
        ${detail}
      </div>`;
  }).join('');
}

function renderColdSnapshotDetail(snap) {
  const files = (snap.files || []).slice(0, 200).map((f) => `
    <div class="cold-file muted"><span>${esc(f.path)}</span><span>${esc(coldFmtBytes(f.bytes))}</span></div>`).join('');
  const skipped = (snap.skipped || []).length
    ? `<div class="muted cold-hint">跳过：${esc((snap.skipped || []).slice(0, 3).join('；'))}</div>`
    : '';
  return `
    <div class="cold-snap-detail">
      <div class="cold-actions">
        <button class="btn btn-small cold-restore" data-id="${esc(snap.id)}" data-mode="memory">还原记忆</button>
        <button class="btn btn-small btn-danger cold-restore" data-id="${esc(snap.id)}" data-mode="state">整套覆盖</button>
      </div>
      ${skipped}
      <div class="cold-files">${files || '<div class="muted">（这份快照没有记录文件清单）</div>'}</div>
    </div>`;
}

/** 渲染完统一重新绑事件：页面是整块重建的，事件不会自己回来。 */
function bindColdStorageEvents() {
  const s = coldState();

  $('#cold-refresh-btn')?.addEventListener('click', () => loadColdStorageView());

  $('#cold-snapshot-btn')?.addEventListener('click', async () => {
    if (s.busy) return;
    s.busy = true;
    try {
      const r = await api('/api/cold-storage/snapshot', {
        method: 'POST',
        body: JSON.stringify({ reason: '手动', note: '控制台手动打点' })
      });
      s.note = `已保存快照 ${r.id}（${r.files} 个文件，${coldFmtBytes(r.bytes)}）`;
    } catch (e) {
      s.note = `快照失败：${e.message}`;
    } finally {
      s.busy = false;
      await loadColdStorageView();
    }
  });

  $('#cold-prune-btn')?.addEventListener('click', async () => {
    if (!(await uiConfirm('只保留最近 50 份快照，更旧的会被删除。\n\n要删的那些里如果有你还想留的，先别清理。'))) return;
    try {
      const r = await api('/api/cold-storage/prune', { method: 'POST', body: JSON.stringify({ keep: 50 }) });
      s.note = r.removed?.length ? `已清理 ${r.removed.length} 份旧快照` : '没有需要清理的旧快照';
    } catch (e) {
      s.note = `清理失败：${e.message}`;
    }
    await loadColdStorageView();
  });

  const input = $('#cold-search-input');
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runColdSearch();
  });
  input?.addEventListener('input', () => { s.query = input.value; });

  $('#cold-search-chat')?.addEventListener('change', (e) => { s.chat = e.target.value; });

  $('#cold-search-btn')?.addEventListener('click', () => runColdSearch());

  $('#cold-clear-search-btn')?.addEventListener('click', () => {
    s.query = '';
    s.hits = null;
    renderColdStoragePage();
  });

  $$('.cold-snap-head').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.parentElement?.dataset?.id || '';
      s.openId = s.openId === id ? '' : id;
      renderColdStoragePage();
    });
  });

  $$('.cold-restore').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const mode = btn.dataset.mode;
      const what = mode === 'state'
        ? '把 messages/、memory/、sessions/ 整套覆盖成快照那一刻的内容'
        : '只把缺的群友印象并回记忆（已有的不覆盖，可重复点）';
      if (!(await uiConfirm(`从快照还原：\n\n${what}\n\n建议先退出应用再还原，否则内存态会把改动覆盖回去。继续？`))) return;
      try {
        const r = await api('/api/cold-storage/restore', {
          method: 'POST',
          body: JSON.stringify({ id, mode, force: true })
        });
        const keys = Object.keys(r.chats || {});
        s.note = keys.length
          ? `已从 ${r.snapshot} 还原，补回 ${keys.length} 个会话的记忆`
          : `已从 ${r.snapshot} 还原（没有需要补的记忆）`;
      } catch (err) {
        s.note = `还原失败：${err.message}`;
      }
      await loadColdStorageView();
    });
  });
}

async function runColdSearch() {
  const s = coldState();
  const q = (s.query || '').trim();
  if (!q) { s.hits = null; renderColdStoragePage(); return; }
  try {
    const params = new URLSearchParams({ q, limit: '40' });
    if (s.chat) params.set('chat', s.chat);
    const r = await api(`/api/cold-storage/search?${params.toString()}`);
    s.hits = { q, total: r.total || 0, snapshots: r.snapshots || 0, items: r.hits || [] };
  } catch (e) {
    s.hits = null;
    s.note = `检索失败：${e.message}`;
  }
  renderColdStoragePage();
}
