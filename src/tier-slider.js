// 响应档位滑条的换算：滑条位置（0~100）↔ 档位 / 随机概率。
//
// 刻意做成**零依赖模块**：不 import config.js、prompt.js 等任何东西。
// 因为 config.js（保存配置时派生档位）和 prompt.js（运行时判定档位）
// 都需要它，而 prompt.js 又 import config.js —— 若把这个函数放进任一方
// 都会形成循环依赖（config → prompt → config）。
//
// 滑条分段（长度由用户指定）：
//
//   0 ──── 10 ──── 20 ───────────────── 90 ──── 100
//   │  1 档  │  2 档 │      3 档（70%）      │ 4 档 │
//   仅艾特    +关键词   概率线性增长 0→100%    全响应
//
// 3 档概率线性，公式 prob = (pos - 20) / 70 * 100
//   pos=20 → 0%   pos=55（该段正中）→ 50%   pos=90 → 100%

/** 滑条各段的分界位置 */
export const TIER_SLIDER_BANDS = {
  tier1End: 10,     // 0~10  → 1 档
  tier2End: 20,     // 10~20 → 2 档
  tier3End: 90      // 20~90 → 3 档；90~100 → 4 档
};

/**
 * 滑条位置 → { tier, randomPercent }
 * @param {number} pos 0~100，非法值或 NaN 按 100（4 档）处理
 */
export function sliderToTier(pos) {
  const b = TIER_SLIDER_BANDS;
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return { tier: 4, randomPercent: 100 };
  const p = Math.min(100, Math.max(0, raw));

  if (p <= b.tier1End) return { tier: 1, randomPercent: 0 };
  if (p <= b.tier2End) return { tier: 2, randomPercent: 0 };
  if (p <= b.tier3End) {
    const pct = ((p - b.tier2End) / (b.tier3End - b.tier2End)) * 100;
    return { tier: 3, randomPercent: Math.round(pct * 10) / 10 };
  }
  return { tier: 4, randomPercent: 100 };
}

/**
 * { tier, randomPercent } → 滑条位置（把已保存的配置还原成滑条位置）
 * @param {number} tier 1~4
 * @param {number} randomPercent 仅 tier===3 时有效（0~100）
 */
export function tierToSlider(tier, randomPercent = 0) {
  const b = TIER_SLIDER_BANDS;
  const t = Math.min(4, Math.max(1, Number(tier) || 4));
  const pct = Math.min(100, Math.max(0, Number(randomPercent) || 0));

  if (t === 1) return Math.round(b.tier1End / 2);                     // 该段中点
  if (t === 2) return Math.round((b.tier1End + b.tier2End) / 2);
  if (t === 3) return Math.round(b.tier2End + (pct / 100) * (b.tier3End - b.tier2End));
  return Math.round((b.tier3End + 100) / 2);
}
