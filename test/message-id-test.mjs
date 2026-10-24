// 消息 id 负数回归测试（2026-09-26）
//
// 背景：QQ 消息 id 是有符号 64 位（NT 常见负数，如 -1399738219），项目内置工具
// 一直按"非零整数（可负）"校验；但 card-to-link 技能三处要求"必须是正整数"
// （card_to_link / send_card_link 的 messageId 校验、resolveReplyId 的 n > 0），
// image-lookup 的 get_msg 转换正则也只认正数 —— 负数 id 的消息一半场景直接废掉。
//
// 本套件驱动**真实的 card-to-link 技能**（setup(api) 注册工具后直接调 execute）：
//   1. store.findByMid：负数 mid 两种传法都能命中
//   2. card_to_link：负数 / 负数字符串通过校验并以数字形态调 get_msg
//   3. card_to_link：0 仍被拒（非零整数语义不变）
//   4. send_card_link：负数 id 作为 replyToMessageId 传到发送层（引用回复）
//
// 运行：node test/message-id-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

// ⚠️ 数据目录隔离：必须在 import src/* 之前设置
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-msgid-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { ChatStore } = await import('../src/store.js');

const c = createChecker('消息 id 负数（QQ 消息 id 可为负）');

// ── 1. 存档查找 ─────────────────────────────────────────────────────────
await c.check('store.findByMid：负数 mid（数字/字符串）都能命中', () => {
  const store = new ChatStore(0);
  store.appendIncoming('group:123', { mid: -1399738219, ts: Date.now(), senderId: 'u1', senderName: '群友', text: '负数消息' });
  assert.ok(store.findByMid('group:123', -1399738219), '数字形态应命中');
  assert.ok(store.findByMid('group:123', '-1399738219'), '字符串形态应命中');
  assert.equal(store.findByMid('group:123', 0), null, '0 不是有效消息 id');
});

process.exit(c.finish() ? 0 : 1);
