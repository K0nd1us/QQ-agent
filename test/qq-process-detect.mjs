import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// QQ 进程检测的回归测试。
//
// 这条 bug 值得单独写测试，因为它**在纯英文路径下完全不暴露**：
//   wmic 按系统 ANSI（中文系统 = GBK）输出，Node 按 UTF-8 读，
//   路径里的中文变成乱码，于是"QQ 明明在跑、界面却说未启动"。
// 实测踩到时，用户的目录正好叫 "qq-agent - 副本"。
//
// 所以这里不只做静态断言，还会**真的调一次**检测函数，
// 有 QQ 在跑时验证路径里没有乱码 —— 这才是能拦住回归的那一层。

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

const SRC = fs.readFileSync('src/app.js', 'utf8');

console.log('=== 静态：不再用 wmic ===');
{
  // wmic 有三个问题：ANSI 编码、CSV 逗号错位、Win11 24H2+ 已移除
  const wmicCalls = [...SRC.matchAll(/execFileAsync\(\s*'wmic'/g)].length;
  check(wmicCalls === 0, `不再调用 wmic（找到 ${wmicCalls} 处）`);
  // ⚠️ 要看**代码**里有没有用，不能看整个文件 —— 注释里里正好解释为什么要弃用它，
  //    直接对全文做正则会被自己写的说明文字判成违规。
  const codeOnly = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 去掉块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1');  // 去掉行注释（避免误删 https://）
  check(!/format:csv/.test(codeOnly), '代码里不再用 wmic 的 CSV 格式（路径含逗号会错位）');
  check(/format:csv/.test(SRC), '但注释里保留了对这个坑的说明（方便以后理解）');
}

console.log('\n=== 静态：PowerShell 必须显式强制 UTF-8 ===');
{
  check(/\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/.test(SRC),
    'PowerShell 命令里带了 [Console]::OutputEncoding=UTF8');
  check(/Get-CimInstance Win32_Process/.test(SRC), '用 Get-CimInstance 查进程');
  check(/ConvertTo-Json/.test(SRC), '输出 JSON（不是 CSV，避免逗号错位）');
  check(/-NonInteractive/.test(SRC), '带 -NonInteractive（避免某些环境挂住等输入）');
  check(/maxBuffer/.test(SRC), '设了 maxBuffer（进程多时输出会超默认 1MB）');
  check(/不要.*退回 wmic|不要在这里退回 wmic/.test(SRC),
    '注释里写明"查不到就返回空，不要退回 wmic"（乱码路径比空更糟）');
  check(/副本/.test(SRC) || /乱码/.test(SRC),
    '注释里记了这个坑（中文路径乱码 → 误判未启动）');
}

console.log('\n=== 静态：优先用自己 spawn 的 pid ===');
{
  check(/qqPortableProc && !qqPortableProc\.killed/.test(SRC),
    'qqPortableRunningPid 先检查本进程拉起过的那个');
  check(/process\.kill\(qqPortableProc\.pid, 0\)/.test(SRC),
    '用 signal 0 探测存活（不查系统，不受编码/权限影响）');
}

// ── 实测：真的调一次检测函数 ──
console.log('\n=== 实测：调用检测函数，看路径有没有乱码 ===');
{
  const i = SRC.indexOf('async function listQqProcesses');
  const j = SRC.indexOf('async function qqPortableRunningPid');
  if (i < 0 || j < 0) { bad('从源码里抠不出 listQqProcesses'); }
  else {
    const fn = new Function('execFile', 'promisify', `${SRC.slice(i, j)}\n return listQqProcesses;`);
    const listQqProcesses = fn(execFile, promisify);
    const procs = await listQqProcesses();
    if (procs.length === 0) {
      ok('当前没有 QQ 进程在跑，跳过实测（静态检查已覆盖）');
    } else {
      ok(`检测到 ${procs.length} 个 QQ.exe 进程`);
      // 乱码的典型表现：U+FFFD 替换字符，或成串的 '?'
      const garbled = procs.filter((p) => /\uFFFD|\?\?\?/.test(p.path));
      check(garbled.length === 0,
        '所有进程路径都没有乱码',
        garbled.slice(0, 2).map((p) => p.path).join('\n'));
      check(procs.every((p) => p.pid > 0 && p.path), '每个进程都有 pid 与路径');
      check(procs.every((p) => /QQ\.exe$/i.test(p.path)), '返回的都是 QQ.exe');
      // 非 ASCII 路径必须原样保留（这就是当初坏掉的地方）
      const nonAscii = procs.filter((p) => /[^\x00-\x7f]/.test(p.path));
      if (nonAscii.length) {
        console.log(`      （信息）有 ${nonAscii.length} 个进程路径含非 ASCII 字符，原样保留：`);
        console.log(`      ${nonAscii[0].path}`);
      }
    }
  }
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
