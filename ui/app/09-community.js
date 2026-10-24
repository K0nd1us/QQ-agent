// 〔社区：提示/上传/发送配置/活跃设置/市场〕——M9 拆分第 10 段
'use strict';
/* ══════════════════════════════════════════════════════════════
   社区功能：意见收集 + 金句上传
   ══════════════════════════════════════════════════════════════
   数据流向：浏览器 → https://kondius.cn/qq-agent/api（作者自建的公开
   收件箱，静态站之外的一个小型接收服务）。不经过本地后端 ——
   本地后端只服务本机，碰不到作者的服务器；分发版用户也是这个地址
   （意见和金句本来就是发给作者看的）。
*/
const COMMUNITY_API = 'https://kondius.cn/qq-agent/api';

/** 统一的提示小模态框（替代 alert —— 原生对话框与 UI 风格割裂）。 */
function showNoticeModal(title, text) {
  const overlay = modelModalShell({
    head: title,
    body: `<div class="hint" style="font-size:13.5px;line-height:1.7">${esc(text)}</div>`,
    foot: `<button class="btn btn-primary" id="notice-ok">知道了</button>`
  });
  overlay.querySelector('#notice-ok').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 上传成功浮框（右上角）：不自动消失，只能手动关闭，带目标网址。
 * 意见收集 / 金句上传成功后调用。
 */
function showUploadToast(title, url, { onClose } = {}) {
  // 同类型只留一个（连着传两次不堆叠）
  document.querySelectorAll('.upload-toast').forEach((el) => {
    el.classList.add('closing');
    setTimeout(() => el.remove(), 180);
  });
  const el = document.createElement('div');
  el.className = 'upload-toast';
  el.innerHTML = `
    <div class="ut-head">
      <span class="ut-title">${esc(title)}</span>
      <button class="ut-close" type="button" aria-label="关闭" title="关闭">×</button>
    </div>
    <a class="ut-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  document.body.appendChild(el);
  el.querySelector('.ut-close').addEventListener('click', () => {
    el.classList.add('closing');
    setTimeout(() => { el.remove(); onClose?.(); }, 180);
  });
}


/** 档位说明（concept2 设计稿文案：带 <b> 强调，百分比与后端判定同源）。 */
function descOf(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '只有被 @ 时才响应，其余消息标记已读、<b>不调模型</b>（最省 token）';
  if (tier === 2) return '在 1 档基础上，<b>命中关键词</b>也响应';
  if (tier === 3) return `被 @ / 命中关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '任何消息都响应 —— <b>最费 token</b>';
}

/** 头部摘要文案（折叠卡 head 右侧的当前档位小结）。 */
function tierSummary(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  return tier === 3 ? `3 档 · ${randomPercent}%` : `${tier} 档 · ${TIER_NAME[tier]}`;
}

/**
 * 档位滑条控制器（2026-09-24 · 对齐 concept2 设计稿）：
 * 轨道/分段/拇指都是模板里的静态节点（.tier-scale / .tier-band / .tier-knob），
 * 控制器只做"值 ↔ 界面"与交互。动画契约按设计稿：
 *   · 预设 / 键盘跳档 → 拇指走 CSS 弹簧缓动（transition: left … cubic-bezier(.34,1.4,.64,1)）
 *   · 拖动中 → 临时 transition:none，帧级跟手（这是设计稿帧率正确的关键）
 *   · 松手   → 恢复过渡
 * 控制器协议与 00-core 的 createVSlider 保持一致
 * （setValues / applyValues / setDual / setDisabled / destroy / .values /
 *  onChange({low, high, byUser})）—— applyPeakPreset 等既有调用方零改动。
 * 值语义同旧协议：low = 低谷（活跃）档位点（数值大 = 档高），
 * high = 高峰（安静）档位点，恒有 low >= high；单珠模式只用 low。
 */
function createTierBar({ mount, dual = false, low = 100, high = 10, onChange = null, onInput = null } = {}) {
  // 位置保留两位小数（不取整）：整数量化会让拇指 1% 一跳（宽轨上≈6~10px 的台阶），
  // 拖起来"一段一段"且不跟手。1% 的 1/100 精度对换算毫无影响。
  const clamp = (v) => Math.min(100, Math.max(0, Math.round((Number(v) || 0) * 100) / 100));
  const st = { low: clamp(low), high: clamp(high), dual: !!dual, disabled: false };
  if (st.high > st.low) { const t = st.low; st.low = st.high; st.high = t; }

  // 档位代表位 = 区间中心（1→5、2→15、3→55、4→95）。
  // 松手吸附规则：1/2/4 档语义是离散的（档内任何位置等价）→ 弹簧回档位中心；
  // 3 档是"随机概率线性"（位置=概率）→ 保留精确位置不吸附。
  const B = TIER_SLIDER_BANDS;
  const TIER_POS = [
    B.tier1End / 2,
    (B.tier1End + B.tier2End) / 2,
    (B.tier2End + B.tier3End) / 2,
    (B.tier3End + 100) / 2
  ];
  const snapIfDiscrete = (v) => {
    const { tier } = sliderToTierUI(v);
    return (tier === 1 || tier === 2 || tier === 4) ? TIER_POS[tier - 1] : v;
  };

  // 拇指是模板里的静态节点（设计稿同款 markup）；缺了就兜底补一颗
  const knobLo = mount.querySelector('.knob-valley') || mount.querySelector('.tier-knob');
  let knobHi = mount.querySelector('.knob-peak');
  if (!knobHi) {
    knobHi = document.createElement('div');
    knobHi.className = 'tier-knob knob-peak';
    mount.appendChild(knobHi);
  }
  let knobRendered = false;   // 首帧装填不播动画（弹窗刚打开时不该有珠子弹出）
  [knobLo, knobHi].forEach((k, i) => {
    k.setAttribute('role', 'slider');
    k.setAttribute('aria-label', i === 0 ? '低谷时段档位点' : '高峰时段档位点');
    k.setAttribute('aria-valuemin', '0');
    k.setAttribute('aria-valuemax', '100');
    k.tabIndex = 0;
  });

  const fire = (byUser) => { if (onChange) onChange({ low: st.low, high: st.high, byUser }); };

  function render() {
    knobLo.style.left = st.low + '%';
    knobHi.style.left = st.high + '%';
    // 高峰珠随峰谷开关显隐（点击切换时淡入淡出）；拖动中形态不变，不触发动画
    if (st.dual) uiShow(knobHi, () => { knobHi.style.display = ''; }, knobRendered);
    else uiHide(knobHi, () => { knobHi.style.display = 'none'; }, knobRendered);
    knobLo.style.opacity = st.disabled ? '.4' : '';
    knobHi.style.opacity = st.disabled ? '.4' : '';
    knobLo.setAttribute('aria-valuenow', String(st.low));
    knobHi.setAttribute('aria-valuenow', String(st.high));
    mount.dataset.dual = st.dual ? '1' : '0';
    knobRendered = true;
  }

  const posFrom = (e) => {
    const r = mount.getBoundingClientRect();
    const w = r.width || 1;
    return clamp(((e.clientX - r.left) / w) * 100);
  };
  let dragging = null;
  const move = (which, v) => {
    if (which === 'lo') st.low = st.dual ? Math.max(v, st.high) : v;
    else st.high = Math.min(v, st.low);
    render();
    // 拖动中的高频轻量回调：读数行实时跟手（而不是松手后才变）
    if (onInput) onInput({ low: st.low, high: st.high, byUser: true });
  };
  mount.addEventListener('pointerdown', (e) => {
    if (st.disabled || dragging || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    const v = posFrom(e);
    if (st.dual) dragging = Math.abs(v - st.low) <= Math.abs(v - st.high) ? 'lo' : 'hi';
    else dragging = 'lo';
    try { mount.setPointerCapture(e.pointerId); } catch { /* 旧环境无指针捕获 */ }
    // 拖动跟手：关掉弹簧过渡，帧级直跟；松手恢复（设计稿同款手法）
    knobLo.style.transition = 'none';
    knobHi.style.transition = 'none';
    move(dragging, v);
  });
  mount.addEventListener('pointermove', (e) => { if (dragging) move(dragging, posFrom(e)); });
  const endDrag = () => {
    if (!dragging) return;
    dragging = null;
    knobLo.style.transition = '';
    knobHi.style.transition = '';
    // 松手吸附：1/2/4 档弹簧回档位中心（transition 已恢复 → 弹滑动画生效）；
    // 3 档（随机概率线性）保留精确位置。
    const lo = snapIfDiscrete(st.low);
    const hi = snapIfDiscrete(st.high);
    if (lo !== st.low || hi !== st.high) {
      st.low = lo;
      st.high = hi;
      render();
      if (onInput) onInput({ low: st.low, high: st.high, byUser: true });
    }
    fire(true);
  };
  mount.addEventListener('pointerup', endDrag);
  mount.addEventListener('pointercancel', endDrag);

  const onKey = (which) => (e) => {
    if (st.disabled) return;
    const cur = which === 'lo' ? st.low : st.high;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1;
    else if (e.key === 'PageDown') next = cur - 10;
    else if (e.key === 'PageUp') next = cur + 10;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 100;
    else return;
    e.preventDefault();
    move(which, next);   // 键盘跳档保留弹簧过渡（招牌滑动动画）
    fire(true);
  };
  knobLo.addEventListener('keydown', onKey('lo'));
  knobHi.addEventListener('keydown', onKey('hi'));

  render();
  return {
    get values() { return { low: st.low, high: st.high }; },
    setValues(lo, hi) {
      st.low = clamp(lo);
      st.high = clamp(hi == null ? lo : hi);
      if (st.high > st.low) { const t = st.low; st.low = st.high; st.high = t; }
      render();
    },
    applyValues(lo, hi) { this.setValues(lo, hi); fire(false); },
    setDual(b) { st.dual = !!b; render(); },
    setDisabled(b) { st.disabled = !!b; render(); },
    destroy() {
      mount.removeEventListener('pointerdown', () => {});
      knobLo.removeEventListener('keydown', onKey('lo'));
      knobHi.removeEventListener('keydown', onKey('hi'));
    }
  };
}

/**
 * 「活跃设置」编辑器（2026-09-24 改版：从两级模态框整体搬进聊天设置的
 * 「活跃设置」折叠卡内联展示 —— 「打开活跃设置编辑器」按钮与两个模态框取消，
 * 原「档位设置」子模态框的内容（各档条数 / 关键词表 / 被召唤后持续参与 /
 * 活跃期）一并摊平进折叠卡）。
 *
 * 布局：左侧一条**竖向**档位滑条（1 档在下、4 档在上，轨道下蓝上黄渐变），
 *       右侧是开关与参数。统一/分群**共用同一条滑条** —— 分群模式下它编辑
 *       当前选中的群（群按钮列表选择），从结构上消灭了
 *       "两套滑条 id + 按元素存在性猜象限"这一类 bug。
 * 峰谷：同一条滑条上两颗珠 —— 上面那颗（档位更高）= 低谷时段档位，
 *       下面那颗 = 高峰时段档位，互不交叉；两珠之间画一条半透明区间带。
 * 保存语义与原模态框一致：改动先落草稿，点「保存」整体提交
 * （store / chatActive 一次写盘），「取消」放弃未保存的改动。
 * 「每个群聊单独设置」开关在折叠卡头部；「指令禁言」已独立成自己的折叠卡
 * （走设置页自动保存），不再进这里的草稿。峰谷的启用开关在「峰谷设置」按钮内。
 *
 * 用法：renderChatSection 渲染 `<div id="ac-editor"></div>` 占位，
 *      bindSettingsEvents 每次重渲染后调 mountActiveConfigEditor(root) 挂载。
 */
function mountActiveConfigEditor(root) {
  const clampNum = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fb; };
  const c = state.config || {};
  const st = c.store || {};
  const B = TIER_SLIDER_BANDS;
  const ps = st.peakSchedule || {};
  const unified0 = st.unifiedTier !== false;
  const peakOn0 = ps.enabled === true;
  const globalPos = sliderToTierUI_tierToSlider(st);

  // ── 草稿（闭包工作副本；保存时整体提交，取消即弃）──
  let dContextPos = globalPos;
  let dPeak = {
    start: String(ps.peak?.start || '09:00'),
    end: String(ps.peak?.end || '18:00'),
    peakPos: clampNum(ps.peak?.sliderPos, 10),     // 高峰（安静）档位点
    valleyPos: clampNum(ps.valley?.sliderPos, 100) // 低谷（活跃）档位点
  };
  // 分群两张图：拷贝时剔除 __ 开头的内部键（旧版 __preview 草稿残留一并清掉，不再随图往返）
  const stripInternal = (m) => Object.fromEntries(Object.entries(m || {}).filter(([k]) => !String(k).startsWith('__')));
  const dGroupPos = stripInternal(st.groupSliderPos);
  const dGroupPeak = stripInternal(st.groupPeakPos);
  let activeGid = '';

  // 峰谷时段字段与各档条数等已收进「峰谷设置」「档位参数与持续参与」两个模态框
  // （打开按钮见下方 ac-right），主编辑器只留滑条 / 分群。

  // 竖向四段刻度：滑条"1 档在下、4 档在上"，说明文字也按同向排列 ——
  // 低档位的描述在下、高档位的描述在上（与珠子位置一一对应，读起来不用翻转）。
  const tier0 = sliderToTierUI(peakOn0 ? dPeak.valleyPos : globalPos).tier;
  const peakTier0 = peakOn0 ? sliderToTierUI(dPeak.peakPos).tier : -1;
  // 分段轨道/分隔线/拇指全部是静态 markup（设计稿同款，见模板）——
  // 档位反馈由拇指位 + 大号读数 + 预设高亮承担，不再做分段动态高亮。

  // 档位参数行模板随「档位参数与持续参与」模态框定义（openTierParamsModal）。

  // 内联挂载：内容直接放进折叠卡的 #ac-editor 容器（不再是模态框）。
  // 下方所有 overlay.querySelector 就地作用于该容器 —— 绑定逻辑与原模态框一致。
  root.innerHTML = `
      <div class="ac-tier-wrap">
        <div class="tier-scale" id="ac-slider" data-dual="${peakOn0 ? '1' : '0'}">
          <div class="tier-band" style="left:0;width:${B.tier1End}%">1</div>
          <div class="tier-band d2" style="left:${B.tier1End}%;width:${B.tier2End - B.tier1End}%">2</div>
          <div class="tier-band d3" style="left:${B.tier2End}%;width:${B.tier3End - B.tier2End}%">3 · 随机概率线性</div>
          <div class="tier-band d4" style="left:${B.tier3End}%;width:${100 - B.tier3End}%">4</div>
          <div class="tier-sep" style="left:${B.tier1End}%"></div>
          <div class="tier-sep" style="left:${B.tier2End}%"></div>
          <div class="tier-sep" style="left:${B.tier3End}%"></div>
          <div class="tier-knob knob-valley" style="left:${peakOn0 ? dPeak.valleyPos : globalPos}%"></div>
          <div class="tier-knob knob-peak" style="left:${dPeak.peakPos}%;${peakOn0 ? '' : 'display:none'}"></div>
        </div>
        <div class="tier-read">
          <span class="tr-big" id="ac-tier-num">${peakOn0 && peakTier0 >= 1 && peakTier0 !== tier0 ? `峰 ${peakTier0} 档 · 谷 ${tier0} 档` : `${tier0} 档`}</span>
          <span class="tr-txt" id="ac-tier-note">${peakOn0 ? `高峰：${descOf(dPeak.peakPos)}<br>低谷：${descOf(dPeak.valleyPos)}` : descOf(peakOn0 ? dPeak.valleyPos : globalPos)}</span>
        </div>
        <div class="hint ac-target" id="ac-target"></div>
      </div>
      <div class="ac-right">
          <div id="ac-group-area"${unified0 ? ' style="display:none"' : ''}>
            <div class="field"><label>选择要单独设置的群聊（来自白名单，点击切换）</label>
              <div class="ac-group-buttons" id="ac-group-buttons"></div></div>
            <div style="margin-top:6px">
              <button class="btn btn-small btn-danger" id="tier-group-clear-btn" type="button">清除所选群的单独设置</button>
            </div>
          </div>
      </div>
      <div class="field" style="display:flex;gap:8px;align-items:center;margin-top:12px">
        <button class="btn" id="ac-cancel">取消</button>
        <button class="btn btn-primary" id="ac-save">保存</button>
        <span class="hint">改动先落在草稿里：「保存」整体提交，「取消」放弃未保存的改动。</span>
      </div>`;
  const overlay = root;

  // 「峰谷时段 / 档位参数 / 统一设置」三件套在折叠卡头部（setCard 的 extra 插槽），
  // 不在编辑器体内 —— 统一从卡头取用（测试桩环境 closest 为 null 时退回体内查找）。
  const headCard = overlay.closest ? overlay.closest('.setcard') : null;
  const ctrl = (sel) => headCard?.querySelector(sel) || overlay.querySelector(sel);
  // 「统一设置」开关：开 = 统一全部群（unifiedTier=true），关 = 每个群单独设置。
  const chkUnified = ctrl('#ac-unifiedtier');
  const unifiedNow = () => (chkUnified ? chkUnified.checked !== false : unified0);
  // 峰谷开关在「峰谷时段」组合按钮内部（文本右侧）：勾选状态即草稿状态，
  // 主滑条的双珠形态据此切换（所见即所得）。
  const chkPeak = ctrl('#ac-peak-enabled');
  const peakOnNow = () => (chkPeak ? chkPeak.checked === true : (state.config?.store?.peakSchedule?.enabled === true));
  const noteEl = overlay.querySelector('#ac-tier-note');
  const targetEl = overlay.querySelector('#ac-target');

  // ── 横向分段档位滑条（指针/键盘驱动，单/双珠同轨道）──
  // 值的真正持有者是下面的草稿变量（dContextPos / dPeak / dGroup*），
  // 滑条只是"把草稿画出来 + 让用户改草稿"的视图。
  const vsl = createTierBar({
    mount: overlay.querySelector('#ac-slider'),
    dual: peakOn0,
    low: peakOn0 ? dPeak.valleyPos : globalPos,
    high: dPeak.peakPos,
    onInput: ({ low, high }) => {
      // 拖动中：读数行 + 头部摘要实时跟手（轻量刷新，不重建任何列表 DOM）
      const peakOn = peakOnNow();
      if (peakOn) {
        syncScale(sliderToTierUI(low).tier, sliderToTierUI(high).tier);
        setNote(`高峰：${descOf(high)}<br>低谷：${descOf(low)}`);
      } else {
        syncScale(sliderToTierUI(low).tier, -1);
        setNote(descOf(low));
      }
    },
    onChange: ({ low, high }) => {
      const unified = unifiedNow();
      const peakOn = peakOnNow();
      if (peakOn) {
        if (unified) { dPeak.peakPos = high; dPeak.valleyPos = low; }
        else if (activeGid) dGroupPeak[activeGid] = { peak: high, valley: low };
      } else {
        if (unified) dContextPos = low;
        else if (activeGid) dGroupPos[activeGid] = low;
      }
      refreshAfterValueChange(peakOn);
    }
  });
  activeVSlider = vsl;
  // 弹窗关闭（取消/保存/Esc/点遮罩都走 closeModelModal → overlay.remove()）时
  // 摘掉 window 级 pointer 监听：观察 overlay 从 DOM 摘除的一瞬。
  const mo = new MutationObserver(() => {
    if (!overlay.isConnected) {
      if (activeVSlider === vsl) activeVSlider = null;
      vsl?.destroy();
      mo.disconnect();
    }
  });
  mo.observe(document.body, { childList: true });

  const allowGroupIds = () => (c.allow?.groups || []).map(String);
  // 已不在白名单的群不再显示（2026-09-25 用户反馈：没必要占按钮位）——
  // 它们的单独设置数据仍保留在草稿/配置里，群重回白名单时自动恢复生效。

  // ── 群按钮列表（只列白名单内的群）──
  function renderGroupButtons() {
    const box = overlay.querySelector('#ac-group-buttons');
    if (!box) return;
    const ids = allowGroupIds();
    if (!ids.includes(activeGid)) activeGid = ids[0] || '';   // 编辑目标失效时回退到第一个白名单群
    box.innerHTML = ids.length
      ? ids.map((id) => {
        const title = groupDisplayName(id);
        const hasOwn = dGroupPos[id] !== undefined || dGroupPeak[id] !== undefined;
        return `<button type="button" class="ac-group-btn${id === activeGid ? ' active' : ''}" data-gid="${esc(id)}">`
          + `${esc(title)}${hasOwn ? '<span class="ac-dot" title="该群有单独设置"></span>' : ''}</button>`;
      }).join('')
      : '<div class="hint">（白名单为空——先在「白名单」设置里添加群聊，再回来分群设置）</div>';
  }
  overlay.querySelector('#ac-group-buttons')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.ac-group-btn');
    if (!btn) return;
    activeGid = String(btn.dataset?.gid || '');
    renderGroupButtons();
    syncSliderUI();
  });
  overlay.querySelector('#tier-group-clear-btn')?.addEventListener('click', () => {
    if (!activeGid) return;
    delete dGroupPos[activeGid];
    delete dGroupPeak[activeGid];
    renderGroupButtons();
    syncSliderUI();
  });

  // ── 刻度 / 说明 ──
  function syncScale(tier, peakTier) {
    const numEl = overlay.querySelector('#ac-tier-num');
    if (numEl) {
      numEl.textContent = (peakTier >= 1 && peakTier !== tier)
        ? `峰 ${peakTier} 档 · 谷 ${tier} 档`
        : `${tier} 档`;
    }
    // 折叠卡头部摘要（设计稿 tierBadge 同款信息）
    const valEl = overlay.closest('.setcard')?.querySelector('.sc-val');
    if (valEl && vsl) {
      const v = vsl.values;
      valEl.textContent = (peakTier >= 1 && peakTier !== tier)
        ? `峰 ${tierSummary(v.high)} / 谷 ${tierSummary(v.low)}`
        : tierSummary(v.low);
    }
  }
  function setNote(html) { if (noteEl) noteEl.innerHTML = html; }

  /** 当前象限该读哪组值（分群未单独设置 → 跟随全局）。 */
  function currentTargets() {
    const unified = unifiedNow();
    const peakOn = peakOnNow();
    if (unified) return peakOn ? { hi: dPeak.peakPos, lo: dPeak.valleyPos } : { single: dContextPos };
    if (peakOn) {
      const gp = activeGid ? dGroupPeak[activeGid] : null;
      return gp ? { hi: clampNum(gp.peak, dPeak.peakPos), lo: clampNum(gp.valley, dPeak.valleyPos) } : { hi: dPeak.peakPos, lo: dPeak.valleyPos };
    }
    const gp = activeGid ? dGroupPos[activeGid] : undefined;
    return { single: (gp !== undefined && gp !== null) ? clampNum(gp, dContextPos) : dContextPos };
  }

  /** 把当前象限的值装回滑条 + 刷新刻度/说明/目标提示（外部装值，不写草稿）。 */
  function syncSliderUI() {
    const unified = unifiedNow();
    const peakOn = peakOnNow();
    if (targetEl) {
      targetEl.textContent = unified
        ? (peakOn ? '当前编辑：全局峰谷双点' : '当前编辑：全局档位')
        : (activeGid ? `当前编辑：${groupDisplayName(activeGid)}` : '当前编辑：（未选择群）');
    }
    if (!vsl) return;
    const none = !unified && !activeGid;   // 分群模式但白名单为空：滑条只读
    vsl.setDisabled(none);
    vsl.setDual(peakOn);
    const t = currentTargets();
    if (peakOn) {
      vsl.setValues(t.lo, t.hi);
      syncScale(sliderToTierUI(t.lo).tier, sliderToTierUI(t.hi).tier);
      setNote(`高峰：${descOf(t.hi)}<br>低谷：${descOf(t.lo)}`);
    } else {
      vsl.setValues(t.single, t.single);
      syncScale(sliderToTierUI(t.single).tier, -1);
      setNote(descOf(t.single));
    }
  }

  /** 值变化后的联动刷新（滑条已是新值，只刷刻度/说明/群按钮小圆点）。 */
  function refreshAfterValueChange(peakOn) {
    const v = vsl?.values || { low: 0, high: 0 };
    if (peakOn) {
      syncScale(sliderToTierUI(v.low).tier, sliderToTierUI(v.high).tier);
      setNote(`高峰：${descOf(v.high)}<br>低谷：${descOf(v.low)}`);
    } else {
      syncScale(sliderToTierUI(v.low).tier, -1);
      setNote(descOf(v.low));
    }
    renderGroupButtons();   // "有单独设置"的小圆点可能变了
  }

  /** 开关切换：只切显隐 + 重载滑条值，不重建弹窗。animate=false 用于初始装填（不播动画）。 */
  function applyQuadrantUI(animate = true) {
    const unified = unifiedNow();
    const peakOn = peakOnNow();
    const garea = overlay.querySelector('#ac-group-area');
    if (garea) {
      if (unified) uiHide(garea, () => { garea.style.display = 'none'; }, animate);
      else uiShow(garea, () => { garea.style.display = ''; }, animate);
    }
    if (!unified && !activeGid) {
      const ids = allowGroupIds();
      activeGid = ids[0] || '';   // 自动选中第一个群，滑条立刻有编辑对象
    }
    renderGroupButtons();
    syncSliderUI();
  }
  // 「统一设置」/「峰谷」开关：改动即时反映到滑条形态与显隐
  chkUnified?.addEventListener('change', () => applyQuadrantUI());
  chkPeak?.addEventListener('change', () => applyQuadrantUI());

  // 快捷档位预设胶囊已按需求移除（统一全部群开关保留）；
  // 档位定位由滑条拖动 + 松手吸附（1/2/4 档回中心）承担。
  // 峰谷预设/自定义保存逻辑已随「峰谷设置」模态框搬入 openPeakModal。

  // 初始装填（刻度/说明/群按钮/滑条值）——不播显隐动画
  applyQuadrantUI(false);

  // 群名补底：没有消息存档的白名单群在 /api/chats 里查不到名字，按钮会退化成
  // 「群 <号>」不方便辨识 —— 悄悄拉一次 OneBot 群列表，回来后按群名重画按钮。
  if (!state.qqGroupNames || !Object.keys(state.qqGroupNames).length) {
    loadQqGroupNames().then(() => {
      if (!overlay.isConnected) return;
      renderGroupButtons();
      syncSliderUI();
    });
  }

  // ── 统一保存：主编辑器与两个模态框共用（extra 携带模态框字段）──
  // 语义：无论从哪里保存，当前草稿 + extra 一起整体提交 —— 不会出现
  // "模态框保存把滑条上未保存的拖动丢掉"的割裂。
  async function saveAll(extra = {}) {
    const storePatch = { unifiedTier: unifiedNow() };
    // 峰谷：enabled 来自「峰谷设置」按钮上的开关（extra 可覆盖），
    // 时段来自「峰谷设置」模态框（extra）或沿用已存配置；两颗珠的位置来自草稿。
    const psNow = state.config?.store?.peakSchedule || {};
    const peakEnabled = extra.peakEnabled ?? peakOnNow();
    const peakStart = extra.peakStart || psNow.peak?.start || dPeak.start;
    const peakEnd = extra.peakEnd || psNow.peak?.end || dPeak.end;
    if (peakEnabled) {
      // 峰谷开：存双点；contextSliderPos 同步写低谷值，保证之后关峰谷不跳档。
      // valley 只写 sliderPos —— start/end 在"高峰外=低谷"语义下是死字段
      // （运行端 peakWindowActive 只读 peak.start/end），写假时段只会漂移误导。
      storePatch.contextSliderPos = dPeak.valleyPos;
      storePatch.peakSchedule = {
        ...psNow, enabled: true,
        peak: { start: peakStart, end: peakEnd, sliderPos: dPeak.peakPos },
        valley: { sliderPos: dPeak.valleyPos }
      };
    } else {
      storePatch.contextSliderPos = dContextPos;
      storePatch.peakSchedule = { ...psNow, enabled: false };
    }
    // 分群两张图整体替换（__ 开头内部键已在装填时剔除，不会写回配置）
    storePatch.groupSliderPos = { __replace__: dGroupPos };
    storePatch.groupPeakPos = { __replace__: dGroupPeak };
    // 各档条数 / 关键词表（来自「档位参数与持续参与」模态框）
    if (extra.tierParams) Object.assign(storePatch, extra.tierParams);
    // 指令禁言已独立成「指令禁言」折叠卡（走设置页自动保存），不在这里写盘
    const patch = {
      store: storePatch
    };
    if (extra.chatActive) {
      patch.chatActive = { ...(state.config?.chatActive || {}), ...extra.chatActive };
    }
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    if (r?.config) state.config = r.config;
    return r;
  }

  // ── 峰谷时段模态框（高峰时段 / 预设方案 / 自定义保存）──
  // 启用开关在主界面「峰谷时段」组合按钮内部（文本右侧），这里只管时段本身。
  function openPeakModal() {
    const psNow = state.config?.store?.peakSchedule || {};
    const start = String(psNow.peak?.start || dPeak.start);
    const end = String(psNow.peak?.end || dPeak.end);
    const sub = modelModalShell({
      head: '峰谷时段',
      body: `
        <div class="field-row">
            <div class="field"><label>高峰时段（开始 ~ 结束，所有群共享）</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="time" id="cfg-peak-start" value="${esc(start)}" />
                <span class="muted">~</span>
                <input type="time" id="cfg-peak-end" value="${esc(end)}" />
              </div>
              <div class="hint">时段支持跨零点；高峰之外的时间一律视为低谷（用低谷档位）。启用 / 停用峰谷用「峰谷时段」按钮上的开关。</div></div>
            <div class="field"><label>预设方案</label>
              <select id="cfg-peak-preset">
                <option value="">— 选择预设 —</option>
                ${peakPresetOptions(psNow).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}
              </select>
              <div class="hint" id="peak-preset-hint" style="margin-top:4px">选预设自动填充时段与两个档位点（套用到当前编辑的滑条）。</div></div>
          </div>
          <div class="field"><button class="btn btn-small" id="peak-preset-save-btn" type="button">保存当前方案为「自定义」</button></div>`,
      foot: `<button class="btn" id="ac-peak-cancel">取消</button>
             <button class="btn btn-primary" id="ac-peak-save">保存</button>`
    });
    // 预设套用：写当前在场的滑条（applyPeakPreset 设值后派发 input，联动自动刷新）
    const peakPreset = sub.querySelector('#cfg-peak-preset');
    if (peakPreset) peakPreset.addEventListener('change', () => {
      if (peakPreset.value) applyPeakPreset(peakPreset.value);
      peakPreset.value = '';
    });
    // 保存「自定义」预设（读当前滑条上的值）
    const peakSaveBtn = sub.querySelector('#peak-preset-save-btn');
    if (peakSaveBtn) peakSaveBtn.addEventListener('click', async () => {
      const s = sub.querySelector('#cfg-peak-start')?.value || '09:00';
      const e = sub.querySelector('#cfg-peak-end')?.value || '18:00';
      const v = vsl?.values || { low: 100, high: 10 };
      const cu = {
        peak: { start: s, end: e, sliderPos: v.high },
        // valley 只存 sliderPos（"高峰外=低谷"语义；start/end 无人读）
        valley: { sliderPos: v.low }
      };
      try {
        const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ store: { peakSchedule: { custom: cu } } }) });
        if (r?.config) state.config = r.config;
        const hint = sub.querySelector('#peak-preset-hint');
        if (hint) hint.textContent = `已保存「自定义」（峰 ${s}~${e} @${cu.peak.sliderPos} / 其余 @${cu.valley.sliderPos}）`;
      } catch (e2) {
        alert(`保存自定义失败：${e2.message}`);
      }
    });
    sub.querySelector('#ac-peak-cancel')?.addEventListener('click', () => {
      closeModelModal(sub);
      applyQuadrantUI();   // 取消 = 放弃未保存的开关/时段改动，滑条形态回到已存配置
    });
    sub.querySelector('#ac-peak-save')?.addEventListener('click', async () => {
      try {
        // 启用与否读「峰谷设置」按钮上的开关（所见即所得），时段来自本弹窗
        await saveAll({
          peakStart: sub.querySelector('#cfg-peak-start')?.value || '09:00',
          peakEnd: sub.querySelector('#cfg-peak-end')?.value || '18:00'
        });
        closeModelModal(sub);
        loadSettings();
      } catch (e) {
        alert(`保存峰谷设置失败：${e.message}`);
      }
    });
  }

  // ── 档位参数模态框（历史条数 / 关键词表 / 被召唤后持续参与）──
  function openTierParamsModal() {
    const stNow = state.config?.store || {};
    const cNow = state.config || {};
    // 2026-09-25 改版：各档条数统一 —— 档位只决定触发方式，历史条数一条配置管全部。
    // 老配置的 allCount 作为缺省值兜底显示（stripObsoleteFields 已不再写入新字段）。
    const sub = modelModalShell({
      head: '档位参数',
      body: `
        <h4 class="tp-h">响应时随【已读信息】带多少条历史（各档位相同）</h4>
        <div class="tp-row">发送
          <input class="inp mono tp-count" type="number" id="tp-historycount" min="1" max="500" value="${esc(stNow.historyCount ?? stNow.allCount ?? 80)}" />
          条已读历史。</div>
        <h4 class="tp-h" style="margin-top:12px">连续触发时的前缀缓存锚定</h4>
        <div class="checkbox-row"><input type="checkbox" id="tp-anchor" ${stNow.promptAnchor?.enabled !== false ? 'checked' : ''} />
          <label for="tp-anchor">复用上一轮的记忆+已读前缀，只追加新内容（推荐开启，缓存命中大幅省 token）</label></div>
        <div class="tp-row">最多额外追加
          <input class="inp mono tp-count" type="number" id="tp-anchor-extra" min="1" max="50" value="${esc(Number(stNow.promptAnchor?.maxExtraRead ?? 5))}" />
          条已读，超出则整体重置窗口。</div>
        <div class="field"><label>② 的关键词表（每行一个，不区分大小写）</label>
          <textarea id="tp-keywords" rows="4" placeholder="小鲸鱼&#10;bot">${esc((stNow.keywords || []).join('\n'))}</textarea></div>
        <h4 class="tp-h" style="margin-top:12px">被召唤后持续参与</h4>
        <div class="checkbox-row"><input type="checkbox" id="tp-chatactive" ${cNow.chatActive?.enabled === true ? 'checked' : ''} />
          <label for="tp-chatactive">被召唤后可持续参与话题（1/2/3 档触发时生效）</label></div>
        <div class="field"><label>活跃期最长持续（分钟，到期自动潜水）</label>
          <input type="number" id="tp-chatactive-ttl" min="1" max="240" value="${esc(Number(cNow.chatActive?.ttlMinutes ?? 30))}" style="max-width:160px" /></div>`,
      foot: `<button class="btn" id="tp-cancel">取消</button>
             <button class="btn btn-primary" id="tp-save">保存</button>`
    });
    sub.querySelector('#tp-cancel')?.addEventListener('click', () => closeModelModal(sub));
    sub.querySelector('#tp-save')?.addEventListener('click', async () => {
      try {
        await saveAll({
          tierParams: {
            historyCount: clampInt(sub.querySelector('#tp-historycount')?.value, 1, 500, 80),
            promptAnchor: {
              enabled: sub.querySelector('#tp-anchor')?.checked === true,
              maxExtraRead: clampInt(sub.querySelector('#tp-anchor-extra')?.value, 1, 50, 5)
            },
            keywords: String(sub.querySelector('#tp-keywords')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean)
          },
          chatActive: {
            enabled: sub.querySelector('#tp-chatactive')?.checked === true,
            ttlMinutes: Math.min(240, Math.max(1, Number(sub.querySelector('#tp-chatactive-ttl')?.value) || 30))
          }
        });
        closeModelModal(sub);
        loadSettings();
      } catch (e) {
        alert(`保存档位参数失败：${e.message}`);
      }
    });
  }

  // 「峰谷时段」组合按钮：点按钮本体 = 设置高峰时段（弹窗）；
  // 点文本右侧的开关 = 启用 / 停用峰谷（不弹窗，即时预览主滑条双珠形态）。
  // stopPropagation：三件套在折叠卡头部，不拦住会顺手把卡折叠了。
  const peakBtn = ctrl('#ac-peak-btn');
  peakBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target?.closest?.('.switch, input')) return;   // 点的是开关，别弹窗
    openPeakModal();
  });
  peakBtn?.addEventListener('keydown', (e) => {
    if (e.target !== peakBtn) return;   // 开关自身的键盘操作不冒泡成"打开弹窗"
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeakModal(); }
  });
  ctrl('#ac-tier-params-btn')?.addEventListener('click', openTierParamsModal);
  overlay.querySelector('#ac-cancel')?.addEventListener('click', () => renderSettings());
  overlay.querySelector('#ac-save')?.addEventListener('click', async () => {
    try {
      await saveAll();
      loadSettings();
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
}

/**
 * 「创建技能 / 创建插件」引导模态框（技能页与插件页标题旁的 ＋ 按钮）。
 *
 * 定位：**引导**而不是代写 —— 控制台无法安全地往磁盘写任意代码，这个弹窗
 * 把用户带到正确的三样东西上：项目自带的脚手架脚本、开发文档、AI 桌面工具
 * 工作流。技能（LLM 型）与插件（确定性型）的文档路径不同，按 kind 切换。
 */
/* ═══ 社区市场：添加模态框 + 上传流程 + 口令安装 ═══
   2026-09-19 新增。所有网络请求走本地后端代理（/api/market/*），
   浏览器不直连官网（CORS 边界 + 凭据不进前端 localStorage）。 */

/** 拉本地已保存的账号凭据列表（{username, savedAt}）。 */
async function fetchMarketAccounts() {
  try {
    const r = await api('/api/market/accounts');
    return r.accounts || [];
  } catch { return []; }
}

/**
 * 「添加技能 / 添加插件」入口模态框：上下两个大按钮。
 * 上面 = 去市场（口令安装），悬停文案「捞点好货」；
 * 下面 = 自己造（原创建引导），悬停文案「我去牛逼」。
 */
function openAddModuleModal(kind) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  // 双市场：技能页开 skill-market，插件页开 plugin-market（线上两个独立页面）
  const marketUrl = `https://www.kondius.cn/qq-agent/${isSkill ? 'skill-market' : 'plugin-market'}/`;
  const overlay = modelModalShell({
    head: `添加${name}`,
    body: `
      <div class="hint" style="margin-bottom:12px">两种来路：从市场捞现成的，或者自己造一个。</div>
      <div class="addmod-stack">
        <button class="addmod-big" id="addmod-market">
          <span class="addmod-label">看看${name}市场</span>
          <span class="addmod-hover-label">捞点好货</span>
        </button>
        <button class="addmod-big addmod-diy" id="addmod-diy">
          <span class="addmod-label">自己造个${name}</span>
          <span class="addmod-hover-label">我去牛逼</span>
        </button>
      </div>`,
    foot: `<button class="btn" id="addmod-cancel">算了</button>`
  });
  overlay.querySelector('#addmod-market')?.addEventListener('click', () => {
    closeModelModal(overlay);
    window.open(marketUrl, '_blank', 'noopener');
    openInstallCodeModal();
  });
  overlay.querySelector('#addmod-diy')?.addEventListener('click', () => {
    closeModelModal(overlay);
    openCreateModuleGuide(kind);
  });
  overlay.querySelector('#addmod-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

/**
 * 口令安装模态框：逐行输入口令，失焦校验；
 * 「就这些吧」批量下载解压到对应目录（类型由服务器决定）。
 */
function openInstallCodeModal() {
  let codeRows = [];   // [{ code, status: 'idle'|'checking'|'ok'|'bad', entry }]
  const overlay = modelModalShell({
    head: '口令安装',
    body: `
      <div class="hint" style="margin-bottom:10px">
        在市场页找到想要的技能/插件，点「复制口令！」，把得到的口令填进来。
        每行一个；填完一行会自动校验。输完点「就这些吧」批量安装。
        <span class="muted">（技能口令和插件口令都行 —— 类型由服务器决定，会装进各自的页签）</span>
      </div>
      <div id="ic-rows"></div>
      <div class="hint" id="ic-status" style="margin-top:10px"></div>`,
    foot: `
      <button class="btn btn-primary" id="ic-confirm">就这些吧</button>
      <button class="btn" id="ic-cancel">算了算了</button>`
  });
  const rowsBox = overlay.querySelector('#ic-rows');
  const statusBox = overlay.querySelector('#ic-status');

  const renderRows = () => {
    rowsBox.innerHTML = codeRows.map((r, i) => {
      const cls = r.status === 'ok' ? ' ok' : (r.status === 'bad' ? ' bad' : (r.status === 'checking' ? ' checking' : ''));
      const dim = r.status === 'ok' ? ' dim' : (r.status === 'bad' ? '' : '');
      const badge = r.status === 'ok'
        ? `<span class="ic-check">✅</span><span class="ic-meta">${esc(r.entry?.name || '')}<span class="muted"> · ${esc(r.entry?.author || '')} · ${r.entry?.type === 'plugin' ? '插件' : '技能'}</span></span>`
        : '';
      return `<div class="ic-row${cls}${dim}">
        <input type="text" class="ic-input" data-idx="${i}" value="${esc(r.code)}"
          placeholder="${r.status === 'ok' ? '已匹配' : '输入 6 位口令'}"
          autocomplete="off" spellcheck="false" ${r.status === 'ok' ? 'readonly' : ''} />
        <button class="ic-del" data-idx="${i}" title="删除这行" aria-label="删除第 ${i + 1} 行">🗑</button>
        ${badge}
      </div>`;
    }).join('');
    // 绑定输入：失焦且有内容 → 触发校验 + 追加新行
    rowsBox.querySelectorAll('.ic-input').forEach((inp) => {
      inp.addEventListener('blur', async () => {
        const idx = Number(inp.dataset.idx);
        const code = inp.value.trim().toUpperCase();
        if (!code) return;
        if (codeRows[idx]?.code === code && codeRows[idx]?.status === 'ok') return;
        codeRows[idx] = { code, status: 'checking', entry: null };
        renderRows();
        try {
          const r = await api('/api/market/verify', { method: 'POST', body: JSON.stringify({ codes: [code] }) });
          const hit = (r.results || [])[0];
          if (codeRows[idx]?.code !== code) return;   // 期间被删/改过，丢弃结果
          if (hit?.ok) {
            codeRows[idx] = { code, status: 'ok', entry: hit };
            // 失焦且有内容 → 下一行出现（只在没有空行时追加）
            if (!codeRows.some((x) => !x.code)) codeRows.push({ code: '', status: 'idle', entry: null });
          } else {
            codeRows[idx] = { code, status: 'bad', entry: null };
          }
        } catch (e) {
          if (codeRows[idx]?.code === code) codeRows[idx] = { code, status: 'bad', entry: null };
          statusBox.textContent = `校验失败：${e?.message || e}`;
        }
        renderRows();
      });
    });
    rowsBox.querySelectorAll('.ic-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        codeRows.splice(Number(btn.dataset.idx), 1);
        if (!codeRows.length) codeRows.push({ code: '', status: 'idle', entry: null });
        renderRows();
      });
    });
  };
  codeRows.push({ code: '', status: 'idle', entry: null });
  renderRows();

  overlay.querySelector('#ic-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ic-confirm')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#ic-confirm');
    const ready = codeRows.filter((r) => r.status === 'ok' && r.entry);
    if (!ready.length) {
      statusBox.textContent = '还没有成功对接的口令（先把口令填对，等它变绿带 ✅）。';
      return;
    }
    btn.disabled = true;
    let installed = 0;
    const notes = [];
    for (const r of ready) {
      statusBox.textContent = `正在安装 ${installed + 1}/${ready.length}：${r.entry?.name || r.code}…`;
      try {
        const res = await api('/api/market/install', {
          method: 'POST',
          body: JSON.stringify({ code: r.code, entry: r.entry })
        });
        installed++;
        notes.push(`${res.kind === 'plugin' ? '插件' : '技能'} ${res.id} 已安装`);
      } catch (e) {
        notes.push(`${r.entry?.name || r.code} 安装失败：${e?.message || e}`);
      }
    }
    statusBox.textContent = installed
      ? `安装完成：${installed} 个。${notes.join('；')}`
      : `全部失败。${notes.join('；')}`;
    btn.disabled = false;
    if (installed) {
      // 刷新两个页签（安装的类型可能在另一页）
      await loadModulePage('skill', { rescan: true }).catch(() => {});
      await loadModulePage('plugin', { rescan: true }).catch(() => {});
      setTimeout(() => closeModelModal(overlay), 1200);
    }
  });
  return overlay;
}

/**
 * 上传流程模态框（点卡片 ⬆ 钮进入）：
 *   第一步：无凭据 → 登录/注册；第二步：有凭据 → 列表选择；
 *   第三步：填展示名/简介 → 后端确认 id → 打包上传 → 待审核提示。
 */
async function openMarketUploadModal(kind, moduleId) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  const s = (state.skills || []).find((x) => x.id === moduleId);
  const displayName0 = s?.name || moduleId;
  const desc0 = s?.description || '';

  const overlay = modelModalShell({
    head: `上传${name}到市场：${moduleId}`,
    body: `<div class="hint">正在读取本地账号…</div>`,
    foot: ''
  });
  const setBody = (html, foot = '') => {
    overlay.querySelector('.model-modal-body').innerHTML = html;
    const footBox = overlay.querySelector('.model-modal-foot');
    if (footBox) footBox.innerHTML = foot;
  };

  // ── 第一步：登录/注册（无凭据时） ──
  const renderLoginStep = (mode = 'login') => {
    const isLogin = mode === 'login';
    setBody(`
      <div class="hint" style="margin-bottom:10px">
        本机还没有 QQ Agent 账号凭据。上传${name}需要先登录（登录一次后会记住，以后不用再登）。
      </div>
      <div class="field"><label>登录 ID${isLogin ? '' : '（3~24 位，字母/数字/下划线）'}</label>
        <input type="text" id="mu-username" autocomplete="username" placeholder="如 my_bot_fan" /></div>
      ${isLogin ? '' : `
      <div class="field"><label>展示用户名（市场里显示的名字）</label>
        <input type="text" id="mu-displayname" maxlength="24" placeholder="如 小小机器人" /></div>`}
      <div class="field"><label>${isLogin ? '密码' : '设置密码（6~72 位）'}</label>
        <input type="password" id="mu-password" autocomplete="current-password" /></div>
      ${isLogin ? '' : `
      <div class="field"><label>确认密码</label>
        <input type="password" id="mu-password2" autocomplete="new-password" /></div>`}
      <div class="hint" id="mu-login-msg" style="min-height:18px"></div>
      <div class="hint" style="margin-top:6px">
        没有账号？<a href="https://www.kondius.cn/qq-agent/skill-market/" target="_blank" rel="noopener">前往官网注册</a>，
        或直接<span class="link" id="mu-switch-mode">${isLogin ? '在这里注册' : '在这里登录'}</span>。
      </div>`,
      `<button class="btn btn-primary" id="mu-login-go">${isLogin ? '登录' : '注册并登录'}</button>
       <button class="btn" id="mu-login-cancel">取消</button>`);
    const doLogin = async () => {
      const loginId = overlay.querySelector('#mu-username')?.value.trim() || '';
      const displayName = overlay.querySelector('#mu-displayname')?.value.trim() || '';
      const password = overlay.querySelector('#mu-password')?.value || '';
      const password2 = overlay.querySelector('#mu-password2')?.value || '';
      const msg = overlay.querySelector('#mu-login-msg');
      if (!loginId || !password) { msg.textContent = '登录 ID 和密码都要填'; return; }
      if (!isLogin) {
        if (!displayName) { msg.textContent = '展示用户名不能为空'; return; }
        if (password !== password2) { msg.textContent = '两次输入的密码不一致'; return; }
      }
      const go = overlay.querySelector('#mu-login-go');
      go.disabled = true;
      msg.textContent = isLogin ? '正在登录…' : '正在注册…';
      try {
        const payload = isLogin
          ? { loginId, password, mode: 'login' }
          : { loginId, displayName, password, mode: 'register' };
        await api('/api/market/login', { method: 'POST', body: JSON.stringify(payload) });
        msg.textContent = isLogin ? '登录成功' : '注册成功';
        await renderAccountPick();   // 进入第二步
      } catch (e) {
        msg.textContent = `${e?.message || e}`;
        go.disabled = false;
      }
    };
    overlay.querySelector('#mu-login-go')?.addEventListener('click', doLogin);
    overlay.querySelector('#mu-password')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && isLogin) doLogin();
    });
    overlay.querySelector('#mu-password2')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
    overlay.querySelector('#mu-login-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#mu-switch-mode')?.addEventListener('click', () => renderLoginStep(isLogin ? 'register' : 'login'));
  };

  // ── 第二步：选择账号 ──
  const renderAccountPick = async () => {
    const accounts = await fetchMarketAccounts();
    if (!accounts.length) { renderLoginStep(); return; }
    setBody(`
      <div class="hint" style="margin-bottom:10px">本机保存了这些账号，用哪个上传？</div>
      ${accounts.map((a) => `
        <button class="account-pick" data-username="${esc(a.username)}">
          <span class="ap-name">${esc(a.username)}</span>
          <span class="muted">保存于 ${fmtTime(a.savedAt)}</span>
        </button>`).join('')}
      <div class="hint" style="margin-top:8px">
        <span class="link" id="mu-use-other">使用其它账号密码登录（新增一个）</span>
        ${accounts.length > 1 ? ' · ' : ''}
        <span class="link" id="mu-remove-one" style="${accounts.length > 1 ? '' : 'display:none'}">移除一个保存的账号</span>
      </div>`);
    overlay.querySelectorAll('.account-pick').forEach((btn) => {
      btn.addEventListener('click', () => renderPublishStep(btn.dataset.username));
    });
    overlay.querySelector('#mu-use-other')?.addEventListener('click', () => renderLoginStep());
    overlay.querySelector('#mu-remove-one')?.addEventListener('click', async () => {
      const accounts2 = await fetchMarketAccounts();
      if (accounts2.length <= 1) return;
      const who = await uiPrompt(`要移除哪个账号？\n${accounts2.map((a, i) => `${i + 1}. ${a.username}`).join('\n')}\n（输入序号或用户名）`);
      if (!who) return;
      const target = /^\d+$/.test(who.trim()) ? accounts2[Number(who.trim()) - 1]?.username : who.trim();
      if (!target || !accounts2.some((a) => a.username === target)) { alert('没找到这个账号'); return; }
      await api('/api/market/logout', { method: 'POST', body: JSON.stringify({ username: target }) });
      await renderAccountPick();
    });
  };

  // ── 第三步：填信息 + 确认上传 ──
  const renderPublishStep = (accountUsername) => {
    setBody(`
      <div class="hint" style="margin-bottom:10px">
        以 <b>${esc(accountUsername)}</b> 的名义上传 <b>${esc(moduleId)}</b>。如果市场上已存在同 id 的条目，上传会被拒绝（换一个 id 再试）。
      </div>
      <div class="field"><label>展示名</label>
        <input type="text" id="mu-name" value="${esc(displayName0)}" maxlength="60" /></div>
      <div class="field field--wide"><label>简介</label>
        <textarea id="mu-desc" rows="3" maxlength="500">${esc(desc0)}</textarea></div>
      <div class="hint" id="mu-pub-msg" style="min-height:18px"></div>
      <div class="hint" style="margin-top:6px">
        ⚠️ 打包上传的是 <code>${isSkill ? 'skills' : 'plugins'}/${esc(moduleId)}/</code> 整个目录。
        请先确认里面没有 API Key、Cookie 等私密信息 —— 审核通过后所有人都能下载。
      </div>`,
      `<button class="btn btn-primary" id="mu-pub-go">打包上传</button>
       <button class="btn" id="mu-pub-cancel">取消</button>`);
    overlay.querySelector('#mu-pub-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#mu-pub-go')?.addEventListener('click', async () => {
      const go = overlay.querySelector('#mu-pub-go');
      const msg = overlay.querySelector('#mu-pub-msg');
      const displayName = overlay.querySelector('#mu-name')?.value.trim() || '';
      const description = overlay.querySelector('#mu-desc')?.value.trim() || '';
      if (!displayName) { msg.textContent = '展示名不能为空'; return; }
      // 人机验证：远端市场对发布强制验签，通过后把 captchaVerifyParam 随上传透传
      go.disabled = true;
      msg.textContent = '请完成人机验证…';
      showCaptcha((captchaVerifyParam) => {
        go.disabled = false;
        if (captchaVerifyParam instanceof Error) { msg.textContent = captchaVerifyParam.message; return; }
        doPublish(captchaVerifyParam);
      });
    });

    async function doPublish(captchaVerifyParam) {
      const go = overlay.querySelector('#mu-pub-go');
      const msg = overlay.querySelector('#mu-pub-msg');
      const displayName = overlay.querySelector('#mu-name')?.value.trim() || '';
      const description = overlay.querySelector('#mu-desc')?.value.trim() || '';
      go.disabled = true;
      msg.textContent = '正在打包并上传…';
      try {
        await api('/api/market/publish', {
          method: 'POST',
          body: JSON.stringify({ kind, id: moduleId, displayName, description, accountUsername, captchaVerifyParam })
        });
        setBody(`
          <div class="hint" style="margin:8px 0">
            ✅ 上传完成！<b>${esc(moduleId)}</b> 已进入<b>待审核</b>状态 ——
            审核通过后才会出现在市场，并生成「复制口令！」按钮。
          </div>
          <div class="hint">可以关闭这个窗口，或去 <a href="https://www.kondius.cn/qq-agent/skill-market/" target="_blank" rel="noopener">市场页面</a> 看看进展。</div>`,
          `<button class="btn" id="mu-done">知道了</button>`);
        overlay.querySelector('#mu-done')?.addEventListener('click', () => closeModelModal(overlay));
      } catch (e) {
        // 409（id 重复）等服务端错误直接显示人话文案
        msg.textContent = `${e?.message || e}`;
        go.disabled = false;
      }
    }
  };

  // 入口分流
  const accounts = await fetchMarketAccounts();
  if (accounts.length) await renderAccountPick();
  else renderLoginStep();
  return overlay;
}

/**
 * 「自己造个技能/插件」引导（2026-09-19 零门槛版）。
 *
 * 面向完全非技术人员：没有命令行、不用找文件夹、不用懂"放进目录"。
 * 全部工作交给一段**复制出去的提示词**：用户把它粘进任意 AI 桌面工具
 * （ZCode / WorkBuddy / Qoder / DeepSeek Harness…），AI 会自己——
 *   ① 找到项目里的开发文档并读懂
 *   ② 通过提问确认用户想要什么、并判定该做成技能还是插件（多数人分不清）
 *   ③ 按文档规范生成 skill.json/plugin.json + index.js
 *   ④ 直接把文件写进 skills/<id>/ 或 plugins/<id>/（热重载自动生效）
 *
 * 提示词里写死了"三步自检"（类型判定 → 文档路径 → 落盘位置），
 * 用户不需要理解其中任何一个术语。
 */
/**
 * 从 /api/status 的 dataDir 推导项目根目录。
 * dataDir 形如 <根>/data 或 <根>/data-2（第二实例）——去掉末尾的 data 段。
 * 拿不到（status 未加载等）返回空串，提示词里走"询问用户"兜底。
 */
function detectProjectRoot() {
  const dir = String(state.status?.dataDir || '');
  if (!dir) return '';
  const norm = dir.replace(/[\\/]+$/, '');
  const m = /[\\/]data(-\d+)?$/i.exec(norm);
  return m ? norm.slice(0, m.index) : norm;
}

function buildModuleCreationPrompt(kind) {
  const isSkill = kind === 'skill';
  // 引导 AI 从"用户点的是技能页还是插件页"出发，但**允许 AI 推翻**——
  // 用户多数分不清两型，点错入口是常态；判定权交给读完了文档的 AI。
  const entryHint = isSkill
    ? '用户是从「技能」页点进来的（他大概率想要一个技能，但也可能点错了，需要你判定）'
    : '用户是从「插件」页点进来的（他大概率想要一个插件，但也可能点错了，需要你判定）';
  // 项目根：拿到了就直接给 AI 绝对路径（省掉 AI 全盘摸索）；拿不到就让 AI 问。
  const root = detectProjectRoot();
  const locateBlock = root
    ? `这个项目就安装在我电脑的这个文件夹里（直接用，不用再找）：
${root}
文档在它下面的 doc/extend_development/ 里，技能/插件目录分别是它下面的 skills/ 和 plugins/。`
    : `先问我一句"QQ Agent 装在哪个文件夹"（我不知道的话，就找桌面或开始菜单里的「QQ Agent」快捷方式 → 右键 → 打开文件所在位置）。拿到项目文件夹后再继续。`;
  return `我电脑上有一个叫「QQ Agent」的 QQ 机器人项目，我想给它加一个新功能，但我不会写代码。请你帮我从头到尾做完，包括把文件放到位。下面是给你的完整工作说明：

【第零步：定位项目】
${locateBlock}

【第一步：先读懂文档】
读取项目里 doc/extend_development/ 目录下的这些文档：
- skill-development.md（技能开发规范）
- plugin-development.md（插件开发规范）
- skill-reference.md（API 完整参考，必读）
- 如果要操作 QQ 本身（查群成员、禁言、发文件等），还要读 snowluma-capabilities.md
先读完再动手。文档里写全了格式要求、API 用法和常见的坑，不按文档做的产物会静默失效（不报错、就是没反应）。

【第二步：搞清楚我要什么】
${entryHint}。
"技能"和"插件"是两种不同的东西（文档第 0 节有判定方法），大多数人分不清，所以：
- 先问清楚我想要这个功能做什么、什么时候触发、要不要机器人"动脑子"判断；
- 然后按文档的判定方法决定做成技能（skills/ 目录）还是插件（plugins/ 目录），并告诉我你的判定和理由；
- 我说不上来的时候，用文档里的"三问判断法"引导我。

【第三步：生成并落盘】
确定类型后：
1. 按对应文档的规范，生成完整可运行的文件（技能是 skills/<id>/skill.json + index.js，插件是 plugins/<id>/plugin.json + index.js）；
2. <id> 用一个简短的小写英文标识（如 my-weather），不要用中文；
3. 把文件直接写到项目对应的目录里去（技能 → skills/<id>/，插件 → plugins/<id>/）。这个项目开着热重载，文件落盘后会自动加载，不需要我重启或刷新；
4. 写完后告诉我：生成了什么、放在哪、回到 QQ Agent 的「技能」或「插件」页签应该看到什么。

【如果出了问题】
生成后如果 QQ Agent 控制台的技能/插件页显示加载失败，把页面上显示的错误原因原样发给我，我来贴给你修（文档里有常见失败对照表）。

现在开始：先简短地问我"你想让机器人学会什么"，然后按上面的流程走完全程。不要让我做任何技术操作。`;
}

function openCreateModuleGuide(kind) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  const prompt = buildModuleCreationPrompt(kind);
  const overlay = modelModalShell({
    head: `自己造个${name}`,
    body: `
      <div class="hint" style="margin-bottom:12px">
        不会写代码？没问题。把下面这段提示词复制出来，粘贴到<b>任何</b>一个 AI 桌面工具里
        （ZCode、WorkBuddy、Qoder、DeepSeek Harness 之类的都行），
        然后告诉它你想要什么功能——它会问清楚需求、读文档、把做好的${name}直接放进项目里，
        你回到这个页面点「刷新」就能看到。<b>全程不需要你碰任何文件夹。</b>
      </div>
      <pre class="guide-code" id="cmg-prompt" style="max-height:220px;overflow:auto;user-select:all;white-space:pre-wrap;word-break:break-all">${esc(prompt)}</pre>
      <div class="hint" id="cmg-copied" style="min-height:18px;color:var(--green)"></div>`,
    foot: `<button class="btn btn-primary" id="cmg-copy">📋 一键复制提示词</button>
           <button class="btn" id="cmg-close">关闭</button>`
  });
  overlay.querySelector('#cmg-copy')?.addEventListener('click', async () => {
    // clipboard API 在 Electron 里稳；失败回落到选中文本让用户 Ctrl+C
    let ok = false;
    try {
      await navigator.clipboard.writeText(prompt);
      ok = true;
    } catch {
      const pre = overlay.querySelector('#cmg-prompt');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        ok = document.execCommand?.('copy') || false;
      }
    }
    const tip = overlay.querySelector('#cmg-copied');
    if (tip) tip.textContent = ok
      ? '✅ 已复制！现在打开你的 AI 工具（ZCode / WorkBuddy / Qoder…）直接粘贴发送。'
      : '复制失败——请手动选中上方文本框里的全部内容按 Ctrl+C 复制。';
  });
  overlay.querySelector('#cmg-close')?.addEventListener('click', () => closeModelModal(overlay));
}