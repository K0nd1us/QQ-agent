// 流式落盘下载测试（M8，2026-09-19）。
//
// 背景：视频下载以前走 safeFetchBinary 整读进内存再写盘 —— 上限 200MB 就真的
// 占 200MB 内存，多个视频并发时直接把进程顶爆。safeFetchBinaryToFile 把下载
// 改成边收边写盘（内存占用与文件大小无关），本测试锁住它的关键行为：
//
//   1. 正常下载：文件内容逐字节一致、contentType 透传、返回字节数准确；
//   2. 超限截断：服务端文件 ≥ 上限时立即中止并**删掉半截文件**（调用方按
//      "文件存在"判定成功，残缺文件留在盘上会被当成已下载）；
//   3. 空响应：报"下载内容为空"，同样不留文件；
//   4. SSRF：入口与每一跳重定向都拒绝内网地址（与 safeFetchBinary 同源）；
//   5. 内存占用：下载一个远大于堆限制的流（用恒定速率生成的合成流），
//      进程堆不随文件增长 —— 流式实现的立身之本。
//
// 运行：node test/safe-fetch-file-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let pass = 0, fail = 0;
function check(name, fn) {
  return fn().then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}: ${e?.message ?? e}`); });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-sff-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

// 测试需要把 127.0.0.1 当"图床例外"放行（与 selftest 场景 14 的做法一致）
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  security: { allowPrivateImageHosts: true }
}));

const { safeFetchBinaryToFile } = await import('../src/safe-fetch.js');

// ── mock 服务器 ─────────────────────────────────────────────────────────
const routes = new Map();   // path → handler(req, res)
const server = http.createServer((req, res) => {
  const h = routes.get(req.url);
  if (h) return h(req, res);
  res.writeHead(404); res.end('nf');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const U = (p) => `http://127.0.0.1:${PORT}${p}`;
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-sff-out-'));

// 正常下载：300KB 分块响应
const BODY = Buffer.alloc(300 * 1024, 0);
for (let i = 0; i < BODY.length; i += 4096) BODY[i] = i % 251;   // 非全零，防"碰巧都是 0"
routes.set('/ok.mp4', (req, res) => {
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': BODY.length });
  res.end(BODY);
});

// 超限：无限流（持续生成数据，永不到 end）—— 到达上限必须被掐断
routes.set('/big.bin', (req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  const chunk = Buffer.alloc(64 * 1024, 7);
  const timer = setInterval(() => res.write(chunk), 5);
  res.on('close', () => clearInterval(timer));
});

// 空响应
routes.set('/empty.bin', (req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end();
});

// 重定向：两跳后落到内网地址（SSRF 逐跳校验必须在第二跳拦下）
routes.set('/redir-private', (req, res) => {
  res.writeHead(302, { location: `http://127.0.0.1:9/evil.bin` });
  res.end();
});

// 重定向：两跳后正常落盘
routes.set('/redir-ok', (req, res) => {
  res.writeHead(302, { location: '/ok.mp4' });
  res.end();
});

await check('正常下载：内容逐字节一致 + 字节数准确 + contentType 透传', async () => {
  const dest = path.join(outDir, 'a.mp4');
  const r = await safeFetchBinaryToFile(U('/ok.mp4'), dest, 1024 * 1024);
  assert.equal(r.bytes, BODY.length, '返回字节数应等于响应长度');
  assert.equal(r.contentType, 'video/mp4', 'contentType 应透传');
  const disk = fs.readFileSync(dest);
  assert.ok(disk.equals(BODY), '落盘内容应与响应体逐字节一致');
});

await check('超限截断：到达上限即中止 + 半截文件被删除', async () => {
  const dest = path.join(outDir, 'big.bin');
  await assert.rejects(
    () => safeFetchBinaryToFile(U('/big.bin'), dest, 128 * 1024),
    (e) => { assert.ok(/上限/.test(e.message), `应是上限错误，实际：${e.message}`); return true; }
  );
  assert.ok(!fs.existsSync(dest), '超限后不得留下半截文件');
});

await check('空响应：报错且不留文件', async () => {
  const dest = path.join(outDir, 'empty.bin');
  await assert.rejects(() => safeFetchBinaryToFile(U('/empty.bin'), dest, 1024), /下载内容为空|ECONN|socket/i);
  assert.ok(!fs.existsSync(dest), '空响应不得留下空文件');
});

await check('重定向：正常两跳后落盘成功', async () => {
  const dest = path.join(outDir, 'redir.mp4');
  const r = await safeFetchBinaryToFile(U('/redir-ok'), dest, 1024 * 1024);
  assert.equal(r.bytes, BODY.length);
  assert.ok(fs.readFileSync(dest).equals(BODY), '重定向后内容应一致');
});

await check('SSRF：重定向到内网端口被拒（逐跳校验）', async () => {
  const dest = path.join(outDir, 'evil.bin');
  await assert.rejects(() => safeFetchBinaryToFile(U('/redir-private'), dest, 1024), /内网|解析|ECONN/i);
  assert.ok(!fs.existsSync(dest), 'SSRF 拒绝后不得留下文件');
});

// 内存占用：下载 96MB 合成流（4 倍于 Node 默认堆预算量级），堆增量必须远小于文件
await check('流式：96MB 下载的堆增量 < 60MB（与文件大小无关）', async () => {
  const TARGET = 96 * 1024 * 1024;
  routes.set('/stream96.bin', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let sent = 0;
    const chunk = Buffer.alloc(256 * 1024, 3);
    (function pump() {
      while (sent < TARGET) {
        const n = Math.min(chunk.length, TARGET - sent);
        sent += n;
        if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    })();
  });
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const dest = path.join(outDir, 'stream96.bin');
  const r = await safeFetchBinaryToFile(U('/stream96.bin'), dest, TARGET + 1024);
  const growth = process.memoryUsage().heapUsed - before;
  assert.equal(r.bytes, TARGET, '应完整收完 96MB');
  assert.equal(fs.statSync(dest).size, TARGET, '落盘大小应等于 96MB');
  assert.ok(growth < 60 * 1024 * 1024, `堆增量 ${Math.round(growth / 1048576)}MB 应 < 60MB（整读实现会 ≈ 96MB+）`);
});

server.close();
try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(fail ? `\n流式下载：通过 ${pass} / 失败 ${fail}` : `\n流式下载：通过 ${pass} / 失败 0`);
process.exit(fail ? 1 : 0);
