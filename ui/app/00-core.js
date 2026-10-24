// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
// ── 本文件是 12 段拆分（M9）中的第 1 段：基础层（工具函数 / state / 主题 / 峰谷 / 滑条）。
//    拆分原则：所有段都是**普通脚本**（无 import/export），按 index.html 里的 defer 顺序
//    执行；跨段共享的顶层 let/const 是全局词法绑定，语义与原单文件完全一致。
//    vendor 模块（tier-slider / price-match）由 /app.js（ESM 桥）挂到 window 上。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ── 原生对话框全面替换（2026-09-26）──────────────────────────────────
   alert / confirm / prompt 在 Electron 里是**Windows 系统对话框**，两个毛病：
   ① 关闭后窗口不认领回键盘焦点（electron/electron#41602 —— "弹过对话框后
      所有输入框打不了字"）；② 系统灰白框和应用观感割裂。
   → alert  → showAppAlert（红色提示弹窗，同步包装，调用点不用改）
   → confirm → uiConfirm（红色确认弹窗，Promise<boolean>；调用点已全部改成
      `if (!(await uiConfirm(…))) return;`）
   → prompt → uiPrompt（红色输入弹窗，Promise<string|null>；同上）
   下面对 window.confirm / window.prompt 的包装只是**安全网**：万一将来有人
   又写了裸 confirm()，至少不会弹系统框裸奔（且带焦点回收）。
   焦点回收保留：安全网触发的原生弹窗仍需要它。 */
const nativeWindowAlert = window.alert;
const nativeWindowConfirm = window.confirm;
const nativeWindowPrompt = window.prompt;

/** 应用内提示弹窗（红色配色）：替代原生 alert，任何地方可直接调用。返回弹窗句柄。 */
function showAppAlert(message) {
  const text = String(message ?? '');
  try {
    const overlay = modelModalShell({
      head: '⚠️ 提示',
      body: `<div class="app-alert-text">${esc(text)}</div>`,
      foot: `<button class="btn" id="app-alert-ok">知道了</button>`,
      danger: true
    });
    const ok = overlay.querySelector('#app-alert-ok');
    ok?.addEventListener('click', () => closeModelModal(overlay));
    setTimeout(() => { try { ok?.focus(); } catch { /* ignore */ } }, 0);
    return overlay;
  } catch {
    // 弹窗基建不可用时不能把错误吞掉 —— 退回原生 alert
    try { if (typeof nativeWindowAlert === 'function') nativeWindowAlert.call(window, text); } catch { /* ignore */ }
    return null;
  }
}

/**
 * 应用内确认弹窗（红色配色）：替代原生 confirm（Windows 系统对话框，观感割裂 +
 * electron#41602 焦点 bug）。**异步**：返回 Promise<boolean>。
 * 调用方写法：`if (!(await uiConfirm('确定删除…？'))) return;`（所在函数需 async）。
 * Esc / 点遮罩 / 「取消」→ false；「确定」→ true。
 */
function uiConfirm(message, { title = '⚠️ 确认', okText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let overlay = null;
    let watch = null;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      if (watch) clearInterval(watch);
      try { if (overlay && overlay.isConnected) closeModelModal(overlay); } catch { /* ignore */ }
      resolve(v);
    };
    try {
      overlay = modelModalShell({
        head: title,
        body: `<div class="app-alert-text">${esc(String(message ?? ''))}</div>`,
        foot: `<button class="btn" id="ui-confirm-cancel">${esc(cancelText)}</button>
               <button class="btn btn-danger" id="ui-confirm-ok">${esc(okText)}</button>`
      });
    } catch {
      // 基建不可用时退回原生 confirm（语义一致：true = 确定）
      try { resolve(!!nativeWindowConfirm.call(window, message)); } catch { resolve(false); }
      return;
    }
    overlay.querySelector('#ui-confirm-ok')?.addEventListener('click', () => settle(true));
    overlay.querySelector('#ui-confirm-cancel')?.addEventListener('click', () => settle(false));
    // Esc / 点遮罩由 modelModalShell 直接关弹窗（不经过本函数）——
    // 监视弹窗被移除兜底落成 false，保证 Promise 一定 settle，调用方不会挂死。
    watch = setInterval(() => { if (!overlay.isConnected) settle(false); }, 120);
    setTimeout(() => { try { overlay.querySelector('#ui-confirm-ok')?.focus(); } catch { /* ignore */ } }, 0);
  });
}

/**
 * 应用内输入弹窗（红色配色）：替代原生 prompt。返回 Promise<string|null>。
 * 调用方写法：`const v = await uiPrompt('输入…');`（null = 取消）。Esc / 遮罩 / 取消 → null。
 */
function uiPrompt(message, def = '') {
  return new Promise((resolve) => {
    let settled = false;
    let overlay = null;
    let watch = null;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      if (watch) clearInterval(watch);
      try { if (overlay && overlay.isConnected) closeModelModal(overlay); } catch { /* ignore */ }
      resolve(v);
    };
    try {
      overlay = modelModalShell({
        head: '⚠️ 输入',
        body: `<div class="app-alert-text">${esc(String(message ?? ''))}</div>
               <div class="field" style="margin-top:10px">
                 <input type="text" id="ui-prompt-input" value="${esc(String(def ?? ''))}" />
               </div>`,
        foot: `<button class="btn" id="ui-prompt-cancel">取消</button>
               <button class="btn btn-primary" id="ui-prompt-ok">确定</button>`
      });
    } catch {
      try { resolve(nativeWindowPrompt.call(window, message, def)); } catch { resolve(null); }
      return;
    }
    const input = overlay.querySelector('#ui-prompt-input');
    overlay.querySelector('#ui-prompt-ok')?.addEventListener('click', () => settle(String(input?.value ?? '')));
    overlay.querySelector('#ui-prompt-cancel')?.addEventListener('click', () => settle(null));
    watch = setInterval(() => { if (!overlay.isConnected) settle(null); }, 120);
    setTimeout(() => { try { input?.focus(); } catch { /* ignore */ } }, 0);
  });
}

(function patchNativeDialogs() {
  window.alert = (message) => { showAppAlert(message); };

  const refocus = (prev) => {
    try { window.qqAgentShell?.refocus?.(); } catch { /* ignore */ }
    try { window.focus(); } catch { /* ignore */ }
    try {
      const el = prev && prev.isConnected && typeof prev.focus === 'function' ? prev : null;
      if (el) el.focus();
    } catch { /* ignore */ }
    // 焦点激活在部分 Windows 环境是异步完成的，250ms 后补一次；
    // 若用户此刻已切到别的程序（hasFocus()=false），绝不抢焦点。
    setTimeout(() => {
      try {
        if (document.hasFocus?.() === false) return;
        window.qqAgentShell?.refocus?.();
      } catch { /* ignore */ }
    }, 250);
  };
  for (const name of ['confirm', 'prompt']) {
    const nativeFn = window[name];
    if (typeof nativeFn !== 'function') continue;
    window[name] = function (...args) {
      const prev = document.activeElement;
      let out;
      try { out = nativeFn.apply(this, args); }
      finally { refocus(prev); }
      return out;
    };
  }
})();

/* ══════════════════════════════════════════════════════════════
   显隐过渡动画（对齐 concept2 设计稿）
   ══════════════════════════════════════════════════════════════
   统一契约：出现 = 淡入 + 轻微上移（220ms）；消失 = 先淡出（150ms）再落实隐藏。
   由 Web Animations API 驱动；jsdom / 测试桩没有 el.animate 时自动退化为
   「立即显隐」——行为语义与测试口径完全不变。
   用法：uiShow(el, apply) / uiHide(el, apply) —— apply 负责落实调用方自己的
   显隐约定（hidden 类名或 style.display），动画只负责"过程"，不改任何终态语义。 */
const UI_IN_FRAMES = [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }];
const UI_OUT_FRAMES = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }];
const UI_EASE_IN = 'cubic-bezier(.25, 1, .5, 1)';
const UI_EASE_OUT = 'cubic-bezier(.4, 0, .2, 1)';

function uiCanAnimate(el) {
  if (!el || typeof el.animate !== 'function') return false;
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch { /* 老环境没有 matchMedia */ }
  return true;
}

function uiIsHidden(el) {
  return !el || el.style.display === 'none' || el.classList.contains('hidden');
}

function uiStopAnim(el) {
  try { el.__uiAnim?.cancel(); } catch { /* ignore */ }
  el.__uiAnim = null;
}

/** 显示：先落实可见（apply），再播入场。已可见时只落实状态、不重播（重渲染不闪）。 */
function uiShow(el, apply, animate = true) {
  if (!el) return;
  const wasHidden = uiIsHidden(el) || !!el.__uiHiding;
  el.__uiHideToken = null;
  el.__uiHiding = false;
  uiStopAnim(el);
  if (apply) apply(); else { el.classList.remove('hidden'); el.style.display = ''; }
  if (!(animate && wasHidden && uiCanAnimate(el))) return;
  try { el.__uiAnim = el.animate(UI_IN_FRAMES, { duration: 220, easing: UI_EASE_IN }); } catch { /* 动画失败不影响显隐 */ }
}

/** 隐藏：先播出场动画，动画落定才落实隐藏（apply）。 */
function uiHide(el, apply, animate = true) {
  if (!el) return;
  const commit = () => { if (apply) apply(); else el.style.display = 'none'; };
  if (el.__uiHiding) return;       // 已在淡出途中：不叠播
  if (uiIsHidden(el)) return;      // 已经隐藏：不重复
  if (!animate || !uiCanAnimate(el)) { commit(); return; }
  uiStopAnim(el);
  el.__uiHiding = true;
  const token = {};
  el.__uiHideToken = token;
  const done = () => {
    if (el.__uiHideToken !== token) return;   // 中途又被显示：作废本次隐藏
    el.__uiHideToken = null;
    el.__uiHiding = false;
    el.__uiAnim = null;
    commit();
  };
  try {
    el.__uiAnim = el.animate(UI_OUT_FRAMES, { duration: 150, easing: UI_EASE_OUT });
    el.__uiAnim.onfinish = done;
  } catch { done(); return; }
  setTimeout(done, 300);   // 兜底：onfinish 不来（动画被打断/元素移除）也要落隐藏
}

/** 入场动画（内容重绘后的新内容淡入；不涉及显隐状态语义）。 */
function uiEnter(el) {
  if (!uiCanAnimate(el)) return;
  try {
    el.__uiAnim?.cancel();
    el.__uiAnim = el.animate(UI_IN_FRAMES, { duration: 220, easing: UI_EASE_IN });
  } catch { /* ignore */ }
}

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条
const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）
const CHAT_MSG_PAGE = 80;    // 存档页：首次渲染行数（500 行 innerHTML 重建太卡）
const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

// ── 峰谷时段预设 ──────────────────────────────────────────────────────────
// 内置作息模板（一键填充时段+档位）+ 一份用户自定义（custom）。
// sliderPos 口径：0~100（10=仅艾特，100=全响应），与峰谷设置页输入框一致。
const PEAK_PRESETS = {
  workbuddy: { label: 'workbuddy（早8~晚11 高峰）',
    peak: { start: '08:00', end: '23:00', sliderPos: 10 }, valley: { sliderPos: 100 } },
  deepseek: { label: 'deepseek（早9~晚6 高峰）',
    peak: { start: '09:00', end: '18:00', sliderPos: 10 }, valley: { sliderPos: 100 } }
};

/** 预设下拉的选项列表：内置 2 个 + 自定义（有才显示）。 */
function peakPresetOptions(ps) {
  const out = Object.entries(PEAK_PRESETS).map(([k, v]) => [k, v.label]);
  const cu = ps?.custom;
  if (cu?.peak?.start) {
    out.push(['custom', `自定义（峰 ${cu.peak.start}~${cu.peak.end} @${cu.peak.sliderPos} / 其余时间 @${cu.valley?.sliderPos ?? 100}）`]);
  }
  return out;
}

/** 把预设套进当前表单（改 DOM 值，用户仍可继续微调后保存）。 */
function applyPeakPreset(key) {
  const p = PEAK_PRESETS[key] || state.config?.store?.peakSchedule?.custom;
  if (!p?.peak) return;
  // ⚠️ 设值后必须派发 input 事件：程序改 .value 不会触发监听，
  // 不派发的话时段字段的联动全停留在旧状态。
  const setVal = (sel, v) => {
    const el = $(sel);
    if (!el) return;
    el.value = v;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 旧环境无 Event 构造器时退化为只设值 */ }
  };
  setVal('#cfg-peak-start', p.peak.start);
  setVal('#cfg-peak-end', p.peak.end);
  // 档位点走自定义竖向滑条控制器（activeVSlider 在活跃设置弹窗打开时挂上）。
  // 高峰珠（档位低）与低谷珠（档位高）各就各位；applyValues 会触发一次
  // onChange 把值写进弹窗草稿 —— 刻度/区间带/说明文字随之刷新。
  const hi = Math.min(Number(p.peak.sliderPos) || 0, Number(p.valley?.sliderPos ?? 100) || 100);
  const lo = Math.max(Number(p.peak.sliderPos) || 0, Number(p.valley?.sliderPos ?? 100) || 100);
  activeVSlider?.applyValues(lo, hi);
  const hint = $('#peak-preset-hint');
  if (hint) hint.textContent = key === 'custom' ? '已套用「自定义」。可继续微调，保存后生效。' : `已套用「${PEAK_PRESETS[key].label}」。可继续微调，保存后生效。`;
}

/* ═══ 自定义竖向档位滑条（2026-09-19）═══
   从零实现的指针驱动滑条，**不用任何 <input type=range>** —— 原生 range 无法
   在同一条轨道上放两颗可独立抓取的珠子（两个 range 叠加只能点到最上面那个，
   这是本轮实测踩过的坑）。控制器协议：
     createVSlider({ mount, dual, low, high, onChange, onInput })
       mount    挂载点元素
       dual     true = 双珠（峰谷），false = 单珠
       low/high 初始值（0~100，恒满足 low >= high；单珠只用 low）
       onChange 值变化回调 ({ low, high, byUser })
       onInput  拖动中高频回调（同参，可选）
     .setValues(low, high)   外部装值（不触发 onChange）
     .applyValues(low, high) 外部装值并**触发一次** onChange（预设套用用）
     .setDual(bool)          切换单/双珠形态（不触发 onChange）
     .setDisabled(bool)      只读态（分群模式但白名单为空）
     .destroy()              摘监听（弹窗关闭时调用）
   可访问性：容器 role=slider + aria-valuenow/min/max + 方向键步进（上下 1、
   PgUp/PgDn 10、Home/End 到端点）；双珠时 Tab 在两颗珠间切换，各自响应键盘。 */
let activeVSlider = null;   // 活跃设置弹窗当前打开的控制器实例（applyPeakPreset 要用）

function createVSlider({ mount, dual = false, low = 100, high = 10, onChange = null, onInput = null } = {}) {
  if (!mount) return null;
  const el = typeof mount === 'string' ? $(mount) : mount;
  if (!el) return null;

  el.classList.add('vslider2');
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-orientation', 'vertical');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.setAttribute('tabindex', '0');

  // DOM：轨道（渐变）+ 可选区间带 + 两颗珠（低谷彩珠 / 高峰灰珠）
  el.innerHTML = `
    <div class="vs2-track"></div>
    <div class="vs2-band"></div>
    <div class="vs2-thumb vs2-low" tabindex="0" role="slider" aria-orientation="vertical"
      aria-label="低谷时段档位（活跃）" aria-valuemin="0" aria-valuemax="100"></div>
    <div class="vs2-thumb vs2-high" tabindex="0" role="slider" aria-orientation="vertical"
      aria-label="高峰时段档位（安静）" aria-valuemin="0" aria-valuemax="100"></div>`;
  const trackEl = el.querySelector('.vs2-track');
  const bandEl = el.querySelector('.vs2-band');
  const lowEl = el.querySelector('.vs2-low');
  const highEl = el.querySelector('.vs2-high');

  let lo = Math.min(100, Math.max(0, Number(low) || 0));
  let hi = Math.min(100, Math.max(0, Number(high) || 0));
  if (hi > lo) { const x = hi; hi = lo; lo = x; }
  let isDual = !!dual;
  let disabled = false;
  let dragging = null;         // 'low' | 'high' | null
  let destroyed = false;
  let sliderRendered = false;  // 首帧装填不播动画（弹窗刚打开时不该有珠子弹出）

  // ── 渲染 ──
  function render() {
    // 珠心锚在值的位置（CSS 里 margin-bottom:-12px 把 bottom 锚点折回珠心）
    lowEl.style.bottom = lo + '%';
    lowEl.setAttribute('aria-valuenow', String(Math.round(lo * 10) / 10));
    highEl.style.bottom = hi + '%';
    highEl.setAttribute('aria-valuenow', String(Math.round(hi * 10) / 10));
    el.setAttribute('aria-valuenow', String(Math.round(lo * 10) / 10));
    // 高峰珠随单/双珠形态显隐（点击切换时淡入淡出）；区间带跟拖动实时走，保持瞬时。
    if (isDual) uiShow(highEl, () => { highEl.style.display = ''; }, sliderRendered);
    else uiHide(highEl, () => { highEl.style.display = 'none'; }, sliderRendered);
    if (isDual && lo > hi) {
      bandEl.style.display = '';
      bandEl.style.bottom = hi + '%';
      bandEl.style.height = (lo - hi) + '%';
    } else {
      bandEl.style.display = 'none';
    }
    sliderRendered = true;
  }

  // ── 事件 ──
  function posFromEvent(e) {
    const rect = el.getBoundingClientRect();
    // bottom=0 在下（1 档端），100 在上（4 档端）：值 = (底部距离 / 高度) * 100
    const y = (e.touches?.[0] ?? e).clientY;
    const raw = ((rect.bottom - y) / rect.height) * 100;
    return Math.min(100, Math.max(0, raw));
  }

  function onDown(e) {
    if (disabled || destroyed) return;
    const pos = posFromEvent(e);
    // 抓取判定：离哪颗珠近抓哪颗；双珠重叠时优先低谷（彩珠在上层）
    const dLow = Math.abs(pos - lo);
    const dHigh = isDual ? Math.abs(pos - hi) : Infinity;
    dragging = dHigh < dLow ? 'high' : 'low';
    moveTo(dragging, pos, true);
    e.preventDefault();   // 阻止文本选中/触摸滚动
  }
  function onMove(e) {
    if (!dragging || disabled || destroyed) return;
    moveTo(dragging, posFromEvent(e), true);
    e.preventDefault();
  }
  function onUp() { dragging = null; }
  // 指针事件统一走 pointer 系列（鼠标+触摸+笔一套搞定），move/up 挂 window 才能拖出边界
  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  function moveTo(which, pos, byUser) {
    if (which === 'high') {
      hi = pos;
      if (hi > lo) hi = lo;          // 高峰珠不能越过低谷珠（上界）
    } else {
      lo = pos;
      // 约束只在双珠时有意义：单珠模式下隐藏的高峰珠是"幽灵下界"，
      // 会把低谷珠锁死在初始位置以下（表现为"全局档位拖不动"，2026-09-19 修）。
      if (isDual && lo < hi) lo = hi;
      if (!isDual) hi = Math.min(hi, lo);   // 维持 lo >= hi 不变量（切双珠时干净）
    }
    render();
    if (byUser) {
      onInput?.({ low: lo, high: hi, byUser: true });
      onChange?.({ low: lo, high: hi, byUser: true });
    }
  }

  // 键盘：每颗珠各自响应方向键（可访问性硬要求）
  function keyFor(target, e) {
    const which = target === highEl ? 'high' : 'low';
    const step = e.shiftKey ? 10 : 1;
    let pos = which === 'high' ? hi : lo;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': pos += step; break;
      case 'ArrowDown': case 'ArrowLeft': pos -= step; break;
      case 'PageUp': pos += 10; break;
      case 'PageDown': pos -= 10; break;
      case 'Home': pos = 0; break;
      case 'End': pos = 100; break;
      default: return false;
    }
    e.preventDefault();
    moveTo(which, Math.min(100, Math.max(0, pos)), true);
    return true;
  }
  lowEl.addEventListener('keydown', (e) => keyFor(lowEl, e));
  highEl.addEventListener('keydown', (e) => keyFor(highEl, e));

  return {
    get values() { return { low: lo, high: hi }; },
    setValues(lowV, highV) {
      let nLo = Math.min(100, Math.max(0, Number(lowV) || 0));
      let nHi = Math.min(100, Math.max(0, Number(highV ?? nLo) || 0));
      if (nHi > nLo) { const x = nHi; nHi = nLo; nLo = x; }
      lo = nLo; hi = nHi; render();
    },
    applyValues(lowV, highV) {
      this.setValues(lowV, highV);
      onChange?.({ low: lo, high: hi, byUser: false });
    },
    setDual(on) { isDual = !!on; render(); },
    setDisabled(on) {
      disabled = !!on;
      el.classList.toggle('vs2-disabled', disabled);
      lowEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      highEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    },
    focusLow() { try { lowEl.focus({ preventScroll: true }); } catch { /* ignore */ } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.innerHTML = '';
    }
  };
}

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  skills: [],            // 扩展条目状态列表（技能+插件，后端判定，含 kind 与不可用原因）
  skillsSummary: {},     // 后端全量摘要 { total, active, disabled, broken, capabilities }
                         // ⚠️ 两页的"生效 N/M"不读它，而是按本页条目现算 ——
                         // 否则技能页会把插件的数量也算进去，两个页签显示同一组数字。
  uninstalledSkills: [], // 配置里有 skills.<id> 段、但磁盘上已无此条目（删目录后的配置残留）
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  memoryView: 'events',
  currentMemoryChatKey: null,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {}, // chatKey -> { note, at, failed? }
  // 提示词预览缓存（GET /api/prompt-preview）：按当前启停状态组装的系统提示 + 可用工具。
  // 设置-工具页与技能页右侧共用；开关变动后 refreshPromptPreview() 拉新并原地替换 DOM。
  promptPreview: null
};

// ── 工具函数 ──
// 控制台标识头：证明请求来自本控制台页面，而非外部网页冒用浏览器。
// 带自定义头的请求必须过 CORS 预检，天然挡住跨站脚本/表单的静默读取。
/** 数字加千分位（token 计数用）。 */
const fmtTok = (n) => (Number(n) || 0).toLocaleString('zh-CN');

/**
 * 金额格式化（成本用）。
 * 成本经常是小额（几分钱），固定两位小数会全显示成 ¥0.00 看不出差别，
 * 所以小于 1 时多给两位有效数字。
 */
const fmtYuan = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
};

/**
 * 用量页当前选中的时间范围（对应 USAGE_RANGES 里的值）。
 * 用 let 而不是 const：点范围按钮会改它，改完要重新拉取数据。
 */
let usageRange = '7';

/*
 * 工具的中文名与分类，用于"调用明细"弹窗。
 *
 * 用 emoji 当图标只是为了扫一眼好认 —— 这类"没什么实际用处但有趣"的细节，
 * 是特意保留的：一张纯数字的表格很无聊，分类 + 图标能让人真的去看一眼。
 */
const TOOL_META = {
  // 发言类
  send_message:      { name: '发消息',     cat: '发言',   icon: '💬' },
  send_sticker:      { name: '发表情包',   cat: '发言',   icon: '🎴' },
  send_poke:         { name: '戳一戳',     cat: '发言',   icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail:  { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images:  { name: '看图片',     cat: '查看', icon: '🖼️' },
  get_active_members:  { name: '看活跃群友', cat: '查看', icon: '👥' },
  // 表情包
  list_stickers:     { name: '列表情库',   cat: '表情',   icon: '📚' },
  get_sticker_image: { name: '看表情图',   cat: '表情',   icon: '🖼️' },
  collect_sticker:   { name: '收藏表情',   cat: '表情',   icon: '⭐' },
  sticker_note:      { name: '备注表情',   cat: '表情',   icon: '📝' },
  // 记忆
  memory_append:     { name: '记一条',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查记忆',     cat: '记忆',   icon: '🧠' },
  memory_remove:     { name: '删记忆',     cat: '记忆',   icon: '🧹' },
  // 联网
  web_search:        { name: '联网搜索',   cat: '联网',   icon: '🌐' },
  web_fetch:         { name: '抓网页',     cat: '联网',   icon: '🔗' },
  // 其他
  report_feedback:   { name: '汇报反馈',   cat: '其他',   icon: '📣' },
  finish:            { name: '结束本次',   cat: '其他',   icon: '🏁' }
};

/** 分类的展示顺序（"其他"垫底） */
const TOOL_CAT_ORDER = ['发言', '查看', '表情', '记忆', '联网', '其他'];

/** 用量页的时间范围选项：[传给后端的值, 按钮文案] */
const USAGE_RANGES = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部']
];

const CONSOLE_MARKER = 'qq-agent-console';

/* ══════════════════════════════════════════════════════════════
   主题（明/暗）—— 「跟随系统」「？」已移除
   ══════════════════════════════════════════════════════════════ */
const THEME_ICON = { dark: '🌙', light: '☀️' };
const THEME_LABEL = { dark: '暗色', light: '亮色' };
const THEME_VALUES = ['dark', 'light'];

/** 读取当前主题设置（localStorage 优先，非法值回退暗色）。 */
function getThemePref() {
  try {
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'dark';
}

/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  return THEME_VALUES.includes(pref) ? pref : 'dark';
}

/** 应用主题到 <html>，并同步按钮图标。 */
function applyTheme(pref) {
  const actual = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', actual);
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = THEME_ICON[pref] || THEME_ICON.dark;
    btn.title = `主题：${THEME_LABEL[pref] || '暗色'}（点击切换）`;
  }
  try { localStorage.setItem('qqa-theme', pref); } catch { /* 忽略 */ }
}

/** 点击按钮：暗 ↔ 亮。 */
function cycleTheme() {
  const next = getThemePref() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}

async function api(path, options = {}) {
  // keepalive 由调用方按需传（配置保存的 POST 用它：页面卸载后请求仍能完成）
  const { keepalive, ...rest } = options;
  const res = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      'x-console-token': CONSOLE_MARKER,
      ...(rest.headers || {})
    },
    ...rest,
    ...(keepalive ? { keepalive: true } : {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { waiting: '等待中', done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady(startedAt) {
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus(status.onebot?.diagnosis || 'SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    // startedAt 由 bootLoop 传入：曾经在这里声明，每轮重置，
    // 45 秒超时判定永远为 false，"启动超时"提示从未出现过
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认项目内 snowluma 文件夹完整，或到设置页手动启动 SnowLuma。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  const startedAt = Date.now();
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady(startedAt)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
  if (state.tab === 'memory') loadMemoryView();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  // 拆成"接口地址"与"模型"两步：合并判断时新手分不清到底缺哪个。
  // 出厂 baseUrl 为空，第一条会直接指出该填什么。
  const urlOk = !!String(cfg.api.baseUrl || '').trim();
  checks.push({
    ok: urlOk,
    label: urlOk ? `接口地址：${cfg.api.baseUrl}` : '还没有填接口地址（Base URL，必填）：官方 API 或中转站提供的 OpenAI 兼容地址',
    fix: urlOk ? null : 'settings-api'
  });
  const modelOk = !!String(cfg.api.model || '').trim();
  checks.push({
    ok: modelOk,
    label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（填好地址和 Key 后会自动拉取勾选，或在模型管理里手动添加）',
    fix: modelOk ? null : 'settings-api'
  });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
    checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : (status?.onebot?.diagnosis || 'OneBot（SnowLuma）未连接 —— 请到 SnowLuma 页签启动'), fix: obOk ? null : 'snowluma-tab' });
  return { ready: urlOk && modelOk && allowOk && obOk, checks };
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  // 预算保险丝已移除：原先这里有一个 pauseReason === 'budget' 的分支
  if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot（SnowLuma）还没连上：请确认 SnowLuma 已启动，且设置里的 WS/HTTP 地址正确。';
  }
  if (show) {
    // 出现交给 .banner 自带的 pageIn；uiShow 只负责作废进行中的淡出并落实状态
    uiShow(banner, () => banner.classList.remove('hidden'), false);
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    // 注意：横幅里从来没有 #banner-goto-settings 这个元素（旧的死监听，已删）
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  } else {
    // 消失先淡出再收起（.banner.hidden 才落实），不再是瞬切
    uiHide(banner, () => banner.classList.add('hidden'));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

function switchTab(name) {
  // 离开设置页（无论去哪）前，先把防抖窗口内还没落盘的改动立即保存。
  // 必须在页签切换、任何 loadXxx 触发**之前**做：等切走之后表单 DOM 还在
  // （只是视图隐藏）其实也能读，但"正在输入的最后一个字段"可能只过了
  // 防抖窗口的一部分 —— 不 flush 的话这次改动要等 600ms 定时器到点，
  // 期间用户看到的其它页签数据（用量/状态）就是旧配置算出来的。
  if (state.tab === 'settings' && name !== 'settings') flushSettingsSaves();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const prevView = $('.view.active');
  $$('.view').forEach((v) => {
    const on = v.id === `view-${name}`;
    v.classList.toggle('active', on);
    if (on) {
      /* 页面视图本身保留原有 display 切换语义；只重启动画，避免新旧页签同时占位。 */
      v.classList.remove('leaving');   // 快速来回切时旧的淡出可能还没收尾
      v.style.animation = 'none';
      void v.offsetWidth;
      v.style.animation = '';
    }
  });
  // 交叉淡化（对齐 concept2）：旧视图 .leaving 与新视图同帧共存约 120ms，
  // 淡出落定后摘掉 .leaving（display 语义始终由 .active 唯一决定）。
  if (prevView && prevView.id !== `view-${name}` && uiCanAnimate(prevView)) {
    prevView.classList.add('leaving');
    const clear = () => prevView.classList.remove('leaving');
    prevView.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, 220);
  }
  state.tab = name;
  if (state.quoteMode && name !== 'chats') exitQuoteMode();   // 离开存档页自动退出金句勾选
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  // 群名补底：设置页（人设分群按钮/活跃设置分群下拉）用 chatNameOf 取名字，
  // 依赖 state.chats —— 若用户没先进过存档页这里是空的，会只显示群号。
  // 进设置页时悄悄拉一次（quiet，失败不报错），列表已在就跳过。
  if (name === 'settings' && !(state.chats || []).length) {
    api('/api/chats').then((d) => { state.chats = d.chats || []; }).catch(() => {});
  }
  if (name === 'memory') loadMemoryView();
  if (name === 'usage') loadUsageView({ force: true });
  if (name === 'skills') loadModulePage('skill');
  if (name === 'plugins') loadModulePage('plugin');
  if (name === 'snowluma') loadSnowlumaPage();
  if (name === 'settings') loadSettings();
}
