/**
 * toFileUri 的单元测试。
 *
 * 为什么这个纯函数值得单独一个套件：
 * 它是「大图发不出去」那个故障的修复核心。如果它把 Windows 反斜杠漏转，
 * 输出会变成 `file:///C:\Users\...`（协议端读不到）→ sender 捕获后**静默回退 base64**
 * → 一切"看起来正常"，但故障根本没修。属于典型的「不报错、行为却坏掉」，
 * 必须有断言守住。
 *
 * ⚠️ 本文件里的反斜杠一律用 BS = String.fromCharCode(92) 构造。
 * 原因：上一版 toFileUri 就是用脚本批量写含反斜杠的代码时，
 * 多层转义把 `\/` 吃成 `/`，写出非法正则，导致整个 sender.js 加载即崩。
 * 零反斜杠写法让这类错误不可能发生。
 */
import assert from 'node:assert/strict';
import { toFileUri } from '../src/sender.js';

const BS = String.fromCharCode(92);          // 反斜杠字符本身
const bs = (...parts) => parts.join(BS);     // 用反斜杠拼接路径

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

console.log('\n== toFileUri ==');

check('Windows 反斜杠路径 → file:///C:/...', () => {
  const input = bs('C:', 'Users', 'Demo', 'AppData', 'Local', 'Temp', 'a.png');
  assert.equal(toFileUri(input), 'file:///C:/Users/Demo/AppData/Local/Temp/a.png');
});

check('正斜杠路径得到同样结果（两种写法必须等价）', () => {
  assert.equal(
    toFileUri('C:/Users/Demo/AppData/Local/Temp/a.png'),
    'file:///C:/Users/Demo/AppData/Local/Temp/a.png'
  );
});

check('已是 file:// URI → 幂等返回（不能被二次转换）', () => {
  const already = 'file:///C:/x/y.png';
  assert.equal(toFileUri(already), already);
  assert.equal(toFileUri(toFileUri('C:/x/y.png')), 'file:///C:/x/y.png');
});

check('大小写不敏感识别已有 URI（FILE:///）', () => {
  assert.equal(toFileUri('FILE:///C:/x.png'), 'FILE:///C:/x.png');
});

check('空格 → %20（协议端 decodeURIComponent 还原）', () => {
  const out = toFileUri('C:/a b/c d.png');
  assert.ok(out.includes('%20'), out);
  assert.ok(!out.includes(' '), out);
});

check('中文 → 百分号编码，且可无损还原', () => {
  const input = 'C:/图 片/猫.png';
  const out = toFileUri(input);
  assert.ok(!/[\u4e00-\u9fa5]/.test(out), `未编码中文: ${out}`);
  assert.equal(decodeURI(out), 'file:///C:/图 片/猫.png');
});

check('# 和 ? 必须转义（否则被当成 URI 分隔符截断）', () => {
  const out = toFileUri('C:/a#b?c.png');
  assert.ok(out.includes('%23'), `# 未转义: ${out}`);
  assert.ok(out.includes('%3F'), `? 未转义: ${out}`);
  assert.ok(!out.includes('#') && !out.includes('?'), out);
  // ⚠️ 这里必须用 decodeURIComponent，不能用 decodeURI。
  // decodeURI **故意不还原**保留字符（# ? & = 等）的转义 —— 拿它做往返断言会误报，
  // 让人以为"转义坏了"去改本来正确的实现。协议端用的正是 decodeURIComponent。
  assert.equal(decodeURIComponent(out), 'file:///C:/a#b?c.png');
});

check('往返一致：decodeURI 能还原成 file:/// + 原路径', () => {
  const input = bs('D:', 'my dir', '子目录', 'p.png');
  const out = toFileUri(input);
  assert.equal(decodeURI(out), 'file:///D:/my dir/子目录/p.png');
});

check('UNC 路径 → file://server/share/... （不是 file:////）', () => {
  const unc = '//server/share/img.png';
  const out = toFileUri(unc);
  assert.equal(out, 'file://server/share/img.png');
  assert.ok(!out.startsWith('file:////'), `斜杠数量不对: ${out}`);
});

check('前导斜杠被归一（/tmp/x.png 不能变成 file://///tmp）', () => {
  const out = toFileUri('/tmp/x.png');
  assert.equal(out, 'file:///tmp/x.png');
});

check('空输入 / 纯空白 / undefined → 空串（不产出 file:///）', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(toFileUri(v), '', `输入 ${JSON.stringify(v)} 得到了 ${toFileUri(v)}`);
  }
});

check('全部输出都以 file:// 开头（协议端识别的前提）', () => {
  const samples = ['C:/a.png', bs('C:', 'a.png'), '/tmp/a.png', '//srv/s/a.png'];
  for (const s of samples) {
    const out = toFileUri(s);
    assert.ok(out.startsWith('file://'), `${JSON.stringify(s)} → ${out}`);
  }
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
