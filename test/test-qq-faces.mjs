// QQ 官方表情映射：入站 id→名称、出站标记→face 段
import assert from 'node:assert';
import { formatQqFace, resolveQqFaceId, describeQqFace } from '../src/qq-faces.js';

function pass(label) {
  console.log('  ✓ ' + label);
}

// 官方表：5 = 流泪
assert.equal(describeQqFace(5), '流泪');
assert.equal(formatQqFace(5), '[QQ表情:流泪(#5)]');
assert.equal(resolveQqFaceId('流泪(#5)'), '5');
assert.equal(resolveQqFaceId('5'), '5');
assert.equal(resolveQqFaceId('流泪'), '5');
assert.equal(resolveQqFaceId('QQ表情:流泪(#5)'), '5');
assert.equal(resolveQqFaceId('不存在的表情xyz'), '');
assert.equal(formatQqFace(''), '[QQ表情]');
pass('官方表映射与解析');

// textToMessageSegments 不导出，通过 onebot.sendText 间接验证会依赖 mock；
// 这里只验证 resolve + format 纯函数边界
assert.equal(resolveQqFaceId('#14'), '14');
assert.equal(describeQqFace(14), '微笑');
pass('边界：#前缀与其它官方 id');

console.log('QQ 表情映射测试全部通过 ✅');
