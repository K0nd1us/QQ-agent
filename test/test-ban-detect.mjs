// 禁言/风控识别：资源下载失败（retcode=100 HTTP download failed）不得误判为禁言
import assert from 'node:assert';
import { SendQueue } from '../src/sender.js';

function msg(s) { return { message: s }; }

assert.ok(SendQueue.isBannedError(msg('send group message failed: Ban state forbit write req')));
assert.ok(SendQueue.isBannedError(msg('OneBot send_group_msg 失败: retcode=100 禁言中')));
assert.ok(SendQueue.isBannedError(msg('账号被限制发言')));

assert.ok(!SendQueue.isBannedError(msg('OneBot send_group_msg 失败: retcode=100 HTTP download failed: 400')));
assert.ok(!SendQueue.isBannedError(msg('retcode=100 HTTP download failed: 403')));
assert.ok(!SendQueue.isBannedError(msg('图片资源下载失败')));

console.log('  ✓ 禁言识别：真禁言命中，download failed 不误判');
console.log('ban-detect 测试通过 ✅');
