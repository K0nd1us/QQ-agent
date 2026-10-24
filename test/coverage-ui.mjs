// 覆盖测试 D：静态界面层
//
// 覆盖：
//   - 样式表结构（主题块不重复、无冲突重复选择器、无死样式、括号平衡）
//   - HTML 本地资源引用全部存在
//   - 主题机制统一（data-theme + qqa-theme）
//   - ui/vendor 下的镜像文件与 src/ 逻辑一致
//   - app.js 引用的 DOM id 都能在某处被创建
//   - 弹窗可访问性（role/aria/Esc 关闭）
//
// 运行：node test/coverage-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, createChecker } from './_harness.mjs';

const c = createChecker('静态界面层覆盖');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const css = read('ui/style.css');
const html = read('ui/index.html');
const landing = read('ui/landing.html');
// M9 拆分：静态扫描面向全部 12 段拼接后的完整代码（与浏览器实际执行的集合一致）
const appJs = (await import('./_ui-load.mjs')).loadUiAppCode().code;

// ── 1. 样式表结构 ────────────────────────────────────────────────────────
c.section('1. 样式表结构');

/** 简易顶层规则解析（与审查脚本一致） */
function parseRules(src) {
  const lines = src.split('\n');
  const rules = [];
  let depth = 0, buf = '', sel = '', start = 0, inComment = false;
  for (let ln = 0; ln < lines.length; ln++) {
    let s = lines[ln].replace(/\/\*.*?\*\//g, '');
    if (inComment) { const e = s.indexOf('*/'); if (e >= 0) { inComment = false; s = s.slice(e + 2); } else continue; }
    const cs = s.indexOf('/*');
    if (cs >= 0) { const ce = s.indexOf('*/', cs); if (ce < 0) { inComment = true; s = s.slice(0, cs); } }
    for (const ch of s) {
      if (ch === '{') { if (depth === 0) { sel = buf.trim(); start = ln + 1; } depth++; buf += ch; }
      else if (ch === '}') { depth--; buf += ch; if (depth === 0) { rules.push({ sel, start, body: buf }); buf = ''; } }
      else buf += ch;
    }
    if (depth === 0) buf = '';
  }
  return rules;
}

await c.check('CSS 大括号平衡', () => {
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  assert.equal(open, close, `{ ${open} vs } ${close}`);
});

const rules = parseRules(css);

await c.check('「？」主题（已移除的彩蛋主题）基础 token 块不得残留', () => {
  // 2026-09 concept2 收敛版把「？」主题整体移除（:root + dark/light 两个 data-theme 块）。
  // 原断言要求该块"恰好出现 1 次"，但主题已删，现改为不得出现。
  const tokenBlocks = rules.filter((r) => /^\s*\[data-theme='\?'\]\s*$/.test(r.sel));
  assert.equal(tokenBlocks.length, 0, `? 主题基础 token 块应已移除，但仍出现 ${tokenBlocks.length} 次：行 ${tokenBlocks.map((r) => r.start).join(', ')}`);
  const banners = (css.match(/「？」主题 v3/g) || []).length;
  assert.equal(banners, 0, `「？」主题 v3 的注释横幅应已移除，但仍出现 ${banners} 次`);
});

await c.check('没有任何选择器被重复定义且属性值冲突', () => {
  const bySel = new Map();
  for (const r of rules) {
    const key = r.sel.replace(/\s+/g, ' ').trim();
    if (!key || key.startsWith('@')) continue;
    if (!bySel.has(key)) bySel.set(key, []);
    bySel.get(key).push(r);
  }
  const conflicts = [];
  for (const [sel, list] of bySel) {
    if (list.length < 2) continue;
    const props = new Map();
    for (const r of list) {
      const inner = r.body.slice(r.body.indexOf('{') + 1, r.body.lastIndexOf('}'));
      for (const decl of inner.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const p = decl.slice(0, i).trim();
        const v = decl.slice(i + 1).trim();
        if (!p || !v) continue;
        if (!props.has(p)) props.set(p, new Set());
        props.get(p).add(v);
      }
    }
    for (const [p, vals] of props) {
      if (vals.size > 1) conflicts.push(`${sel} { ${p}: ${[...vals].join(' VS ')} }`);
    }
  }
  assert.equal(conflicts.length, 0, `存在 ${conflicts.length} 处冲突：\n  ${conflicts.join('\n  ')}`);
});

await c.check('已删除的「保存栏」相关样式不得残留（组件已改为即时保存）', () => {
  for (const dead of ['.save-bar', '.unsaved-dot', '.saved-pulse', '.saved-flash', '#cfg-save-result', '@keyframes pulseRing', '@keyframes savedFlash']) {
    assert.ok(!css.includes(dead), `样式表里仍残留 ${dead}`);
  }
});

await c.check('引用 @keyframes 动画名都必须有定义（避免写了动画却不生效）', () => {
  const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of css.matchAll(/animation(?:-name)?:\s*([^;}]+)/g)) {
    for (const part of m[1].split(',')) {
      for (const tok of part.trim().split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(tok) && !/^(none|infinite|linear|ease|ease-in|ease-out|ease-in-out|forwards|backwards|both|alternate|reverse|running|paused|steps|var)$/.test(tok)) {
          used.add(tok);
        }
      }
    }
  }
  const missing = [...used].filter((k) => !defined.has(k) && !k.startsWith('--'));
  assert.equal(missing.length, 0, `使用了未定义的动画名：${missing.join(', ')}`);
});

await c.check('主题 token 齐备：两个主题都定义了颜色/阴影/前景色变量', () => {
  for (const v of ['--layer-0', '--text', '--muted', '--accent', '--green', '--red', '--orange',
    '--lift-sm', '--lift', '--lift-lg', '--paper-edge', '--depth', '--bevel', '--on-accent', '--overlay']) {
    const hits = (css.match(new RegExp(`\\${v}:`, 'g')) || []).length;
    assert.ok(hits >= 2, `${v} 只出现了 ${hits} 次（至少应在暗/亮两个主题各定义一次）`);
  }
});

// ── 2. HTML 资源引用 ─────────────────────────────────────────────────────
c.section('2. HTML 资源引用与主题机制');

function localRefs(src) {
  const out = [];
  // 只检查"子资源"（script/link/img 的 src/href）。
  // <a href> 是站内导航（落地页部署在官网时 /qq-agent/... 是有效的），不算本地资源；
  // 安装包下载链接另有专门断言。
  for (const m of src.matchAll(/<script[^>]*?src="([^"]+)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/<link[^>]*?href="([^"]+)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/<img[^>]*?src="([^"]+)"/g)) out.push(m[1]);
  return out.filter((u) => !/^(https?:|mailto:|#|data:)/.test(u));
}

await c.check('index.html 的本地资源引用全部存在', () => {
  for (const u of localRefs(html)) {
    const p = path.join(ROOT, 'ui', u.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), `index.html 引用了不存在的资源：${u}`);
  }
});

await c.check('landing.html 的本地资源引用全部存在（曾经引用过不存在的 /assets/theme.*）', () => {
  // ⚠️ landing.html 是**部署到官网**的落地页：/assets/theme.* 是站点级主题包，
  // 存在于服务器上而不在本仓库 ui/ 下（本地直开由 .no-theme 兜底，见页面注释）。
  // 站级资源只校验路径前缀；与页面同目录的相对文件（如群二维码）必须本地存在。
  for (const u of localRefs(landing)) {
    if (/^\/(assets|vendor)\//.test(u)) continue;   // 站级资源，服务器侧存在
    // 群二维码图片：随 ui/ 一起分发（设置页彩蛋与 landing 都引用它）。
    if (u === 'group-qrcode.jpg') {
      const p = path.join(ROOT, 'ui', u);
      assert.ok(fs.existsSync(p), `landing.html 引用的群二维码不存在：${u}`);
      continue;
    }
    if (u.startsWith('/')) {
      assert.fail(`landing.html 不应引用其它本地根路径资源：${u}`);
    } else {
      const p = path.join(ROOT, 'ui', u);
      assert.ok(fs.existsSync(p), `landing.html 引用了不存在的同目录资源：${u}`);
    }
  }
});

await c.check('两个页面的主题机制统一：data-theme + qqa-theme', () => {
  // landing.html 跟随**主站**的主题约定（localStorage 'theme' 键 + html.light/dark），
  // 与控制台（qqa-theme 键）是两套刻意的口径 —— 只对 index.html 校验控制台约定。
  for (const [name, src] of [['index.html', html]]) {
    assert.ok(/qqa-theme/.test(src), `${name} 未使用 qqa-theme 键`);
    assert.ok(/data-theme/.test(src), `${name} 未使用 data-theme 属性`);
    assert.ok(!/localStorage\.getItem\('theme'\)/.test(src), `${name} 仍在读旧的 'theme' 键`);
    assert.ok(!/html\.dark\s*\{/.test(src), `${name} 仍在使用 html.dark 选择器（永远不会命中）`);
  }
});

// ── 2.1 页签与视图容器必须成对 ───────────────────────────────────────────
//
// 加页签时最容易漏掉的第二步：只在 nav 里加了按钮，忘了加 <section id="view-xxx">。
// 后果是点上去"什么也不发生"（switchTab 把视图全隐藏了，但没有一个匹配），
// 而且不报错 —— 正是最该由静态检查兜住的一类。

c.section('2.1 页签 ↔ 视图容器');

await c.check('每个页签都有对应的 view-<name> 容器', () => {
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 5, `页签数量异常（${tabs.length}）：${tabs.join(', ')}`);
  const missing = tabs.filter((t) => !html.includes(`id="view-${t}"`));
  assert.equal(missing.length, 0,
    `这些页签没有对应的视图容器（点上去会没有任何反应）：${missing.join(', ')}`);
});

await c.check('「插件」页签存在，且紧挨着「技能」右边', () => {
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  const i = tabs.indexOf('skills');
  assert.ok(i >= 0, '找不到「技能」页签');
  assert.ok(tabs.includes('plugins'), '找不到「插件」页签');
  assert.equal(tabs[i + 1], 'plugins',
    `「插件」应当紧跟在「技能」右边，实际顺序：${tabs.join(' → ')}`);
  // 两个视图容器也都得在
  for (const id of ['view-skills', 'view-plugins']) {
    assert.ok(html.includes(`id="${id}"`), `缺少视图容器 ${id}`);
  }
});

await c.check('切换页签会加载对应页（switchTab 里两个分支都在）', () => {
  // 只加按钮不加分支 = 点进去是空白页（容器存在但没有渲染逻辑）
  assert.ok(/name === 'skills'\)\s*loadModulePage\('skill'\)/.test(appJs),
    "switchTab 里没有 skills 分支");
  assert.ok(/name === 'plugins'\)\s*loadModulePage\('plugin'\)/.test(appJs),
    "switchTab 里没有 plugins 分支");
});

await c.check('技能页与插件页按 kind 隔离（不会把插件渲染进技能页）', () => {
  // 两页共用 renderModulePage，靠 kind 过滤。过滤条件一旦写错，
  // 两页会显示一样的内容 —— 静态上先盯住"过滤用的是 kind、不是 source"。
  const m = /function renderModulePage\(kind\)[\s\S]*?\n  const items = (.+?);/.exec(appJs);
  assert.ok(m, '找不到 renderModulePage 里的条目过滤');
  assert.ok(/s\.kind === meta\.kind/.test(m[1]),
    `条目过滤没有按 kind 判型：${m[1]}`);
});

await c.check('landing.html 的下载链接带版本号（官网同目录部署，相对路径即可）', () => {
  // 2026-09-07 起下载链接刻意改为"带版本号的相对路径"（commit e359c29）：
  // 安装包与落地页同目录部署在官网，相对路径在部署环境有效；
  // "必须绝对地址"的旧断言是按本地服务口径写的，与部署事实相反。
  const m = /href="([^"]*qq-agent-v[\d.]+-setup\.exe)"/.exec(landing);
  assert.ok(m, '找不到安装包下载链接');
  assert.ok(/^[\w.-]+\.exe$/.test(m[1]), `应为同目录相对文件名（带版本号），实际：${m[1]}`);
});

// ── 3. vendor 镜像一致性 ─────────────────────────────────────────────────
c.section('3. vendor 镜像一致性');

await c.check('ui/vendor/tier-slider.js 与 src/tier-slider.js 的逻辑一致（去掉注释后逐字相同）', () => {
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const a = strip(read('src/tier-slider.js'));
  const b = strip(read('ui/vendor/tier-slider.js'));
  assert.equal(a, b, '两份 tier-slider 已经漂移：前端实际用的是 ui/vendor 那份，后端用 src/ 那份');
});

await c.check('ui/vendor/price-match.js 与 src/model-prices.js 的 matchPriceTable 对同一输入结果一致', async () => {
  const { matchPriceTable: backend } = await import('../src/model-prices.js');
  const { matchPriceTable: frontend } = await import('../ui/vendor/price-match.js');
  const { listOfficialPrices } = await import('../src/model-prices.js');
  const table = listOfficialPrices();
  for (const id of table.slice(0, 12).map((x) => x.id)) {
    const a = backend(id, table);
    const b = frontend(id, table);
    assert.ok(Boolean(a) === Boolean(b), `模型 ${id} 命中结果不一致：后端=${Boolean(a)} 前端=${Boolean(b)}`);
  }
});

// ── 4. DOM id 交叉检查 ───────────────────────────────────────────────────
c.section('4. DOM id 交叉检查');

await c.check('app.js 里 $(\'#id\') / getElementById 引用的 id 都能被创建', () => {
  const declared = new Set();
  // index.html 里静态声明的
  for (const m of html.matchAll(/\bid="([\w-]+)"/g)) declared.add(m[1]);
  // app.js 模板字符串里创建的字面量 id
  for (const m of appJs.matchAll(/\bid="([\w-]+)"/g)) declared.add(m[1]);
  // app.js 里用 JS 赋值的 id（如 vhs.id = 'chaos-vhs'）
  for (const m of appJs.matchAll(/\.id\s*=\s*'([\w-]+)'/g)) declared.add(m[1]);
  // 动态拼接的 id（id="${...}"）无法静态判断，忽略
  // 运行时动态拼接的选择器（'#' + fieldId）：按已知动态名单豁免
  const DYNAMIC_IDS = new Set([
    // switchHtml(id, …) 生成 id="${id}" 的开关；静态扫描看不到模板内部，按字面量调用豁免
    'cfg-useofficialprice', 'cfg-tools-enabled', 'cfg-imagesend',
    'cfg-persona-unified', 'cfg-autostart', 'cfg-closetray', 'cfg-showvision',
    'cfg-proactive', 'cfg-sticker', 'cfg-websearch', 'cfg-allowallwhenempty',
    'cfg-mem-consolidate', 'cfg-mem-usechat'
  ]);
  const refs = new Set();
  for (const m of appJs.matchAll(/\$\('#([\w-]+)'\)/g)) refs.add(m[1]);
  for (const m of appJs.matchAll(/getElementById\('([\w-]+)'\)/g)) refs.add(m[1]);
  const missing = [...refs].filter((id) => !declared.has(id) && !DYNAMIC_IDS.has(id));
  assert.equal(missing.length, 0, `这些 id 被引用但从未创建：${missing.join(', ')}`);
});

// ── 5. 可访问性 ──────────────────────────────────────────────────────────
c.section('5. 可访问性');

await c.check('弹窗外壳带 role="dialog" / aria-modal，且集成 Esc 关闭与焦点管理', () => {
  const m = /function modelModalShell\([\s\S]*?\n\}/.exec(appJs);
  assert.ok(m, '找不到 modelModalShell');
  const body = m[0];
  assert.ok(/role="dialog"/.test(body), '弹窗缺少 role="dialog"');
  assert.ok(/aria-modal="true"/.test(body), '弹窗缺少 aria-modal');
  assert.ok(/aria-label="关闭"/.test(body), '关闭按钮缺少 aria-label');
  assert.ok(/Escape/.test(body), '弹窗未处理 Esc 关闭');
  assert.ok(/focus\(/.test(body), '弹窗未做焦点管理');
});

await c.check('所有「×」图标按钮都有 aria-label', () => {
  const missing = [];
  for (const m of appJs.matchAll(/<button[^>]*>[×✕✖]<\/button>/g)) {
    if (!/aria-label=/.test(m[0])) missing.push(m[0]);
  }
  for (const m of html.matchAll(/<button[^>]*>[×✕✖]<\/button>/g)) {
    if (!/aria-label=/.test(m[0])) missing.push(m[0]);
  }
  assert.equal(missing.length, 0, `缺少 aria-label 的关闭按钮：\n  ${missing.join('\n  ')}`);
});

await c.check('index.html 里的纯图标按钮都有 aria-label 或可见文字', () => {
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const text = m[2].replace(/<[^>]*>/g, '').trim();
    if (text) continue;                      // 有可见文字
    assert.ok(/aria-label=/.test(attrs), `图标按钮缺少 aria-label：<button${attrs}>`);
  }
});

await c.check('主题切换按钮有 aria-label（键盘/读屏可用）', () => {
  assert.ok(/id="theme-btn"[^>]*aria-label=/.test(html), '#theme-btn 缺少 aria-label');
});

c.finish();
