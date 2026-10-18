import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-guard-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const originalFetch = globalThis.fetch;
try {
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
  const { deepSeekSearch, webSearch } = await import('../src/web-search.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch.provider = 'deepseek';
  cfg.webSearch.deepseek = { apiKey: 'test-key', model: 'test-search', baseUrl: 'https://compat.example/responses', timeoutMs: 10000 };
  setRuntimeConfig(cfg);
  let payload, calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, cfg.webSearch.deepseek.baseUrl);
    assert.equal(options.headers.authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(options.body).tools, [{ type: 'web_search' }]);
    return Response.json(payload);
  };
  const source = 'https://official.example/notice';
  const call = { type: 'web_search_call', status: 'completed', action: { sources: [{ url: source }] } };
  const message = url => ({ type: 'message', content: [{ type: 'output_text', text: '模型整理的摘要', annotations: [{ type: 'url_citation', url, title: '公告' }] }] });
  for (const data of [
    { output_text: '模型记忆回答' },
    { status: 'completed', output: [message(source)] },
    { status: 'completed', output: [call, { type: 'message', content: [{ text: '没有来源' }] }] },
    { status: 'incomplete', output: [call, message(source)] },
    { status: 'completed', output: [{ ...call, status: 'failed' }, message(source)] },
    { status: 'completed', output: [call, message('https://unretrieved.example/')] },
    { status: 'completed', output: [call, message('javascript:alert(1)')] },
    { status: 'completed', output: [call, message('https://user:password@official.example/notice')] }
  ]) {
    payload = data;
    await assert.rejects(() => deepSeekSearch('test'), /搜索|来源/);
  }
  payload = { status: 'completed', output: [call, message(source), message(source)] };
  const result = await webSearch('test');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, source);
  assert.equal(result.results[0].verificationRequired, true);
  assert.ok(result.fetchedAt);
  cfg.webSearch.deepseek.baseUrl = 'https://api.deepseek.com/responses';
  const before = calls;
  await assert.rejects(() => deepSeekSearch('test'), /官方 API 当前不支持/);
  assert.equal(calls, before, 'unsupported official endpoint does not spend tokens');
  console.log('PASS search execution/completion/source guards, deduplication and zero-call official endpoint rejection');
} finally { globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
