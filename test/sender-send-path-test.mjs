/**
 * 发送链路测试：「大图发不出去」那个故障的回归保护。
 *
 * 背景（用户实际报障）：
 *   `图画出来了但发送失败：fetch failed（图已存本地：…1.png）`
 *
 * 根因链：
 *   sendImage → onebot.sendImage(base64://…) → sendSegments → call()
 *                                                              ↓
 *                                            AbortSignal.timeout(15000)
 *   1.87MB 的图 → base64 后 2.49MB，要在 15 秒里完成
 *   「上传 body → 协议端解码 → 上传腾讯 → 返回」—— 走不完。
 *   留档记录里小 jpg(300–570KB) 全成功、PNG 大图(1.5–2.4MB) 全失败，尺寸相关性极强。
 *
 * 修法：图本来就已经落盘，改传**本地 file:// 路径**（协议端自己读盘），
 * body 从 2.5MB 降到约 100 字节 —— 三个数量级。base64 保留为回退。
 *
 * 本测试的核心断言就是**体积**：它是"修好了"最直接的证据。
 * 只断言"没有抛错"是不够的 —— 静默回退 base64 也不会抛错，但故障并没修。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import 业务代码之前设好，否则 config.js 会去动真实 data 目录
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sendpath-'));

const { SendQueue, toFileUri } = await import('../src/sender.js');

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

/** 造一个记录调用参数的协议端桩。 */
function makeOnebot({ failFileOnce = false } = {}) {
  const calls = [];
  let shouldFailFile = failFileOnce;
  return {
    calls,
    async sendImage(kind, id, ref, _opts) {
      const key = kind === 'group' ? 'group_id' : 'user_id';
      // 复刻 onebot.sendImage 真实构造的 params，量一下 body 有多大
      const params = { [key]: Number(id), message: [{ type: 'image', data: { file: ref } }] };
      const bodyBytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
      calls.push({ ref, bodyBytes });
      if (shouldFailFile && String(ref).startsWith('file://')) {
        shouldFailFile = false;
        throw new Error('模拟协议端读不到该路径');
      }
      return { message_id: calls.length };
    }
  };
}

const makeQueue = (onebot, logs = []) => new SendQueue({
  onebot,
  store: { appendSelf() {} },
  log: (m) => logs.push(String(m))
});

const makeImage = (bytes = 1.87 * 1024 * 1024) => {
  const buf = Buffer.alloc(Math.round(bytes), 0x41);
  return {
    filePath: 'C:/Users/Demo/AppData/Local/Temp/qq-agent-image-generate/a.png',
    dataUrl: 'base64://' + buf.toString('base64')
  };
};

console.log('\n== 发送链路：本地路径优先 ==');

{
  const img = makeImage();
  const onebot = makeOnebot();
  const q = makeQueue(onebot);
  await q.sendImage('group:456', { file: img.filePath, dataUrl: img.dataUrl }, { note: 'AI绘图' });

  check('只调了一次协议端（没走回退）', () => {
    assert.equal(onebot.calls.length, 1, `实际 ${onebot.calls.length} 次`);
  });

  check('传给协议端的是 file:/// URI（不是 base64）', () => {
    const ref = onebot.calls[0].ref;
    assert.ok(ref.startsWith('file:///'), ref.slice(0, 60));
    assert.ok(!ref.includes('base64'), '不应内联 base64');
  });

  check('★ body 从 MB 级降到 KB 级（这是修复有效的直接证据）', () => {
    const bytes = onebot.calls[0].bodyBytes;
    assert.ok(bytes < 1024, `body 应小于 1KB，实际 ${bytes} 字节`);
  });

  check('对照：同样这张图走 base64 会有多大（说明原来为什么必然超时）', () => {
    const b64Bytes = Buffer.byteLength(
      JSON.stringify({ group_id: 456, message: [{ type: 'image', data: { file: img.dataUrl } }] }),
      'utf8'
    );
    assert.ok(b64Bytes > 1024 * 1024, `base64 body 应大于 1MB，实际 ${b64Bytes}`);
    // 两个数量级以上的差距 —— 把这个数字打出来，便于日后回归时一眼看出退化
    const ratio = b64Bytes / onebot.calls[0].bodyBytes;
    console.log(`         base64 ${(b64Bytes / 1048576).toFixed(2)}MB vs 路径 ${onebot.calls[0].bodyBytes}B  → 缩小 ${Math.round(ratio)} 倍`);
    assert.ok(ratio > 100, `应缩小 100 倍以上，实际 ${Math.round(ratio)} 倍`);
  });
}

console.log('\n== 回退：协议端读不到本地路径时 ==');

{
  const img = makeImage(300 * 1024);
  const onebot = makeOnebot({ failFileOnce: true });
  const logs = [];
  const q = makeQueue(onebot, logs);
  await q.sendImage('group:457', { file: img.filePath, dataUrl: img.dataUrl }, {});

  check('file 失败后自动回退 base64（共调两次）', () => {
    assert.equal(onebot.calls.length, 2, `实际 ${onebot.calls.length} 次`);
    assert.ok(onebot.calls[0].ref.startsWith('file:///'), '第一次应是本地路径');
    assert.ok(onebot.calls[1].ref.startsWith('base64://'), '第二次应是 base64');
  });

  check('回退这件事留了日志（降级不能静默）', () => {
    assert.ok(logs.some((m) => m.includes('回退')), `日志: ${JSON.stringify(logs)}`);
  });
}

console.log('\n== 边界 ==');

{
  const img = makeImage(50 * 1024);
  const onebot = makeOnebot();
  const q = makeQueue(onebot);
  await q.sendImage('group:458', { dataUrl: img.dataUrl }, {});

  check('只有 dataUrl（无本地路径）→ 直接用 base64，不做无意义重试', () => {
    assert.equal(onebot.calls.length, 1, `实际 ${onebot.calls.length} 次`);
    assert.ok(onebot.calls[0].ref.startsWith('base64://'));
  });
}

{
  const onebot = makeOnebot();
  const q = makeQueue(onebot);
  let err = null;
  try { await q.sendImage('group:459', {}, {}); } catch (e) { err = e; }

  check('三样都没有 → 明确报「图片地址为空」', () => {
    assert.ok(err, '应该抛错');
    assert.ok(err.message.includes('图片地址为空'), err.message);
    assert.equal(onebot.calls.length, 0, '不应调协议端');
  });
}

{
  const img = makeImage(30 * 1024);
  const onebot = makeOnebot();
  const q = makeQueue(onebot);
  await q.sendImage('group:460', { file: img.filePath }, {});

  check('协议端能读到路径时：只给 file 也直接用路径（不回退）', () => {
    assert.equal(onebot.calls.length, 1);
    assert.ok(onebot.calls[0].ref.startsWith('file:///'));
  });

  // 去重：check() 是同步的，不能把 async 函数塞进去（否则断言失败会变成
  // 未捕获的 rejection，测试反而"绿"）。这里先 await 拿结果，再同步断言。
  let dupMsg = null;
  try { await q.sendImage('group:460', { file: img.filePath }, {}); } catch (e) { dupMsg = e.message; }
  check('同一张图重复发 → 被去重拦住（不产生第二次协议端调用）', () => {
    assert.ok(dupMsg && dupMsg.includes('刚刚发过'), String(dupMsg));
    assert.equal(onebot.calls.length, 1, '被去重的请求不应到达协议端');
  });
}

{
  // send_image（发网图）那条路：它的入参本来就是一个 http 直链，
  // 而 OneBot 的 image 段原生支持 http，让协议端自己取，body 只剩几十字节。
  // 这里用 5MB（maxBytesMB 默认值）—— base64 后 6.7MB，是笔误都难碰上的体积。
  const img = makeImage(5 * 1024 * 1024);
  const onebot = makeOnebot();
  const q = makeQueue(onebot);
  await q.sendImage('group:461', { url: 'https://example.com/big.jpg', dataUrl: img.dataUrl }, {});

  check('★ 有 url 时优先传 url（协议端自取，5MB 的图 body 仍不足 1KB）', () => {
    assert.equal(onebot.calls.length, 1, `实际 ${onebot.calls.length} 次`);
    assert.equal(onebot.calls[0].ref, 'https://example.com/big.jpg');
    assert.ok(onebot.calls[0].bodyBytes < 1024, `body 应小于 1KB，实际 ${onebot.calls[0].bodyBytes}`);
  });
}

console.log('\n== 只给本地路径时，协议端读不到 → 自身读盘转 base64 ==');

{
  // 真实场景：macOS 上 OneBot 跑在 Docker 容器里，容器看不到宿主机路径。
  // 梗鲸表情包 / 猪猪图片 / 回复配图这些技能只传 { file }（自己下载落盘），
  // 若 SendQueue 只在"调用方另给 dataUrl"时才回退，这些图片技能 100% 发不出图。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sendpath-file-'));
  const filePath = path.join(dir, 'meme with space.png');
  const bytes = Buffer.from('local-image-bytes-for-fallback');
  fs.writeFileSync(filePath, bytes);

  const onebot = makeOnebot({ failFileOnce: true });
  const logs = [];
  const q = makeQueue(onebot, logs);
  await q.sendImage('group:462', { file: filePath }, {});

  check('file 失败后自动读盘转 base64（共调两次）', () => {
    assert.equal(onebot.calls.length, 2, `实际 ${onebot.calls.length} 次`);
    assert.ok(onebot.calls[0].ref.startsWith('file:///'), '第一次应是本地路径');
    assert.ok(onebot.calls[1].ref.startsWith('base64://'), '第二次应是 base64');
  });

  check('base64 内联的是那个文件本身的字节', () => {
    const b64 = onebot.calls[1].ref.slice('base64://'.length);
    assert.ok(Buffer.from(b64, 'base64').equals(bytes), '内联内容应与文件字节一致');
  });

  check('回退留了日志', () => {
    assert.ok(logs.some((m) => m.includes('回退')), `日志: ${JSON.stringify(logs)}`);
  });

  // 文件根本不存在时：保留原始协议端错误，而不是抛一个读文件的无关错误
  const onebot2 = makeOnebot({ failFileOnce: true });
  const q2 = makeQueue(onebot2);
  let msg2 = null;
  try { await q2.sendImage('group:463', { file: path.join(dir, 'missing.png') }, {}); } catch (e) { msg2 = e.message; }
  check('本地文件也不存在 → 原样抛出协议端错误', () => {
    assert.ok(msg2 && msg2.includes('模拟协议端读不到该路径'), String(msg2));
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n== 与 toFileUri 的衔接 ==');
{
  check('反斜杠路径经 SendQueue 后也是规范 URI', () => {
    const BS = String.fromCharCode(92);
    const win = ['C:', 'Users', 'Demo', 'a b.png'].join(BS);
    assert.equal(toFileUri(win), 'file:///C:/Users/Demo/a%20b.png');
  });
}

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
