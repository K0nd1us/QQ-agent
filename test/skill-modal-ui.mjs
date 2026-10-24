import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 技能设置弹窗的**结构与排版层级**测试。
//
// 为什么单独测这个：这次改动的重点全在视觉上（两套字体样式、模态框尺寸），
// 而视觉改动最容易"悄悄退化" —— 比如有人顺手把名字改回普通 div，
// 功能测试全绿，但文案层级没了。所以把结构断言固化下来。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'ui', 'style.css'), 'utf8');
// M9 拆分：改为按 defer 顺序拼接 ui/app/00-11 全部段（vendor 绑定走 sandbox 注入）。
let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

// 桥文件的 vendor 绑定（测试侧注入同名全局，等价于浏览器里的 window.*）
const importedNames = ['TIER_SLIDER_BANDS', 'sliderToTier', 'tierToSlider', 'matchPriceTable'];

function makeEl() {
  const el = {
    innerHTML: '', className: '', textContent: '', style: {}, dataset: {},
    children: [], _q: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, remove() {},
    appendChild(c) { el.children.push(c); return c; },
    querySelector(sel) { el._q[sel] ||= makeEl(); return el._q[sel]; },
    querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, focus() {}, click() {},
    scrollIntoView() {}, insertBefore() {}, closest: () => null
  };
  return el;
}
const document = {
  documentElement: makeEl(), body: makeEl(), head: makeEl(),
  querySelector: () => makeEl(), querySelectorAll: () => [],
  getElementById: () => makeEl(), createElement: () => makeEl(),
  addEventListener() {}, removeEventListener() {}
};

const sandbox = {
  document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1/', protocol: 'http:', host: '127.0.0.1' },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  alert: () => {}, confirm: () => true, prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  URL, Blob: function () {}, FileReader: function () {},
  Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x))
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } = await import('../src/tier-slider.js');
const { matchPriceTable } = await import('../src/model-prices.js');
Object.assign(sandbox, { TIER_SLIDER_BANDS, sliderToTier, tierToSlider, matchPriceTable });
for (const n of importedNames) if (!(n in sandbox)) sandbox[n] = undefined;

// app.js 是 ES module，vm 跑不了 import —— 把 export 去掉后当普通脚本执行
code = code.replace(/^export\s+(function|const|async function)/gm, '$1');
const ctx = vm.createContext(sandbox);
vm.runInContext(code, ctx, { filename: 'ui/app.js' });

const render = sandbox.renderSkillSettingsModal;
check(typeof render === 'function', 'renderSkillSettingsModal 可被调用（纯函数）');

const demo = {
  id: 'demo-skill',
  name: '示例技能',
  version: '2.1.0',
  description: '这是一段技能介绍，用来验证名字与介绍确实用了两套不同的字体样式。',
  configSchema: {
    flagOn: { type: 'boolean', label: '开关项', description: '一个布尔设置' },
    numVal: { type: 'number', label: '数值项', description: '一个数字设置' },
    modePick: { type: 'enum', label: '枚举项', values: ['a', 'b'], description: '一个枚举设置' },
    longText: { type: 'string', label: '长文本项', description: '这条描述故意写得比较长，用来触发 field--wide 让它占满整行，避免在窄列里换行碎成一条不好读。' },
    secretThing: { type: 'string', label: '密钥项', secret: true, description: '密文字段' },
    managed: { type: 'internal', label: '列表项', description: '由专用界面管理' }
  },
  settings: { flagOn: true, numVal: 7, modePick: 'b', longText: '内容', secretThing: '******', managed: [] }
};

const built = render(demo);
check(built && typeof built.html === 'string', '返回 HTML 字符串');

const html = built.html || '';

// ── 1) 名字与介绍必须是两个不同的类（两套字体样式）──
check(html.includes('skill-modal__name'), '名字用 .skill-modal__name');
check(html.includes('skill-modal__desc'), '介绍用 .skill-modal__desc');
check(html.includes('skill-modal__id'), '机器名（目录名）单独一行用 .skill-modal__id');

// ── 2) 两套样式的 CSS 在字族/字号/字重/颜色/行高上确实不同 ──
const cssBlock = (cls) => {
  const i = CSS.indexOf('.' + cls + ' {');
  if (i < 0) return '';
  const j = CSS.indexOf('}', i);
  return CSS.slice(i, j);
};
const nameCss = cssBlock('skill-modal__name');
const descCss = cssBlock('skill-modal__desc');
check(nameCss && descCss, '两套样式的 CSS 规则都存在');
const grab = (css, prop) => (new RegExp(prop + ':\\s*([^;]+)').exec(css) || [, ''])[1].trim();
check(grab(nameCss, 'font-family').includes('var(--mono)'),
  `名字用等宽字体（实际：${grab(nameCss, 'font-family')}）`);
check(!grab(descCss, 'font-family').includes('var(--mono)'),
  `介绍用正文字体（实际：${grab(descCss, 'font-family')}）`);
check(grab(nameCss, 'font-size') !== grab(descCss, 'font-size'),
  `字号不同（名字 ${grab(nameCss, 'font-size')} / 介绍 ${grab(descCss, 'font-size')}）`);
check(grab(nameCss, 'font-weight') !== grab(descCss, 'font-weight'),
  `字重不同（${grab(nameCss, 'font-weight')} / ${grab(descCss, 'font-weight')}）`);
check(grab(nameCss, 'color') !== grab(descCss, 'color'),
  `颜色不同（${grab(nameCss, 'color')} / ${grab(descCss, 'color')}）`);
check(grab(nameCss, 'line-height') !== grab(descCss, 'line-height'),
  `行高不同（${grab(nameCss, 'line-height')} / ${grab(descCss, 'line-height')}）`);

// ── 3) 模态框要够大，且不再是固定 480px 的小对话框 ──
const modalCss = cssBlock('skill-modal');
check(/width:\s*min\(\s*9\d\dpx/.test(modalCss), `模态框宽度用 min(9xx px, vw)（实际：${grab(modalCss, 'width')}）`);
check(/vh/.test(grab(modalCss, 'max-height')), `高度用视口单位（实际：${grab(modalCss, 'max-height')}）`);
check(grab(modalCss, 'padding') === '0',
  '模态框自身 padding 为 0（头/身/脚各自管内边距，滚动区才能贴边）');
check(html.includes('skill-modal__head') && html.includes('skill-modal__body') && html.includes('skill-modal__foot'),
  '弹窗分成 head / body / foot 三段（可滚动区在中间）');

// ── 4) 表单用网格，长文本占整行 ──
check(html.includes('class="skill-form"'), '字段容器用 .skill-form 网格');
check(html.includes('field--wide'), '长文本字段带 field--wide（占满整行，避免窄列里换行碎掉）');
const gridCss = cssBlock('skill-form');
check(/grid-template-columns/.test(gridCss), '表单用 grid 布局（多字段不再挤成一长条）');

// ── 5) 各类型都渲染出正确控件 ──
check(/type="checkbox"/.test(html) && html.includes('skill-toggle-row'), 'boolean → 整行可点的复选框');
check(/type="number"/.test(html), 'number → 数字输入');
check(html.includes('<select'), 'enum → 下拉（值写错会让技能行为异常，下拉从根上避免手抖）');
check(/type="password"/.test(html), 'secret → 密码框');
check(!html.includes('value="******"'), 'secret 字段不回填脱敏值（否则一保存就把密钥覆盖成星号）');

// ── 6) internal 字段不进表单，但要在弹窗里说明去哪改 ──
check(html.includes('skill-modal__internal'), 'internal 字段有独立区块');
check(!/data-key="managed"/.test(html), 'internal 字段不渲染成表单输入');
check(html.includes('由专用界面管理'), 'internal 字段写明了去哪改（而不是让它悄悄消失）');

// ── 7) 有键盘出口（弹窗变大后鼠标要移很远）──
check(html.includes('id="skset-x"'), '有关闭按钮');
check(html.includes('role="dialog"') && html.includes('aria-modal'), '有对话框无障碍属性');

// ── 8) 卡片也用同一套两字体层级 ──
check(CSS.includes('.skill-card__name') && CSS.includes('.skill-card__desc'), '卡片的名字/介绍也是两个类');
const cardNameCss = cssBlock('skill-card__name');
const cardDescCss = cssBlock('skill-card__desc');
check(grab(cardNameCss, 'font-family').includes('var(--mono)') && !grab(cardDescCss, 'font-family').includes('var(--mono)'),
  '卡片同样：名字等宽、介绍正文');
check(grab(cardNameCss, 'font-weight') !== grab(cardDescCss, 'font-weight'), '卡片名字与介绍字重不同');

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
