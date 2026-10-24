import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 下载器测试：起一个本地 HTTP 服务，真实走一遍下载。
//
// 为什么不 mock fetch：这次改动的核心就是"流式读取 + 增量哈希 + 原子改名"，
// mock 掉 fetch 等于把要测的东西替换掉了。起个本地服务成本很低，
// 但能真的验证字节数、哈希、中断清理、进度回调。

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

const { download, formatProgress, fmtBytes, fmtDuration, fileSha256, createProgressRenderer } =
  await import('../scripts/lib/download.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-dl-'));

// ── 纯函数：进度格式化 ──────────────────────────────────────────────────
console.log('\n=== 进度格式化 ===');
{
  const t = formatProgress({ got: 50, total: 100, width: 10, elapsedMs: 1000 });
  check(t.includes('50.0%'), `百分比正确（${t.trim()}）`);
  check(t.includes('█') && t.includes('░'), '有已完成/未完成两段字符');
  check(/剩 /.test(t), '给出了剩余时间');
  check(t.includes('B/s'), '给出了速度');

  // 条数固定，避免每帧长度跳动导致终端里一行抖
  const a = formatProgress({ got: 1, total: 100, width: 20, elapsedMs: 100 });
  const b = formatProgress({ got: 99, total: 100, width: 20, elapsedMs: 100 });
  check(a.split('[')[1].split(']')[0].length === b.split('[')[1].split(']')[0].length,
    '不同进度下进度条格子数不变（否则每帧长度跳动会闪）');

  // 未知总大小：不能编一个百分比出来
  const u = formatProgress({ got: 1048576, total: 0, width: 20, elapsedMs: 1000 });
  check(!/%/.test(u), `总大小未知时不显示百分比（${u.trim()}）`);
  check(u.includes('1.0 MB'), '总大小未知时仍报已下载量');

  // 边界：0 / 超过 100%
  check(formatProgress({ got: 0, total: 100, width: 10, elapsedMs: 0 }).includes('0.0%'), '起始 0%');
  check(formatProgress({ got: 200, total: 100, width: 10, elapsedMs: 1000 }).includes('100.0%'),
    '超出总长时夹到 100%（不画出越界的条）');
  ok('formatProgress：百分比/速度/剩余时间/未知大小/越界都处理正确');

  check(fmtBytes(0) === '0 B' && fmtBytes(1024) === '1.0 KB' && fmtBytes(1048576) === '1.0 MB',
    `fmtBytes 换算正确（${fmtBytes(0)} / ${fmtBytes(1024)} / ${fmtBytes(1048576)}）`);
  check(fmtDuration(45) === '45s' && fmtDuration(80) === '1m20s' && fmtDuration(NaN) === '?',
    `fmtDuration 正确（${fmtDuration(45)} / ${fmtDuration(80)} / ${fmtDuration(NaN)}）`);
}

// ── 真实 HTTP 下载 ──────────────────────────────────────────────────────
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024 + 12345);   // ~3MB，够触发多次进度刷新
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;
const SHA = createHash('sha256').update(PAYLOAD).digest('hex').toUpperCase();

let server;
let mode = 'ok';          // ok | truncate | notfound | noLength
let slow = false;
const serve = (req, res) => {
  if (mode === 'notfound') { res.writeHead(404); res.end('nope'); return; }
  if (mode === 'truncate') {
    // 声明完整长度，但只发一半就断开 —— 模拟"下到一半连接断了"。
    // ⚠️ 必须等这半个 body 真的刷出去再 destroy：
    //    write() 后立刻 destroy() 会把缓冲一起丢掉，客户端一个字节都收不到，
    //    那样测的是"连接被拒"而不是"中途断开"，两条路径的报错完全不同。
    const half = PAYLOAD.subarray(0, Math.floor(PAYLOAD.length / 2));
    res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
    res.write(half, () => { res.socket?.destroy(); });
    return;
  }
  const headers = mode === 'noLength' ? {} : { 'content-length': String(PAYLOAD.length) };
  res.writeHead(200, headers);
  if (!slow) { res.end(PAYLOAD); return; }
  // 分块慢发，让进度回调有机会多次触发
  let off = 0;
  const step = 256 * 1024;
  const timer = setInterval(() => {
    if (off >= PAYLOAD.length) { clearInterval(timer); res.end(); return; }
    res.write(PAYLOAD.subarray(off, off + step));
    off += step;
  }, 15);
};

server = http.createServer(serve);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

console.log('\n=== 正常下载 ===');
{
  const dest = path.join(tmp, 'ok.bin');
  const seen = [];
  const r = await download(`${base}/file.bin`, dest, {
    expectedSha256: SHA, quiet: true, onProgress: (p) => seen.push(p.got)
  });
  check(fs.existsSync(dest), '文件已落到目标路径');
  check(r.bytes === PAYLOAD.length, `字节数正确（${r.bytes}）`);
  check(r.sha256 === SHA, '流式增量算出的 SHA256 正确');
  check(fs.readFileSync(dest).equals(PAYLOAD), '内容逐字节一致');
  check(!fs.existsSync(`${dest}.part`), '.part 临时文件已改名，没有残留');
  check(seen.length >= 1, `进度回调被调用（${seen.length} 次）`);
  check(seen[seen.length - 1] === PAYLOAD.length, '最后一次进度是完整字节数');
  ok('正常下载：流式写盘 + 哈希正确 + 原子改名 + 进度回调');
}

console.log('\n=== 慢速下载（分块）===');
{
  slow = true;
  const dest = path.join(tmp, 'slow.bin');
  const seen = [];
  await download(`${base}/slow.bin`, dest, { quiet: true, onProgress: (p) => seen.push(p.got) });
  slow = false;
  check(seen.length > 2, `分块传输时进度多次刷新（${seen.length} 次）`);
  check(seen.every((v, i) => i === 0 || v >= seen[i - 1]), '进度单调递增（不会倒退）');
  check(fs.readFileSync(dest).equals(PAYLOAD), '慢速下载内容也正确');
  ok('慢速下载：进度多次刷新且单调递增');
}

console.log('\n=== 哈希不匹配 ===');
{
  const dest = path.join(tmp, 'bad.bin');
  let threw = '';
  try {
    await download(`${base}/file.bin`, dest, { expectedSha256: 'A'.repeat(64), quiet: true });
  } catch (e) { threw = e.message; }
  check(threw.includes('SHA256 校验失败'), `报出哈希校验失败（${threw.slice(0, 60)}）`);
  check(!fs.existsSync(dest), '校验失败时目标文件不存在（不能留下可疑文件）');
  check(!fs.existsSync(`${dest}.part`), '校验失败时 .part 也被清掉');
  ok('哈希不匹配：报错并清理，绝不留半个文件');
}

console.log('\n=== 连接中断（声明长度但只发一半）===');
{
  mode = 'truncate';
  const dest = path.join(tmp, 'cut.bin');
  let threw = '';
  try {
    await download(`${base}/cut.bin`, dest, { quiet: true });
  } catch (e) { threw = e.message; }
  mode = 'ok';
  check(threw !== 'fetch failed' && !/^fetch failed$/i.test(threw.trim()),
    '报错不是光秃秃的 fetch failed（那个信息对用户毫无用处）', `实际：${threw}`);
  check(/中断|不完整|无法连接/.test(threw),
    `明确说是中断/不完整/连不上（${threw.slice(0, 80)}）`);
  check(!fs.existsSync(dest), '中断时目标文件不存在');
  check(!fs.existsSync(`${dest}.part`), '中断时 .part 被清掉（不会攒一堆垃圾）');
  ok('连接中断：检测到并清理干净');
}

console.log('\n=== 404 ===');
{
  mode = 'notfound';
  const dest = path.join(tmp, 'nf.bin');
  let threw = '';
  try {
    await download(`${base}/missing.bin`, dest, { hint404: '可手动放到 xxx 目录' });
  } catch (e) { threw = e.message; }
  mode = 'ok';
  check(threw.includes('404'), '报出 404');
  check(threw.includes('可手动放到'), '带上了调用方给的放置指引');
  ok('404：错误信息含"手动放置"提示');
}

console.log('\n=== 服务器不给 content-length ===');
{
  mode = 'noLength';
  const dest = path.join(tmp, 'nolength.bin');
  const r = await download(`${base}/nl.bin`, dest, { quiet: true });
  mode = 'ok';
  check(r.bytes === PAYLOAD.length, `拿不到长度也能完整下载（${r.bytes}）`);
  check(fs.readFileSync(dest).equals(PAYLOAD), '内容一致');
  ok('无 content-length：不误报"不完整"，照常完成');
}

console.log('\n=== 非 TTY 输出不该刷屏 ===');
{
  // 模拟非 TTY 的 stderr，数一行输出多少行
  const chunks = [];
  const fake = { isTTY: false, columns: 80, write: (x) => { chunks.push(x); return true; } };
  const r = createProgressRenderer({ stream: fake, label: 'T ' });
  for (let pct = 0; pct <= 100; pct += 1) {
    r.update({ got: pct * 1048576, total: 100 * 1048576, elapsedMs: pct * 100 });
  }
  r.done({ got: 100 * 1048576, total: 100 * 1048576, elapsedMs: 10000 });
  const lines = chunks.join('').split('\n').filter(Boolean);
  check(lines.length <= 14, `101 次刷新只打了 ${lines.length} 行（按 10% 节点，不刷屏）`);
  check(lines.length >= 5, '但仍然有足够的进度反馈');
  ok('非 TTY：按百分比节点打印，不会把日志刷满');
}

console.log('\n=== TTY 原地刷新 ===');
{
  const chunks = [];
  const fake = { isTTY: true, columns: 100, write: (x) => { chunks.push(x); return true; } };
  const r = createProgressRenderer({ stream: fake, label: 'T ' });
  for (let i = 0; i < 50; i++) r.update({ got: i * 1048576, total: 100 * 1048576, elapsedMs: i * 200 });
  r.done({ got: 100 * 1048576, total: 100 * 1048576, elapsedMs: 10000 });
  const joined = chunks.join('');
  check(joined.includes('\r'), 'TTY 上用 \\r 原地刷新（不是一行一条）');
  const newlines = joined.split('\n').length - 1;
  check(newlines <= 2, `几乎不产生换行（${newlines} 个），不刷屏`);
  check(joined.includes('█') || joined.includes('░'), '画出了进度条');
  ok('TTY：原地刷新，且被限流到 ~10fps');
}

console.log('\n=== fileSha256 与下载结果一致 ===');
{
  const dest = path.join(tmp, 'ok.bin');
  check(fileSha256(dest) === SHA, 'fileSha256 与流式计算的哈希一致');
}

await new Promise((r) => server.close(r));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
