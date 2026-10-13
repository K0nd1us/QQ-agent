import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';

const env = await bootApp({ config: { security: { allowPrivateImageHosts: true } } });
const { app, onebotHttp, pushGroupMsg, llm } = env;
const { getTool } = await import('../src/tool-registry.js');
const { ChatStore } = await import('../src/store.js');
const imageUrl = `http://127.0.0.1:${onebotHttp.server.address().port}/img.png`;
const image = { type: 'image', data: { file: 'quoted.png', url: imageUrl } };
const quote = (mid, original, extra = []) => pushGroupMsg(111, 'User', '', mid, {
  message: [{ type: 'reply', data: { id: String(original) } },
    { type: 'at', data: { qq: '888' } }, ...extra]
});
const entry = mid => app.store.findByMid('group:456', mid);
try {
  // 原图从未进入本地历史：只能通过 OneBot get_msg 取得。
  onebotHttp.state.messages.set('-9100', {
    sender: { user_id: 9101, nickname: '原图作者' },
    message: [image, { type: 'image', data: { ...image.data, url: `${imageUrl}?second` } }]
  });
  llm.state.script.push(
    { toolCalls: [{ name: 'get_message_images', args: { messageId: 38000 } }] },
    { content: '' }
  );
  quote(38000, -9100);
  await waitFor(() => llm.state.requests.length >= 2, 8000, '引用图片进入模型');
  assert.equal(entry(38000).reply.messageId, '-9100');
  assert.equal(entry(38000).media.length, 2);
  assert.ok(entry(38000).media.every(m => m.sourceMessageId === '-9100'));
  assert.ok(entry(38000).text.includes('[图片]'));
  assert.equal((entry(38000).text.match(/\[引用 /g) || []).length, 1);
  const visionParts = llm.state.requests[1].messages
    .filter(m => m.role === 'user' && Array.isArray(m.content)).flatMap(m => m.content);
  assert.equal(visionParts.filter(p => p.type === 'image_url').length, 2);
  assert.equal(app.store.findByMid('group:456', -9100), null);
  await waitFor(() => app.orchestrator.runningChats.size === 0);
  app.orchestrator.setPaused(true);

  // 自带图片和引用图片相同时去重，不丢失原图定位信息。
  quote(38001, -9100, [image]);
  await waitFor(() => entry(38001));
  assert.equal(entry(38001).media.length, 2);
  const ctx = { store: app.store, chatKey: 'group:456', session: { status: 'running', trigger: [entry(38001)] } };
  const tool = getTool('get_message_images');
  const result = await tool.execute(ctx, { messageId: 38001 });
  assert.equal(result.content.filter(p => p.type === 'image_url').length, 2);

  // 纯文本引用、获取失败保持降级；不能从占位符编造图片。
  onebotHttp.state.messages.set('9102', null);
  quote(38003, 9102);
  quote(38004, 9103);
  await waitFor(() => entry(38003) && entry(38004));
  assert.equal(entry(38003).media.length, 0);
  assert.ok(entry(38003).text.includes('[引用消息]'));
  assert.equal(entry(38004).media.length, 0);
  assert.ok(entry(38004).text.includes('被引用的原话'));

  const restored = new ChatStore();
  assert.equal(restored.findByMid('group:456', 38000).reply.messageId, '-9100');
  assert.equal(restored.findByMid('group:456', 38000).media.length, 2);
  assert.equal(onebotHttp.state.sends.length, 0, '测试不发送 QQ 消息');
  console.log('PASS: quoted images reach vision model without original history; multiple images, dedupe, failure fallback and persistence');
} finally {
  await env.teardown();
}
