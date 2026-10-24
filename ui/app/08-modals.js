// 〔通用弹窗外壳 / 模型选择 / 人设 / 白名单 / saveConfig〕——M9 拆分第 9 段
'use strict';
// ── 模型选择/添加/删除 模态框 ──
function closeAnimatedOverlay(overlay) {
  if (!overlay || overlay.classList.contains('closing')) return;
  overlay.classList.add('closing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    overlay.remove();
  };
  overlay.addEventListener('animationend', (e) => {
    if (e.target === overlay) finish();
  }, { once: true });
  setTimeout(finish, 400);
}

function closeModelModal(overlay) {
  if (!overlay || overlay.classList.contains('closing')) return;
  // 先摘掉全局键盘监听并把焦点还给打开它的元素（可访问性）
  if (overlay._keyHandler) {
    document.removeEventListener('keydown', overlay._keyHandler);
    overlay._keyHandler = null;
  }
  const back = overlay._prevFocus;
  if (back && typeof back.focus === 'function' && back.isConnected) {
    try { back.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  closeAnimatedOverlay(overlay);
}

/**
 * 弹窗外壳。
 * 主体方向判定：body **以 `<div class="model-modal-left"` 开头**才加 .row（横向），
 * 其余一律纵向堆叠。
 * ⚠️ 曾经只要 body 里"包含" model-modal-left 就加 row —— 但复合结构的弹窗
 *    （顶部工具栏 + 中部双栏 + 底部提示，如批量价格编辑、模型添加）需要的是
 *    外层纵向、双栏在 .ma-body 内部横向。误判成 row 后，工具栏与提示文
 *    两个 flex 项把宽度吃光，.ma-body（flex:1, basis 0）被挤成 0 宽，
 *    整个内容区隐形（2026-09-05 批量价格弹窗"空白"事故）。
 */
function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true" aria-label="${esc(String(head || '对话框'))}">
      <div class="model-modal-head">
        <span>${head}</span>
        <button class="model-modal-close" type="button" aria-label="关闭" title="关闭（Esc）">×</button>
      </div>
      <div class="model-modal-body${/^\s*<div class="model-modal-left"/.test(String(body)) ? ' row' : ''}">${body}</div>
      <div class="model-modal-foot">${foot || ''}</div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));

  // ── 可访问性：Esc 关闭 + 焦点管理 ──
  // 此前全项目只有一处 Escape 监听，且位于一个从未被调用的死函数里 ——
  // 键盘用户打开弹窗后既关不掉、焦点也留在背景上，屏幕阅读器不播报对话框。
  const prevFocus = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeModelModal(overlay); }
  };
  // 只让"最上层"的弹窗响应 Esc：弹窗可以叠（模型选择 → 添加模型）
  overlay._onKey = onKey;
  overlay._prevFocus = prevFocus;
  const isTopmost = () => {
    const all = $$('.model-modal-overlay');
    return all[all.length - 1] === overlay;
  };
  const keyHandler = (e) => { if (isTopmost()) onKey(e); };
  overlay._keyHandler = keyHandler;
  document.addEventListener('keydown', keyHandler);

  // 打开后把焦点移进弹窗（优先第一个输入框，否则关闭按钮）
  setTimeout(() => {
    if (!overlay.isConnected) return;
    const first = overlay.querySelector('input:not([type=hidden]), textarea, select')
      || overlay.querySelector('.model-modal-foot button:not([disabled])')
      || overlay.querySelector('.model-modal-close');
    try { first?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }, 0);
  return overlay;
}

/**
 * 调用明细弹窗：点「调用次数」卡片打开，列出各类工具分别被调用了多少次。
 *
 * 这东西对省钱没什么实际帮助 —— 但一张纯数字的成本表太无聊了，
 * 而"机器人这周发了 133 条消息、戳了 6 次、翻了 3 次聊天记录"这类数字
 * 恰恰是最能反映它"活成什么样"的。所以做出来，纯粹因为好看又好玩。
 */
function openToolBreakdown() {
  const counts = (state.usageStats && state.usageStats.toolCounts) || {};
  const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);

  if (!total) {
    modelModalShell({
      head: '调用明细',
      body: '<div class="empty-hint">这个时间区间内还没有任何工具调用记录。</div>'
    });
    return;
  }

  const max = Math.max(...entries.map(([, n]) => n));

  // 按分类分组，分类内按次数降序
  const byCat = new Map();
  for (const [key, n] of entries) {
    const meta = TOOL_META[key] || { name: key, cat: '其他', icon: '🔧' };
    if (!byCat.has(meta.cat)) byCat.set(meta.cat, []);
    byCat.get(meta.cat).push({ key, n, ...meta });
  }
  const cats = TOOL_CAT_ORDER.filter((c) => byCat.has(c));
  for (const c of byCat.keys()) if (!cats.includes(c)) cats.push(c);

  const rows = cats.map((cat) => {
    const items = byCat.get(cat).sort((a, b) => b.n - a.n);
    const catTotal = items.reduce((a, x) => a + x.n, 0);
    return `
      <div class="tb-cat">
        <div class="tb-cat-head">
          <span class="tb-cat-name">${esc(cat)}</span>
          <span class="tb-cat-sum">${catTotal} 次 · ${(catTotal / total * 100).toFixed(0)}%</span>
        </div>
        <div class="tb-rows">
          ${items.map((it) => `
            <div class="tb-row">
              <span class="tb-icon" aria-hidden="true">${it.icon}</span>
              <span class="tb-text">
                <span class="tb-name">${esc(it.name)}</span>
                <span class="tb-code">${esc(it.key)}</span>
              </span>
              <span class="tb-bar"><i style="width:${(it.n / max * 100).toFixed(1)}%"></i></span>
              <span class="tb-n">${it.n}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');

  // 一句话小结（让这堆数字有个"人味"的结论）
  const say = counts.send_message ? `发了 ${counts.send_message} 条消息` : '一条都没发';
  const poke = counts.send_poke ? `、戳了 ${counts.send_poke} 次` : '';
  const sticker = counts.send_sticker ? `、贴了 ${counts.send_sticker} 张表情` : '';
  const search = (Number(counts.web_search) || 0) + (Number(counts.web_fetch) || 0);
  const searchTxt = search ? `、联网查了 ${search} 次` : '';

  modelModalShell({
    head: `调用明细（${state.usageStats?.rangeLabel || ''} · 共 ${total} 次）`,
    body: `
      <div class="tool-breakdown">
        <div class="tb-lead">这段时间里，机器人${say}${poke}${sticker}${searchTxt}。</div>
        ${rows}
      </div>`,
    foot: '<div class="muted tb-foot">工具调用本身不额外计费，成本来自它们消耗的 token。</div>'
  });
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
function openPersonaPicker() {
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    $('#persona-pick-hint').textContent = '人设列表为空';
    return;
  }
  const overlay = modelModalShell({
    head: '选择人设',
    body: `
      <div class="model-modal-right" id="persona-list" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${(state.personaTemplates[id]?.text === ($('#cfg-roletext')?.value ?? '')) ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  overlay.querySelectorAll('.mm-model').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const tpl = state.personaTemplates[id];
      if (tpl) {
        $('#cfg-roletext').value = tpl.text;
        $('#cfg-customrules').value = tpl.customRules || '';
        const input = $('#cfg-persona-pick');
        if (input) input.value = tpl.name;
        // ⚠️ 程序化赋值不触发 input/change 事件 → 自动保存不会启动。
        //    这是"选了人设但改了不生效/切走就丢"的根因之一：用户以为点选
        //    完就保存了，实际上防抖窗口从未开启，切页签的 flush 也无从发起。
        //    主动派发 input 让表单监听器（#settings-form 上的委托监听）感知变化。
        $('#cfg-roletext')?.dispatchEvent(new Event('input', { bubbles: true }));
      }
      closeModelModal(overlay);
      syncPersonaButtons();
    });
  });
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本"></textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则"></textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules })
      });
      closeModelModal(overlay);
      $('#cfg-roletext').value = text;
      $('#cfg-customrules').value = customRules;
      const input = $('#cfg-persona-pick');
      if (input) input.value = name;
      // 同 openPersonaPicker：程序化赋值不触发 input 事件，自动保存不会启动 ——
      // 主动派发一次，否则"添加完人设切走页签"就丢（保存从未发起）。
      $('#cfg-roletext')?.dispatchEvent(new Event('input', { bubbles: true }));
      await loadSettings();
      // loadSettings 会重渲染整个表单；重渲染用的是 state.config（含刚派发
      // 事件触发的自动保存最终值）。自动保存在途时渲染守卫会拦下并补绘，不会丢。
      $('#persona-pick-hint').textContent = `人设「${name}」已添加并填入表单，自动保存稍后生效（也可切走页签前确认）。`;
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

/**
 * 「模型配置」模态框（2026-09-18 改版）：收纳原页面的
 * 模型目录 / Base URL / API Key / 图片视频专用模型 / 图片视频开关 / 视频理解方式。
 * 保存按钮 = 把这些字段 PATCH 到 /api/config（掩码 Key 不回传，与主页面同语义）。
 */
function openModelConfigModal() {
  const c = state.config || {};
  const currentProvider = (state.providers || []).find((p) => p.id === c.api?.provider);
  const displayOf = (modelId) => {
    const m = String(modelId || '').trim();
    if (!m) return '';
    for (const p of (state.providers || [])) {
      if ((p.modelNames || {})[m]) return p.modelNames[m];
    }
    return m;
  };
  const overlay = modelModalShell({
    head: '模型配置',
    body: `
      <div class="field"><label>模型目录（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="mc-model-pick" readonly placeholder="点击选择模型" value="${esc(currentProvider ? ((currentProvider.modelNames || {})[c.api.model] || c.api.model || '') : '')}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="mc-test-btn">测试连通性</button>
        </div>
        <div class="hint" id="mc-test-result" style="margin-top:4px"></div></div>
      <div class="field-row">
        <div class="field"><label>当前 Base URL</label>
          <input type="text" id="mc-baseurl" readonly value="${esc(c.api?.baseUrl || '')}" /></div>
        <div class="field"><label>当前 API Key</label>
          <div style="display:flex;gap:8px">
            <input type="password" id="mc-apikey" value="${esc((currentProvider?.hasKey || c.api?.apiKey) ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
            <button class="btn btn-small" id="mc-apikey-toggle" type="button">显示</button>
            <button class="btn btn-small btn-danger" id="mc-apikey-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除</button>
          </div></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="mc-vision" ${c.api?.vision !== false ? 'checked' : ''} />
        <label for="mc-vision">图片输入（关闭则移除看图工具）</label>
        <span id="mc-vision-hint" class="muted" style="font-size:12px;align-self:center"></span></div>
      <div class="checkbox-row"><input type="checkbox" id="mc-video" ${c.api?.video === true ? 'checked' : ''} />
        <label for="mc-video">视频输入（GIF 转视频发给模型）</label></div>
      <div class="field-row">
        <div class="field"><label>图片输入专用模型（留空用主模型）</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="mc-vision-model-pick" readonly placeholder="点击选择" value="${esc(displayOf(c.api?.visionModel))}" style="flex:1;cursor:pointer" />
            <button class="btn btn-small" id="mc-vision-model-clear" type="button">清空</button>
          </div></div>
        <div class="field"><label>视频输入专用模型（留空用主模型）</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="mc-video-model-pick" readonly placeholder="点击选择" value="${esc(displayOf(c.api?.videoModel))}" style="flex:1;cursor:pointer" />
            <button class="btn btn-small" id="mc-video-model-clear" type="button">清空</button>
          </div></div>
      </div>
      <div class="field"><label>视频理解方式</label>
        <select id="mc-video-mode">
          ${[
            ['auto', '自动：配了视频专用模型就原生读视频，否则抽帧'],
            ['native', '原生：把视频直接交给全模态模型（需模型支持）'],
            ['frames', '抽帧：把视频变成若干张图片（任何视觉模型都能用）'],
            ['off', '关闭：只读时长/分辨率等元信息']
          ].map(([v, l]) => `<option value="${v}" ${(c.api?.videoMode || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>`,
    foot: `<button class="btn" id="mc-scan-btn" title="逐个真实请求模型探测图片输入能力，结果回填目录徽标">扫描图片能力</button>
           <button class="btn" id="mc-cancel">取消</button>
           <button class="btn btn-primary" id="mc-save">保存</button>`
  });

  // 视觉能力扫描：POST /api/vision/scan（202 异步），进度经 SSE vision-scan
  // 事件写 #mc-vision-hint（02-sse-sessions.js 监听），完成后监听器自动刷新
  // state.visionResults 并重渲染 —— 目录徽标（visionBadge）随之更新。
  overlay.querySelector('#mc-scan-btn').addEventListener('click', async () => {
    const btn = overlay.querySelector('#mc-scan-btn');
    const hint = overlay.querySelector('#mc-vision-hint');
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      await api('/api/vision/scan', { method: 'POST', body: JSON.stringify({}) });
      if (hint) hint.textContent = '扫描中…（会真实请求每个模型，请稍候）';
    } catch (e) {
      if (hint) hint.textContent = `启动扫描失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = '扫描图片能力';
  });

  // 模型选择：复用主模型选择器语义，但选完只写本弹窗的表单（不立即 POST）
  overlay.querySelector('#mc-model-pick').addEventListener('click', () => {
    const providers = state.providers || [];
    if (!providers.length) { alert('模型目录为空：请先用「模型管理」添加提供商。'); return; }
    const pickOverlay = modelModalShell({
      head: '选择模型',
      body: `
        <div class="model-modal-left" id="mcp-left"></div>
        <div class="model-modal-right" id="mcp-right"></div>`,
      foot: `<button class="btn" id="mcp-cancel">取消</button>`
    });
    const pl = pickOverlay.querySelector('#mcp-left');
    const pr = pickOverlay.querySelector('#mcp-right');
    let activePid = c.api?.provider || providers[0].id;
    const renderLeft = () => {
      pl.innerHTML = providers.map((p) =>
        `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
      pl.querySelectorAll('.mm-prov').forEach((el) => el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); }));
    };
    const renderRight = () => {
      const p = providers.find((x) => x.id === activePid);
      if (!p) { pr.innerHTML = ''; return; }
      const names = p.modelNames || {};
      pr.innerHTML = p.models.map((m) => `
        <div class="mm-model" data-model="${esc(m)}">
          <span>${esc(names[m] || m)}</span>${visionBadge(activePid, m)}
          <span class="muted" style="font-size:11px">${esc(m)}</span>
        </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
      pr.querySelectorAll('.mm-model').forEach((el) => el.addEventListener('click', () => {
        overlay.querySelector('#mc-model-pick').value = (names[el.dataset.model] || el.dataset.model);
        overlay.querySelector('#mc-picked').value = `${activePid}|||${el.dataset.model}`;
        overlay.querySelector('#mc-baseurl').value = p.baseURL || '';
        closeModelModal(pickOverlay);
      }));
    };
    renderLeft();
    renderRight();
    pickOverlay.querySelector('#mcp-cancel').addEventListener('click', () => closeModelModal(pickOverlay));
  });
  // 隐藏字段：选中模型的 pid|||model（未选择时为空 = 保持现状）
  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.id = 'mc-picked';
  overlay.querySelector('.model-modal-body').appendChild(hidden);

  // 专用模型选择（写隐藏字段，保存时带走）
  const pickSpecial = (which) => {
    const providers = state.providers || [];
    if (!providers.length) { alert('模型目录为空。'); return; }
    const fieldId = which === 'vision' ? 'mc-vision-model-pick' : 'mc-video-model-pick';
    const pickOverlay = modelModalShell({
      head: which === 'vision' ? '选择图片输入模型' : '选择视频输入模型',
      body: `
        <div class="model-modal-left" id="msp-left"></div>
        <div class="model-modal-right" id="msp-right"></div>`,
      foot: `<button class="btn" id="msp-cancel">取消</button>`
    });
    const pl = pickOverlay.querySelector('#msp-left');
    const pr = pickOverlay.querySelector('#msp-right');
    let activePid = providers[0].id;
    const renderLeft = () => {
      pl.innerHTML = providers.map((p) =>
        `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
      pl.querySelectorAll('.mm-prov').forEach((el) => el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); }));
    };
    const renderRight = () => {
      const p = providers.find((x) => x.id === activePid);
      if (!p) { pr.innerHTML = ''; return; }
      const names = p.modelNames || {};
      pr.innerHTML = p.models.map((m) => `
        <div class="mm-model" data-model="${esc(m)}">
          <span>${esc(names[m] || m)}</span>${visionBadge(activePid, m)}
          <span class="muted" style="font-size:11px">${esc(m)}</span>
        </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
      pr.querySelectorAll('.mm-model').forEach((el) => el.addEventListener('click', () => {
        overlay.querySelector('#' + fieldId).value = (names[el.dataset.model] || el.dataset.model);
        overlay.querySelector('#' + fieldId).dataset.model = el.dataset.model;
        closeModelModal(pickOverlay);
      }));
    };
    renderLeft();
    renderRight();
    pickOverlay.querySelector('#msp-cancel').addEventListener('click', () => closeModelModal(pickOverlay));
  };
  overlay.querySelector('#mc-vision-model-pick').addEventListener('click', () => pickSpecial('vision'));
  overlay.querySelector('#mc-video-model-pick').addEventListener('click', () => pickSpecial('video'));
  overlay.querySelector('#mc-vision-model-clear').addEventListener('click', () => {
    const el = overlay.querySelector('#mc-vision-model-pick');
    el.value = ''; delete el.dataset.model;
  });
  overlay.querySelector('#mc-video-model-clear').addEventListener('click', () => {
    const el = overlay.querySelector('#mc-video-model-pick');
    el.value = ''; delete el.dataset.model;
  });

  // Key 显示/清除：与主页面同款（fetchRealKey 走 /api/providers/key）
  overlay.querySelector('#mc-apikey-toggle').addEventListener('click', async () => {
    const input = overlay.querySelector('#mc-apikey');
    const btn = overlay.querySelector('#mc-apikey-toggle');
    const show = input.type === 'password';
    if (show) {
      try {
        const pid = c.api?.provider;
        const r = pid ? await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`) : await api('/api/api-key');
        input.type = 'text';
        input.value = String(r.apiKey || '（无）');
        btn.textContent = '隐藏';
      } catch (e) { alert(`读取密钥失败：${e.message}`); }
    } else {
      input.type = 'password';
      input.value = '******';
      btn.textContent = '显示';
    }
  });
  overlay.querySelector('#mc-apikey-clear').addEventListener('click', async () => {
    if (!(await uiConfirm('确定清除已保存的 API Key？'))) return;
    try {
      const pid = c.api?.provider;
      if (pid) {
        await api('/api/providers/set-key', { method: 'POST', body: JSON.stringify({ providerId: pid, apiKey: '' }) });
      } else {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ api: { apiKey: '' } }) });
      }
      const input = overlay.querySelector('#mc-apikey');
      input.value = '';
      input.placeholder = '输入新 Key 可替换';
      await loadSettings();
    } catch (e) { alert(`清除失败：${e.message}`); }
  });

  // 连通性测试：与主页面 runConnectivityTest 同款逻辑（读弹窗里的表单值）
  overlay.querySelector('#mc-test-btn').addEventListener('click', async () => {
    const btn = overlay.querySelector('#mc-test-btn');
    const out = overlay.querySelector('#mc-test-result');
    btn.disabled = true;
    btn.textContent = '测试中…';
    out.textContent = '';
    try {
      const picked = overlay.querySelector('#mc-picked').value;
      const model = picked ? picked.split('|||')[1] : (c.api?.model || '');
      const keyInput = overlay.querySelector('#mc-apikey');
      const raw = (keyInput.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: overlay.querySelector('#mc-baseurl').value.trim(), apiKey, model })
      });
      const res = r.result || {};
      out.textContent = res.ok ? `✓ 测试通过（${res.latencyMs}ms）` : `✗ ${res.note || '测试失败'}`;
    } catch (e) {
      out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = '测试连通性';
  });

  overlay.querySelector('#mc-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mc-save').addEventListener('click', async () => {
    const patch = {
      vision: overlay.querySelector('#mc-vision').checked,
      video: overlay.querySelector('#mc-video').checked,
      videoMode: overlay.querySelector('#mc-video-mode').value
    };
    const picked = overlay.querySelector('#mc-picked').value;
    if (picked) {
      const [pid, model] = picked.split('|||');
      patch.provider = pid;
      patch.model = model;
      const p = (state.providers || []).find((x) => x.id === pid);
      if (p?.baseURL) patch.baseUrl = p.baseURL;
    } else if (overlay.querySelector('#mc-baseurl').value.trim() !== (c.api?.baseUrl || '')) {
      patch.baseUrl = overlay.querySelector('#mc-baseurl').value.trim();
    }
    // 专用模型：dataset.model 里是干净的 id（没选过就删属性 = 走"保持原值"分支）
    const vEl = overlay.querySelector('#mc-vision-model-pick');
    const dEl = overlay.querySelector('#mc-video-model-pick');
    if (vEl.dataset.model !== undefined || vEl.value === '') patch.visionModel = vEl.dataset.model || '';
    if (dEl.dataset.model !== undefined || dEl.value === '') patch.videoModel = dEl.dataset.model || '';
    // Key：只在用户输入了非掩码明文时才回传（掩码/留空 = 保持）
    const raw = (overlay.querySelector('#mc-apikey').value || '').trim();
    if (raw && raw !== '******') patch.apiKey = raw;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ api: patch }) });
      closeModelModal(overlay);
      loadSettings();
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '模型目录为空：请先在下方的“手动添加提供商”里添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>${visionBadge(p.id, m)}
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        // 同步规则：图片/视频专用模型如果指向**其它提供商**的旧模型，
        // 主模型一换就再也对不上（识别请求会发到已弃用的端点）。
        // 这里随主模型一起切换：专用模型属于同一提供商 → 跟随主模型 id；
        // 属于别的提供商（用户特意挑的跨渠道视觉模型）→ 清空回退主模型。
        // 用户在设置里明确填写的专用模型仍然优先，只有"跟随主模型"的
        // 旧值才被替换 —— 判定依据：旧专用模型属于当前主提供商（跟随态）。
        const cfg = state.config || {};
        const oldProvider = cfg.api?.provider;
        const oldVision = String(cfg.api?.visionModel || '').trim();
        const oldVideo = String(cfg.api?.videoModel || '').trim();
        const followsMain = (spec, oldPid) => spec === oldPid;
        const visionModel = oldVision && followsMain(oldVision, oldProvider)
          ? (pid === oldProvider ? model : '')
          : oldVision;
        const videoModel = oldVideo && followsMain(oldVideo, oldProvider)
          ? (pid === oldProvider ? model : '')
          : oldVideo;
        try {
          // 只更新 provider/model/baseUrl；apiKey 保持当前已保存值，不把密钥回写到接口请求里
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL, ...(visionModel !== oldVision ? { visionModel } : {}), ...(videoModel !== oldVideo ? { videoModel } : {}) } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 选择记忆整理专用模型：复用模型目录选择器，保存到 config.memory.provider/model。 */
function openMemoryModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#mem-model-hint').textContent = '模型目录为空：请先到「模型 API」页签添加提供商。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择记忆整理模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  // 从 DOM 的隐藏字段读当前值（而非 state.config）：
  // 用户可能刚选过但还没保存，或 state 还没刷新，DOM 才是最新真相。
  const currentProvider = $('#cfg-mem-provider')?.value || state.config?.memory?.provider || '';
  const currentModel = $('#cfg-mem-model')?.value || state.config?.memory?.model || '';
  let activePid = currentProvider || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel && p.id === currentProvider ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 必须把"是否跟随聊天模型"的当前勾选状态一并提交。
          // 否则：用户取消勾选（→ 只改了 DOM，state.config 仍是 true）后直接点模型，
          // 这次提交不带 useChatModel，随后 loadSettings() 又按 state.config(true)
          // 重新渲染 —— 复选框被打回"已勾选"，迫使必须先保存一次才能选模型。
          const useChatBox = $('#cfg-mem-usechat');
          const useChatModel = useChatBox ? !!useChatBox.checked
            : (state.config?.memory?.useChatModel !== false);
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ memory: { provider: pid, model, useChatModel } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#mem-model-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 选择图片/视频专用模型：已废弃（2026-09-18 弹窗改版残骸）。
 * 专用模型的唯一编辑入口是「模型配置」弹窗（openModelConfigModal 里的
 * #mc-vision-model-pick / #mc-video-model-pick，保存时直接 POST api patch）。
 * 本函数及其宣称的"写 DOM 隐藏字段 + 表单自动保存带走"链路已删除 ——
 * 目标隐藏字段（cfg-vision-model 等）从未渲染，保存链读不到它们。
 */

/**
 * “获取列表”后的勾选添加弹窗。
 *
 * 两个针对中转站的优化：
 *   1. 搜索框：中转站常返回几百上千个模型，没有搜索就没法用
 *   2. 双列模式：若模型 id 普遍带 "/"（OpenRouter 风格的 vendor/model），
 *      拆成左厂商 / 右模型两列，比一长条列表好找得多；否则保持单列 + 搜索
 */
function openModelAddModal(baseUrl, apiKey, remoteModels, knownProviderId, onApplied = null) {
  const providers = state.providers || [];
  // 已知提供商 id 优先（模型管理里"拉取模型列表"传来的），否则按 baseUrl 匹配
  const existingProvider = providers.find((p) => p.id === knownProviderId)
    || providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === String(baseUrl || '').replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const all = (remoteModels || []).slice();

  // 有多少比例的 id 是 vendor/model 形式？超过一半就启用双列
  const slashed = all.filter((m) => String(m).includes('/'));
  const dual = all.length > 0 && slashed.length / all.length >= 0.5;

  // 预先按厂商分组（仅双列模式用）
  const groups = new Map();
  for (const m of all) {
    const s = String(m);
    const vendor = dual ? (s.includes('/') ? s.slice(0, s.indexOf('/')) : '(其他)') : '';
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(s);
  }
  const vendorList = [...groups.keys()].sort((a, b) => {
    if (a === '(其他)') return 1;
    if (b === '(其他)') return -1;
    return groups.get(b).length - groups.get(a).length;
  });

  const countText = `共 ${all.length} 个模型${dual ? ` · ${vendorList.length} 个厂商` : ''}`;

  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="ma-search" placeholder="搜索模型或厂商…" autocomplete="off" />
        <span class="muted" id="ma-count" style="font-size:12px;white-space:nowrap">${esc(countText)}</span>
      </div>
      <div class="ma-body ${dual ? 'dual' : 'single'}">
        ${dual ? '<div class="model-modal-left" id="ma-left"></div>' : ''}
        <div class="model-modal-right" id="ma-right"></div>
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });

  const searchEl = overlay.querySelector('#ma-search');
  const countEl = overlay.querySelector('#ma-count');
  const right = overlay.querySelector('#ma-right');
  const left = dual ? overlay.querySelector('#ma-left') : null;

  let activeVendor = dual ? vendorList[0] : '';
  let keyword = '';

  // 渲染成 checkbox 行
  const rowHtml = (m) => {
    const added = existingIds.has(m);
    const modelPart = dual && String(m).includes('/') ? String(m).slice(String(m).indexOf('/') + 1) : String(m);
    return `
      <label class="mm-model">
        <input type="checkbox" class="ma-check" value="${esc(m)}" ${added ? 'checked disabled' : ''} />
        <span class="mm-model-text">${esc(modelPart)}</span>
        ${added ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
      </label>`;
  };

  function matches(m) {
    if (!keyword) return true;
    return String(m).toLowerCase().includes(keyword);
  }

  function renderRight() {
    const pool = dual ? (groups.get(activeVendor) || []) : all;
    const list = pool.filter(matches);
    right.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<div class="muted" style="padding:10px">没有匹配的模型</div>';
    // 更新计数：显示当前筛选出来的数量
    countEl.textContent = keyword
      ? `${list.length} / ${dual ? pool.length : all.length}`
      : countText;
  }

  function renderLeft() {
    if (!left) return;
    const vendors = vendorList.filter((v) => (groups.get(v) || []).some(matches));
    left.innerHTML = vendors.length
      ? vendors.map((v) => `
          <div class="mm-prov ${v === activeVendor ? 'active' : ''}" data-vendor="${esc(v)}">
            ${esc(v)} <span class="muted" style="font-size:11px">${(groups.get(v) || []).filter(matches).length}</span>
          </div>`).join('')
      : '<div class="muted" style="padding:10px">没有匹配的厂商</div>';
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => {
        activeVendor = el.dataset.vendor;
        renderLeft();
        renderRight();
      });
    });
    // 当前厂商被搜索过滤掉了 → 自动切到第一个可见的
    if (vendors.length && !vendors.includes(activeVendor)) {
      activeVendor = vendors[0];
      renderLeft();
      renderRight();
    }
  }

  // 搜索：输入时同时刷两列（双列模式下左列的计数也要跟着变）
  searchEl.addEventListener('input', () => {
    keyword = String(searchEl.value || '').trim().toLowerCase();
    renderLeft();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      // 2026-09-19（M9 清理）：旧 #provider-action-hint 元素已随改版消失；写不存在的
      // 元素会在 catch 里二次抛错（未处理 rejection）。改写存活的 #provider-hint，
      // 并且做空保护 —— 弹窗链路里不一定有设置页的提示节点（2026-09-26）。
      const hint = $('#provider-hint');
      if (hint) hint.textContent = `已加入 ${newModels.length} 个模型。`;
      // 先等 loadSettings 把 state.providers 刷成最新，宿主回调（模型管理的
      // refresh）再重渲染才不会读到旧数据 —— 修"加完不立刻显示"的老毛病
      await loadSettings();
      if (typeof onApplied === 'function') await onApplied(newModels);
    } catch (e) {
      const hint = $('#provider-hint');
      if (hint) hint.textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
/**
 * 「模型管理」模态框（2026-09-18 改版）：左右两列。
 * 左列 = 提供商列表 + 添加提供商 / 删除提供商按钮；
 * 右列 = 选中提供商的 baseURL、API Key（掩码）、模型列表（ID + 显示名）、
 *        拉取模型列表 / 删除模型按钮。
 * 替代了页面上原来的「删除模型 / 提供商」按钮和「手动添加提供商」整块表单。
 */
function openModelManageModal() {
  const overlay = modelModalShell({
    head: '模型管理',
    body: `
      <div class="model-modal-left" id="mg-left"></div>
      <div class="model-modal-right" id="mg-right"></div>`,
    foot: `<button class="btn" id="mg-close">关闭</button>`
  });
  const left = overlay.querySelector('#mg-left');
  const right = overlay.querySelector('#mg-right');
  const cfgProvider = String(state.config?.api?.provider || '');
  let activePid = cfgProvider || (state.providers || [])[0]?.id || '';

  // 刷新（2026-09-26）：必须**先 loadSettings 再重渲染** —— 直接 renderLeft()
  // 会读到旧的 state.providers，表现为"刚添加的提供商不显示，动一下模态框才出来"。
  // 所有会改动提供商/模型的子弹窗统一用它收尾。
  const refresh = async () => {
    try { await loadSettings(); } catch (e) { console.error('[模型管理] 刷新失败:', e); }
    renderLeft();
    renderRight();
  };

  function renderLeft() {
    const providers = state.providers || [];
    left.innerHTML = `
      <div style="padding:6px 0 8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-small" id="mg-add-prov">＋ 添加提供商</button>
        <button class="btn btn-small btn-danger" id="mg-del-prov">删除提供商</button>
      </div>
      ${providers.map((p) => `
        <div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">
          ${esc(p.displayName || p.id)}${p.id === cfgProvider ? ' <span class="muted" style="font-size:11px">（当前）</span>' : ''}
        </div>`).join('') || '<div class="muted" style="padding:10px;font-size:12px">还没有提供商，点上方「添加提供商」。</div>'}`;
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
    // 添加提供商：弹子模态框（Base URL + Key → 拉取/勾选模型 → POST /api/providers）
    left.querySelector('#mg-add-prov').addEventListener('click', () => {
      openProviderAddModal(refresh);
    });
    // 删除提供商：删当前选中的那个（confirm 在右列的删除按钮上做过了，这里再拦一道）
    left.querySelector('#mg-del-prov').addEventListener('click', async () => {
      const p = (state.providers || []).find((x) => x.id === activePid);
      if (!p) { alert('请先在列表里选中一个提供商。'); return; }
      const modelCount = (p.models || []).length;
      if (!(await uiConfirm(`确定删除整个提供商「${p.displayName || p.id}」？\n\n将一并删除它的 API Key 与 ${modelCount} 个模型。此操作不可撤销。`))) return;
      try {
        await api('/api/providers', { method: 'DELETE', body: JSON.stringify({ providerId: p.id }) });
        // 删的是当前主提供商 → 后端会清空选中模型，刷新设置页提示重新选
        activePid = cfgProvider === p.id ? '' : activePid;
        await loadSettings();
        renderLeft();
        renderRight();
      } catch (err) {
        alert(`删除提供商失败：${err.message}`);
      }
    });
  }

  function renderRight() {
    const p = (state.providers || []).find((x) => x.id === activePid);
    if (!p) { right.innerHTML = '<div class="muted" style="padding:12px;font-size:12px">左侧选中一个提供商后，这里显示它的端点、密钥与模型。</div>'; return; }
    const names = p.modelNames || {};
    right.innerHTML = `
      <div class="field"><label>Base URL</label>
        <input type="text" id="mg-baseurl" value="${esc(p.baseURL || '')}" readonly style="width:100%" /></div>
      <div class="field"><label>API Key</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="mg-apikey" value="${esc(p.hasKey ? '******' : '')}" readonly placeholder="${p.hasKey ? '' : '（未保存）'}" style="flex:1" />
          <button class="btn btn-small" id="mg-apikey-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="mg-apikey-clear" type="button" title="清除已保存的 API Key">清除密钥</button>
        </div></div>
      <div class="field"><label>模型（${(p.models || []).length} 个）</label>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <button class="btn btn-small" id="mg-add-model" title="手动填写模型 id 添加，不依赖拉取">＋ 添加模型</button>
          <button class="btn btn-small" id="mg-fetch-models">拉取模型列表</button>
          <button class="btn btn-small btn-danger" id="mg-del-model">删除模型</button>
        </div>
        <div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
          ${(p.models || []).map((m) => `
            <label class="mm-model" style="cursor:pointer">
              <input type="radio" name="mg-model" value="${esc(m)}" />
              <span style="flex:1">${esc(names[m] || m)}</span>
              <span class="muted" style="font-size:11px">${esc(m)}</span>
            </label>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型：点「＋ 添加模型」手动加，或「拉取模型列表」自动拉取。</div>'}
        </div></div>`;

    // Key 显示/隐藏：走 /api/providers/key 取明文（与主页面同款）
    right.querySelector('#mg-apikey-toggle').addEventListener('click', async () => {
      const input = right.querySelector('#mg-apikey');
      const btn = right.querySelector('#mg-apikey-toggle');
      const show = input.type === 'password';
      try {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(p.id)}`);
        if (show) {
          input.type = 'text';
          input.value = String(r.apiKey || '（无）');
          btn.textContent = '隐藏';
        } else {
          input.type = 'password';
          input.value = p.hasKey ? '******' : '';
          btn.textContent = '显示';
        }
      } catch (e) {
        alert(`读取密钥失败：${e.message}`);
      }
    });
    // Key 清除
    right.querySelector('#mg-apikey-clear').addEventListener('click', async () => {
      if (!p.hasKey) return;
      if (!(await uiConfirm(`确定清除「${p.displayName || p.id}」的 API Key？`))) return;
      try {
        await api('/api/providers/set-key', { method: 'POST', body: JSON.stringify({ providerId: p.id, apiKey: '' }) });
        await loadSettings();
        renderLeft();
        renderRight();
      } catch (e) {
        alert(`清除失败：${e.message}`);
      }
    });
    // 手动添加模型（2026-09-26）：端点没 /v1/models、拉取失败、或只想补一个 id 时的主入口
    right.querySelector('#mg-add-model').addEventListener('click', () => {
      openManualAddModelModal(p, refresh);
    });
    // 拉取模型：从该提供商的端点拉（Key 用后端保存的）
    right.querySelector('#mg-fetch-models').addEventListener('click', async () => {
      const btn = right.querySelector('#mg-fetch-models');
      btn.disabled = true;
      btn.textContent = '拉取中…';
      try {
        const r = await api('/api/providers/fetch-models', {
          method: 'POST',
          body: JSON.stringify({ baseUrl: p.baseURL, providerId: p.id })
        });
        // 复用勾选加入弹窗（把新模型并进该提供商），加完自动刷新右栏
        openModelAddModal(p.baseURL, '', r.models || [], p.id, refresh);
      } catch (e) {
        alert(`拉取失败：${e.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '拉取模型列表';
      }
    });
    // 删除模型：删当前选中的单选模型
    right.querySelector('#mg-del-model').addEventListener('click', async () => {
      const picked = right.querySelector('input[name="mg-model"]:checked');
      if (!picked) { alert('请先在列表里选中一个要删除的模型。'); return; }
      const model = picked.value;
      if (!(await uiConfirm(`确定从「${p.displayName || p.id}」删除模型 ${model}？`))) return;
      try {
        await api('/api/providers/models', {
          method: 'DELETE',
          body: JSON.stringify({ providerId: p.id, modelId: model })
        });
        await loadSettings();
        renderLeft();
        renderRight();
      } catch (e) {
        alert(`删除失败：${e.message}`);
      }
    });
  }

  renderLeft();
  renderRight();
  overlay.querySelector('#mg-close').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 手动添加模型（2026-09-26）：不依赖「拉取模型列表」也能给已有提供商补模型。
 * 拉取要求端点支持 /v1/models 且 Key 有效 —— 不少服务商没有这个接口，手动填 id
 * 是最可靠的兜底入口，也是模型管理里唯二的加模型方式之一。
 */
function openManualAddModelModal(provider, onDone) {
  const overlay = modelModalShell({
    head: `手动添加模型 · ${esc(provider.displayName || provider.id)}`,
    body: `
      <div class="field"><label>模型 id（照抄服务商给的模型名，如 deepseek-chat）</label>
        <input type="text" id="mmg-id" placeholder="glm-5.3-flash / deepseek-chat / …" autocomplete="off" /></div>
      <div class="field"><label>显示名（可选，只影响目录里的展示）</label>
        <input type="text" id="mmg-name" placeholder="留空则直接用模型 id" autocomplete="off" /></div>
      <div class="hint">不确定模型 id？去服务商的模型列表里复制原文。填错不会报错，但发消息会失败（404）。</div>`,
    foot: `<button class="btn" id="mmg-cancel">取消</button>
           <button class="btn btn-primary" id="mmg-save">添加</button>`
  });
  overlay.querySelector('#mmg-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mmg-save').addEventListener('click', async () => {
    const id = overlay.querySelector('#mmg-id').value.trim();
    const name = overlay.querySelector('#mmg-name').value.trim() || id;
    if (!id) { alert('请填写模型 id'); return; }
    try {
      await api('/api/providers/models', {
        method: 'POST',
        body: JSON.stringify({ providerId: provider.id, models: [{ id, name }] })
      });
      closeModelModal(overlay);
      if (onDone) onDone();
    } catch (e) {
      alert(`添加失败：${e.message}`);
    }
  });
  return overlay;
}

/** 模型管理里的「添加提供商」子模态框：Base URL + Key → 拉取勾选模型 → 添加。 */
function openProviderAddModal(onDone) {
  const overlay = modelModalShell({
    head: '添加提供商',
    body: `
      <div class="field"><label>Base URL</label>
        <input type="text" id="pa-baseurl" placeholder="例如 https://api.deepseek.com/v1" style="width:100%" /></div>
      <div class="field"><label>API Key</label>
        <input type="password" id="pa-apikey" placeholder="sk-..." autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型 id（可先留空 —— 填完上面两项会自动弹出拉取勾选；也可直接手动填）</label>
        <div id="pa-model-rows"></div>
        <button class="btn btn-small" id="pa-add-row" style="margin-top:6px">＋ 添加一行</button></div>`,
    foot: `<button class="btn" id="pa-cancel">取消</button>
           <button class="btn btn-primary" id="pa-confirm">添加</button>`
  });
  let rows = [{ id: '', name: '' }];
  const rowsBox = overlay.querySelector('#pa-model-rows');
  function renderRows() {
    rowsBox.innerHTML = `
      <table class="model-rows-table">
        ${rows.map((row, i) => `
          <tr>
            <td><input type="text" class="pa-mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="pa-mr-name" data-i="${i}" placeholder="显示名（可选）" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger pa-mr-del" data-i="${i}" ${rows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    rowsBox.querySelectorAll('.pa-mr-id').forEach((el) => el.addEventListener('input', () => { rows[Number(el.dataset.i)].id = el.value; }));
    rowsBox.querySelectorAll('.pa-mr-name').forEach((el) => el.addEventListener('input', () => { rows[Number(el.dataset.i)].name = el.value; }));
    rowsBox.querySelectorAll('.pa-mr-del').forEach((el) => el.addEventListener('click', () => {
      if (rows.length <= 1) return;
      rows.splice(Number(el.dataset.i), 1);
      renderRows();
    }));
  }
  renderRows();
  overlay.querySelector('#pa-add-row').addEventListener('click', () => { rows.push({ id: '', name: '' }); renderRows(); });

  // ── 自动拉取（2026-09-26）────────────────────────────────────────────
  // Base URL 与 API Key 都填好、且两个文本框都不在焦点时，**静默**拉取模型列表：
  // 成功 → 直接弹出原来要点「拉取模型列表」才会出现的勾选框（勾「加入列表」即
  // 以这两项创建提供商）；失败 / 空列表 → 什么都不显示，用户可继续手动填模型 id。
  // 指纹去重：同 (baseUrl, apiKey) 只自动拉一次，改了任一项才拉下一次。
  const autoFetched = new Set();
  const baseEl = overlay.querySelector('#pa-baseurl');
  const keyEl = overlay.querySelector('#pa-apikey');
  const maybeAutoFetch = () => {
    // blur 瞬间焦点还没落到下一个元素，推后一拍再判"两框都失焦"，
    // 否则 tab 从 Base URL 切到 API Key 也会误触发。
    setTimeout(async () => {
      if (!overlay.isConnected) return;
      const baseUrl = baseEl.value.trim();
      const apiKey = keyEl.value.trim();
      if (!baseUrl || !apiKey) return;
      if (document.activeElement === baseEl || document.activeElement === keyEl) return;
      const fp = `${baseUrl}\n${apiKey}`;
      if (autoFetched.has(fp)) return;
      autoFetched.add(fp);
      try {
        const r = await api('/api/providers/fetch-models', {
          method: 'POST', body: JSON.stringify({ baseUrl, apiKey })
        });
        const models = r.models || [];
        if (!models.length) return;
        // 无提供商分支：勾「加入列表」= 直接以 baseUrl+apiKey 创建该提供商；
        // 创建成功才收掉本弹窗，并让宿主（模型管理）刷新左栏；取消勾选框则回到
        // 本表单继续手动填。
        openModelAddModal(baseUrl, apiKey, models, '', async () => {
          closeModelModal(overlay);
          if (onDone) await onDone();
        });
      } catch { /* 静默：拉不到就什么都不显示 */ }
    }, 0);
  };
  baseEl.addEventListener('blur', maybeAutoFetch);
  keyEl.addEventListener('blur', maybeAutoFetch);
  overlay.querySelector('#pa-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#pa-confirm').addEventListener('click', async () => {
    const baseUrl = overlay.querySelector('#pa-baseurl').value.trim();
    const apiKey = overlay.querySelector('#pa-apikey').value.trim();
    const models = rows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { alert('请填写 Base URL'); return; }
    if (!apiKey) { alert('请填写 API Key（提供商必须带密钥才能测试连通性）'); return; }
    if (!models.length) { alert('请至少添加一个模型（或添加后用「拉取模型列表」勾选）'); return; }
    try {
      await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      closeModelModal(overlay);
      // onDone（宿主的 refresh）自己会 loadSettings + 重渲染；没有宿主就只刷数据。
      // ⚠️ 顺序很重要：先刷数据再重渲染 —— 之前 onDone 在 loadSettings 之前跑，
      // 左栏拿旧 state.providers 渲染，新提供商要"动一下模态框"才出现（2026-09-26 修）。
      if (onDone) await onDone();
      else await loadSettings();
    } catch (e) {
      alert(`添加失败：${e.message}`);
    }
  });
  return overlay;
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  // 群名进补底缓存：分群按钮等处只显示群名，靠这份名字辨识
  if (isGroups) {
    state.qqGroupNames = state.qqGroupNames || {};
    for (const g of list) {
      const id = String(g?.id ?? '').trim();
      const name = String(g?.name ?? '').trim();
      if (id && name) state.qqGroupNames[id] = name;
    }
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const close = () => closeAnimatedOverlay(overlay);
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  // ⚠️ 必须挂到 DOM：曾经漏了这一步 —— 弹窗建好、监听也绑了，但从未进入文档，
  // 表现就是「点选择群 / 选择好友毫无反应」（2026-09-26 白名单拉取全链路测试抓出）。
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // 勾选变化时实时刷新头部计数（打开时显示的只是当时的预选数）
  overlay.addEventListener('change', (e) => {
    if (e.target && e.target.matches && e.target.matches('input[type=checkbox]')) {
      overlay.querySelector('.modal-head').textContent =
        `选择${isGroups ? '群' : '好友'}（已选 ${$$('input[type=checkbox]:checked', overlay).length} 个）`;
    }
  });
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    close();
  });
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'memory') {
    patch.memory = {
      ...(c.memory || {}),
      consolidateEnabled: chk('#cfg-mem-consolidate', c.memory?.consolidateEnabled !== false),
      useChatModel: chk('#cfg-mem-usechat', c.memory?.useChatModel !== false),
      provider: val('#cfg-mem-provider', c.memory?.provider || '').trim(),
      model: val('#cfg-mem-model', c.memory?.model || '').trim(),
      consolidateMinIntervalMs: Number(val('#cfg-mem-interval', c.memory?.consolidateMinIntervalMs ?? 21600000)) || 21600000
    };
  }

  if (sec === 'api') {
    patch.api = {
      ...(c.api || {}),
      // 思考强度/温度/最大工具轮数已移入「信息发送配置」内联卡（renderChatSection
      // 的 sc-* 字段，saveConfig 'chat' 分支收集）。此处不再收集这三个字段 ——
      // deepMerge 不写就保留服务端旧值，那边保存过的值不会被这里覆盖。
      //
      // visionModel / videoModel / videoMode 也不在这里收集：唯一编辑入口是
      // 「模型配置」弹窗（mc-vision-model-pick 等，保存时直接 POST api patch）。
      // 曾经这里读 #cfg-vision-model 等隐藏字段，但那批字段自 2026-09-18 改版后
      // 不再渲染 —— 读不到就回写旧值，看似保存实则死写点（openSpecialModelPicker
      // 及其注释宣称的"表单自动保存链"是改版残骸，已一并删除）。
      // 成本核算：官方价开关（走中转站时通常要关掉开关自己填）
      useOfficialPrice: chk('#cfg-useofficialprice', c.api.useOfficialPrice !== false),
      // 远程价格表 URL：留空 = 只用内置表
      // 全局兜底单价：仅当没有模型级价格时生效
      priceInputPerM: Number(val('#cfg-price-in', c.api.priceInputPerM ?? 0)) || 0,
      priceOutputPerM: Number(val('#cfg-price-out', c.api.priceOutputPerM ?? 0)) || 0,
      priceCachedPerM: Number(val('#cfg-price-cached', c.api.priceCachedPerM ?? 0)) || 0,
      // 模型身份三件套：正常路径由模型目录选择器直接 POST（openModelPicker），
      // 这里把隐藏字段 / 只读框的当前值一并带上 —— 保证"选完模型又在
      // 本区块改了单价"的合并保存不会把 model/provider/baseUrl 丢掉。
      // （deepMerge 下不写就保留服务端旧值，写了就与隐藏字段一致，两个方向都安全。）
      model: val('#cfg-model', c.api.model || '').trim(),
      provider: val('#cfg-provider', c.api.provider || '').trim(),
      baseUrl: val('#cfg-baseurl-value', c.api.baseUrl || '').trim(),
      // 备选模型列表：从 DOM 实时读取（fallbackRows 是 bindSettingsEvents 的局部变量，
      // 顶层 saveConfig 访问不到，所以这里直接查 DOM），过滤掉空行。
      // 提供商列已删：model 输入框显示"提供商名 · 模型id"，但存的是纯 id +
      // 提供商由 fallbackRows 内部维护 —— 显示格式不能进配置。
      // 改为从显示值反解太脆（模型 id 本身可含 ·），所以这里读 data-* 属性
      // （renderFallbackRows 渲染时把真值放在 data-model / data-provider 上）。
      fallbackModels: $$('#fallback-model-rows .fb-model-pick').map((el) => ({
        model: String(el.dataset.model || '').trim(),
        provider: String(el.dataset.provider || '').trim()
      })).filter((r) => r.model)
    };
    // 把当前模型的单价存进 modelPrices[模型]（只影响这一个模型，不动内置官方表）。
    // 若开关是打开的，则不应写入 —— 那时输入框是禁用的，读到的值就是官方价，
    // 写进去会凭空产生一条自定义价。
    //
    // ⚠️ 模型名与开关状态都必须读**界面实时值**（c.api 是上次保存的旧值）：
    // 用户可能改了模型/开关但还没保存过，用旧值会把价格存到错误的模型名下。
    const curModel = String(($('#cfg-model')?.value ?? c.api?.model) || '').trim();
    const officialOn = ($('#cfg-useofficialprice')?.checked) ?? (c.api?.useOfficialPrice !== false);
    if (curModel) {
      const isLocked = officialOn;   // 锁定只跟开关绑定
      if (!isLocked) {
        const nextMap = { ...(c.api?.modelPrices || {}) };
        const i = Number(val('#cfg-price-in', 0)) || 0;
        const o = Number(val('#cfg-price-out', 0)) || 0;
        const ca = Number(val('#cfg-price-cached', 0)) || 0;
        if (i || o || ca) {
          nextMap[curModel] = { in: i, out: o, cached: ca || i };
        } else {
          delete nextMap[curModel];   // 全 0 = 清除自定义，回落到官方表
        }
        // 同样需要整体替换，否则 delete 掉的那一项会在合并时复活
        patch.api.modelPrices = { __replace__: nextMap };
      }
    }
    // 当前 API Key：2026-09-18 改版后 Key 输入框在「模型配置」弹窗里自带保存逻辑
    // （mc-apikey → providers/set-key），表单里旧 #cfg-apikey 已不存在 —— 这段
    // 兜底读取随之删除；顶层的 patch.api.apiKey 分支只服务于"非目录提供商"的
    // 旧配置，那种情况现在也走弹窗。
  }

  if (sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    patch.webSearch = {
      ...(c.webSearch || {}),
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'bing'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search',
      deepseek: {
        ...(c.webSearch?.deepseek || {}),
        ...(enteredDsKey && enteredDsKey !== '******' ? { apiKey: enteredDsKey } : {}),
        model: val('#cfg-ds-searchmodel', c.webSearch?.deepseek?.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
      },
      zhipu: {
        ...(c.webSearch?.zhipu || {}),
        ...(enteredZhipuKey && enteredZhipuKey !== '******' ? { apiKey: enteredZhipuKey } : {}),
        engine: val('#cfg-zhipu-engine', c.webSearch?.zhipu?.engine || 'search_std')
      },
      bocha: {
        ...(c.webSearch?.bocha || {}),
        ...(enteredBochaKey && enteredBochaKey !== '******' ? { apiKey: enteredBochaKey } : {})
      },
      baidu: {
        ...(c.webSearch?.baidu || {}),
        ...(enteredBaiduKey && enteredBaiduKey !== '******' ? { apiKey: enteredBaiduKey } : {})
      },
      metaso: {
        ...(c.webSearch?.metaso || {}),
        ...(enteredMetasoKey && enteredMetasoKey !== '******' ? { apiKey: enteredMetasoKey } : {})
      },
      // 自定义搜索服务：列表由「添加/删除」按钮维护（POST /api/search-providers），
      // 但**当前选中那家的 Key 编辑框**在这里随表单提交 —— 用户改 Key 的主路径
      // 就是这个框。按 id 定位条目原地更新；掩码/留空 = 不动，明文 = 覆盖。
      providers: (c.webSearch?.providers || []).map((p) => {
        const sel = val('#cfg-searchprovider', '');
        if (sel !== `custom:${p.id}`) return p;
        const entered = val('#cfg-custom-sp-key', '').trim();
        if (entered && entered !== '******') return { ...p, apiKey: entered };
        return p;
      }),
      // 自定义服务 Key 的「清除」不走表单（专用按钮直接 POST），这里不处理空串。
    };
  }

  if (sec === 'persona') {
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || ''),
      systemPromptOverride: val('#cfg-sysprompt', c.persona.systemPromptOverride || '')
    };
    // 统一人设开关：编辑器随开关二选一在场，读不到的保持旧值。
    patch.personaUnified = chk('#cfg-persona-unified', c.personaUnified !== false);
    // personaByChat 不在这里收集：独立人设模态框已改为**直接 POST 落盘**（openPerChatPersonaModal
    // 的 saveToMap），不再走"隐藏 JSON → 表单保存链"——那条链的 change 事件根本到不了 form
    // 监听器，而且 loadSettings 重建 DOM 会把没保存的值吹掉。这里如果再把（可能过期的）
    // 隐藏 JSON 值 POST 一遍，会把 modal 刚存的条目用旧值覆盖回去。
    // ⚠️ 统一开关运行语义（与 personaForChat 一致）：开启 = 一律用全局人设，
    //    personaByChat 条目不参与合并（数据保留，关掉开关后恢复生效）。
  }

  if (sec === 'allow') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    // deny 不在这里硬清空：UI 没有 deny 编辑入口（屏蔽走「屏蔽名单」按钮），
    // 曾经无条件写 patch.deny = { groups: [], private: [] } —— 用户手改 JSON
    // 加的黑名单在任何一次 allow 区块保存时被抹掉。不写 = deepMerge 保留现值。
    // 想清空 deny 必须显式走屏蔽名单管理或手改后不再让这里覆盖。
    const allowAllBox = $('#cfg-allowallwhenempty');
    patch.allowAllWhenEmpty = allowAllBox ? !!allowAllBox.checked : (c.allowAllWhenEmpty === true);
  }

  if (sec === 'chat') {
    // 信息发送配置已内联到「运行节奏」折叠卡（sc-* 字段）
    const effort = val('#sc-thinking-effort', c.api?.thinkingEffort || '');
    const effortValid = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
    // effort 档与 (mode, effort) 二维状态的映射。'on-noeffort' 是独立档：
    // 后端思考模块区分 on（明确开启）/ auto（跟随模型），若在这里
    // 折叠成 ''（默认），"明确开启思考但选中的下拉档恰好是'开'"的既有配置
    // 会在一次无关保存中被静默改写成 auto。
    const prevMode = c.api?.thinkingMode || 'auto';
    let thinkingMode;
    if (effort === 'off') thinkingMode = 'off';
    else if (effortValid) thinkingMode = 'on';
    else if (effort === 'on-noeffort') thinkingMode = 'on';
    else if (prevMode === 'on') thinkingMode = 'on';   // 原本就是 on 且下拉显示"默认"：保持 on
    else thinkingMode = 'auto';
    patch.api = {
      ...(c.api || {}),
      temperature: Math.min(2, Math.max(0, Number(val('#sc-temperature', c.api?.temperature ?? 0.8)) || 0.8)),
      maxRounds: Math.min(40, Math.max(1, Number(val('#sc-maxrounds', c.api?.maxRounds ?? 12)) || 12)),
      thinkingMode,
      thinkingEffort: effortValid ? effort : ''
    };
    patch.wakeDelayMs = Number(val('#sc-wakedelay', c.wakeDelayMs)) || 2000;
    patch.drainDelayMs = Number(val('#sc-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Math.min(8, Math.max(1, Number(val('#sc-maxruns', c.maxConcurrentRuns)) || 2));
    patch.sessionRetryAttempts = Math.min(5, Math.max(0, Number(val('#sc-sessionretry', c.sessionRetryAttempts ?? 2)) || 0));
    patch.send = {
      ...(c.send || {}),
      minGapMs: Number(val('#sc-mingap', c.send?.minGapMs ?? 1000)) || 1000,
      maxGapMs: Number(val('#sc-maxgap', c.send?.maxGapMs ?? 3000)) || 3000,
      maxPerMinute: Number(val('#sc-maxpermin', c.send?.maxPerMinute ?? 80)) || 80,
      maxPerHour: Number(val('#sc-maxperhour', c.send?.maxPerHour ?? 500)) || 500
    };
    patch.proactive = {
      ...(c.proactive || {}),
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      // 兜底值与后端三处口径统一（DEFAULT_CONFIG / orchestrator 读取链）：
      // 曾经这里兜底 60000/120000/0.1，后端默认 1800000/5400000/0.25 ——
      // 用户清空输入框后一次保存就把"出厂 30~90 分钟一次、25% 概率"
      // 静默改写成"1~2 分钟一次、10% 概率"（主动开话题突然变高频）。
      checkIntervalMinMs: Number(val('#cfg-pro-min', c.proactive?.checkIntervalMinMs)) || 1800000,
      checkIntervalMaxMs: Number(val('#cfg-pro-max', c.proactive?.checkIntervalMaxMs)) || 5400000,
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability ?? 0.25)) || 0.25
    };
    patch.sticker = {
      ...(c.sticker || {}),
      enabled: chk('#cfg-sticker', !!c.sticker?.enabled),
      encourage: Math.min(3, Math.max(0, Number(val('#cfg-sticker-encourage', c.sticker?.encourage ?? 1)) || 0)),
      promptMaxStickers: Math.min(50, Math.max(1, Number(val('#cfg-sticker-promptmax', c.sticker?.promptMaxStickers ?? 10)) || 10))
    };
    // 指令禁言（独立折叠卡「指令禁言」，与其他聊天设置一样即时自动保存）
    patch.commandMute = {
      ...(c.commandMute || {}),
      enabled: chk('#ac-cmdmute-enabled', c.commandMute?.enabled !== false),
      command: String(val('#ac-cmdmute-command', c.commandMute?.command || '/安静')).trim() || '/安静',
      durationMin: Math.max(0, Number(val('#ac-cmdmute-duration', c.commandMute?.durationMin ?? 30)) || 0)
    };
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
    patch.ui = {
      ...(c.ui || {}),
      // 主题在点选项时就已应用并写入 localStorage，这里把它一并存到后端以便跨设备保留
      theme: getThemePref(),
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      refreshMs: Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000
    };
    // memberNotes 不在这里收集：desktop 区块没有备注编辑入口，把 state.config
    // 里的旧快照整体 POST 一遍是"副本回写"——后端运行时删掉的备注会被旧快照
    // 复活（deepMerge 按键覆盖，删掉的键不会消失）。备注的唯一写入口是
    // 「成员备注」模态框（直接 POST 增量 patch），这里不写 = deepMerge 保留现值。
  }

  if (sec === 'onebot') {
    // ⚠️ 令牌是脱敏回传的（值是 ******，真实值只在后端）：
    //    留空 / ****** = 保持原值不变；只有输入了新明文才更新。
    //    曾经直接把输入框的值（脱敏后为空）写进 patch，
    //    结果"保存一次别的设置，OneBot 令牌就被清空"。
    const enteredWsToken = val('#cfg-obtoken', '').trim();
    const enteredHttpToken = val('#cfg-obhttptoken', '').trim();
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      ...(enteredWsToken && enteredWsToken !== '******' ? { accessToken: enteredWsToken } : {}),
      ...(enteredHttpToken && enteredHttpToken !== '******' ? { httpAccessToken: enteredHttpToken } : {})
    };
  }

  if (sec === 'tools') {
    // 工具配置直接从 state.config.tools 读取（事件绑定已实时更新）
    patch.tools = state.config.tools || { enabled: true, overrides: {}, categories: {} };
  }

  // ── POST 之前的最后防线：去掉"空 patch"造成的无谓请求 ──
  // 变动监听挂在整个 #settings-form 上，点击 readonly 输入框、拖动滑条
  // 等不产生真实改动的操作也会触发一次保存。空 patch（没有任何顶层键）
  // 直接跳过 —— 它不会破坏数据，但每次都会让后端全量落盘 + 广播 status。
  if (Object.keys(patch).length === 0) {
    return { ok: true, config: state.config };
  }

  // keepalive：页面卸载（关窗/刷新）后请求仍能完成 —— beforeunload 的
  // 兜底 flush 依赖这一点，普通 fetch 会随页面一起被浏览器中止。
  // ⚠️ 但 keepalive 有 64KB body 上限，超限时 fetch 直接抛 "Failed to fetch"
  // （连请求都不发）。设置 patch 多数很小，但关键词表/模型列表/工具 overrides
  // 可能超 —— 按体积自适应：大 body 退回普通 fetch（卸载兜底本来也只是尽力而为）。
  const bodyStr = JSON.stringify(patch);
  const useKeepalive = bodyStr.length < 60_000;
  const data = await api('/api/config', { method: 'POST', body: bodyStr, ...(useKeepalive ? { keepalive: true } : {}) });
  state.config = data.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  return data;
}
