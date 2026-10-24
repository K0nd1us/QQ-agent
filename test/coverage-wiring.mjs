// 覆盖测试 E：界面接线（真实 DOM）
//
// 用 jsdom 加载真实的 ui/index.html 并执行 ui/app.js，然后按**用户的真实操作路径**遍历：
//   - 8 个页签（点 .tab[data-tab]）：会话/存档/记忆/用量/技能/插件/SnowLuma/设置
//     （技能与插件是**两个独立页签**：同构的渲染逻辑、不同的类型过滤，都要走一遍）
//   - 8 个设置分区（点 .settings-menu-item[data-section]）
//   - 若干主要弹窗（点开后再扫）
// 对扫到的每一个交互元素（button/input/select/textarea/a），检查"它自己或任一祖先"
// 是否挂了该类型的事件监听 —— 即：这个控件点下去/改一下，到底有没有代码在管。
//
// 依赖 jsdom（可选）：未安装时打印说明并跳过。
//   npm i -D jsdom      # 启用本测试
//
// 运行：node test/coverage-wiring.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, bootApp, createChecker } from './_harness.mjs';

const c = createChecker('界面接线（真实 DOM）');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('\n⚠ 未安装 jsdom，跳过本套件。启用方式：npm i -D jsdom\n');
  c.ok('jsdom 未安装 —— 已跳过（安装后自动启用）');
  c.finish();
  process.exit(0);
}

const ctx = await bootApp({});
const { base } = ctx;

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
// M9 拆分：app.js 变成 ESM 桥 + 12 个普通脚本段。桥只做 import + window 赋值，
// 这里改为直接拼接 12 段后 window.eval（vendor 值已在下方注入 window，
// 与浏览器里桥文件的 window.* 赋值等价）。
let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;
code = code.replace(/^'use strict';\s*$/m, '');
// eval 环境跑不了 export 前缀（07 段的 renderSkillSettingsModal 有一个）——
// 剥掉后再执行（拆分前 app.js 同款处理）。
code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');

const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// 监听器追踪（必须在执行 app.js 之前安装）
const listeners = new Map();
const origAdd = window.EventTarget.prototype.addEventListener;
window.EventTarget.prototype.addEventListener = function (type, ...rest) {
  if (!listeners.has(this)) listeners.set(this, new Set());
  listeners.get(this).add(String(type));
  return origAdd.call(this, type, ...rest);
};

window.fetch = (input, init) => fetch(new URL(String(input), base).href, init);
window.EventSource = class { constructor() {} addEventListener() {} close() {} };
window.alert = () => {};
window.confirm = () => true;
// jsdom 的 window 上没有 structuredClone（真实浏览器有）。补个等价垫片，
// 否则依赖它的弹窗会以"structuredClone is not defined"失败 —— 那是测试环境问题。
if (typeof window.structuredClone !== 'function') {
  window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

const tier = await import(pathToFileURL(path.join(ROOT, 'src', 'tier-slider.js')).href);
const priceMod = await import(pathToFileURL(path.join(ROOT, 'ui', 'vendor', 'price-match.js')).href);
window.TIER_SLIDER_BANDS = tier.TIER_SLIDER_BANDS;
window.sliderToTier = tier.sliderToTier;
window.tierToSlider = tier.tierToSlider;
window.matchPriceTable = priceMod.matchPriceTable;

window.eval(code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

// ── 判定：元素自身或任一祖先有该类型监听 ──────────────────────────────────
function wantedTypes(tag, type) {
  if (tag === 'a') return ['click'];
  if (tag === 'select') return ['change', 'input', 'click'];
  if (type === 'checkbox' || type === 'radio' || type === 'file') return ['change', 'click', 'input'];
  if (tag === 'input' || tag === 'textarea') return ['input', 'change', 'keydown', 'keyup', 'focus', 'blur', 'click'];
  return ['click', 'submit', 'mousedown', 'keydown'];
}
function wired(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const want = wantedTypes(tag, type);
  let n = el;
  while (n && n.nodeType === 1) {
    const set = listeners.get(n);
    if (set) for (const t of want) if (set.has(t)) return true;
    n = n.parentElement;
  }
  return false;
}

/**
 * "批量读取式"控件：自身不挂监听，值在**提交按钮**被点时才被整体读走。
 * 典型例子是白名单选择器：`确定` 按钮里执行
 *   $$('input[type=checkbox]:checked', overlay).map(el => el.value)
 * 所以这些复选框没有自己的监听器是正常的，不算缺陷 —— 这里单独标记出来，
 * 与"真的没人管"区分开（后者才是 bug）。
 */
function batchRead(el) {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type !== 'checkbox' && type !== 'radio') return false;
  const box = el.closest('.model-modal, .modal');
  if (!box) return false;
  return [...box.querySelectorAll('button')].some((b) => wired(b));
}

const rows = [];
const seen = new WeakSet();
function scan(label) {
  let added = 0;
  for (const el of window.document.querySelectorAll('button, input, select, textarea, a[href]')) {
    if (seen.has(el)) continue;
    seen.add(el);
    added++;
    let hidden = false;
    try {
      const cs = window.getComputedStyle(el);
      hidden = cs.display === 'none' || cs.visibility === 'hidden';
      // 屏幕外锚点（left/top: -9999px）：视觉上永远不可见，是给 SDK 挂的隐藏元素
      // （如阿里云验证码的 #captcha-trigger），不属于"看得见但点了没反应"的缺陷。
      if (!hidden && /-999\d+px/.test(String(cs.left || '') + String(cs.top || ''))) hidden = true;
    } catch { /* ignore */ }
    const isWired = wired(el);
    const isBatch = !isWired && batchRead(el);
    rows.push({
      label,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      cls: String(el.className || '').slice(0, 36),
      text: (el.textContent || '').trim().slice(0, 16),
      hidden,
      batch: isBatch,
      ok: isWired || isBatch
    });
  }
  return added;
}

// 等待首屏渲染完成（有内容再继续）
for (let i = 0; i < 40; i++) {
  if (window.document.querySelectorAll('button, input, select, textarea, a[href]').length >= 10) break;
  await sleep(200);
}
const cov = {};
cov['首屏'] = scan('首屏');

// ── 1) 逐个页签（点真实按钮）────────────────────────────────────────────
// 注意：8 个 view 都是 index.html 里的静态节点，切页签不会新建元素
//（它们在首屏那轮就已全部扫到）。所以这里统计"访问过的页签数"，而不是新增元素数。
// ⚠️ 这份列表必须与 index.html 里的 .tab 保持一致 —— 漏掉一个页签，
// 那一页的按钮就永远不会被接线检查覆盖（skills/plugins 曾经就是这样被漏掉的）。
const visitedTabs = [];
for (const t of ['sessions', 'chats', 'memory', 'usage', 'skills', 'plugins', 'snowluma', 'settings']) {
  const tabBtn = window.document.querySelector(`.tab[data-tab="${t}"]`);
  if (tabBtn) tabBtn.click(); else { try { window.switchTab(t); } catch { /* ignore */ } }
  await sleep(800);
  visitedTabs.push(t);
  cov[`页签/${t}`] = scan(`页签/${t}`);
}

// 上面那份清单必须覆盖 index.html 声明的**全部**页签。
// 漏一个的后果很隐蔽：那一页永远不会被接线检查扫到 —— 页面上"看得见但点了没反应"
// 的控件就此长期潜伏（skills 页此前就是这样被漏掉的）。
await c.check('页签遍历覆盖了 index.html 声明的全部页签', () => {
  const declared = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  const missed = declared.filter((t) => !visitedTabs.includes(t));
  if (missed.length) {
    throw new Error(`这些页签没被遍历到（请同步本文件的页签清单）：${missed.join(', ')}`);
  }
  const extra = visitedTabs.filter((t) => !declared.includes(t));
  if (extra.length) {
    throw new Error(`遍历清单里有 index.html 未声明的页签：${extra.join(', ')}`);
  }
  return `${declared.length} 个页签全部覆盖`;
});

// ── 2) 设置页各分区（点侧栏菜单项）────────────────────────────────────────
const sections = [...window.document.querySelectorAll('.settings-menu-item[data-section]')].map((el) => el.dataset.section);
for (const sec of sections) {
  const item = window.document.querySelector(`.settings-menu-item[data-section="${sec}"]`);
  if (item) item.click(); else continue;
  await sleep(500);
  cov[`设置/${sec}`] = scan(`设置/${sec}`);
}

// ── 3) 主要弹窗：直接调用各自的打开函数（比找按钮可靠），逐个扫描 ────────
// 参数与"前置设置分区"按各函数签名/依赖给：有些函数会先读写本分区的元素
//（如 openWhitelistPicker 开头就写 #pick-result），分区不对就会抛 null。
const MODALS = [
  ['提示弹窗', 'showNoticeModal', ['测试标题', '测试正文'], null],
  ['调用明细', 'openToolBreakdown', [], null],
  ['用量下钻', 'openUsageBreakdown', ['model', 'm0'], null],
  ['人设选择器', 'openPersonaPicker', [], 'persona'],
  ['人设新建', 'openPersonaCreateModal', [], 'persona'],
  ['全局人设设置', 'openGlobalPersonaModal', [], 'persona'],
  ['模型选择器', 'openModelPicker', [], 'api'],
  ['记忆模型选择器', 'openMemoryModelPicker', [], 'memory'],
  ['模型添加', 'openModelAddModal', ['https://example.com/v1', 'k', ['m1', 'm2']], 'api'],
  ['模型配置', 'openModelConfigModal', [], 'api'],
  ['模型管理', 'openModelManageModal', [], 'api'],
  ['批量价格编辑', 'openBatchPriceModal', [], 'api'],
  ['屏蔽名单', 'openBlocklistModal', [], 'chat'],
  ['意见反馈', 'openFeedbackModal', [], null],
  ['群白名单选择', 'openWhitelistPicker', ['groups'], 'allow'],
  ['好友白名单选择', 'openWhitelistPicker', ['friends'], 'allow']
];
const modalReport = [];
for (const [name, fn, args, section] of MODALS) {
  for (const ov of [...window.document.querySelectorAll('.model-modal-overlay, .modal-overlay')]) { try { ov.remove(); } catch { /* ignore */ } }
  window.switchTab?.('settings');
  await sleep(250);
  if (section) {
    const item = window.document.querySelector(`.settings-menu-item[data-section="${section}"]`);
    if (item) item.click();
    await sleep(350);
  }
  let err = '';
  try {
    if (typeof window[fn] !== 'function') err = '函数不存在';
    else await window[fn](...args);
  } catch (e) { err = String(e?.message ?? e); }
  await sleep(700);
  const n = scan(`弹窗/${name}`);
  const opened = window.document.querySelectorAll('.model-modal-overlay, .modal-overlay').length > 0;
  cov[`弹窗/${name}`] = n;
  modalReport.push(`${name}: ${err ? '打不开(' + err.slice(0, 34) + ')' : (opened ? '已打开' : '未产生弹窗')} +${n}`);
}
for (const ov of [...window.document.querySelectorAll('.model-modal-overlay, .modal-overlay')]) { try { ov.remove(); } catch { /* ignore */ } }

// ── 汇总 ────────────────────────────────────────────────────────────────
const total = rows.length;
const broken = rows.filter((r) => !r.ok && !r.hidden);
const brokenHidden = rows.filter((r) => !r.ok && r.hidden);

await c.check('遍历全部页签/设置分区/弹窗后，没有"可见但没接线"的交互元素', () => {
  const batch = rows.filter((r) => r.batch);
  console.log(`      覆盖范围：${Object.entries(cov).filter(([, n]) => n > 0).length} 个场景，共 ${total} 个交互元素`);
  console.log(`      可见且未接线：${broken.length}；隐藏且未接线：${brokenHidden.length}；批量读取式（正常）：${batch.length}`);
  for (const b of broken) console.log(`        ✗ [${b.label}] <${b.tag}${b.type ? ' ' + b.type : ''}> id=${b.id || '-'} class="${b.cls}" 文本="${b.text}"`);
  for (const b of brokenHidden.slice(0, 10)) console.log(`        (隐藏) [${b.label}] <${b.tag}> id=${b.id || '-'} class="${b.cls}"`);
  if (broken.length) throw new Error(`${broken.length} 个可见交互元素没有任何事件监听`);
  return `元素 ${total} 个，全部有归属`;
});

await c.check('各主要弹窗能正常打开（不算缺陷：无数据时可能不产生内容）', () => {
  console.log('      弹窗打开情况：');
  for (const r of modalReport) console.log(`        ${r}`);
  const failed = modalReport.filter((r) => r.includes('打不开') || r.includes('函数不存在'));
  if (failed.length) throw new Error(`有 ${failed.length} 个弹窗打开失败：${failed.join('; ')}`);
  return `${modalReport.filter((r) => r.includes('已打开')).length}/${modalReport.length} 个弹窗成功打开`;
});

await c.check('扫描覆盖面足够（走完全部页签与设置分区）', () => {
  const secs = Object.keys(cov).filter((k) => k.startsWith('设置/')).length;
  const modals = Object.keys(cov).filter((k) => k.startsWith('弹窗/') && cov[k] > 0).length;
  if (visitedTabs.length < 6) throw new Error(`只访问了 ${visitedTabs.length} 个页签`);
  if (secs < 6) throw new Error(`只扫到 ${secs} 个设置分区`);
  return `页签 ${visitedTabs.length} / 设置分区 ${secs} / 弹窗 ${modals}，交互元素 ${total} 个`;
});

// ── 4) 回归：用量页「展开全部 / 收起」────────────────────────────────────
await c.check('用量页「展开全部/收起」按钮真的能开合（曾经完全没有绑定）', async () => {
  const models = Array.from({ length: 25 }, (_, i) => ({
    key: `m${i}`, vendor: '测试渠道', model: `model-${i}`, runs: 1,
    promptTokens: 100, completionTokens: 10, cachedTokens: 0, cacheHitRate: 0, cost: 0.001
  }));
  const stats = {
    mode: 'models',
    totals: { runs: 25, promptTokens: 2500, completionTokens: 250, cachedTokens: 0, cacheHitRate: 0, cost: 0.025 },
    days: [], chats: [], models
  };
  window.switchTab('usage');
  // 等页签自己的异步加载（/api/usage/stats 等）跑完，否则它会在我们手工渲染之后
  // 用真实（空）数据把表格覆盖掉 —— 那会让断言看到 0 行。1.5s 在机器负载高时
  // 可能不够（2026-09-26 两次偶发误报都是它），加一层"被盖掉就补渲染"的兜底。
  await sleep(1500);
  window.renderUsagePage(stats, {}, {});
  await sleep(150);

  let btn = window.document.querySelector('#models-expand');
  if (btn && btn.style.display === 'none') {
    // 异步加载晚于手工渲染落地、表格被盖回空数据 → 补渲染一次再断言
    window.renderUsagePage(stats, {}, {});
    await sleep(150);
    btn = window.document.querySelector('#models-expand');
  }
  if (!btn) throw new Error('找不到 #models-expand');
  const tb = window.document.querySelector('[data-table="models"] tbody');
  if (btn.style.display === 'none') throw new Error('模型 25 行时按钮应可见');

  const a = tb.querySelectorAll('tr[data-key]').length;
  if (a !== 20) throw new Error(`折叠态应 20 行，实际 ${a}`);
  btn.click();
  await sleep(120);
  const b = tb.querySelectorAll('tr[data-key]').length;
  if (b !== 25) throw new Error(`展开后应 25 行，实际 ${b}`);
  if (btn.textContent.trim() !== '收起') throw new Error(`展开后文案应为「收起」，实际「${btn.textContent.trim()}」`);
  btn.click();
  await sleep(120);
  const d = tb.querySelectorAll('tr[data-key]').length;
  if (d !== 20) throw new Error(`再点应收起回 20 行，实际 ${d}`);
  return `折叠 ${a} → 展开 ${b} → 收起 ${d}`;
});

await ctx.teardown();
try { window.close(); } catch { /* ignore */ }
try { dom.window.close(); } catch { /* ignore */ }
process.exit(c.finish() ? 0 : 1);
