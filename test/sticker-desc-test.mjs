// mergeStickerLibrary 不该用「空的 desc」覆盖已存的 desc。
//
// 上游写法：desc: String(item.desc ?? old?.desc ?? '').trim()
//   `??` 只在 null/undefined 时回退 —— 但同步回来的 desc 常常是**空串**，
//   空串不是 nullish，于是已存的 desc 被直接冲成空。
//   表现：每同步一次 QQ 收藏表情，本地存着的备注就没了。
//
// 用户手写的备注走的是 localNote（applyStickerNote 只写它），那条路一直没被碰 ——
// 所以本 bug 影响的是 desc 这个字段本身。修复只改判空方式，不动任何字段语义。
//
// 运行：node test/sticker-desc-test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR 在 config.js 导入时就会求值（stickers.js 顶层就用了它拼 STICKER_FILE），
// 所以必须先设好环境变量再动态 import。
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-sticker-'));

const { mergeStickerLibrary } = await import('../src/stickers.js');

const BASE = { emoji_id: 'e1', resId: 'res1', url: 'http://x/1.png' };
const existing = [{ id: 'e1', resId: 'res1', url: 'http://x/1.png', desc: '已存的备注' }];
const descOf = (list, id = 'e1') => list.find((e) => e.id === id)?.desc;

// ── 1. 核心：同步回来空 desc，不能冲掉已存的 ──
assert.strictEqual(
  descOf(mergeStickerLibrary(existing, [{ ...BASE, desc: '' }])),
  '已存的备注',
  '空字符串不该覆盖已存的 desc'
);

// ── 2. 只给空白字符也算空（trim 之后是空串）──
assert.strictEqual(
  descOf(mergeStickerLibrary(existing, [{ ...BASE, desc: '   ' }])),
  '已存的备注',
  '纯空白不该覆盖已存的 desc'
);

// ── 3. 完全没有 desc 字段（undefined）本来就不该覆盖 —— 守住原有行为，别改坏 ──
assert.strictEqual(
  descOf(mergeStickerLibrary(existing, [{ ...BASE }])),
  '已存的备注',
  '缺字段时不该覆盖'
);

// ── 4. 非空 desc 要能更新（QQ 侧真改了备注，得同步过来）──
assert.strictEqual(
  descOf(mergeStickerLibrary(existing, [{ ...BASE, desc: 'QQ 侧新备注' }])),
  'QQ 侧新备注',
  '非空 desc 应当更新'
);

// ── 5. 首次收藏（没有 old）时空 desc 就是空，不能变成 "undefined" 之类的字面量 ──
{
  const fresh = mergeStickerLibrary([], [{ emoji_id: 'e2', resId: 'res2', url: 'http://x/2.png', desc: '' }]);
  const e = fresh.find((x) => x.id === 'e2');
  assert.ok(e, '首次收藏的条目应当被保留');
  assert.strictEqual(e.desc, '', '首次收藏且无备注时 desc 应为空串');
}

// ── 6. 同步绝不能碰 localNote（用户手写的备注走这里）──
{
  const withNote = [{
    id: 'e1', resId: 'res1', url: 'http://x/1.png',
    desc: 'QQ 侧备注', localNote: '我写的备注'
  }];
  const merged = mergeStickerLibrary(withNote, [{ ...BASE, desc: '' }]);
  const e = merged.find((x) => x.id === 'e1');
  assert.strictEqual(e.localNote, '我写的备注', 'localNote 不该被同步影响');
  assert.strictEqual(e.desc, 'QQ 侧备注', 'desc 也不该被空值冲掉');
}

// ── 7. 其它字段照旧跟随同步（确认这个改动只影响 desc）──
{
  const merged = mergeStickerLibrary(existing, [{ ...BASE, url: 'http://x/new.png', md5: 'abc' }]);
  const e = merged.find((x) => x.id === 'e1');
  assert.strictEqual(e.url, 'http://x/new.png', 'url 应当被同步更新');
  assert.strictEqual(e.md5, 'ABC', 'md5 应当被同步更新并大写');
}

console.log('✓ stickers desc 不被空值覆盖自测全部通过');
