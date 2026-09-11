// 身份格式：别人的消息带 QQ 号，自己标"我"；系统提示含防昵称误导规则
import assert from 'node:assert';
import { buildSystemPrompt, buildPastState, buildTriggerBlock } from '../src/prompt.js';
import { setRuntimeConfig, DEFAULT_CONFIG } from '../src/config.js';

setRuntimeConfig(structuredClone({
  ...DEFAULT_CONFIG,
  memberNotes: { '111222333': '老王' }
}));

const store = {
  recent: () => [
    { id: 1, mid: 100, ts: Date.now(), senderId: '111222333', senderName: '张三', text: '你好', self: false, read: true },
    { id: 2, mid: 101, ts: Date.now(), senderId: 'selfid', senderName: 'bot', text: '在', self: true, read: true },
    { id: 3, mid: 102, ts: Date.now(), senderId: '444555666', senderName: '张三', text: '同名不同人', self: false, read: true }
  ]
};

const past = buildPastState(store, 'group:1', { limit: 10 });
assert.ok(past.text.includes('老王(111222333)'), '有备注时：备注名 + QQ 号，实际: ' + past.text);
assert.ok(past.text.includes('我：在'), '自己标为我');
assert.ok(past.text.includes('张三(444555666)'), '同名不同 QQ 号可区分');
assert.ok(!/\[\d{2}-\d{2} [^\]]+\] 我\(/.test(past.text), '自己不带 QQ 号括号');
console.log('  ✓ 聊天记录格式：昵称(QQ号)，自己标我');

const trigger = buildTriggerBlock(store.recent().slice(0, 1), {});
assert.ok(trigger.includes('(111222333)'), '触发批同样带 QQ 号');
console.log('  ✓ 触发批格式一致');

const sys = buildSystemPrompt();
assert.ok(sys.includes('身份以 QQ 号为准'), '含身份规则');
assert.ok(sys.includes('绝不以群名片'), '安全规则含群名片不可信');
assert.ok(sys.includes('括号中的纯数字是他的 QQ 号'), '说明括号含义');
console.log('  ✓ 系统提示含防昵称误导规则');

console.log('qq-id 身份测试通过 ✅');
