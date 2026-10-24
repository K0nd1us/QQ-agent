/**
 * 改动 src/ 之后的最后一道关：确认模块真的能加载、关键导出都在、关键行为符合预期。
 *
 * 为什么需要它（2026-09-14 真实故障）：
 *   修"大图发不出去"时，我用脚本批量往 `src/sender.js` 里写含反斜杠的正则，
 *   多层转义把 `\/` 吃成了 `/`，写出一句非法正则。`node --check` 其实报了 exit=1，
 *   但我的检查命令是 `node --check a.js && node --check b.js && ... && echo OK`，
 *   第一项失败后短路，而我在混排输出里看到了别的 "OK"，误以为全部通过。
 *   差点交付一个"加载即崩"的 sender.js —— 那会让所有出站消息失效，
 *   比原本要修的 bug 严重得多。
 *
 * 它检查的是**语法检查覆盖不到**的东西：
 *   1. ESM 顶层 import 是否真的成功（依赖缺失、循环引用、非法字面量都在这里暴露）
 *   2. 命名导出是否还在（改名/删函数时，引用方要到运行才炸）
 *   3. 关键纯函数的行为抽查（输出错字符不报错、只是行为悄悄变坏的那类）
 *   4. 分档/正则常量对**边界输入**的判断（宽前缀误纳是本项目踩过的坑）
 *
 * 用法：node scripts/preload-check.mjs   （或 npm run check:load）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = (rel) => new URL(rel, import.meta.url).href;
const file = (rel) => fileURLToPath(new URL(rel, import.meta.url));

let bad = 0;
const ok = (msg) => console.log(`  [ok]   ${msg}`);
const fail = (msg) => { bad++; console.log(`  [FAIL] ${msg}`); };

// ── 1) 模块能加载 + 关键导出还在 ────────────────────────────────────────────
const MODULES = [
  ['../src/sender.js', ['SendQueue', 'toFileUri']],
  ['../src/onebot.js', ['OneBotClient']],
  ['../src/tools.js', ['buildToolDefs', 'executeTool']],
  ['../src/config.js', ['getConfig']],
  ['../src/plugin-loader.js', ['loadPlugins']]
];

console.log('\n== 模块加载与导出 ==');
for (const [rel, expected] of MODULES) {
  try {
    const m = await import(url(rel));
    const missing = expected.filter((n) => !(n in m));
    if (missing.length) fail(`${rel.slice(3)} 缺少导出: ${missing.join(', ')}`);
    else ok(`${rel.slice(3)}  (${expected.join(', ') || '仅副作用'})`);
  } catch (e) {
    fail(`${rel.slice(3)} 加载失败: ${e.constructor.name}: ${String(e.message).split('\n')[0]}`);
  }
}

// ── 2) toFileUri 行为抽查 ──────────────────────────────────────────────────
// 它是"大图发不出去"的修复核心：把本地路径转成 OneBot 能识别的 file URI。
// 一旦转错，sender 会静默回退 base64 —— 不报错，但故障根本没修。
console.log('\n== toFileUri 行为 ==');
try {
  const { toFileUri } = await import(url('../src/sender.js'));
  const BS = String.fromCharCode(92);                    // 反斜杠（零转义写法）
  const cases = [
    [['C:', 'Users', 'a', 'b.png'].join(BS), 'file:///C:/Users/a/b.png', 'Windows 反斜杠路径'],
    ['C:/Users/a/b.png', 'file:///C:/Users/a/b.png', '正斜杠路径'],
    ['file:///C:/x.png', 'file:///C:/x.png', '已是 URI（须幂等）'],
    ['//srv/share/a.png', 'file://srv/share/a.png', 'UNC 路径']
  ];
  for (const [input, want, label] of cases) {
    const got = toFileUri(input);
    if (got === want) ok(`${label} -> ${got}`);
    else fail(`${label}: 期望 ${want}，实际 ${got}`);
  }
  // 保留字符必须转义，否则 URI 会被 # / ? 截断
  const hash = toFileUri('C:/a#b?c.png');
  if (hash.includes('%23') && hash.includes('%3F')) ok(`保留字符已转义 -> ${hash}`);
  else fail(`# ? 未转义: ${hash}`);
  if (decodeURIComponent(hash) === 'file:///C:/a#b?c.png') ok('转义可被 decodeURIComponent 还原');
  else fail(`还原不一致: ${decodeURIComponent(hash)}`);
} catch (e) {
  fail(`toFileUri 抽查失败: ${e.message}`);
}

// ── 3) 常量对边界输入的判断（宽前缀误纳是本项目踩过的坑）────────────────────
console.log('\n== OneBot 超时分档 ==');
try {
  const src = readFileSync(file('../src/onebot.js'), 'utf8');
  const m = src.match(/const SLOW_ACTION = (.+);/);
  if (!m) {
    fail('未找到 SLOW_ACTION 定义');
  } else {
    // 从源码里的正则字面量提取 pattern 与 flags：
    // lit = "/^(send_(group|private)|upload_|_send)/i" -> 最后一个 / 之前是 pattern，之后是 flags
    const lit = m[1].trim();
    const lastSlash = lit.lastIndexOf('/');
    const re = new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));
    // 扛大 body 的：需要宽容超时；轻量交互的：必须短超时（否则协议端不响应会干等）
    const cases = [
      ['send_group_msg', true], ['send_private_msg', true], ['send_group_forward_msg', true],
      ['upload_group_file', true], ['_send_group_notice', true],
      ['send_poke', false], ['friend_poke', false], ['group_poke', false],
      ['get_status', false], ['get_group_info', false]
    ];
    const wrong = cases.filter(([a, want]) => re.test(a) !== want);
    if (wrong.length) {
      for (const [a, want] of wrong) fail(`SLOW_ACTION 对 ${a} 判为 ${re.test(a)}，应为 ${want}`);
    } else {
      ok(`SLOW_ACTION 对 ${cases.length} 个 action 的判断全部符合预期`);
    }
  }
} catch (e) {
  fail(`分档检查失败: ${e.message}`);
}

console.log(bad ? `\n>>> ${bad} 项不通过\n` : '\n>>> 全部通过\n');
process.exit(bad ? 1 : 0);
