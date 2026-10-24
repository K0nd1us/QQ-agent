import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// 免安装包打包逻辑的测试。
//
// 为什么值得测：strip 规则写错的后果是"少带了一个文件"，
// 而那要到用户启动 QQ 时才炸 —— 报错还多半是缺 dll 之类看不懂的提示。
// 所以"该剥的剥、该留的留"必须固化下来。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

const { stripReason, isStagedUpdate, STRIP_RULES,
  identityNeedles, scanForPrivateData, GENERIC_NEEDLES } = await import('../scripts/pack-qq-portable.mjs');

console.log('=== 必须剥离 ===');
for (const p of ['debug.log', 'beacon_report.log', 'Bin\\beacon_report.log', 'QQUninst.exe', 'Uninstall.exe', 'Uninstall.xml', 'ExtraInfo.ini', 'versions/9.9.33-51802-9.9.33-52230.zip']) {
  // 注意 zip 那条要显式开 keepUpdates=false（默认就是 false）
  check(Boolean(stripReason(p)), `剥离：${p}`);
}

console.log('\n=== 必须保留 ===');
// 少带文件的后果是启动时才报缺 dll，所以这一组比上面更关键
for (const p of [
  'QQ.exe',
  'versions/9.9.33-51802/QQNT.dll',
  'versions/9.9.33-51802/resources.pak',
  'versions/9.9.33-51802/icudtl.dat',
  'Bin/QQ.dll',
  'Plugin/x.dll',
  'QQLicense.rtf',
  'licensenew_QQ_2052.rtf',
  'versions/9.9.33-51802/LICENSE.electron.txt',
  'versions/9.9.33-51802/LICENSES.chromium.html',
  'versions/channel.json',
  'versions/config.json',
  'versions/setting.json'
]) {
  check(stripReason(p) === null, `保留：${p}`, stripReason(p) ? `被误判为：${stripReason(p)}` : '');
}

console.log('\n=== 许可文件不能被剥离（法务相关）===');
check(STRIP_RULES.every((r) => !/LICENSE|License|QQLicense/i.test(String(r.test))),
  '剥离规则里没有任何一条针对许可文件');
for (const p of ['QQLicense.rtf', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) {
  check(stripReason(p) === null, `许可文件保留：${p}`);
}

console.log('\n=== 其它 ===');
check(isStagedUpdate('versions/9.9.33-51802-9.9.33-52230.zip'), '识别待安装的更新包');
check(!isStagedUpdate('versions/9.9.33-51802/QQNT.dll'), '普通程序文件不是更新包');
check(!isStagedUpdate('versions/9.9.33-51802'), '版本目录本身不是更新包');
// --keep-updates 时更新包要保留（有人希望离线升级）
check(stripReason('versions/9.9.33-51802-9.9.33-52230.zip', { keepUpdates: true }) === null,
  '--keep-updates 时保留更新包');
// 大小写：Windows 上文件系统不区分大小写，规则也不能区分
check(Boolean(stripReason('DEBUG.LOG')) && Boolean(stripReason('UNINSTALL.EXE')),
  '剥离规则不区分大小写（Windows 上大小写不敏感）');
check(stripReason('') === null && stripReason('/') === null, '空路径不崩');

// ── 打包脚本本身的说明与参数 ──
console.log('\n=== 打包脚本 ===');
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'pack-qq-portable.mjs'), 'utf8');
check(/getArg\('--format', 'zip'\)/.test(src), '默认产出 zip（好认、双击能看、跨平台原生支持）');
check(/tar\.zst/.test(src), '仍然支持 --format tar.zst（更小更快，实测 509MB/6s vs zip 525MB/67s）');
check(/--from/.test(src) && /--out/.test(src) && /--keep-updates/.test(src) && /--allow-personal/.test(src),
  '支持 --from / --out / --keep-updates / --allow-personal');
check(src.includes('portable-info.json'), '会写入 portable-info.json（解压方能知道版本与来源）');
check(src.includes('README-portable.txt'), '会写入 README-portable.txt（存放位置与许可说明）');
check(/专有软件/.test(src) && /腾讯/.test(src), 'README 里写明 QQ 是腾讯专有软件、再分发需自行确认许可');
check(/不包含任何用户数据|一个字节都没有|不含任何用户数据/.test(src), 'README 里声明不含用户数据');
check(src.includes('"tar"') || src.includes("'tar'"), '用 bsdtar 打包（Windows 自带，用户无需额外装工具）');

// ── 隐私：不能把打包者的身份信息发出去 ──
console.log('\n=== 隐私保护 ===');
{
  // 这个文件曾经把源目录写进清单里 —— 那是带用户名的绝对路径，会跟着归档分发出去
  check(!/packedFrom/.test(src),
    'portable-info.json 里不写源目录（那是带用户名的绝对路径）');
  check(src.includes('不要') && src.includes('用户名'),
    '注释里说明了为什么不写路径（避免以后有人又加回去)');

  // ExtraInfo.ini：安装器留下的按次安装标识
  check(Boolean(stripReason('ExtraInfo.ini')),
    'ExtraInfo.ini 被剥离（安装器留下的按次安装标识）');
  check(/QQUrlMgr/.test(src),
    '注释里记录了"只有 QQUrlMgr.exe 读它、QQ.exe 不读"这个判断依据');

  // 隐私扫描机制本身
  check(typeof scanForPrivateData === 'function', 'scanForPrivateData 已导出（可复用/可测）');
  check(typeof identityNeedles === 'function', 'identityNeedles 已导出');
  const needles = identityNeedles();
  check(Array.isArray(needles) && needles.length > 0, `身份关键词能取到（${needles.length} 个）`);
  check(needles.every((x) => x.length >= 3),
    '过短的关键词被滤掉（否则会命中整个包，没有参考价值）');
  check(src.includes('拒绝打包') || src.includes('已中止打包'),
    '身份信息命中时**拒绝打包**（而不是只打印一句警告）');
  check(src.includes('--allow-personal'), '提供 --allow-personal 显式放行的出口');
  // 通用路径只提示不拦：腾讯 dll 里编了一堆开发商机器的调试路径，拦下来没法打包
  check(GENERIC_NEEDLES.length > 0 && src.includes('非打包者数据'),
    '通用路径（C:\\Users\\ 等）只提示不拦，并说明了原因');
  check(/privacyScan/.test(src), '扫描结果写进清单，下载方可自行核对');

  // 扫描函数真的要能工作：造一个含用户名的文件，必须被抓出来
  const os = await import('node:os');
  const tmpScan = fs.mkdtempSync(path.join(os.tmpdir(), 'privscan-'));
  const me = os.userInfo().username;
  fs.mkdirSync(path.join(tmpScan, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmpScan, 'clean.bin'), Buffer.from('nothing to see here'));
  fs.writeFileSync(path.join(tmpScan, 'sub', 'leak.json'), JSON.stringify({ path: `C:\\Users\\${me}\\Desktop\\x` }));
  const r = scanForPrivateData(tmpScan);
  check(r.identity.some((h) => h.file.includes('leak.json')),
    `能扫出含用户名的文件（用户名 "${me}"）`);
  check(!r.identity.some((h) => h.file === 'clean.bin'), '干净文件不会误报');
  check(r.scanned === 2, `扫描计数正确（${r.scanned}）`);
  fs.rmSync(tmpScan, { recursive: true, force: true });
}

// ── setup.mjs 的接入 ──
console.log('\n=== setup.mjs 接入 ===');
const setup = fs.readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8');
check(/QQ_PORTABLE_URL/.test(setup) && /QQ_PORTABLE_SHA256/.test(setup), '有免安装包的地址与哈希常量');
check(/免安装包：缓存命中/.test(setup), '缓存命中时不重复下载 650 MB');
check(/NO_PORTABLE|\-\-no-portable/.test(setup), '支持 --no-portable 强制走"从已装的 QQ 复制"');
check(/解压即用/.test(setup), '注释说明了免安装包为什么存在（绕开"装不回指定版本"）');
// 关键：解压失败要能退回老路，而不是直接失败
check(/退回"从机器上已装的 QQ 复制"/.test(setup), '免安装包失败时会退回"从已装的 QQ 复制"');
check(/portable-info\.json/.test(setup), '解压后读清单核对版本');
// 两个地址的环境变量必须分开 —— 之前手滑写成同一个，
// 用户设 QQ_PORTABLE_URL 时会把安装包地址也一起改掉
{
  const m1 = setup.match(/const QQ_X64_URL = process\.env\.(\w+)/);
  const m2 = setup.match(/const QQ_PORTABLE_URL = \(process\.env\.(\w+)/);
  check(m1 && m2 && m1[1] !== m2[1],
    `安装包与免安装包用不同的环境变量（${m1?.[1]} / ${m2?.[1]}）`);
  check(m2 && m2[1] === 'QQ_PORTABLE_URL', '免安装包用 QQ_PORTABLE_URL');
}

// ── 归档与固定哈希一致（如果本地已经打过包）──
console.log('\n=== 本地归档（如果存在）===');
// 默认产出 zip；也认 tar.zst（--format tar.zst 时）
const arc = [path.join(ROOT, 'dist', 'QQ_portable.zip'), path.join(ROOT, 'dist', 'QQ_portable.tar.zst')]
  .find((p) => fs.existsSync(p));
if (fs.existsSync(arc)) {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  await new Promise((res, rej) => {
    fs.createReadStream(arc).on('data', (d) => h.update(d)).on('end', res).on('error', rej);
  });
  const actual = h.digest('hex').toUpperCase();
  const m = setup.match(/QQ_PORTABLE_SHA256 = \(process\.env\.QQ_PORTABLE_SHA256\s*\|\|\s*'([0-9A-Fa-f]{64})'\)/);
  const pinned = (m ? m[1] : '').toUpperCase();
  check(pinned === actual,
    `归档 SHA256 与 setup 里的固定值一致（${(fs.statSync(arc).size / 1048576).toFixed(0)} MB）`,
    `实际 ${actual}\n固定 ${pinned || '（没写死）'}`);
} else {
  ok('本地没有归档，跳过哈希比对（先跑 npm run pack:qq 生成）');
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
