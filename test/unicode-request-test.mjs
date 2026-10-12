import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';
import { truncateText, stringifyWellFormedJson } from '../src/unicode.js';

const quoted = 'x'.repeat(119) + '😀';
assert.equal(quoted.slice(0, 120).isWellFormed(), false);
assert.equal(truncateText(quoted, 120), 'x'.repeat(119));
for (const text of ['中文😀尾部', '😀😀', 'plain']) {
  for (let limit = 0; limit <= text.length + 1; limit++) {
    const clipped = truncateText(text, limit);
    assert.ok(clipped.length <= limit && clipped.isWellFormed() && text.startsWith(clipped));
  }
}
const valid = { text: '中文😀\\ud83d', nested: ['🚀'], nil: null, number: 3 };
assert.equal(stringifyWellFormedJson(valid), JSON.stringify(valid));
const broken = { text: '高\ud83d低\ude00', nested: ['😀\ud83d'] };
assert.deepEqual(JSON.parse(stringifyWellFormedJson(broken)), { text: '高�低�', nested: ['😀�'] });
assert.equal(broken.text, '高\ud83d低\ude00');
console.log('PASS truncation budgets, surrogate repair, valid JSON bytes and immutable input');

const env = await bootApp({
  config: { wakeDelayMs: 10 },
  script: [{ toolCalls: [{ name: 'finish', args: { summary: 'test complete' } }] }]
});
try {
  const { app, pushGroupMsg, waitSessionDone, llm } = env;
  await waitFor(() => app.onebot.selfId);
  app.onebot.getMsg = async () => ({ sender: { user_id: 112, nickname: '引用者' }, message: [{ type: 'text', data: { text: quoted } }] });
  pushGroupMsg(111, '测试者', '', 901, { message: [
    { type: 'reply', data: { id: '900' } },
    { type: 'at', data: { qq: '888' } },
    { type: 'text', data: { text: 'unicode quote regression' } }
  ] });
  const session = await waitSessionDone('x'.repeat(20));
  assert.equal(session.status, 'noreply');
  const entry = app.store.findByMid('group:456', 901);
  assert.ok(entry);
  assert.ok(entry.text.includes('x'.repeat(119)));
  assert.ok(entry.text.isWellFormed());
  assert.ok(!entry.text.includes('😀'));
  assert.ok(llm.state.requests[0].messages.some(m => String(m.content).includes('x'.repeat(119))));
  console.log('PASS real reply ingestion, saved quote and model request with mocked OneBot/LLM');

  const { chatCompletion } = await import('../src/llm.js');
  const { skillManager } = await import('../src/skills/manager.js');
  const realFetch = globalThis.fetch;
  const transforms = skillManager.getRequestTransforms;
  const captured = [];
  const check = value => {
    if (typeof value === 'string') assert.ok(value.isWellFormed());
    else if (value && typeof value === 'object') Object.values(value).forEach(check);
  };
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body); check(body); captured.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
    };
    const messages = [{ role: 'user', content: '旧历史\ud83d' }];
    const overrides = { baseUrl: 'https://mock.invalid/v1', apiKey: 'test', model: 'mock', timeoutMs: 5000, thinkingEffort: 'off' };
    await chatCompletion({ messages, overrides });
    assert.equal(captured[0].messages[0].content, '旧历史�');
    assert.equal(messages[0].content, '旧历史\ud83d');
    skillManager.getRequestTransforms = () => [({ body }) => ({ ...body, messages: [
      { role: 'user', content: [{ type: 'text', text: '插件\ude00' }, { type: 'image_url', image_url: { url: 'https://example.com/😀.png' } }] },
      { role: 'tool', tool_call_id: 'test', content: '工具结果\ud83d' }
    ] })];
    await chatCompletion({ messages, overrides, tools: [{ type: 'function', function: { name: 'test', description: '工具\ud83d', parameters: { type: 'object', properties: {} } } }] });
    assert.equal(captured[1].messages[0].content[0].text, '插件�');
    assert.equal(captured[1].messages[0].content[1].image_url.url, 'https://example.com/😀.png');
    assert.equal(captured[1].messages[1].content, '工具结果�');
    assert.equal(captured[1].tools[0].function.description, '工具�');
    assert.equal(captured.length, 2);
    console.log('PASS transport repairs legacy/late transformed/multimodal/tool strings without mutation or retries');
  } finally { globalThis.fetch = realFetch; skillManager.getRequestTransforms = transforms; }
} finally { await env.teardown(); }
