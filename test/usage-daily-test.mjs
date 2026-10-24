// 按日快照测试：生成 → 命中加速 → 目录变化重算 → 聚合与实时路径一致。
// 离线运行：临时数据目录 + 手工伪造会话文件 + __testUsageDaily 测试钩子。
// 2026-09-19 之后快照形态：已完结日固化成 usage-days/<日>.json 单日文件
// （旧的 usage-daily.json 汇总只作一次性迁移源，loadUsageDayFile 兜底读取）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-usage-daily-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  api: { baseUrl: '', apiKey: '', model: 'test-model', priceInputPerM: 1, priceOutputPerM: 2, priceCachedPerM: 0 },
  server: { port: 3399 }
}));

// 造会话：昨天 2 个 + 今天 1 个
const sessionsDir = path.join(dataDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const now = Date.now();
const mkSession = (id, startedAt, tokens) => {
  const s = {
    id, chatKey: 'group:10086', startedAt, endedAt: startedAt + 60000,
    status: 'done', model: 'test-model', vendor: 'testvendor',
    usage: { promptTokens: tokens, completionTokens: Math.round(tokens / 2), totalTokens: tokens * 2, cachedTokens: 0, calls: 1 },
    webSearchCount: 1,
    messages: [
      { toolCall: { name: 'send_message', args: {}, result: 'ok' } },
      { raw: { created: Math.floor(startedAt / 1000), model: 'test-model', usage: { prompt_tokens: tokens, completion_tokens: Math.round(tokens / 2) } } }
    ],
    sent: []
  };
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(s));
};
// "昨天"锚定在昨天**正午**：直接用 now-24h 的话，深夜跑测试（比如 00:30）时
// 再减 1~2 小时就跨回前天 —— 会话落错日，断言"昨天 3000"变 1000，纯属时间态假故障。
const yd = new Date();
yd.setDate(yd.getDate() - 1);
yd.setHours(12, 0, 0, 0);
const yesterday = yd.getTime();
mkSession('s-old1', yesterday - 3600_000, 1000);
mkSession('s-old2', yesterday - 7200_000, 2000);
mkSession('s-today', now - 600_000, 500);

const { __testUsageDaily } = await import('../src/app.js');
const T = __testUsageDaily();
const dayKeyOf = (ts) => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const yesterdayKey = dayKeyOf(yesterday);
const todayKey = dayKeyOf(now);
const snapshotFile = path.join(dataDir, 'usage-days', `${yesterdayKey}.json`);

await check('首次统计：昨天进快照、今天实时', async () => {
  const { stats, recomputedDays, usedSnapshotDays } = await T.buildUsageStatsWithSnapshots({ range: '7' });
  assert.ok(fs.existsSync(snapshotFile), '快照文件应生成');
  assert.ok(recomputedDays >= 1, `至少重算 1 天（昨天），实际 ${recomputedDays}`);
  assert.ok(usedSnapshotDays >= 0, '快照天数非负');
  // 昨天的 token：1000 + 2000 prompt ×（each 会话两条 message.raw？只有 1 条 raw）
  const yDay = stats.days.find((d) => d.day === yesterdayKey);
  assert.ok(yDay, `days 里应有昨天（${yesterdayKey}）`);
  assert.equal(yDay.promptTokens, 3000, `昨天 prompt 应为 3000，实际 ${yDay.promptTokens}`);
  // 今天不进 days？——days 维度只含已完结日 + 快照；今天在 totals 里但不单列
  // （与原实现一致：mode=days 时 byDay 含今天吗？原实现含（今天也分桶）。
  //  快照版：今天实时聚合并入 totals。检查 totals：
  assert.equal(stats.totals.promptTokens, 3500, `总 prompt 应 3500（昨 3000 + 今 500），实际 ${stats.totals.promptTokens}`);
});

await check('快照文件格式：version/day/aggregates，且不含今天', async () => {
  const parsed = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  assert.equal(parsed.version, 1, '单日文件 version 应为 1');
  assert.equal(parsed.day, yesterdayKey, `单日文件 day 应为昨天（${yesterdayKey}）`);
  assert.ok(parsed.aggregates, '缺 aggregates');
  // 今天不该有自己的单日文件（今天的量只实时算，不固化）
  assert.ok(!fs.existsSync(path.join(dataDir, 'usage-days', `${todayKey}.json`)), '今天不该进按天快照');
});

await check('第二次统计：昨天命中快照（recomputedDays = 0）且结果一致', async () => {
  const r1 = await T.buildUsageStatsWithSnapshots({ range: '7' });
  assert.equal(r1.recomputedDays, 0, `昨天应命中快照不再重算，实际重算 ${r1.recomputedDays}`);
  assert.equal(r1.stats.totals.promptTokens, 3500);
  const yDay = r1.stats.days.find((d) => d.day === yesterdayKey);
  assert.equal(yDay.promptTokens, 3000);
  assert.ok(r1.usedSnapshotDays >= 1, '至少用了 1 天快照');
});

await check('目录变化（新增会话）→ 对应日重算', async () => {
  // 单日文件已固化：新增会话要反映出来，得让该日走回算 —— 删掉昨天的日文件
  // 模拟"快照失效"（loadUsageDayFile 缺失即重算，回算会扫到新会话并重新固化）。
  mkSession('s-old3', yesterday - 10800_000, 700);
  fs.rmSync(snapshotFile, { force: true });
  const r = await T.buildUsageStatsWithSnapshots({ range: '7' });
  assert.ok(r.recomputedDays >= 1, `日文件删除后昨天应重算，实际 ${r.recomputedDays}`);
  const yDay = r.stats.days.find((d) => d.day === yesterdayKey);
  assert.equal(yDay.promptTokens, 3700, `昨天应为 3700（3000+700），实际 ${yDay.promptTokens}`);
});

await check('快照与实时聚合路径数值一致（buildUsageStats 兜底口径不漂移）', async () => {
  const viaSnapshot = await T.buildUsageStats({ range: '7' });
  const viaLive = await T.collectUsageRows({ range: '7' });
  // 两条路径的 totals.promptTokens 必须一致（成本口径走同一套 costOfRows 输入）
  assert.equal(viaSnapshot.totals.promptTokens, viaLive.rows.reduce((a, r) => a + r.promptTokens, 0),
    `快照路径 ${viaSnapshot.totals.promptTokens} vs 实时 ${viaLive.rows.reduce((a, r) => a + r.promptTokens, 0)}`);
  assert.equal(viaSnapshot.totals.completionTokens, viaLive.rows.reduce((a, r) => a + r.completionTokens, 0));
});

await check('range=today：只用今天的实时数据', async () => {
  const r = await T.buildUsageStatsWithSnapshots({ range: 'today' });
  assert.equal(r.stats.totals.promptTokens, 500, `今天 500，实际 ${r.stats.totals.promptTokens}`);
});

await check('删除快照文件 → 自动重建且数据不变', async () => {
  fs.rmSync(snapshotFile, { force: true });
  const r = await T.buildUsageStatsWithSnapshots({ range: '7' });
  assert.ok(fs.existsSync(snapshotFile), '快照应重建');
  assert.equal(r.stats.totals.promptTokens, 4200, `重建后总量 4200，实际 ${r.stats.totals.promptTokens}`);
});

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n按日快照：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
