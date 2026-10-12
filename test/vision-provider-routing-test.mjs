import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vision-routing-'));
process.env.QQ_AGENT_DATA_DIR = temporary;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { chatCompletion, chatCompletionWithRetry, resolveSpecializedApi } = await import('../src/llm.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.api = { ...cfg.api, provider: 'text', model: 'text-model', baseUrl: 'https://text.example/v1', visionModel: 'qwen3.8-flash', videoModel: 'video-model', apiKey: 'obsolete-direct-key' };
cfg.providers = [{ id: 'text', models: ['text-model'], baseURL: cfg.api.baseUrl }, { id: 'vision', models: ['qwen3.8-flash', 'video-model'], baseURL: 'https://vision.example/v1' }];
cfg.dshProviderKeys = { text: 'text-key', vision: 'vision-key' };
setRuntimeConfig(cfg);
const fetchOriginal = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  calls.push({ url, auth: options.headers.authorization, body });
  return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], model: body.model, usage: { total_tokens: 3 } });
};
try {
  await chatCompletion({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(calls.at(-1).url, 'https://text.example/v1/chat/completions'); assert.equal(calls.at(-1).auth, 'Bearer text-key');
  const images = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
  const result = await chatCompletionWithRetry({ messages: images }, 0);
  assert.equal(calls.at(-1).url, 'https://vision.example/v1/chat/completions'); assert.equal(calls.at(-1).auth, 'Bearer vision-key');
  assert.equal(calls.at(-1).body.model, 'qwen3.8-flash');
  assert.equal(result._usedApi.provider, 'vision'); assert.equal(result._usedApi.apiKey, undefined);
  await chatCompletion({ messages: [{ role: 'user', content: [...images[0].content, { type: 'video_url', video_url: { url: 'https://video.example/v' } }] }] });
  assert.equal(calls.at(-1).body.model, 'video-model'); assert.equal(calls.at(-1).auth, 'Bearer vision-key');
  await chatCompletion({ messages: images, overrides: { baseUrl: 'https://override.example/v1', model: 'explicit', apiKey: 'override-key' } });
  assert.equal(calls.at(-1).body.model, 'explicit'); assert.equal(calls.at(-1).auth, 'Bearer override-key');
  cfg.dshProviderKeys.vision = ''; setRuntimeConfig(cfg);
  const count = calls.length;
  await assert.rejects(() => chatCompletion({ messages: images }), /缺少接口地址或密钥/);
  assert.equal(calls.length, count, 'missing vision key never leaks the main key to a different endpoint');
  cfg.dshProviderKeys.vision = 'vision-key'; cfg.providers.push({ ...cfg.providers[1], id: 'duplicate' });
  assert.throws(() => resolveSpecializedApi('qwen3.8-flash', cfg.api, cfg), /多个提供商/);
  cfg.api.visionProvider = 'vision'; assert.equal(resolveSpecializedApi('qwen3.8-flash', cfg.api, cfg).provider, 'vision');
  cfg.api.videoModel = cfg.api.visionModel;
  cfg.api.videoProvider = 'duplicate'; cfg.dshProviderKeys.duplicate = 'video-key'; setRuntimeConfig(cfg);
  await chatCompletion({ messages: images });
  assert.equal(calls.at(-1).auth, 'Bearer vision-key', '同名视频模型不能覆盖图片提供商');
  await chatCompletion({ messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://video.example/v' } }] }] });
  assert.equal(calls.at(-1).auth, 'Bearer video-key', '同名模型按输入模态选供应商');
  assert.equal(resolveSpecializedApi('manual-model', cfg.api, { ...cfg, api: { ...cfg.api, visionProvider: '' } }).baseUrl, cfg.api.baseUrl);
  const { skillManager } = await import('../src/skills/manager.js');
  const originalCapabilities = skillManager.getCapabilityProviders;
  let feedback = 0;
  try {
    skillManager.getCapabilityProviders = name => name === 'llm.endpoint-pick'
      ? [{ fn: () => ({ id: 'pool', baseUrl: 'https://pool.example/v1', apiKey: 'pool-key' }) }]
      : name === 'llm.endpoint-feedback' ? [{ fn: () => { feedback++; } }] : [];
    cfg.api.visionProvider = 'text'; cfg.api.visionModel = 'text-model'; setRuntimeConfig(cfg);
    await chatCompletion({ messages: images });
    assert.equal(calls.at(-1).url, 'https://text.example/v1/chat/completions');
    assert.equal(calls.at(-1).auth, 'Bearer text-key');
    assert.equal(feedback, 0, 'pinned dedicated requests do not get billed to an unused pool account');
  } finally { skillManager.getCapabilityProviders = originalCapabilities; }
  console.log('PASS real request construction: text/vision/video providers and keys, override precedence, usage identity, missing-key and ambiguous-provider guards');
} finally { globalThis.fetch = fetchOriginal; fs.rmSync(temporary, { recursive: true, force: true }); }
