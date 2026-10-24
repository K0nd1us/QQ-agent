// 把装好的 QQ 打包成"免安装"归档，供 setup 直接下载解压。
//
// ── 为什么需要这个 ────────────────────────────────────────────────────
// QQ 9.9.x 用的是腾讯自研的 HummerSetup 安装器，**不支持静默安装**。
// 原来只能"让用户装一遍再复制"，但这在真实场景里有两个硬伤：
//
//   1. **装不上低版本**：机器上已经有更新的 QQ 时，装旧版会被拒绝或直接升级掉，
//      降级根本不成立 —— 而协议栈偏偏要求特定版本。
//   2. **不该动用户的 QQ**：为了做个便携版去覆盖用户日常用的 QQ，代价太大。
//
// 免安装包把"装"这一步整个去掉：解压即用，不碰系统里任何东西，
// 也不需要在目标机器上装 QQ。
//
// ── 为什么用 tar.zst ──────────────────────────────────────────────────
// 实测（1133 MB 的 versions/ 目录）：
//   zip(deflate) 525 MB / 67s    gzip 523 MB / 53s    zstd 509 MB / 6s
// zstd 又小又快（压缩阶段快 10 倍），而 Windows 自带的 bsdtar 原生支持解压，
// 不需要用户额外装任何工具。
//
// 用法：
//   node scripts/pack-qq-portable.mjs                  # 打包 runtime/qq-portable
//   node scripts/pack-qq-portable.mjs --from D:\QQ     # 从别处打包
//   node scripts/pack-qq-portable.mjs --out dist\QQ_portable.tar.zst
//   node scripts/pack-qq-portable.mjs --keep-updates   # 保留待安装的更新包（默认剥离）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 注意：被 import 时 process.argv 是**测试进程**的参数，
// 所以这些只在 main() 里真正使用，不做成模块级副作用。
const args = process.argv.slice(2);
const getArg = (name, dflt = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] || dflt) : dflt;
};

const log = (...a) => console.log('[pack]', ...a);
const warn = (...a) => console.warn('[pack] ⚠', ...a);
const die = (m) => { console.error('[pack] ❌', m); process.exit(1); };

const SRC = path.resolve(getArg('--from', path.join(ROOT, 'runtime', 'qq-portable')));
const KEEP_UPDATES = args.includes('--keep-updates');
// 格式默认 zip：更好认、双击能看、Windows/macOS/Linux 都原生支持。
// （实测 tar.zst 更小 509MB/6s vs zip 525MB/67s，但可移植性优先。）
// 想更小的话：--format tar.zst
const FORMAT = (getArg('--format', 'zip') || 'zip').toLowerCase();
const OUT = path.resolve(getArg('--out',
  path.join(ROOT, 'dist', `QQ_portable.${FORMAT === 'zip' ? 'zip' : 'tar.zst'}`)));

/**
 * 打包时要剥掉的东西。
 *
 * 原则：**只剥"明显不该带走"的**，宁可多带也不要少带 ——
 * 少一个文件的表现是"启动时才报错"，极难排查；多带几个文件只是大一点。
 */
export const STRIP_RULES = [
  // 日志：那是**打包者机器上**的运行日志，带过去既没用又泄露信息（路径、账号痕迹）
  { id: 'logs', test: (rel) => /\.log$/i.test(rel), why: '运行日志（属于打包者的机器，且可能含路径信息）' },
  // 卸载器：它记录的是**原始安装路径**（实测里面有 C:\Softwares\QQ 这种字样），带过去会误导
  { id: 'uninstall', test: (rel) => /^(Uninstall|QQUninst)\.(exe|xml)$/i.test(path.basename(rel)), why: '卸载器（记录了原安装路径）' },
  // 安装器留下的元数据：里面是一串不透明的**按次安装生成**的标识。
  // 实测只有 Bin\QQUrlMgr.exe（URL 关联处理器，便携场景根本不会跑）读它，
  // QQ.exe / QQNT.dll 都不读 —— 剥掉对便携运行没有影响。
  // 换掉它是有意为之：那是打包者那次安装留下的标识，不该跟着分发出去。
  { id: 'extrainfo', test: (rel) => /^ExtraInfo\.ini$/i.test(path.basename(rel)), why: '安装器留下的按次安装标识' }
];

/** 待安装的更新包：默认剥掉（几百 MB 的重复内容），但可用 --keep-updates 保留。 */
export function isStagedUpdate(rel) {
  // 形如 versions/9.9.33-51802-9.9.33-52230.zip
  return /^versions[\\/][^\\/]+-\d+\.\d+\.\d+-\d+\.zip$/i.test(rel);
}

/** 判断某个相对路径是否应当跳过；返回原因或 null。 */
export function stripReason(rel, { keepUpdates = false } = {}) {
  for (const r of STRIP_RULES) if (r.test(rel)) return r.why;
  if (!keepUpdates && isStagedUpdate(rel)) return '待安装的更新包（可用 --keep-updates 保留）';
  return null;
}

// ── 隐私扫描 ────────────────────────────────────────────────────────────
//
// 要发出去的东西不能靠印象保证"没有个人数据"，必须真的扫一遍。
//
// 分两档，因为两类命中的性质完全不同：
//   · **身份类**（用户名、用户主目录、源路径）—— 命中就**拒绝打包**。
//     这些是打包者的身份信息，散出去就是散出去了。
//   · **通用路径类**（C:\Users\、AppData、Desktop）—— 只提示。
//     腾讯自己的 dll 里就编了一堆开发商机器上的调试路径（PDB 路径之类），
//     那是发行版自带的东西，不是打包者的数据，拦下来只会让人没法打包。
//
// 只扫"文本化"的内容：把每个块按 latin1 解码后做子串匹配。
// 这样即使文件是二进制，内嵌的路径字符串也能被发现。

/** 身份类关键词：命中即拒绝打包。 */
export function identityNeedles(env = process.env) {
  const out = new Set();
  try {
    const u = os.userInfo().username;
    if (u && u.length >= 3) out.add(u);
  } catch { /* 取不到就算 */ }
  const home = os.homedir();
  if (home) {
    out.add(home.replace(/\\/g, '\\'));
    out.add(home.replace(/\\/g, '/'));
  }
  for (const k of ['USERNAME', 'USER', 'USERPROFILE', 'HOME']) {
    const v = env[k];
    if (v && v.length >= 3) out.add(v);
  }
  // 太短的词（如 "a"）会把整个包都命中，没有参考价值
  return [...out].filter((x) => x.length >= 3);
}

/** 通用路径类：只提示，不拦。 */
export const GENERIC_NEEDLES = ['C:\\Users\\', 'C:/Users/', '\\AppData\\', '/home/'];

/**
 * 扫描一个目录，返回命中的关键词与文件。
 * @returns {{identity: Array<{needle:string,file:string}>, generic: Array<{needle:string,file:string}>, scanned:number, bytes:number}}
 */
export function scanForPrivateData(dir, { identity = identityNeedles(), generic = GENERIC_NEEDLES } = {}) {
  const idHits = [];
  const genHits = [];
  const seen = new Set();
  let scanned = 0;
  let bytes = 0;
  const CHUNK = 4 * 1024 * 1024;

  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      if (rel === 'portable-info.json' || rel === 'README-portable.txt') continue;   // 自己写的，单独管
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      scanned += 1;
      bytes += size;
      if (size === 0) continue;
      let fd;
      try { fd = fs.openSync(full, 'r'); } catch { continue; }
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      while (pos < size) {
        let n;
        try { n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos); } catch { break; }
        if (n <= 0) break;
        const t = buf.subarray(0, n).toString('latin1');
        for (const needle of identity) {
          const key = needle + '\u0000' + rel;
          if (t.includes(needle) && !seen.has(key)) { seen.add(key); idHits.push({ needle, file: rel }); }
        }
        for (const needle of generic) {
          const key = needle + '\u0000' + rel;
          if (t.includes(needle) && !seen.has(key)) { seen.add(key); genHits.push({ needle, file: rel }); }
        }
        pos += n;
      }
      fs.closeSync(fd);
    }
  };
  walk(dir);
  return { identity: idHits, generic: genHits, scanned, bytes };
}

/** 从 versions/ 目录名读版本。 */
function readVersion(dir) {
  try {
    const vdir = path.join(dir, 'versions');
    const names = fs.readdirSync(vdir)
      .map((n) => n.match(/^(\d+\.\d+\.\d+)-(\d+)$/))
      .filter(Boolean)
      .map((m) => ({ short: m[1], build: m[2] }));
    if (!names.length) return null;
    names.sort((a, b) => Number(b.build) - Number(a.build));
    return names[0];
  } catch { return null; }
}

// ── 主流程 ──────────────────────────────────────────────────────────────

function main() {
if (!fs.existsSync(path.join(SRC, 'QQ.exe'))) {
  die(`源目录里没有 QQ.exe：${SRC}\n  先用 npm run setup 装好便携 QQ，或用 --from 指定已装好的 QQ 目录`);
}

const ver = readVersion(SRC);
if (!ver) warn('读不到版本号（versions/ 里没有形如 9.9.33-51802 的目录），仍会继续打包');

log(`源目录：${SRC}`);
log(`版本：  ${ver ? `${ver.short}-${ver.build}` : '未知'}`);

// ── 1) 暂存到 staging 目录（把要剥掉的文件排除在外）──────────────────────
// 为什么用 staging 而不是直接 tar + 排除参数：
//   exclude 模式各平台差异大（有的要 --exclude，有的要 -X），容易写错；
//   staging 是"看得见摸得着"的，还能顺便统计到底剥了什么。
const staging = path.join(OUT.replace(/\.tar\.zst$|\.zip$|\.tar\.gz$/, '') + '.staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const stripped = [];
let fileCount = 0;
let rawBytes = 0;

const walk = (from, to) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const rel = path.relative(SRC, src);
    const reason = stripReason(rel, { keepUpdates: KEEP_UPDATES });
    if (reason) { stripped.push({ rel, reason }); continue; }
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); walk(src, dst); continue; }
    if (!e.isFile()) continue;
    try {
      fs.copyFileSync(src, dst);
      fileCount += 1;
      rawBytes += fs.statSync(dst).size;
    } catch (err) {
      warn(`复制失败（跳过）：${rel} —— ${err.message}`);
    }
  }
};
walk(SRC, staging);

log(`已暂存 ${fileCount} 个文件，${(rawBytes / 1048576).toFixed(0)} MB`);
if (stripped.length) {
  log(`剥离 ${stripped.length} 项：`);
  const byReason = new Map();
  for (const s of stripped) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
  for (const [why, n] of byReason) log(`  - ${why}（${n} 个）`);
}

// ── 1.5) 隐私扫描：要发出去的东西，不能靠印象保证 ──────────────────────
// 扫描对象是 staging（= 真正要打包的内容），而不是源目录 ——
// 源目录里有已被剥掉的 Uninstall.xml（里面有打包者的安装路径），
// 扫源目录会误报。
log('扫描个人数据…');
const scan = scanForPrivateData(staging);
const ALLOW = args.includes('--allow-personal');

if (scan.generic.length) {
  // 通用路径不拦：腾讯自己的 dll 里就编了一堆开发商机器上的调试路径，
  // 那是发行版自带的，不是打包者的数据。
  const files = [...new Set(scan.generic.map((h) => h.file))];
  log(`（提示）${scan.generic.length} 处通用路径字样，分布在 ${files.length} 个文件里`);
  log('       多为腾讯 dll 内编译进去的调试路径，非打包者数据。样例：');
  for (const h of scan.generic.slice(0, 3)) log(`         ${h.needle} ← ${h.file}`);
}

if (scan.identity.length) {
  warn('');
  warn('='.repeat(66));
  warn('⛔ 检测到**打包者的身份信息**，拒绝打包：');
  const uniqNeedles = [...new Set(scan.identity.map((h) => h.needle))];
  for (const n of uniqNeedles) {
    const files = scan.identity.filter((h) => h.needle === n).map((h) => h.file);
    warn(`   关键词 "${n}" → ${files.length} 个文件`);
    for (const f of files.slice(0, 5)) warn(`      ${f}`);
    if (files.length > 5) warn(`      …还有 ${files.length - 5} 个`);
  }
  warn('');
  warn('  这些是会跟着归档分发出去的身份信息（用户名 / 用户主目录 / 源路径）。');
  warn('  请先确认它们是怎么进来的：');
  warn('    · 若是某个清单/配置文件写了绝对路径 —— 把它加进 STRIP_RULES');
  warn('    · 若确实是程序运行必需 —— 用 --allow-personal 确认后继续');
  warn('='.repeat(66));
  if (!ALLOW) {
    fs.rmSync(staging, { recursive: true, force: true });
    die('已中止打包（未产出任何归档）');
  }
  warn('--allow-personal：无视上述命中，继续打包。');
} else {
  log(`✓ 没有打包者的身份信息（扫了 ${scan.scanned} 个文件 / ${(scan.bytes / 1048576).toFixed(0)} MB）`);
}

// ── 2) 写一个自己的清单：解压后 setup 靠它知道这是免安装包、版本是多少 ──
const info = {
  kind: 'qq-portable',
  packFormat: 1,
  qqVersion: ver ? `${ver.short}-${ver.build}` : '',
  qqShort: ver?.short || '',
  qqBuild: ver?.build || '',
  packedAt: new Date().toISOString(),
  // ⚠️ 这里**不要**写 source 路径：那是打包者机器上的绝对路径，
  // 里面通常带着用户名（C:\Users\xxx\...）。这个文件会跟着归档分发出去，
  // 写上去等于把打包者的用户名一起散出去。
  fileCount,
  rawBytes,
  stripped: stripped.map((s) => ({ path: s.rel, why: s.reason })),
  // 打包时做过的隐私扫描结果 —— 下载方可以据此自己核对，而不用相信一句"没有个人数据"
  privacyScan: {
    identityHits: scan.identity.length,
    genericPathHits: scan.generic.length,
    scannedFiles: scan.scanned
  },
  // 说明用途与限制，解压出来的人能看懂这是什么
  note: 'QQ 便携运行文件（由 scripts/pack-qq-portable.mjs 生成）。'
    + '内容来自一份正常安装的 QQ，剥离了日志与卸载器；不含任何用户数据（聊天记录、账号）。'
    + '配合 --user-data-dir 使用即可与系统里已装的 QQ 完全隔离。'
};
fs.writeFileSync(path.join(staging, 'portable-info.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');

// 许可提示：QQ 是腾讯的专有软件，重打包分发与"链接官方安装包"是两回事
fs.writeFileSync(path.join(staging, 'README-portable.txt'), [
  'QQ 便携运行文件',
  '================',
  '',
  '这是把一份正常安装的 QQ 复制出来的运行文件，用于配合 QQ Agent 的便携运行',
  '（启动时带 --user-data-dir，与系统里已安装的 QQ 互不影响）。',
  '',
  '! 重要：QQ 是腾讯公司的专有软件，版权与许可归腾讯所有。',
  '  本归档只是为了让「免安装」成为可能而做的复制，不包含任何修改。',
  '  再分发前请自行确认符合腾讯的许可条款；本仓库不随代码分发 QQ 本体。',
  '',
  '包含的许可文件（请勿删除）：',
  '  QQLicense.rtf / licensenew_QQ_2052.rtf  腾讯 QQ 许可',
  '  LICENSE.electron.txt / LICENSES.chromium.html  运行时的开源许可',
  '',
  '不包含：',
  '  任何用户数据（聊天记录、登录态、账号信息）—— 一个字节都没有',
  '  运行日志、卸载器',
  '',
  `版本：${info.qqVersion || '未知'}`,
  `打包时间：${info.packedAt}`,
  ''
].join('\n'), 'utf8');

// ── 3) 打包 ─────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });

log(`压缩中（${FORMAT}）…`);
const t0 = Date.now();
try {
  const tarArgs = FORMAT === 'zip'
    ? ['-a', '-c', '-f', OUT, '-C', staging, '.']
    : ['-c', '--zstd', '-f', OUT, '-C', staging, '.'];
  execFileSync('tar', tarArgs, { stdio: 'inherit', timeout: 1_800_000 });
} catch (error) {
  die(`打包失败：${error.message}\n  需要 bsdtar（Windows 10+ 自带 tar）。Linux 上装 libarchive-tools。`);
}
const sec = ((Date.now() - t0) / 1000).toFixed(0);

// ── 4) 算哈希 + 输出可直接粘贴的配置 ────────────────────────────────────
const hash = createHash('sha256');
const fd = fs.openSync(OUT, 'r');
const buf = Buffer.alloc(8 * 1024 * 1024);
let pos = 0;
for (;;) {
  const n = fs.readSync(fd, buf, 0, buf.length, pos);
  if (n <= 0) break;
  hash.update(buf.subarray(0, n));
  pos += n;
}
fs.closeSync(fd);
const sha = hash.digest('hex').toUpperCase();
const outMB = fs.statSync(OUT).size / 1048576;

fs.rmSync(staging, { recursive: true, force: true });

console.log('');
log('='.repeat(66));
log(`✅ 打包完成：${OUT}`);
log(`   原始：${(rawBytes / 1048576).toFixed(0)} MB（${fileCount} 个文件）`);
log(`   压缩：${outMB.toFixed(0)} MB（${(outMB / (rawBytes / 1048576) * 100).toFixed(0)}%），用时 ${sec}s`);
log(`   版本：${info.qqVersion || '未知'}`);
log('');
log('把文件上传到你的分发地址，然后把下面两行填进 scripts/setup.mjs：');
log('');
log(`const QQ_PORTABLE_URL = 'https://你的域名/.../${path.basename(OUT)}';`);
log(`const QQ_PORTABLE_SHA256 = '${sha}';`);
log('');
log('（或作为环境变量传入：QQ_PORTABLE_URL / QQ_PORTABLE_SHA256）');
log('='.repeat(66));
}

// 只有"node scripts/pack-qq-portable.mjs"这种直接执行才真的去打包。
// 被 import 时（测试要拿 stripReason 等纯函数）只暴露函数，不产生任何副作用。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
