// reply-safety 插件测试（2026-10-21）。
//
// 背景：模型偶尔把完整回复写进正文 content、却不调用 send_message。
// 核心按设计不把正文发出去，于是出现「思考完就不回复」。
// reply-safety 负责把这种成稿按原句抢救成一条 send_message。
//
// 这条链路判错的代价极不对称：
//   · 该发没发 → 这轮沉默（可接受）
//   · 不该发却发了 → 内心戏/计划稿发进群（不可接受）
// 所以本测试的重点不是"能救多少"，而是"哪些必须拦住"。
//
// 运行：node test/reply-safety-test.mjs

import assert from 'node:assert/strict';
import { isPlanningText, extractMessages, pickGrounded, setup, providers } from '../plugins/reply-safety/index.js';
import { rescueUnsentReply } from '../src/reply-rescue.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${error?.message ?? error}`);
  }
}

// 测试配置：默认开启、不试运行、1500 字上限
let currentConfig = { enabled: true, dryRun: false, maxChars: 1500 };
const logs = [];
setup({
  config: () => currentConfig,
  log: (message) => logs.push(String(message))
});

const cap = (name) => (args) => providers[name]?.(args);

// 真实故障现场：mvho07mt-96e03a5d 第二轮写进正文的回复
const REAL_ESCAPED = `点了番茄炒蛋呀，乖~ 才14块还挺会省😌
备注写「放门口」，是懒得下楼还是怕我盯你吃饭 hhh
送到了就开吃，别边刷手机边凉掉了`;

console.log('\n== 计划腔否决（该沉默）==');

check('第三人称内心戏 → 判定为计划腔', () => {
  assert.equal(isPlanningText('他问我在干嘛，我应该回得轻松点。'), true);
});
check('候选稿 → 判定为计划腔', () => {
  assert.equal(isPlanningText('候选：\n1. 在的\n2. 咋了'), true);
});
check('明确决定不说话 → 判定为计划腔', () => {
  assert.equal(isPlanningText('算了，不回了。'), true);
});
check('舞台说明（沉默）→ 判定为计划腔', () => {
  assert.equal(isPlanningText('（沉默）'), true);
});
check('解释「这条不用回」→ 判定为计划腔', () => {
  assert.equal(isPlanningText('这条消息不用回。'), true);
});
check('文本工具调用残留 → 判定为计划腔', () => {
  assert.equal(isPlanningText('<tool_call>{"name":"send_message"}</tool_call>'), true);
});
check('英文思考 → 判定为计划腔', () => {
  assert.equal(isPlanningText('The user asked what to eat. I should recommend something light.'), true);
});

console.log('\n== 成品话识别（该抢救）==');

check('真实故障回复 → 不是计划腔', () => {
  assert.equal(isPlanningText(REAL_ESCAPED), false);
});
check('真实故障回复 → 原样抽成一条，保留换行', () => {
  assert.deepEqual(extractMessages(REAL_ESCAPED), [REAL_ESCAPED]);
});
check('`回复：` 只是壳，剥掉后内容保留', () => {
  assert.deepEqual(extractMessages('回复：在的'), ['在的']);
});
check('`回复：` + 多行 → 标签剥掉、正文保留', () => {
  assert.deepEqual(extractMessages('回复：在的\n咋了'), ['在的\n咋了']);
});
check('计划行 + 成品行 → 只留成品行', () => {
  assert.deepEqual(
    extractMessages('他问我在干嘛，我应该回得轻松点。\n回复：在的\n咋了'),
    ['在的\n咋了']
  );
});
check('整段被引号包住 → 剥掉外层引号', () => {
  assert.deepEqual(extractMessages('“在的，咋了”'), ['在的，咋了']);
});
check('超过字数上限 → 不抢救', () => {
  currentConfig = { ...currentConfig, maxChars: 10 };
  assert.deepEqual(extractMessages(REAL_ESCAPED), []);
  currentConfig = { ...currentConfig, maxChars: 1500 };
});
check('分析/思路 + 答案标签 → 只留答案正文', () => {
  assert.deepEqual(extractMessages('分析：他问吃什么\n思路：先反问再推荐\n答案：随便'), ['随便']);
});
check('舞台说明 → 撤回为空', () => {
  assert.deepEqual(extractMessages('（沉默）'), []);
});
check('文本工具调用 → 撤回为空（交给核心解析器）', () => {
  assert.deepEqual(extractMessages('<tool_call>{"name":"send_message"}</tool_call>'), []);
});
check('中文里出现「你怎么不回我」不能被误判成决定沉默', () => {
  assert.equal(isPlanningText('你怎么不回我呀，我等半天了'), false);
  assert.deepEqual(extractMessages('你怎么不回我呀，我等半天了'), ['你怎么不回我呀，我等半天了']);
});

console.log('\n== 草稿溯源（最后一道闸）==');

check('没有 remember 过 → 全部拒绝', () => {
  providers['reply.grounded-select']({ reset: true });
  assert.deepEqual(pickGrounded(['在的'], []), []);
  assert.deepEqual(providers['reply.grounded-select']({ proposed: ['在的'], sent: [] }), { enabled: true, picked: [] });
});
check('remember 后：出自草稿的原句 → 通过', () => {
  providers['reply.grounded-select']({ reset: true });
  providers['reply.grounded-select']({ remember: REAL_ESCAPED });
  assert.deepEqual(
    providers['reply.grounded-select']({ proposed: [REAL_ESCAPED], sent: [] }),
    { enabled: true, picked: [REAL_ESCAPED] }
  );
});
check('已经发过的原句 → 去重拒绝', () => {
  const picked = providers['reply.grounded-select']({
    proposed: [REAL_ESCAPED],
    sent: [{ type: 'text', text: REAL_ESCAPED }]
  });
  assert.deepEqual(picked, { enabled: true, picked: [] });
});
check('不在草稿里的句子 → 拒绝（防模型/裁判编造）', () => {
  providers['reply.grounded-select']({ reset: true });
  providers['reply.grounded-select']({ remember: REAL_ESCAPED });
  assert.deepEqual(
    providers['reply.grounded-select']({ proposed: ['我编的一句'], sent: [] }),
    { enabled: true, picked: [] }
  );
});
check('reset 清空草稿 → 回到全拒绝', () => {
  providers['reply.grounded-select']({ reset: true });
  assert.deepEqual(
    providers['reply.grounded-select']({ proposed: [REAL_ESCAPED], sent: [] }),
    { enabled: true, picked: [] }
  );
});

console.log('\n== 与核心 reply-rescue 的联动 ==');

await checkAsync('真实故障：正文 → 合成一条 send_message', async () => {
  providers['reply.grounded-select']({ reset: true });
  providers['reply.grounded-select']({ remember: REAL_ESCAPED });
  const calls = await rescueUnsentReply({
    text: REAL_ESCAPED,
    trigger: 'C4LLM3Kai: [图片]',
    sent: [],
    cap
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'send_message');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { messages: [REAL_ESCAPED] });
});

await checkAsync('计划腔：正文 → 一条都不发', async () => {
  providers['reply.grounded-select']({ reset: true });
  providers['reply.grounded-select']({ remember: '他问我在干嘛，我应该回得轻松点。' });
  const calls = await rescueUnsentReply({
    text: '他问我在干嘛，我应该回得轻松点。',
    trigger: '在吗',
    sent: [],
    cap
  });
  assert.deepEqual(calls, []);
});

await checkAsync('试运行：抽出候选但不发', async () => {
  currentConfig = { ...currentConfig, dryRun: true };
  providers['reply.grounded-select']({ reset: true });
  providers['reply.grounded-select']({ remember: REAL_ESCAPED });
  logs.length = 0;
  const calls = await rescueUnsentReply({
    text: REAL_ESCAPED,
    trigger: 'C4LLM3Kai: [图片]',
    sent: [],
    cap
  });
  assert.deepEqual(calls, []);
  assert.ok(logs.some((line) => line.includes('试运行')), `没有试运行日志：${logs.join(' | ')}`);
  currentConfig = { ...currentConfig, dryRun: false };
});

await checkAsync('插件关闭：所有能力回到 no-op', async () => {
  currentConfig = { ...currentConfig, enabled: false };
  providers['reply.grounded-select']({ reset: true });
  providers['reply.grounded-select']({ remember: REAL_ESCAPED });
  const calls = await rescueUnsentReply({
    text: REAL_ESCAPED,
    trigger: 'C4LLM3Kai: [图片]',
    sent: [],
    cap
  });
  assert.deepEqual(calls, []);
  currentConfig = { ...currentConfig, enabled: true };
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
