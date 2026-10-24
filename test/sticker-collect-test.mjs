// 表情收藏链测试（2026-09-26）
//
// 背景（现场实测后的链路修正）：
//   · collect_sticker 此前只做本地转存、不入 QQ 收藏 —— 直链 rkey 过期后产生
//     "收藏成功却永远发不出去"的僵尸条目（现场实测直链 400）；部署换目录后
//     历史条目按旧绝对路径判定，集体过不了发送闸（现场 16/16 被拒）。
//   · 修正后 collect **必定调用 add_custom_face**（QQ"把图片变成表情"的同款能力），
//     本地转存降为双保险；条目带 emojiId / qqFile / persistFailed。
//
// 本套件用临时数据目录 + 本地 mock OneBot 驱动**真实** StickerManager / SendQueue：
//   1. 收藏必定入 QQ 收藏（base64）+ 备注回写 + 本地双保险 + 过发送闸
//   2. 拿不到字节时把 url 交给 QQ 服务端自取 → 条目用长效表情 url（消灭僵尸条目）
//   3. add_custom_face 失败不阻断本地收藏，如实标注 qqCollectError
//   4. 幂等补录：老条目重复收藏时补进 QQ 收藏
//   5. 搬家自愈：旧绝对路径按文件名重定位到受控目录（healLocalPaths / localStickerPath）
//   6. sender：本地 file:/// 被拒 → base64 内联回退（修"本地收藏永远发不出去"）
//
// 运行：node test/sticker-collect-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createChecker, sleep } from './_harness.mjs';

// ── 环境：临时数据目录（必须在 import src 模块之前设好）──────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-sticker-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'sticker-images'), { recursive: true });

// 1x1 PNG 夹具
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const fixtureCache = path.join(dataDir, 'cache-src.png');
fs.writeFileSync(fixtureCache, PNG);

// ── mock OneBot（HTTP API，行为按场景切换）──────────────────────────────
const scenario = {
  getImage: {},            // get_image 返回体
  addResult: { status: 'ok', retcode: 0, data: { emoji_id: 'E1' } },
  favList: [{ emoji_id: 'E1', resId: 'E1', url: 'https://p.qpic.cn/qq_expression/test/E1.png', md5: 'M1' }],
  rejectFileRef: false,    // send_group_msg 拒收 file:/// 形态
  rejectAll: false         // send_group_msg 全拒（测两种形态都失败的报错）
};
const calls = [];          // { action, body }
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const action = String(req.url || '').replace(/^\//, '');
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (action !== 'expired.jpg') calls.push({ action, body });
    if (action === 'get_image') return reply({ status: 'ok', retcode: 0, data: scenario.getImage });
    if (action === 'add_custom_face') return reply(scenario.addResult);
    if (action === 'modify_custom_face') return reply({ status: 'ok', retcode: 0, data: null });
    if (action === 'fetch_custom_face_detail') return reply({ status: 'ok', retcode: 0, data: scenario.favList });
    if (action === 'send_group_msg') {
      const seg = (body.message || []).find((s) => s.type === 'image') || {};
      const ref = String(seg?.data?.file || '');
      if (scenario.rejectAll || (scenario.rejectFileRef && ref.toLowerCase().startsWith('file:///'))) {
        return reply({ status: 'failed', retcode: 100, wording: '不支持的文件形态' });
      }
      return reply({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    }
    if (action === 'expired.jpg') { res.writeHead(400); res.end('expired'); return; }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作' }));
  });
});
const mockPort = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));
const base = `http://127.0.0.1:${mockPort}`;

const { OneBotClient } = await import('../src/onebot.js');
const { StickerManager, localStickerPath } = await import('../src/sticker-manager.js');
const { normalizeStickerEntry, loadStickerStore, saveStickerStore } = await import('../src/stickers.js');
const { SendQueue } = await import('../src/sender.js');

const onebot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: base, accessToken: '', httpToken: '', onEvent: () => {} });
const callsOf = (action) => calls.filter((c) => c.action === action);
const fileUriOf = (p) => `file:///${p.replace(/\\/g, '/')}`;

const c = createChecker('表情收藏链（collect 必定入 QQ 收藏）');

// ── 1. 缓存路径：必定 add_custom_face + 备注回写 + 本地双保险 ────────────
await c.check('收藏必定调用 add_custom_face（base64 入库）+ modify_custom_face 回写备注', async () => {
  scenario.getImage = { file: fixtureCache };
  scenario.addResult = { status: 'ok', retcode: 0, data: { emoji_id: 'E1' } };
  const sm = new StickerManager(onebot);
  const saved = await sm.collect('1001', { url: '', file: 'CACHEID.jpg', note: '小蓝鲸举牌' });
  const adds = callsOf('add_custom_face');
  assert.ok(adds.length >= 1, '应调用过 add_custom_face');
  assert.ok(String(adds[0].body.file).startsWith('base64://'), `入应用 base64 形态：${String(adds[0].body.file).slice(0, 20)}`);
  const mods = callsOf('modify_custom_face');
  assert.ok(mods.some((m) => m.body.emoji_id === 'E1' && m.body.desc === '小蓝鲸举牌'), '备注应回写进 QQ 收藏');
  assert.equal(saved.emojiId, 'E1');
  assert.equal(saved.qqCollectError, '');
  assert.equal(saved.persistFailed, false);
  assert.ok(saved.localFile.startsWith('file:///'), '本地转存双保险应落地');
  assert.ok(localStickerPath(saved.url), '新收藏应过发送闸');
});

await c.check('normalize 保留 emojiId / qqFile / persistFailed / localFile（sync 不再剥掉）', () => {
  const n = normalizeStickerEntry({ id: 'x', emojiId: 'E9', qqFile: 'a.jpg', persistFailed: true, localFile: 'file:///t.png' });
  assert.equal(n.emojiId, 'E9');
  assert.equal(n.qqFile, 'a.jpg');
  assert.equal(n.persistFailed, true);
  assert.equal(n.localFile, 'file:///t.png');
});

// ── 2. 拿不到字节：url 交给 QQ 服务端自取 → 长效表情 url（消灭僵尸条目）──
await c.check('转存拿不到字节时仍入 QQ 收藏（服务端自取 url），条目用长效表情 url', async () => {
  calls.length = 0;
  scenario.getImage = {};
  const sm = new StickerManager(onebot);
  const saved = await sm.collect('2002', { url: `${base}/expired.jpg`, file: 'NOCACHE.jpg', note: '僵尸样本修复' });
  const adds = callsOf('add_custom_face');
  assert.equal(adds.length, 1, '应恰好调用一次 add_custom_face');
  assert.equal(adds[0].body.file, `${base}/expired.jpg`, '没字节时应把原 url 交给 QQ 服务端自取');
  assert.equal(saved.emojiId, 'E1');
  assert.equal(saved.url, 'https://p.qpic.cn/qq_expression/test/E1.png', '应使用 QQ 收藏回查的长效表情 url');
  assert.equal(saved.persistFailed, false, '进了 QQ 收藏就不是僵尸条目');
});

// ── 3. add 失败不阻断本地收藏，如实标注 ──────────────────────────────────
await c.check('add_custom_face 失败：本地收藏照常、qqCollectError 如实标注', async () => {
  calls.length = 0;
  scenario.getImage = { file: fixtureCache };
  scenario.addResult = { status: 'failed', retcode: 200, wording: '图片格式不支持' };
  const sm = new StickerManager(onebot);
  const saved = await sm.collect('3003', { url: '', file: 'C3.jpg', note: '入收藏失败样本' });
  assert.equal(saved.emojiId, '');
  assert.ok(/图片格式不支持/.test(saved.qqCollectError), `应带失败原因：${saved.qqCollectError}`);
  assert.ok(localStickerPath(saved.url), '本地收藏仍应可发');
  assert.equal(saved.persistFailed, false);
});

// ── 4. 幂等补录：老条目重复收藏时补进 QQ 收藏 ────────────────────────────
await c.check('幂等补录：无 emojiId 的老条目再收藏一次会被补进 QQ 收藏', async () => {
  calls.length = 0;
  scenario.getImage = { file: fixtureCache };
  scenario.addResult = { status: 'ok', retcode: 0, data: { emoji_id: 'E1' } };
  saveStickerStore([{ id: 'collected_4004', resId: 'collected_4004', url: 'https://example.com/old.jpg', source: 'ai' }]);
  const sm = new StickerManager(onebot);
  const saved = await sm.collect('4004', { url: '', file: 'C4.jpg', note: '补录' });
  assert.equal(callsOf('add_custom_face').length, 1, '应补调 add_custom_face');
  assert.equal(saved.emojiId, 'E1');
  assert.ok(localStickerPath(saved.url), '地址应升级为本地转存');
});

// ── 5. 搬家自愈 ─────────────────────────────────────────────────────────
await c.check('搬家自愈：旧绝对路径按文件名重定位到受控目录（构造时自动修好）', () => {
  const pic = path.join(dataDir, 'sticker-images', 'moved.png');
  fs.writeFileSync(pic, PNG);
  saveStickerStore([{ id: 'collected_5005', resId: 'collected_5005', source: 'ai', url: fileUriOf('C:/somewhere/old-deploy/sticker-images/moved.png') }]);
  // 旧路径直接查：受控目录内存在同名文件 → 自愈解析应命中
  assert.ok(localStickerPath(fileUriOf('C:/somewhere/old-deploy/sticker-images/moved.png')), 'localStickerPath 应按文件名自愈');
  // 构造时 healLocalPaths 应把条目 url 重写到受控目录
  const sm = new StickerManager(onebot);
  const e = sm.entries.find((x) => x.id === 'collected_5005');
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  assert.ok(norm(e.url).includes(norm(path.join(dataDir, 'sticker-images'))), `url 应重写到受控目录：${e.url}`);
  assert.ok(localStickerPath(e.url), '自愈后应过发送闸');
});

// ── 6. sender：本地 file:/// 被拒 → base64 回退 ──────────────────────────
const fakeStore = { appendSelf() {} };

await c.check('本地表情 file:/// 被协议端拒收时，自动转 base64 重发成功', async () => {
  calls.length = 0;
  scenario.rejectFileRef = true;
  const pic = path.join(dataDir, 'sticker-images', 'send-me.png');
  fs.writeFileSync(pic, PNG);
  const sq = new SendQueue({ onebot, store: fakeStore });
  const r = await sq.sendSticker('group:123', { id: 'collected_6006', url: fileUriOf(pic) });
  assert.equal(r.message_id, 9001);
  const sends = callsOf('send_group_msg');
  const refs = sends.map((s) => String(s?.body?.message?.[0]?.data?.file || ''));
  assert.equal(sends.length, 2, `应先试 file 形态再试 base64（实发 ${sends.length} 次：${JSON.stringify(refs).slice(0, 120)}）`);
  assert.ok(refs[0].startsWith('file:///'), `第一次应是 file:///${' '}，实际 ${refs[0].slice(0, 60)}`);
  assert.ok(refs[1].startsWith('base64://'), `第二次应是 base64 内联，实际 ${refs[1].slice(0, 30)}`);
});

await c.check('两种形态都被拒时报错含双方原因（不再是哑抛）', async () => {
  scenario.rejectAll = true;
  const sq = new SendQueue({ onebot, store: fakeStore });
  const pic = path.join(dataDir, 'sticker-images', 'send-me.png');
  await assert.rejects(
    () => sq.sendSticker('group:123', { id: 'collected_6007', url: fileUriOf(pic) }),
    (e) => /两种形态都发不出去/.test(String(e.message)) && /base64=/.test(String(e.message)),
    '错误应同时带上 file 与 base64 两次失败的原因'
  );
});

mock.close();
fs.rmSync(dataDir, { recursive: true, force: true });
await sleep(50);
console.log('');
process.exit(c.finish() ? 0 : 1);
