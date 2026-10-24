/* 账号中心前端：只读列表 + 增删改启停，所有数据来自同源 /api/hub/*。 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const state = {
    data: null,
    refreshing: false,
    busy: new Set(),
    targetId: '',
    toastTimer: null,
    errorShown: false
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatMoney(value) {
    const num = Number(value) || 0;
    if (!num) return '¥0.00';
    if (num < 0.01) return `¥${num.toFixed(4)}`;
    return `¥${num.toFixed(2)}`;
  }

  function formatUptime(startedAt) {
    const ms = Date.now() - Number(startedAt || 0);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return '刚刚启动';
    if (minutes < 60) return `运行 ${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `运行 ${hours} 小时`;
    return `运行 ${Math.floor(hours / 24)} 天`;
  }

  function shortUrl(value) {
    const text = String(value || '');
    if (!text) return '';
    return text.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  function accountState(account) {
    if (!account.enabled) return { key: 'stopped', label: '已停止' };
    const s = account.status || {};
    if (s.error || (s.lastError && !s.running)) return { key: 'error', label: '异常' };
    if (s.starting) return { key: 'starting', label: '启动中' };
    if (s.running && s.connected) return { key: 'online', label: '在线' };
    if (s.running) return { key: 'waiting', label: s.restartInMs ? '等待重启' : '等待协议端' };
    return { key: 'stopped', label: '已停止' };
  }

  function avatarClass(id) {
    let sum = 0;
    for (const ch of String(id || '')) sum = (sum + ch.charCodeAt(0)) % 6;
    return `alt-${sum}`;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function toast(text, { error = false, ms = 4200 } = {}) {
    const el = $('#toast');
    el.textContent = String(text || '');
    el.classList.toggle('err', !!error);
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function show(id) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }

  function hide(id) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }

  function hideAllModals() {
    for (const id of ['create-modal', 'rename-modal', 'more-modal', 'delete-modal']) hide(id);
    state.targetId = '';
  }

  function renderSummary(data) {
    const s = data.summary || {};
    const items = [
      { label: '账号', value: s.accounts || 0, unit: '个' },
      { label: '运行中', value: s.running || 0, unit: `/ ${s.accounts || 0}` },
      { label: '协议端已连接', value: s.connected || 0, unit: `/ ${s.running || 0}` },
      { label: '今日总花费', value: formatMoney(s.todayCost), unit: `${s.todayRuns || 0} 次调用` }
    ];
    $('#summary').innerHTML = items.map((item) => `
      <div class="stat">
        <span class="stat-label">${esc(item.label)}</span>
        <span class="stat-value">${esc(item.value)}${item.unit ? `<small>${esc(item.unit)}</small>` : ''}</span>
      </div>
    `).join('');
  }

  function renderNotices(data) {
    const notices = Array.isArray(data.notices) ? data.notices : [];
    const box = $('#notices');
    if (!notices.length) { box.innerHTML = ''; return; }
    box.innerHTML = notices.map((n) => `
      <div class="notice ${esc(n.level || 'info')}"><span>${esc(n.text)}</span></div>
    `).join('');
  }

  function renderAccount(account) {
    const st = accountState(account);
    const busy = state.busy.has(account.id);
    const uin = account.uin ? `QQ ${esc(account.uin)}` : '未登录（协议端未连接）';
    const nickname = account.nickname ? ` · ${esc(account.nickname)}` : '';
    const protocol = account.onebot.wsUrl || account.onebot.httpUrl || '';
    const protocolText = protocol ? shortUrl(protocol) : '未配置 OneBot';
    const reach = account.protocolEnd?.reachable;
    const protocolClass = !protocol ? 'warn' : reach === false ? 'warn' : reach === true ? 'ok' : '';
    const usage = account.usage;
    const usageText = usage ? `${formatMoney(usage.cost)} · ${usage.runs} 次` : (account.status.running ? '读取中…' : '—');
    const uptime = account.status.running ? formatUptime(account.status.startedAt) : '';
    const error = account.diagnosis || account.status.lastError || '';
    const disabled = busy ? ' disabled' : '';

    return `
      <article class="acct" data-id="${esc(account.id)}" data-state="${esc(st.key)}">
        <div class="acct-head">
          <div class="avatar ${avatarClass(account.id)}">${esc((account.name || '?').slice(0, 1))}</div>
          <div class="ident">
            <h3>${esc(account.name)}${account.primary ? '<span class="badge primary">1 号 · 原数据</span>' : ''}</h3>
            <div class="sub" title="${esc(uin)}">${uin}${nickname}</div>
          </div>
          <span class="status-pill ${esc(st.key)}"><span class="dot"></span>${esc(st.label)}</span>
        </div>

        <div class="meta">
          <div class="meta-row"><span>当前模型</span><b title="${esc(account.model || '')}">${esc(account.model || '未选择模型')}</b></div>
          <div class="meta-row"><span>今日用量</span><b>${esc(usageText)}</b></div>
          <div class="meta-row"><span>协议端</span><b class="${protocolClass}" title="${esc(protocol)}">${esc(protocolText)}</b></div>
          <div class="meta-row"><span>控制台端口</span><b class="mono">${account.port || '—'}</b></div>
        </div>

        <div class="chips">
          <span class="chip">群 <b>${account.allowGroups}</b></span>
          <span class="chip">私聊 <b>${account.allowPrivate}</b></span>
          ${account.allowAll ? '<span class="chip">白名单为空 · 全部允许</span>' : ''}
          ${account.status.paused ? '<span class="chip paused">已暂停</span>' : ''}
          ${!account.enabled ? '<span class="chip">不随程序自启</span>' : ''}
          ${uptime ? `<span class="chip">${esc(uptime)}</span>` : ''}
        </div>

        ${error ? `<div class="card-error">${esc(String(error).slice(0, 220))}</div>` : ''}

        <div class="card-actions">
          <button class="btn btn-primary grow" data-action="open" data-id="${esc(account.id)}"${disabled} type="button">打开控制台</button>
          ${account.status.running
            ? `<button class="btn" data-action="stop" data-id="${esc(account.id)}"${disabled} type="button">停止</button>`
            : `<button class="btn" data-action="start" data-id="${esc(account.id)}"${disabled} type="button">启动</button>`}
          <button class="btn" data-action="${account.status.paused ? 'resume' : 'pause'}" data-id="${esc(account.id)}"${disabled || !account.status.running ? ' disabled' : ''} type="button">${account.status.paused ? '恢复' : '暂停'}</button>
          <button class="btn" data-action="more" data-id="${esc(account.id)}"${disabled} type="button" title="更多操作">⋯</button>
        </div>
      </article>
    `;
  }

  function renderAccounts(data) {
    const box = $('#accounts');
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    if (!accounts.length) {
      box.innerHTML = '<div class="empty">还没有账号。点右上角「＋ 新建账号」开始。</div>';
      return;
    }
    box.innerHTML = accounts.map(renderAccount).join('');
  }

  function render() {
    if (!state.data) return;
    renderSummary(state.data);
    renderNotices(state.data);
    renderAccounts(state.data);
    const hint = $('#list-hint');
    if (state.data && state.data.baseDataDir) {
      hint.title = `数据根目录：${state.data.baseDataDir}`;
    }
  }

  async function refresh({ quiet = false } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const data = await api('/api/hub/state');
      state.data = data;
      state.errorShown = false;
      render();
    } catch (error) {
      if (!quiet) toast(`账号中心连接失败：${error.message}`, { error: true });
      if (!state.errorShown && !state.data) {
        $('#accounts').innerHTML = `<div class="empty">连接账号中心失败：${esc(error.message)}<br/>请稍候自动重试，或按 F5 刷新。</div>`;
        state.errorShown = true;
      }
    } finally {
      state.refreshing = false;
    }
  }

  async function withBusy(id, fn) {
    state.busy.add(id);
    render();
    try {
      return await fn();
    } finally {
      state.busy.delete(id);
      render();
    }
  }

  function accountById(id) {
    return (state.data?.accounts || []).find((a) => a.id === id) || null;
  }

  async function openConsole(account) {
    await withBusy(account.id, async () => {
      if (!account.status.running) {
        toast('账号还没运行，正在启动…');
        await api(`/api/hub/accounts/${encodeURIComponent(account.id)}/start`, { method: 'POST', body: '{}' });
      }
      const result = await api(`/api/hub/accounts/${encodeURIComponent(account.id)}/open`);
      if (!result.url) throw new Error('该账号没有可用的控制台地址');
      window.location.href = result.url;
    });
  }

  async function action(name, id) {
    const account = accountById(id);
    if (!account && name !== 'open-base-dir' && name !== 'create-open') return;

    if (name === 'start') {
      await withBusy(id, async () => {
        toast('正在启动，连接到协议端后卡片会变绿…');
        await api(`/api/hub/accounts/${encodeURIComponent(id)}/start`, { method: 'POST', body: '{}' });
        toast('已启动');
      }).catch((error) => toast(error.message, { error: true }));
      return;
    }
    if (name === 'stop' || name === 'restart') {
      await withBusy(id, async () => {
        toast(name === 'stop' ? '正在停止…' : '正在重启…');
        await api(`/api/hub/accounts/${encodeURIComponent(id)}/${name}`, { method: 'POST', body: '{}' });
        toast(name === 'stop' ? '已停止' : '已重启');
      }).catch((error) => toast(error.message, { error: true }));
      return;
    }
    if (name === 'pause' || name === 'resume') {
      await withBusy(id, async () => {
        await api(`/api/hub/accounts/${encodeURIComponent(id)}/${name}`, { method: 'POST', body: '{}' });
        toast(name === 'pause' ? '已暂停该号的自动回复' : '已恢复');
      }).catch((error) => toast(error.message, { error: true }));
      return;
    }
    if (name === 'open') {
      await openConsole(account).catch((error) => toast(error.message, { error: true }));
      return;
    }
    if (name === 'open-base-dir') {
      await api('/api/hub/open-data-dir', { method: 'POST', body: JSON.stringify({}) })
        .then((r) => toast(`已打开：${r.dir}`))
        .catch((error) => toast(error.message, { error: true }));
      return;
    }
    if (name === 'open-account-dir') {
      await api('/api/hub/open-data-dir', { method: 'POST', body: JSON.stringify({ id }) })
        .then((r) => toast(`已打开：${r.dir}`))
        .catch((error) => toast(error.message, { error: true }));
      return;
    }
    if (name === 'more') {
      state.targetId = id;
      $('#more-title').textContent = account.name;
      $('#more-sub').textContent = `${account.uin ? `QQ ${account.uin}` : '未登录'} · 端口 ${account.port} · ${account.dataDir}`;
      show('more-modal');
      return;
    }
    if (name === 'rename-open') {
      if (!state.targetId) return;
      const target = accountById(state.targetId);
      if (!target) return;
      $('#rename-name').value = target.name;
      hide('more-modal');
      show('rename-modal');
      $('#rename-name').focus();
      $('#rename-name').select();
      return;
    }
    if (name === 'delete-open') {
      const target = accountById(state.targetId);
      if (!target) return;
      if (target.primary) { toast('1 号账号使用原 data/ 目录，不能在这里删除', { error: true }); return; }
      $('#delete-sub').textContent = `将删除「${target.name}」${target.uin ? `（QQ ${target.uin}）` : ''}。`;
      $('#delete-confirm').value = '';
      $('#delete-confirm').placeholder = target.name;
      hide('more-modal');
      show('delete-modal');
      $('#delete-confirm').focus();
      return;
    }
    if (name === 'create-open') {
      $('#create-name').value = '';
      show('create-modal');
      $('#create-name').focus();
    }
  }

  async function submitCreate() {
    const name = $('#create-name').value.trim();
    if (!name) { toast('先给账号起个名字', { error: true }); $('#create-name').focus(); return; }
    const button = document.querySelector('[data-action="create-submit"]');
    button.disabled = true;
    try {
      await api('/api/hub/accounts', { method: 'POST', body: JSON.stringify({ name }) });
      hide('create-modal');
      toast(`已创建「${name}」，正在启动…`);
      await refresh({ quiet: true });
    } catch (error) {
      toast(error.message, { error: true });
    } finally {
      button.disabled = false;
    }
  }

  async function submitRename() {
    const id = state.targetId;
    const name = $('#rename-name').value.trim();
    if (!id || !name) { toast('名称不能为空', { error: true }); return; }
    const button = document.querySelector('[data-action="rename-submit"]');
    button.disabled = true;
    try {
      await api(`/api/hub/accounts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      });
      hide('rename-modal');
      state.targetId = '';
      toast('已改名');
      await refresh({ quiet: true });
    } catch (error) {
      toast(error.message, { error: true });
    } finally {
      button.disabled = false;
    }
  }

  async function submitDelete() {
    const id = state.targetId;
    const account = accountById(id);
    if (!id || !account) return;
    const confirm = $('#delete-confirm').value.trim();
    if (confirm !== account.name) {
      toast('输入的账号名称不一致，未删除', { error: true });
      return;
    }
    const button = document.querySelector('[data-action="delete-submit"]');
    button.disabled = true;
    try {
      const result = await api(`/api/hub/accounts/${encodeURIComponent(id)}?confirm=${encodeURIComponent(confirm)}`, { method: 'DELETE' });
      hide('delete-modal');
      state.targetId = '';
      toast(`已删除。数据已移到：${result.movedTo}`);
      await refresh({ quiet: true });
    } catch (error) {
      toast(error.message, { error: true });
    } finally {
      button.disabled = false;
    }
  }

  function applyTheme(theme) {
    const value = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', value);
    try { localStorage.setItem('qqa-hub-theme', value); } catch { /* ignore */ }
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (target) {
      const name = target.dataset.action;
      const id = target.dataset.id || '';
      if (name === 'create-submit') return void submitCreate();
      if (name === 'rename-submit') return void submitRename();
      if (name === 'delete-submit') return void submitDelete();
      if (name === 'modal-close' || name === 'create-cancel') { hideAllModals(); return; }
      if (name === 'refresh') { refresh().catch(() => {}); return; }
      return void action(name, id);
    }
    if (event.target.classList.contains('overlay')) hideAllModals();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideAllModals();
    if (event.key === 'Enter') {
      if (!$('#create-modal').hidden) { event.preventDefault(); submitCreate(); }
      else if (!$('#rename-modal').hidden) { event.preventDefault(); submitRename(); }
      else if (!$('#delete-modal').hidden) { event.preventDefault(); submitDelete(); }
    }
  });

  $('#theme-btn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'light' ? 'dark' : 'light');
  });

  try {
    const saved = localStorage.getItem('qqa-hub-theme');
    applyTheme(saved === 'light' ? 'light' : 'dark');
  } catch {
    applyTheme('dark');
  }

  refresh();
  setInterval(() => {
    if (document.hidden) return;
    refresh({ quiet: true });
  }, 2000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh({ quiet: true });
  });
})();
