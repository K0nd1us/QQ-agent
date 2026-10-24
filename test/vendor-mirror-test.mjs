// vendor 镜像一致性锁（M10c，2026-09-19）。
//
// 背景：ui/vendor/ 下有两份"src/ 的浏览器镜像"（tier-slider、price-match）。
// 镜像存在的理由成立 —— app.js 是浏览器脚本，不该 import src/；
// 但"两边逻辑必须保持一致"一直只是注释里的一句话，没有任何机制保证。
// 历史上已经出现过后端修了、镜像忘了跟（或反之）的漂移窗口。
//
// 这个测试把"必须一致"变成硬约束：
//   1. tier-slider：两份文件除了头部注释必须逐字符一致；
//   2. price-match：镜像的匹配决策必须与后端 matchPriceTable 完全同结果
//      （镜像不返回 matched 字段是刻意的——前端不展示它；所以比较的是
//      "命中了哪一条 + 未命中"，而不是整个返回对象）。
//
// 注意 price-match 是"行为锁"而非"字节锁"：后端将来加 matched 之外的
// 修饰字段时，镜像不必跟着改；但匹配规则（精确 → 去前缀 → 最长前缀）
// 一旦分叉立即红。tier-slider 是纯函数集合且无修饰字段差异，直接锁字节。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. tier-slider：字节锁（剥掉头部注释、归一化行尾后必须一致）────────
// 头部注释解释的是"各自为什么存在"（后端讲循环依赖、前端讲镜像理由），
// 允许不同；行尾 CRLF/LF 是编辑器差异，不算漂移；代码体一个字符都不许差。
function stripHeaderComment(text) {
  // 剥掉整个头部注释区：从文件开头到第一个"代码行"（非 // 注释、非空行）为止。
  // 两边的头注释行数与措辞都不同（各自解释"我为什么存在"），只有代码体必须一致。
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//')) { i++; continue; }
    break;
  }
  return lines.slice(i).join('\n').trim();
}
check('tier-slider：ui/vendor 镜像与 src/ 代码体逐字符一致', () => {
  const backend = stripHeaderComment(read('src/tier-slider.js')).trim();
  const mirror = stripHeaderComment(read('ui/vendor/tier-slider.js')).trim();
  assert.equal(mirror, backend, '代码体不一致：改了 src/tier-slider.js 忘了同步 ui/vendor/tier-slider.js（或反之）');
});

// ── 2. price-match：行为锁（同输入同命中）──────────────────────────────
const { sliderToTier, tierToSlider, TIER_SLIDER_BANDS } = await import('../src/tier-slider.js');
const { matchPriceTable } = await import('../src/model-prices.js');
const mirrorMod = await import('../ui/vendor/price-match.js');
const mirrorMatch = mirrorMod.matchPriceTable;

check('price-match：镜像与后端在代表性输入上命中一致', () => {
  const table = [
    { id: 'deepseek-v4-flash', in: 1, out: 4 },
    { id: 'glm-5.3', in: 2, out: 8 },
    { id: 'glm-5.3-flash', in: 0.5, out: 2 },
    { id: 'gpt-5', in: 10, out: 40 },
    { id: 'gpt-5.6', in: 12, out: 48 }
  ];
  const cases = [
    'deepseek-v4-flash',          // 精确
    'z-ai/glm-5.3',               // 去前缀后精确
    'gpt-5.6-preview',            // 最长前缀 → gpt-5.6（不是 gpt-5）
    'gpt-5-turbo',                // 前缀 → gpt-5
    'gpt-5',                      // 边界：恰好等长于 gpt-5
    '',                           // 空
    '完全不存在的模型'              // 未命中
  ];
  for (const id of cases) {
    const be = matchPriceTable(id, table);
    const fe = mirrorMatch(id, table);
    // 后端带 matched 修饰字段；镜像没有。比较"命中哪条 + 核心字段"。
    const sameId = (be?.id ?? null) === (fe?.id ?? null);
    assert.ok(sameId, `输入 "${id}"：后端命中 ${be?.id ?? 'null'}，镜像命中 ${fe?.id ?? 'null'} —— 匹配规则已分叉`);
    if (be) {
      assert.equal(fe.in, be.in, `"${id}" 的 in 价不一致`);
      assert.equal(fe.out, be.out, `"${id}" 的 out 价不一致`);
    }
  }
});

check('tier-slider：换算往返（sliderToTier ∘ tierToSlider）自洽', () => {
  // 这条顺带锁语义：任何位置的换算 → 还原 → 再换算必须幂等。
  for (let pos = 0; pos <= 100; pos += 5) {
    const t = sliderToTier(pos);
    const back = tierToSlider(t.tier, t.randomPercent);
    const t2 = sliderToTier(back);
    assert.deepEqual(t2, t, `pos=${pos} 往返不自洽`);
  }
  assert.ok(TIER_SLIDER_BANDS.tier1End < TIER_SLIDER_BANDS.tier2End
    && TIER_SLIDER_BANDS.tier2End < TIER_SLIDER_BANDS.tier3End, '档位分界必须递增');
});

console.log(fail ? `\n镜像一致性锁：通过 ${pass} / 失败 ${fail}` : `\n镜像一致性锁：通过 ${pass} / 失败 0`);
process.exit(fail ? 1 : 0);
