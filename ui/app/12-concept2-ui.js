// 设置折叠卡 / spark 柱图 —— concept2 视觉语言的交互层
'use strict';

/* ── <details> 折叠开合动画（工具调用卡 / 记忆折叠 / 提示词卡）──
   观感对齐设置页折叠卡（.setcard-body.fold-body 的 grid-rows 补间）：
   高度 + 透明度 + 内边距 .22s ease 补间、箭头同步旋转 —— 且**任何时刻点击
   都立即换向**，补间从"当前可见高度"重新出发（与 CSS transition 同款的
   可打断 / 可反向语义），快速连点不会再出现"点击被吞掉、视觉与状态脱节"。
   实现注记：Chrome ≤130 的 <details> 关闭态由 UA Shadow DOM 的 slot 隐藏
   （作者 CSS 保不住布局），所以收起动画期间先保持 open 属性、补间落定后再
   摘 —— 摘除发生在高度为 0 的一瞬，视觉无感。
   · 只接管 `details.collapsible`，尊重 e.defaultPrevented（summary 里的按钮
     若已阻止默认开合，这里不越权代开）。
   · 无 WAAPI（jsdom 测试环境）时退化为原生瞬时开合，行为语义不变。
   · 程序化改 d.open（渲染时恢复展开状态）不经过这里，天然无动画。 */
function clearCollapsibleAnimStyles(content) {
  if (!content) return;
  for (const p of ['overflow', 'height', 'padding-top', 'padding-bottom', 'opacity']) {
    content.style.removeProperty(p);
  }
}

function toggleCollapsibleAnim(d) {
  const content = [...d.children].find((el) => el.tagName !== 'SUMMARY');
  const want = !(d.__target ?? d.open);
  d.__target = want;
  // 箭头走状态类（CSS transform 过渡天然可打断）：open 属性收起时要等补间
  // 落定才摘，用它驱动箭头会慢半拍。
  d.classList.toggle('coll-open', want);
  d.classList.toggle('coll-shut', !want);
  if (!content || !uiCanAnimate(content)) {
    if (!want) clearCollapsibleAnimStyles(content);
    d.open = want;
    return;
  }
  const seq = (d.__collSeq = (d.__collSeq || 0) + 1);
  // 关键帧值一律自算成安全值：关闭态的内容被 UA 隐藏（未渲染时 getComputedStyle
  // 的 padding / opacity 可能回空串），拿它拼 keyframe 会让 animate() 抛错、
  // 被 catch 吞成"开启动画消失、直接弹开"。未渲染 = 不测量，直接用"收拢"帧当起点。
  const px = (v) => `${Math.max(0, Number.parseFloat(v) || 0)}px`;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 1; };
  const shutFrame = { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 };
  let from = shutFrame;
  if (d.open) {
    // 内容在渲染树里（展开态 / 补间中途换向）：从当前可见值出发
    const csNow = getComputedStyle(content);
    from = {
      height: px(content.getBoundingClientRect().height),
      paddingTop: px(csNow.paddingTop),
      paddingBottom: px(csNow.paddingBottom),
      opacity: num(csNow.opacity)
    };
  }
  // 取消在途补间并还原自然态 —— 再量目标高度（同步完成，中间不会重绘）
  try { content.__collAnim?.cancel(); } catch { /* ignore */ }
  content.__collAnim = null;
  clearCollapsibleAnimStyles(content);
  if (want && !d.open) d.open = true;
  let to = shutFrame;
  if (want) {
    const csNat = getComputedStyle(content);
    to = {
      height: px(content.offsetHeight),
      paddingTop: px(csNat.paddingTop),
      paddingBottom: px(csNat.paddingBottom),
      opacity: 1
    };
  }
  const settle = () => {
    if (d.__collSeq !== seq) return;   // 已被更新的点击接管
    if (!want) d.open = false;
    clearCollapsibleAnimStyles(content);
    content.__collAnim = null;
  };
  content.style.overflow = 'hidden';
  try {
    content.__collAnim = content.animate([from, to], { duration: 220, easing: 'cubic-bezier(.25, 1, .5, 1)' });
    content.__collAnim.onfinish = settle;
  } catch { settle(); return; }
  setTimeout(settle, 400);   // 兜底：动画被打断（DOM 重建）也要落最终状态
}

document.addEventListener('click', (e) => {
  if (e.defaultPrevented) return;
  const sum = e.target && e.target.closest ? e.target.closest('details.collapsible > summary') : null;
  if (!sum) return;
  const d = sum.parentElement;
  if (!d || d.tagName !== 'DETAILS') return;
  e.preventDefault();   // 接管默认开合，动画落定后再落 open
  toggleCollapsibleAnim(d);
});

/* ── 设置项下拉收纳（grid-rows 0fr↔1fr）──
   点 fold-head 开合；head 里的开关/按钮/徽标不冒泡。 */
function bindSetcardFolds(root) {
  const scope = root || document;
  scope.querySelectorAll('.setcard.fold .fold-head').forEach((h) => {
    if (h.__foldBound) return;
    h.__foldBound = true;
    h.addEventListener('click', (e) => {
      if (e.target.closest('button, [role="button"], .switch, .badge, input, select, label, a')) return;
      const card = h.closest('.setcard');
      if (!card) return;
      card.classList.toggle('open');
    });
  });
  scope.querySelectorAll('.setcard-head .switch, .setcard-head button, .setcard-head .badge, .setcard-head label').forEach((el) => {
    if (el.__stopBound) return;
    el.__stopBound = true;
    el.addEventListener('click', (e) => e.stopPropagation());
  });
}

/* 把一段 HTML 包成折叠设置卡。
   extra：卡头内 sc-tt（标题块）与 sc-val（右上角摘要）之间的自定义插槽
   （如「活跃设置」头部的"每个群聊单独设置"开关）。 */
function setCard(opts) {
  const {
    id = '',
    icon = '⚙',
    gray = false,
    title = '',
    sub = '',
    val = '',
    extra = '',
    body = '',
    open = false
  } = opts || {};
  const fid = id ? ` id="${id}"` : '';
  return `
    <div class="setcard fold${open ? ' open' : ''}"${fid}>
      <div class="setcard-head fold-head${extra ? ' has-extra' : ''}">
        <div class="sc-ico${gray ? ' gray' : ''}">${icon}</div>
        <div class="sc-tt"><h4>${title}</h4>${sub ? `<div class="sc-sub">${sub}</div>` : ''}</div>
        ${extra || ''}
        ${val ? `<span class="sc-val">${val}</span>` : ''}
        <span class="chev-r">›</span>
      </div>
      <div class="setcard-body fold-body"><div class="fold-inner">${body}</div></div>
    </div>`;
}

/* 自动把「h3 分组 / settings-divider 分段」收成折叠卡
   —— 覆盖未手动包 setCard 的设置区块，实现「设置项下拉框收纳」。 */
function autoFoldSettings(root) {
  const form = (root && root.id === 'settings-form') ? root
    : (root && root.querySelector && root.querySelector('#settings-form'))
      || document.getElementById('settings-form');
  if (!form) return;
  // 已是折叠卡结构（显式 setCard）：只绑定交互
  if (form.querySelector(':scope > .setcard.fold, :scope > .setcard')) {
    bindSetcardFolds(form);
    return;
  }
  const kids = [...form.children];
  if (!kids.length) return;

  const frag = document.createDocumentFragment();
  let pageHeadDone = false;
  let pageTitle = '';
  let group = null;
  let groupTitle = '';
  let groupIcon = '⚙';
  let groupGray = false;
  let segIdx = 0;

  const flush = () => {
    if (!group) return;
    const body = group;
    const title = groupTitle || pageTitle || '设置项';
    const icon = groupIcon;
    const gray = groupGray;
    const open = segIdx === 0;
    const wrap = document.createElement('div');
    wrap.innerHTML = setCard({ icon, gray, title, body: '', open });
    const card = wrap.firstElementChild;
    const inner = card.querySelector('.fold-inner');
    while (body.firstChild) inner.appendChild(body.firstChild);
    frag.appendChild(card);
    group = null;
    groupTitle = '';
    groupIcon = '⚙';
    groupGray = false;
    segIdx += 1;
  };

  const ensureGroup = () => {
    if (!group) group = document.createElement('div');
    return group;
  };

  for (const el of kids) {
    const tag = el.tagName;
    // 页面主标题：第一枚 h3 直接保留
    if (tag === 'H3' && !pageHeadDone) {
      pageHeadDone = true;
      pageTitle = (el.textContent || '').trim();
      frag.appendChild(el);
      continue;
    }
    // 副标题行
    if (el.classList && el.classList.contains('setsub') && !segIdx && !group) {
      frag.appendChild(el);
      continue;
    }
    // 分组标题 → 开新卡
    if (tag === 'H3') {
      flush();
      groupTitle = (el.textContent || '').trim();
      // 标题不再占独立节点，放进卡头
      el.remove();
      // 图标启发：按关键字
      const t = groupTitle;
      if (/模型|API|渠道/.test(t)) { groupIcon = '🔑'; }
      else if (/搜索/.test(t)) { groupIcon = '🔍'; }
      else if (/记忆/.test(t)) { groupIcon = '🧠'; }
      else if (/人设|角色/.test(t)) { groupIcon = '🎭'; }
      else if (/白名单|允许/.test(t)) { groupIcon = '✅'; }
      else if (/聊天|消息|发送|响应|触发|活跃/.test(t)) { groupIcon = '💬'; }
      else if (/桌面|启动|更新|数据/.test(t)) { groupIcon = '🖥'; }
      else if (/OneBot|SnowLuma|连接/.test(t)) { groupIcon = '🔌'; }
      else if (/工具|技能|插件/.test(t)) { groupIcon = '🧰'; }
      else if (/成本|价格|费用/.test(t)) { groupIcon = '💰'; }
      else if (/备选|降级|故障/.test(t)) { groupIcon = '🔄'; groupGray = true; }
      else if (/高级|安全|风险/.test(t)) { groupIcon = '⚠'; groupGray = true; }
      else { groupIcon = '⚙'; groupGray = true; }
      ensureGroup();
      continue;
    }
    // 分隔线 → 同组内换段；若组内已有内容则拆成下一卡
    if (el.classList && el.classList.contains('settings-divider')) {
      const g = ensureGroup();
      if (g.childElementCount > 0) {
        flush();
        // 分隔线后的段落用默认标题
        groupTitle = '更多设置';
        groupIcon = '⋯';
        groupGray = true;
        ensureGroup();
      }
      el.remove();
      continue;
    }
    ensureGroup().appendChild(el);
  }
  flush();
  form.innerHTML = '';
  form.appendChild(frag);
  bindSetcardFolds(form);
}

/* ── spark 柱图 ──
   data-spark="7,10,8,14,11,17,13" 或 JS 直接调 renderSpark(el, values) */
function formatSparkPoint(key, x) {
  const n = Number(x) || 0;
  if (key === 'cost') return typeof fmtYuan === 'function' ? fmtYuan(n) : String(n);
  if (key === 'cacheHitRate') return (n * 100).toFixed(1) + '%';
  return typeof fmtTok === 'function' ? fmtTok(n) : String(n);
}

function renderSpark(sp, values, labels) {
  if (!sp || !values || !values.length) return;
  // 不 filter NaN：会把 values 与 labels 下标错位；非法值按 0 画
  const v = values.map((x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  });
  if (!v.length) return;
  const labs = (labels || []).map((s) => String(s == null ? '' : s));
  // labels 落 dataset：bindSparks 重绘只读 data-spark，不存就会丢日期
  sp.dataset.sparkLabels = JSON.stringify(labs);
  sp.dataset.spark = v.join(',');
  const mx = Math.max(...v, 1);
  // 整列都是热区：<i> 撑满高度，柱体是内部 <b>。
  // 鼠标只要落在该列纵向范围内（哪怕在矮柱上方的空白）就能触发悬停。
  sp.innerHTML = v.map((x, i) => {
    const h = Math.max(4, (x / mx) * 100);
    return '<i class="' + (i === v.length - 1 ? 'hi' : '') + '" data-i="' + i + '">'
      + '<b style="height:' + h + '%"></b></i>';
  }).join('');
  bindSparkHover(sp, v, labs);
}

function bindSparkHover(sp, values, labels) {
  const card = sp.closest('.usage-card') || sp.closest('.metric');
  if (!card) return;
  const valueEl = card.querySelector('.uc-value, .m-v');
  const subEl = card.querySelector('.uc-sub, .m-d');
  const key = sp.dataset.sparkKey || '';
  const baseValue = valueEl ? valueEl.textContent : '';
  const baseSub = subEl ? subEl.textContent : '';

  sp.querySelectorAll('i[data-i]').forEach((bar) => {
    bar.addEventListener('mouseenter', () => {
      const i = Number(bar.dataset.i);
      const x = values[i];
      const label = labels[i] || '';
      sp.querySelectorAll('i.on').forEach((b) => b.classList.remove('on'));
      bar.classList.add('on');
      if (subEl) subEl.textContent = label || baseSub;
      if (valueEl) valueEl.textContent = formatSparkPoint(key, x);
    });
  });
  // renderSpark 可能被 bindSparks 再跑一遍：mouseleave 挂在 sp 容器上，
  // 不先卸旧的会叠多个监听。柱子监听随 innerHTML 重建自然清理，不用管。
  if (sp.__sparkLeave) sp.removeEventListener('mouseleave', sp.__sparkLeave);
  sp.__sparkLeave = () => {
    sp.querySelectorAll('i.on').forEach((b) => b.classList.remove('on'));
    if (valueEl) valueEl.textContent = baseValue;
    if (subEl) subEl.textContent = baseSub;
  };
  sp.addEventListener('mouseleave', sp.__sparkLeave);
}

function bindSparks(root) {
  const scope = root || document;
  scope.querySelectorAll('.spark[data-spark]').forEach((sp) => {
    const raw = sp.dataset.spark || sp.getAttribute('data-spark');
    if (!raw) return;
    let labels = [];
    try {
      const rawLabels = sp.dataset.sparkLabels || sp.getAttribute('data-spark-labels');
      if (rawLabels) labels = JSON.parse(rawLabels);
      if (!Array.isArray(labels)) labels = [];
    } catch { labels = []; }
    renderSpark(sp, raw.split(',').map(Number), labels);
  });
}

/* 从按天统计抽一列做 spark（cost / runs / promptTokens / search） */
function sparkFromDays(days, key) {
  const list = (days || []).slice(-7);
  return list.map((d) => Number(d?.[key]) || 0);
}

/* 页面渲染后统一绑定 */
function enhanceConcept2UI(root) {
  if (root && (root.id === 'settings-form' || (root.querySelector && root.querySelector('#settings-form')))) {
    autoFoldSettings(root);
  }
  bindSetcardFolds(root);
  bindSparks(root);
}

// 供非 module 脚本使用
window.bindSetcardFolds = bindSetcardFolds;
window.setCard = setCard;
window.autoFoldSettings = autoFoldSettings;
window.renderSpark = renderSpark;
window.bindSparkHover = bindSparkHover;
window.formatSparkPoint = formatSparkPoint;
window.bindSparks = bindSparks;
window.sparkFromDays = sparkFromDays;
window.enhanceConcept2UI = enhanceConcept2UI;

/* ── 侧栏宽度：固定 + 右缘拖拽调宽（localStorage 持久化）── */
const LIST_W_KEY = 'qqa-list-width';
const LIST_W_MIN = 180;
const LIST_W_MAX = 520;
const LIST_W_DEFAULT = 288;

function applyListWidth(px) {
  const w = Math.round(Math.min(LIST_W_MAX, Math.max(LIST_W_MIN, Number(px) || LIST_W_DEFAULT)));
  document.querySelectorAll('.list-pane').forEach((p) => {
    p.style.setProperty('--list-w', w + 'px');
    p.style.flexBasis = w + 'px';
    p.style.width = w + 'px';
  });
  try { localStorage.setItem(LIST_W_KEY, String(w)); } catch { /* 隐私模式忽略 */ }
  return w;
}

function initListResizers() {
  let saved = LIST_W_DEFAULT;
  try {
    const v = Number(localStorage.getItem(LIST_W_KEY));
    if (Number.isFinite(v) && v > 0) saved = v;
  } catch { /* ignore */ }
  applyListWidth(saved);

  document.querySelectorAll('.list-resizer').forEach((handle) => {
    if (handle.__resizeBound) return;
    handle.__resizeBound = true;
    const pane = handle.closest('.list-pane');
    if (!pane) return;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing-list');

      const onMove = (ev) => {
        applyListWidth(startW + (ev.clientX - startX));
      };
      const onUp = (ev) => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing-list');
        try { handle.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    handle.addEventListener('dblclick', () => applyListWidth(LIST_W_DEFAULT));
  });
}

window.applyListWidth = applyListWidth;
window.initListResizers = initListResizers;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initListResizers);
} else {
  initListResizers();
}
