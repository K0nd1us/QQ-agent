// 长期冷储存回归测试
//
// 覆盖 src/cold-storage.js 的五条主路径：
//   1. snapshot：把 messages / memory / sessions / 脱敏配置 / 记忆摘要 抄进归档
//   2. search：关键词能命中记忆与消息；限定会话时**查不到别的会话**
//   3. restore --mode memory：把缺的印象补回 memory/，重复执行幂等
//   4. prune：只保留最新 N 份
//   5. captureBeforeReset：同一原因在冷却窗口内去重（一次批量清理只留一份快照）
//
// 另外钉住两条安全口径：归档里不能出现真实 apiKey；_meta.json（含水位）不参与还原。
//
// 运行：node test/cold-storage-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

// ⚠️ 数据目录隔离：必须在 import src/* 之前设置（config.js 在模块加载时就算出 DATA_DIR）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-cold-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
// 冷储存储存目录单独指到临时目录，避免和真实环境的 <data>/../cold-storage 混在一起
const coldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-coldstore-'));
process.env.QQ_AGENT_COLD_STORAGE_DIR = coldDir;

const SECRET_KEY = 'sk-test-SECRET-do-not-leak';

const {
  snapshot, searchArchives, restoreSnapshot, pruneArchives,
  listSnapshots, captureBeforeReset, archiveStatus, COLD_DIR
} = await import('../src/cold-storage.js');

const c = createChecker('长期冷储存（快照 / 检索 / 还原 / 轮转）');

// ── 造数据：两个会话 + 一份会话留档 + 含密钥的配置 ──────────────────────
function seed() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'memory', 'group_123'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'memory', 'group_999'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    api: { baseUrl: 'https://example.invalid/v1', apiKey: SECRET_KEY, model: 'm' },
    persona: { botName: '测试Bot' }
  }), 'utf8');

  fs.writeFileSync(path.join(dataDir, 'messages', 'group_123.json'), JSON.stringify({
    chatKey: 'group:123', nextLocalId: 3,
    messages: [
      { localId: 1, sender: '阿伟', text: '今天群里聊了冷储存的话题' },
      { localId: 2, sender: '机器人', text: '我也记得这件事' }
    ]
  }), 'utf8');

  fs.writeFileSync(path.join(dataDir, 'memory', 'group_123', '456.json'), JSON.stringify({
    userId: '456', name: '阿伟', impressions: [{ content: '喜欢冷储存', createdAt: 1 }], updatedAt: 1
  }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'memory', 'group_123', '_meta.json'), JSON.stringify({ lastConsolidatedAt: 12345 }), 'utf8');

  // 另一个会话：用来验证「限定检索时查不到隔壁群」
  fs.writeFileSync(path.join(dataDir, 'memory', 'group_999', '777.json'), JSON.stringify({
    userId: '777', name: '别群的人', impressions: [{ content: '也在聊冷储存' }], updatedAt: 1
  }), 'utf8');

  fs.writeFileSync(path.join(dataDir, 'sessions', 'sess-1.json'), JSON.stringify({
    id: 'sess-1', chatKey: 'group:123', status: 'done', transcript: '阿伟 说：冷储存要留档'
  }), 'utf8');
}

/** 清掉冷储存里的历史快照（每个用例从干净状态开始） */
function resetCold() {
  fs.rmSync(coldDir, { recursive: true, force: true });
  fs.mkdirSync(coldDir, { recursive: true });
}

// ── 1. 快照 ─────────────────────────────────────────────────────────────
await c.check('snapshot：把消息/记忆/留档/脱敏配置/记忆摘要都抄进归档', async () => {
  seed();
  resetCold();
  const { id, manifest } = await snapshot({ reason: 'unit-test' });
  const dir = path.join(coldDir, id);

  assert.ok(fs.existsSync(path.join(dir, 'messages', 'group_123.json')), '缺消息存档');
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'group_123', '456.json')), '缺记忆文件');
  assert.ok(fs.existsSync(path.join(dir, 'sessions', 'sess-1.json')), '缺会话留档');
  assert.ok(fs.existsSync(path.join(dir, 'memory.json')), '缺记忆摘要');
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), '缺 manifest');

  const digest = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
  assert.equal(digest.chats['group:123'].members['456'].name, '阿伟');
  assert.deepEqual(digest.chats['group:123'].members['456'].impressions, ['喜欢冷储存']);
  assert.ok(manifest.totalBytes > 0, 'totalBytes 应大于 0');
});

await c.check('snapshot：配置只留脱敏副本，真实 apiKey 不进归档', async () => {
  const all = listSnapshots();
  const dir = path.join(coldDir, all[0].id);
  const redacted = JSON.parse(fs.readFileSync(path.join(dir, 'config.redacted.json'), 'utf8'));
  assert.equal(redacted.api.apiKey, '__REDACTED__');
  assert.equal(redacted.persona.botName, '测试Bot', '非敏感字段应原样保留');
  // 全量扫一遍：任何归档文件里都不该出现密钥原文
  const walk = (d, acc = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, acc); else acc.push(p);
    }
    return acc;
  };
  const leaked = walk(dir).filter((f) => fs.readFileSync(f, 'utf8').includes(SECRET_KEY));
  assert.deepEqual(leaked, [], `密钥泄漏到：${leaked.join(', ')}`);
});

// ── 2. 检索 ─────────────────────────────────────────────────────────────
await c.check('search：记忆与消息都能命中', () => {
  const hits = searchArchives(['冷储存'], { limit: 50 });
  assert.ok(hits.total > 0, '应有命中');
  const labels = hits.results.flatMap((r) => r.hits.map((h) => h.label));
  assert.ok(labels.some((l) => l.includes('memory.json') || l.includes('456')), `记忆应命中，实际：${labels.slice(0, 5).join(' | ')}`);
  assert.ok(labels.some((l) => l.includes('messages/group_123.json')), '消息存档应命中');
});

await c.check('search：限定会话时查不到隔壁群', () => {
  const mine = searchArchives(['冷储存'], { onlyChat: 'group:123', limit: 50 });
  assert.ok(mine.total > 0, '本会话应有命中');
  const files = mine.results.flatMap((r) => r.hits.map((h) => h.file));
  assert.ok(!files.some((f) => f.includes('group_999')), `不该出现别的会话：${files.join(', ')}`);

  // 会话留档是跨会话混放的：限定检索只放行 chatKey 属于本会话的那几份。
  // 这里把每条 sessions/ 命中都读回去核对一遍，防止实现退化成「整个 sessions/ 放行」。
  const sessionFiles = [...new Set(files.filter((f) => f.startsWith('sessions/')))];
  for (const rel of sessionFiles) {
    const snapDir = mine.results[0].snapshot.dir;
    const data = JSON.parse(fs.readFileSync(path.join(snapDir, rel), 'utf8'));
    assert.equal(data.chatKey, 'group:123', `${rel} 不属于本会话却出现在结果里`);
  }

  const other = searchArchives(['冷储存'], { onlyChat: 'group:999', limit: 50 });
  assert.ok(other.total > 0, '隔壁群自己查自己应有命中（说明不是整体屏蔽）');
  assert.ok(other.results.flatMap((r) => r.hits.map((h) => h.file)).every((f) => f.includes('group_999')));
});

await c.check('search：多关键词是 AND 语义', () => {
  const both = searchArchives(['冷储存', '阿伟'], { limit: 50 });
  assert.ok(both.total > 0, '两个词同时出现应命中');
  const none = searchArchives(['冷储存', '根本不存在的词'], { limit: 50 });
  assert.equal(none.total, 0, '有一个词不在就不该命中');
});

// ── 3. 还原 ─────────────────────────────────────────────────────────────
await c.check('restore --mode memory：补回缺的印象，且不动 _meta 水位', () => {
  // 模拟「删掉某群友记忆」：把 456.json 删掉
  fs.rmSync(path.join(dataDir, 'memory', 'group_123', '456.json'), { force: true });
  const before = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'group_123', '_meta.json'), 'utf8'));

  const report = restoreSnapshot('latest', { mode: 'memory', force: true });
  assert.ok(report.chats['group:123'], `应报告补回 group:123，实际 ${JSON.stringify(report.chats)}`);
  assert.equal(report.chats['group:123'].impressions, 1);

  const restored = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'group_123', '456.json'), 'utf8'));
  assert.equal(restored.userId, '456');
  assert.equal(restored.name, '阿伟');
  assert.deepEqual(restored.impressions.map((i) => i.content), ['喜欢冷储存']);

  // _meta.json 不参与还原：水位不能被旧快照带回
  const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'group_123', '_meta.json'), 'utf8'));
  assert.equal(after.lastConsolidatedAt, before.lastConsolidatedAt);
});

await c.check('restore --mode memory：重复执行幂等（不会叠出重复印象）', () => {
  const again = restoreSnapshot('latest', { mode: 'memory', force: true });
  assert.deepEqual(again.chats, {}, `第二次不该再补任何东西，实际：${JSON.stringify(again.chats)}`);
  const restored = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'group_123', '456.json'), 'utf8'));
  assert.equal(restored.impressions.length, 1);
});

await c.check('restore --mode state：消息存档被整体覆盖回快照那一刻', () => {
  fs.writeFileSync(path.join(dataDir, 'messages', 'group_123.json'), JSON.stringify({ chatKey: 'group:123', messages: [] }), 'utf8');
  const report = restoreSnapshot('latest', { mode: 'state', force: true });
  assert.ok(report.written > 0, '应写入文件');
  const back = JSON.parse(fs.readFileSync(path.join(dataDir, 'messages', 'group_123.json'), 'utf8'));
  assert.equal(back.messages.length, 2, '应恢复到快照里的 2 条消息');
});

await c.check('restore：latest 跳过 pre-restore（否则会还原「上一次还原」）', async () => {
  resetCold();
  await snapshot({ reason: 'real-one' });
  await new Promise((r) => setTimeout(r, 5));
  await snapshot({ reason: 'pre-restore', note: '模拟还原前自动存档' });
  const report = restoreSnapshot('latest', { mode: 'memory', force: true });
  assert.ok(!/pre-restore/.test(report.snapshot), `latest 不该选中 pre-restore，实际 ${report.snapshot}`);
});

// ── 4. 轮转 ─────────────────────────────────────────────────────────────
await c.check('prune：只保留最新 N 份', async () => {
  resetCold();
  for (let i = 0; i < 4; i++) {
    await snapshot({ reason: `r${i}` });
    await new Promise((r) => setTimeout(r, 3)); // 时间戳精度到毫秒，确保目录名不同
  }
  assert.equal(listSnapshots().length, 4);
  const result = pruneArchives({ keep: 2 });
  assert.equal(result.removed.length, 2);
  assert.equal(listSnapshots().length, 2);
});

// ── 5. 自动快照去重 ─────────────────────────────────────────────────────
await c.check('captureBeforeReset：同一原因在冷却窗口内只打一次', async () => {
  resetCold();
  const first = captureBeforeReset('clear-chat', { chatKeys: ['group:123'] });
  const second = captureBeforeReset('clear-chat', { chatKeys: ['group:123'] });
  await first;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(first, '第一次应产生快照');
  assert.equal(second, null, '冷却窗口内的第二次应被去重');
  assert.equal(listSnapshots().length, 1);
});

await c.check('captureBeforeReset：不同原因各自留档（不会被误去重）', async () => {
  resetCold();
  captureBeforeReset('delete-messages', { chatKeys: ['group:123'] });
  await new Promise((r) => setTimeout(r, 50));
  // 冷却按「原因」判定，不同原因应各存一份
  const other = captureBeforeReset('clear-finished-sessions');
  await other;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(listSnapshots().length >= 2, `应有至少 2 份快照，实际 ${listSnapshots().length}`);
});

// ── 6. 状态 ─────────────────────────────────────────────────────────────
await c.check('archiveStatus：报告目录、份数、是否在运行', () => {
  const st = archiveStatus();
  assert.equal(st.root, COLD_DIR);
  assert.equal(st.dataDir, dataDir);
  assert.ok(st.count >= 1);
  assert.equal(typeof st.running, 'boolean');
});

process.exit(c.finish() ? 0 : 1);
