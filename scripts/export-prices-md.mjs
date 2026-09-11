// 把内置价格表导出成 Markdown 文档（docs/model-prices.md）。
// 分组依据 = src/model-prices.js 里的 `// ══ 厂商 ══` 注释段（保持文件内的人工分组顺序）。
// 用法：node scripts/export-prices-md.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_PRICES } from '../src/model-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'model-prices.js');
const outPath = path.join(__dirname, '..', 'docs', 'model-prices.md');

// ── 解析源码里的分组注释，得到每个模型 id 归属的厂商名 ──
const src = fs.readFileSync(srcPath, 'utf8');
const groups = [];            // [{ name, ids: [] }]
let current = { name: '未分组', ids: [] };
for (const line of src.split(/\r?\n/)) {
  const g = line.match(/\/\/\s*══\s*(.+?)\s*══/);
  if (g) {
    if (current.ids.length) groups.push(current);
    current = { name: g[1].trim(), ids: [] };
    continue;
  }
  const k = line.match(/^\s*'([^']+)':\s*\{/);
  if (k && OFFICIAL_PRICES[k[1]]) current.ids.push(k[1]);
}
if (current.ids.length) groups.push(current);

const placed = new Set(groups.flatMap((g) => g.ids));
const orphans = Object.keys(OFFICIAL_PRICES).filter((id) => !placed.has(id));
if (orphans.length) groups.push({ name: '其它', ids: orphans });

const num = (v) => (v === null || v === undefined ? '—' : String(v));
const entries = Object.values(OFFICIAL_PRICES);
const officialN = entries.filter((e) => e.src === 'official').length;
const derivedN = entries.length - officialN;
const today = new Date().toISOString().slice(0, 10);

const lines = [];
lines.push('# 内置模型价格表（完整导出）');
lines.push('');
lines.push(`> 由 \`src/model-prices.js\` 导出（\`node scripts/export-prices-md.mjs\`，非手写），数据核对时间 ${today}  `);
lines.push('> 单位：**元 / 每百万 token**。美元价按 1 USD ≈ 7.2 CNY 换算。');
lines.push('');
lines.push(`共 **${entries.length}** 条：**${officialN}** 条官方直取（official），**${derivedN}** 条二手折算（derived）。`);
lines.push('');
lines.push('| 标记 | 含义 |');
lines.push('|---|---|');
lines.push('| `official` | 厂商官方定价文档/价格页直接取到，人民币原价照录 |');
lines.push('| `derived` | 官方页未能直连，按官方公告与可信转载折算，仅供参考 |');
lines.push('| 峰谷 ✓ | 分时段计价，高峰 = 闲时 ×2（前三列取闲时价） |');
lines.push('| 图片 | 图片输入 token 换算规则 |');
lines.push('');

for (const g of groups) {
  const rows = g.ids.map((id) => ({ id, ...OFFICIAL_PRICES[id] }));
  const dN = rows.filter((r) => r.src === 'official').length;
  lines.push(`## ${g.name}（${rows.length} 条，${dN === rows.length ? '全部 official' : dN === 0 ? '全部 derived' : `${dN} 条 official`}）`);
  lines.push('');
  lines.push('| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const peak = r.peak ? `✓ ${num(r.peak.in)} / ${num(r.peak.out)}` : '—';
    const img = r.image
      ? (r.image.mode === 'capped' ? `封顶 ${r.image.maxTokensPerImage}/张` : (r.image.note || r.image.mode))
      : '—';
    const note = String(r.note || '').replace(/\|/g, '\\|');
    lines.push(`| \`${r.id}\` | ${num(r.in)} | ${num(r.out)} | ${num(r.cached)} | ${peak} | ${img} | ${r.src || '—'} | ${note} |`);
  }
  lines.push('');
}

fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`已导出 ${entries.length} 条（${groups.length} 个分组）→ ${outPath}`);
console.log(`official ${officialN} / derived ${derivedN}`);
