import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mention-label-'));
process.env.QQ_AGENT_DATA_DIR = temporary;
try {
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
  const { buildTriggerBlock, resolveContextTier } = await import('../src/prompt.js');
  const config = structuredClone(DEFAULT_CONFIG);
  config.persona.botName = '小鲸鱼';
  config.store.contextTier = 1;
  setRuntimeConfig(config);
  const ctx = { selfId: '888', selfNickname: 'DSH', botName: '小鲸鱼' };
  const make = extra => ({ id: 1, mid: 900, ts: Date.now(), senderId: '111', senderName: '群友', text: '', self: false, ...extra });
  const cases = [
    [make({ text: '@陌生群名片 在吗', atMe: true, atNames: ['@陌生群名片'] }), true],
    [make({ text: '@DSH 在吗', atMe: false, atNames: ['@DSH'] }), false],
    [make({ text: '@小鲸鱼 在吗', atMe: false, atNames: ['@小鲸鱼'] }), false],
    [make({ text: '@全体成员 晚上好', atMe: false, atNames: ['@全体成员'] }), false],
    [make({ text: '@他人 晚上好', atMe: false, atNames: ['@他人'] }), false],
    [make({ text: '[CQ:at,qq=888] 在吗' }), true],
    [make({ text: '@DSH 在吗' }), true],
    [make({ text: '@小鲸鱼 在吗' }), true],
    [make({ text: '@他人 在吗' }), false],
    [make({ text: '@全体成员 晚上好' }), false]
  ];
  for (const [entry, expected] of cases) {
    const block = buildTriggerBlock([entry], ctx);
    const label = /（[^）]*@我/.test(block);
    const gate = resolveContextTier({ chatKey: 'group:456', triggerEntries: [entry], ...ctx, roll: 100 });
    assert.equal(label, expected, entry.text);
    assert.equal(gate.reason === '被艾特', expected, entry.text);
    if (entry.atMe === false) assert.ok(!block.includes('提到我'), entry.text);
  }
  const bodyMention = make({ text: '@DSH 小鲸鱼看看', atMe: false, atNames: ['@DSH'] });
  assert.ok(buildTriggerBlock([bodyMention], ctx).includes('提到我'), '正文提到机器人仍保留标签');
  const empty = { selfNickname: '', selfId: '888' };
  assert.ok(!/（[^）]*@我/.test(buildTriggerBlock([make({ text: '你们看 @别人' })], empty)));
  console.log('PASS protocol true/false, renamed card, same-name users, all-members, legacy fallback, empty nickname and body mention');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
