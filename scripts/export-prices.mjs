// 把内置官方价格表导出成 prices.json —— 上传到你自己的服务器后，
// 在「设置 → 模型 API → 远程价格表 URL」里填它的地址，
// agent 启动时与每 24 小时就会自动拉取（远程条目按模型 id 覆盖内置表）。
//
// 用法：
//   node scripts/export-prices.mjs            # 导出到项目根目录 prices.json
//   node scripts/export-prices.mjs /path/to/out.json
//
// 之后维护方式：直接编辑服务器上的那个 JSON（格式与内置表条目同构），
// 不用改代码、不用发版。格式说明见文件头注释（src/price-feed.js）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_PRICES } from '../src/model-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'prices.json'));

const payload = {
  updated: new Date().toISOString().slice(0, 10),
  comment: 'qq-agent 远程价格表。单位：元/百万 token。条目字段：in/out（必填数字）、cached（可 null）、peak/image/note/src（可选）。',
  prices: OFFICIAL_PRICES
};

fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
console.log(`已导出 ${Object.keys(OFFICIAL_PRICES).length} 条 → ${out}`);
console.log('上传到服务器后，把它的 URL 填进「设置 → 模型 API → 远程价格表 URL」。');
