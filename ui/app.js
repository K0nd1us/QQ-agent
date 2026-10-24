// QQ Agent 控制台前端入口（M9 拆分后的 ESM 桥）。
// 本文件只做一件事：把 /vendor/*.js 的 ES module 导出挂到 window 上，
// 供后续 12 个普通脚本（ui/app/00-11）按全局名直接引用。
//
// 为什么不直接把 12 段也做成 ES module：跨段共享的顶层 let/const（state、
// usageRange、activeVSlider、updateAvailable…）有 40+ 个绑定，做成 ESM 要给
// 每一段写 import/export 清单，拆分本身就会引入大量可写错的地方；
// 普通脚本 + defer 顺序执行的全局词法绑定与原单文件语义完全一致，
// 测试加载器（vm 共享 context）也沿用同一套语义。
//
// 执行顺序保证：module script（本文件）与带 defer 的普通 script 共享同一条
// "延迟执行队列"，按文档顺序执行 —— 所以本文件一定先于 00-core.js 运行。
import { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } from '/vendor/tier-slider.js';
import { matchPriceTable } from '/vendor/price-match.js';

window.TIER_SLIDER_BANDS = TIER_SLIDER_BANDS;
window.sliderToTier = sliderToTier;
window.tierToSlider = tierToSlider;
window.matchPriceTable = matchPriceTable;
