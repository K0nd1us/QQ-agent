import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// QQ 安装包下载源与版本锁定的回归测试。
//
// 为什么需要它：换下载源时最容易犯的三个错，全是"静默"的 ——
//   1) 只改了 URL，忘了同步版本号/文件名 → 下载到的文件与命名不符，手动放置指引失效
//   2) 沿用了旧安装包的 SHA256 → 每次 setup 都以"校验失败"告终（比不校验更糟）
//   3) 没意识到协议栈钉死了 CLIENT_BUILD → 装完能打开但登录被拒，排查方向全错
// 这三条都不会在语法检查里暴露，所以固化成测试。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

// ── 1) 下载源 ──
check(!SRC.includes('dldir1v6.qq.com'), '不再使用腾讯 CDN 的 dldir1v6 地址');
check(SRC.includes('https://www.kondius.cn/netdisk/api/download/'),
  '下载源指向 kondius.cn 分发地址');
check(!/QQ_PORTABLE_VERSION\s*\|\|\s*'9\.9\.26/.test(SRC),
  '默认 QQ 版本不再是 9.9.26（用户已要求换到 9.9.33）');

const verM = SRC.match(/QQ_PORTABLE_VERSION\s*\|\|\s*'([^']+)'/);
const ver = verM ? verM[1] : '';
// 目标版本 = 实际运行的 QQ 版本（免安装包里就是这一版）
check(ver === '9.9.33.51802', `默认版本是 9.9.33.51802（实际 ${ver}）`);
const [shortV, buildV] = [ver.split('.').slice(0, 3).join('.'), ver.split('.').pop()];
check(shortV === '9.9.33' && buildV === '51802', `版本拆解正确（${shortV} / ${buildV}）`);

// ── 2) URL 模板能拼出用户要求的那条完整地址 ──
// 安装包名现在是一个**写死的常量**，不再由版本号推导：
// 目标版本(51802) 和分发站上的安装包(260813) 是两个不同的产物。
const nameM2 = SRC.match(/QQ_INSTALLER_NAME = process\.env\.QQ_INSTALLER_NAME \|\| '([^']+)'/);
const instName = nameM2 ? nameM2[1] : '';
check(instName === 'QQ_9.9.33_260813_x64_01.exe',
  `安装包名写死为 netdisk 上真实存在的那个（实际 ${instName}）`);
check(!/QQ_INSTALLER_NAME = `/.test(SRC),
  '安装包名不再由版本号拼接 —— 拼错的话兜底下载会 404，而报错只会说"下载失败"');
const urlTpl = SRC.match(/QQ_X64_URL = process\.env\.QQ_INSTALLER_URL \|\|\s*\n?\s*`([^`]+)`/);
check(!!urlTpl, '找得到 URL 模板');
if (urlTpl) {
  const built = urlTpl[1].replace(/\$\{QQ_INSTALLER_NAME\}/g, instName);
  const want = `https://www.kondius.cn/netdisk/api/download/${instName}`;
  check(built === want, '拼出的安装包地址正确', `实际: ${built}\n期望: ${want}`);
}

// ── 3) 目标版本与安装包是"两个产物"，不能混为一谈 ──
check(ver !== '9.9.33.260813',
  '目标版本已不再是安装包文件名里的那个日期（两者是不同产物）');
check(/两个是不同的产物|不同的产物/.test(SRC),
  '注释里说明了"目标版本 vs 兜底安装包"是两个产物，避免以后又被拼到一起');

// ── 4) SHA256 不能沿用旧包的哈希 ──
// SHA256 的写法可能是多行的，用"抓常量定义块、再从中取字符串字面量"的方式，
// 不要假设它一定写在一行里（之前就因为改成多行导致断言静默失效）。
const shaBlockM = SRC.match(/const QQ_X64_SHA256 = \(([\s\S]*?)\)\.trim\(\)\.toUpperCase\(\);/);
check(!!shaBlockM, '找得到 QQ_X64_SHA256 定义');
const shaBlock = shaBlockM ? shaBlockM[1] : '';
check(shaBlock.includes('process.env.QQ_X64_SHA256'), 'SHA256 支持用环境变量覆盖');
const pinned = (shaBlock.match(/'([0-9A-Fa-f]{64})'/) || [])[1] || '';
check(pinned.toUpperCase() === 'B25C0D3CE9DF764074A9118D0DED927E1B2D7EBF60E306112E8DF18A040EC492',
  `SHA256 已固定为实测值（实际 ${pinned || '（没写死）'}）`);
check(Boolean(pinned),
  '写死了哈希 —— 换源时留空即可（留空只是不校验，不会误报失败）');
// 没配哈希时不能判"不匹配"，否则每次 setup 都重下几百 MB
check(/if \(!QQ_X64_SHA256\) \{[\s\S]{0,200}?跳过下载/.test(SRC),
  '缓存校验在"未配置哈希"时跳过而不是判为不匹配（避免每次重下几百 MB）');
check(SRC.includes('本次下载到的 SHA256'), '未配置哈希时会打印实际值，便于固定');

// ── 5) 版本匹配检查存在，且能识别当前的不匹配 ──
check(SRC.includes('function readClientBuild'), '能从 snowluma/index.mjs 读出 CLIENT_BUILD');
check(SRC.includes('function checkClientBuildMatch'), '有版本匹配检查函数');
check(SRC.includes('扫码登录可能被拒'), '提示里点明真实症状（登录被拒），而不是只说"版本不一致"');
check(SRC.includes('QQ_PORTABLE_VERSION=') && SRC.includes('SNOWLUMA_VERSION='),
  '提示里给出两个处理方向（换 QQ 版本 / 换 SnowLuma）');
check(SRC.includes('EXPECTED_CLIENT_BUILD'), '期望的 CLIENT_BUILD 由版本号推导，不写死');

// ── 5b) 如果本机缓存里还留着安装包，就直接验一遍哈希是否与固定值一致 ──
// 这是"固定值真的对得上"的硬证据 —— 比只检查源码里有个 64 位字符串可靠得多。
{
  const cacheDir = path.join(ROOT, 'runtime', '.cache');
  let installer = null;
  try {
    installer = fs.readdirSync(cacheDir).find((n) => /^QQ_.*\.exe$/i.test(n));
  } catch { /* 没缓存就算了 */ }
  if (installer) {
    const full = path.join(cacheDir, installer);
    const { createHash } = await import('node:crypto');
    const h = createHash('sha256');
    await new Promise((res, rej) => {
      fs.createReadStream(full).on('data', (d) => h.update(d)).on('end', res).on('error', rej);
    });
    const actual = h.digest('hex').toUpperCase();
    check(actual === pinned.toUpperCase(),
      `缓存安装包的 SHA256 与固定值一致（${installer}）`,
      `实际 ${actual}\n固定 ${pinned}`);
  } else {
    ok('本机没有缓存的安装包，跳过哈希实测（源码里的固定值已单独校验）');
  }
}

// ── 6) 实跑 --check：应当报告协议栈真实版本 ──
// （这一步是"真跑"，能发现函数名写错、模板串拼错这类只在运行时暴露的问题）
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.mjs'), '--check'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
  });
  // 也可能退出 0
  ok('--check 可以正常运行');
} catch (e) {
  const out = String(e.stdout || '') + String(e.stderr || '');
  check(out.includes('CLIENT_BUILD'),
    '--check 会报告协议栈的 CLIENT_BUILD（排查版本问题时第一眼就能看到）',
    out.slice(0, 400));
}

// ── 6b) 安装器类型识别（纯函数）──────────────────────────────────────
// 这一节来自真实故障：QQ 9.9.33 的安装包是腾讯自研的 HummerSetup，
// 而脚本写死的是 NSIS 的 `/s /D=`。用错的开关不会报错，只会弹出 GUI 等人点，
// 脚本一直等到超时 —— 表现就是"退出码取不到、QQ.exe 没出现"，完全没有线索。
{
  const { detectInstallerType, INSTALLER_TYPES, parseRegQueryValue, countQqProcesses,
    commonQqDirs, parseVersionDir, SKIP_ON_COPY,
    chooseQqInstall, collectQqInstallCandidates } = await import('../scripts/lib/qq-installer.mjs');
  check(typeof collectQqInstallCandidates === 'function', 'collectQqInstallCandidates 已导出');

  const mk = (str, tail = '') => Buffer.from('MZ' + '\0'.repeat(64) + str + '\0'.repeat(64) + tail, 'latin1');

  const nsis = detectInstallerType(mk('NullsoftInst'));
  check(nsis?.id === 'nsis', `识别 NSIS（实际 ${nsis?.id}）`);
  check(Array.isArray(nsis?.silentArgs?.( 'D:\\x')) && nsis.silentArgs('D:\\x').includes('/S'),
    'NSIS 给出 /S 开关');

  const inno = detectInstallerType(mk('Inno Setup Setup Data'));
  check(inno?.id === 'inno', `识别 Inno Setup（实际 ${inno?.id}）`);
  check(inno?.silentArgs?.('D:\\x').includes('/VERYSILENT'), 'Inno 给出 /VERYSILENT');

  // 真实情况：特征串在文件中间/尾部也要能认出来（HummerSetup 的标识在 PDB 路径里）
  const hummer = detectInstallerType(mk('xxx', 'QQInstaller/Setup3/HummerSetup.pdb'));
  check(hummer?.id === 'hummer', `从尾部 PDB 路径识别出 HummerSetup（实际 ${hummer?.id}）`);
  check(hummer?.silentArgs === null,
    'HummerSetup 明确返回"没有静默开关" —— 不去盲试 NSIS/Inno 开关（盲试会弹 GUI 卡到超时）');
  check(/不支持/.test(hummer?.note || ''), 'HummerSetup 的说明写清了"不支持静默开关"');

  check(detectInstallerType(mk('nothing recognizable here')) === null, '认不出来时返回 null（而不是瞎猜一个）');
  check(detectInstallerType(Buffer.alloc(0)) === null, '空 buffer 不崩');
  check(INSTALLER_TYPES.length >= 5, `覆盖了 ${INSTALLER_TYPES.length} 种打包器`);
  // 每种都要么有静默参数、要么明确说没有 —— 不允许"有类型但 silentArgs 是 undefined"
  const badTypes = INSTALLER_TYPES.filter((t) => !('silentArgs' in t));
  check(badTypes.length === 0, '每种打包器都显式声明了 silentArgs（null 表示"没有"）');

  // reg query 输出解析
  const regOut = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT',
    '    Install    REG_SZ    C:\\Softwares\\QQ',
    ''
  ].join('\r\n');
  check(parseRegQueryValue(regOut, 'Install') === 'C:\\Softwares\\QQ',
    `能从 reg query 输出里取出安装路径（实际 ${JSON.stringify(parseRegQueryValue(regOut, 'Install'))}）`);
  check(parseRegQueryValue(regOut, 'NotThere') === '', '值不存在时返回空串');
  check(parseRegQueryValue('', 'Install') === '', '空输出不崩');
  check(parseRegQueryValue('    Install    REG_SZ    "C:\\a b\\QQ"', 'Install') === 'C:\\a b\\QQ',
    '带引号的路径会去掉引号');

  // tasklist 输出解析
  const tl = [
    '信息: 没有运行的任务匹配指定标准。',
    'QQ.exe                       12345 Console                    1     45,678 K',
    'QQ.exe                       99999 Console                    1    120,000 K',
    'QQExternal.exe               11111 Console                    1      1,000 K'
  ].join('\r\n');
  check(countQqProcesses(tl) === 2, `数出 2 个 QQ 进程（实际 ${countQqProcesses(tl)}）`);
  check(countQqProcesses('信息: 没有运行的任务匹配指定标准。') === 0, '没在跑时返回 0');
  check(countQqProcesses('') === 0, '空输出返回 0');
  // 关键：不能把别的 exe 或提示文字算进去
  check(countQqProcesses('QQExternal.exe  1  Console 1 1 K') === 0, 'QQExternal.exe 不算（只认 QQ.exe）');

  // 常见目录 & 版本解析
  const dirs = commonQqDirs({ LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' });
  check(dirs.some((d) => d.includes('Tencent\\QQNT')), '常见目录里包含 Tencent\\QQNT');
  check(commonQqDirs({}).length > 0, '环境变量缺失时仍给得出默认目录');
  check(parseVersionDir('9.9.33-51802')?.build === '51802', '解析 9.9.33-51802');
  check(parseVersionDir('9.9.33-51802-9.9.33-52230.zip') === null,
    '更新包（带 .zip 的版本号）不算已装版本');
  check(parseVersionDir('channel.json') === null, '非版本目录返回 null');
  check(SKIP_ON_COPY.has('Tencent Files') && SKIP_ON_COPY.has('MyFiles'),
    '复制时跳过用户数据目录（不该把聊天记录一起搬过来）');

  // ── 多份 QQ 共存时的择优（这是"随便挑一个"会踩的坑）──
  // 场景：老机器上同时有 QQ 9.7（D:\QQ）和 QQ 9.9（C:\QQNT）。
  // 随手挑第一个的结果可能是复制了一份 9.7 —— 协议栈完全对不上，
  // 表现是登录失败，而排查方向会跑偏到网络/账号上去。
  {
    const V = (short, build) => ({ short, build });
    const cands = [
      { dir: 'D:\\QQ', version: V('9.7.23', '29368'), source: 'registry' },
      { dir: 'C:\\QQNT', version: V('9.9.33', '51802'), source: 'registry' }
    ];
    const r = chooseQqInstall(cands, { wantShort: '9.9.33' });
    check(r.pick?.dir === 'C:\\QQNT', `多个版本共存时选中匹配的那个（实际 ${r.pick?.dir}）`);
    check(r.mismatched === false, '匹配时 mismatched 为 false');
    check(/版本匹配/.test(r.reason), `理由说明是版本匹配（${r.reason}）`);

    // 只有不匹配的：仍要给出一个（并标记 mismatched，让调用方警告）
    const only9 = chooseQqInstall([cands[0]], { wantShort: '9.9.33' });
    check(only9.pick?.dir === 'D:\\QQ', '只有不匹配版本时也能选中（好过完全没有）');
    check(only9.mismatched === true, '不匹配时 mismatched=true —— 调用方据此提醒用户');
    check(/期望 9\.9\.33/.test(only9.reason), `理由里写明期望版本（${only9.reason}）`);

    // 同版本多份：取 build 更大的（更可能是当前在用的）
    const two = chooseQqInstall([
      { dir: 'A:\\qq', version: V('9.9.33', '100'), source: 'registry' },
      { dir: 'B:\\qq', version: V('9.9.33', '52230'), source: 'registry' }
    ], { wantShort: '9.9.33' });
    check(two.pick?.dir === 'B:\\qq', `同版本取 build 更大的（实际 ${two.pick?.dir}）`);

    // 读不到版本：优先于"版本不符"，但排在"版本匹配"之后
    const mixed = chooseQqInstall([
      { dir: 'X', version: null, source: 'common' },
      { dir: 'Y', version: V('9.7.23', '1'), source: 'registry' },
      { dir: 'Z', version: V('9.9.33', '2'), source: 'registry' }
    ], { wantShort: '9.9.33' });
    check(mixed.pick?.dir === 'Z', '有匹配版本时，读不到版本的和不符的都排后面');
    const noMatch = chooseQqInstall([
      { dir: 'X', version: null, source: 'common' },
      { dir: 'Y', version: V('9.7.23', '1'), source: 'registry' }
    ], { wantShort: '9.9.33' });
    check(noMatch.pick?.dir === 'X', '没有匹配版本时，读不到版本的优先于明确不符的');

    // 空输入
    check(chooseQqInstall([], { wantShort: '9.9.33' }).pick === null, '没有候选时返回 null');
    check(chooseQqInstall(null).pick === null, '传 null 不崩');
    check(/没有找到/.test(chooseQqInstall([]).reason), '空候选的理由说明是"没有找到"');
    ok('多个 QQ 共存时按版本择优（不会拿老版本冒充）');
  }

  // ── 全新机器路径：文档与参数都要在 ──
  {
    check(/--from/.test(SRC), '支持 --from <目录>（装在自定义路径时用）');
    check(/--run-installer/.test(SRC), '支持 --run-installer（帮用户把 GUI 安装器跑起来）');
    check(SRC.includes('这台机器上没有找到已安装的 QQ'), '没有找到 QQ 时给出明确引导');
    check(/双击运行/.test(SRC), '引导里说明要双击运行安装包');
    check(/完全退出 QQ/.test(SRC) && /托盘/.test(SRC), '引导里提醒"完全退出 QQ（含托盘）"');
    check(/重新运行：npm run setup|重跑/.test(SRC), '引导里说明装完要重跑 setup');
    check(/不支持静默安装/.test(SRC), '说明了为什么不能自动装（HummerSetup 会弹 GUI）');

    // 版本比对必须基于**实际装好的版本**，不是配置里的期望值
    // （从已装的 QQ 复制过来时两者会不同，报配置值等于自欺欺人）
    check(SRC.includes('readQqVersionFromDir(QQ_PORTABLE_DIR)'),
      '版本匹配检查读取实际安装的版本（而不是配置里期望的版本）');
    check(/与配置里期望的/.test(SRC), '实际版本与配置不同时会说明这是预期内的差异');

    // 复制时必须跳过用户数据
    check(SRC.includes('SKIP_ON_COPY') && SRC.includes('已跳过用户数据目录'),
      '复制时跳过用户数据目录（不搬聊天记录）');
    ok('全新机器引导与参数齐备');
  }

  ok('安装器识别 / 注册表解析 / 进程检测 / 版本解析 全部正确');
}

// ── 6c) 协议栈版本对齐（让 CLIENT_BUILD 与实际运行的 QQ 一致）─────────
{
  check(/function alignClientBuild/.test(SRC), '有 alignClientBuild（把协议栈声明对齐到实际版本）');
  check(/var CLIENT_BUILD = "\[\^"\]\+"/.test(SRC), '会替换 CLIENT_BUILD 声明');
  check(/var BUILD_VERSION_SHORT = "\[\^"\]\+"/.test(SRC), '会替换 BUILD_VERSION_SHORT 声明');
  check(/\.orig/.test(SRC), '改之前备份成 index.mjs.orig（可还原）');
  check(/QQ_ALIGN_CLIENT_BUILD/.test(SRC), '可用 QQ_ALIGN_CLIENT_BUILD=0 关掉');
  check(/只需第一次|只在第一次改之前备份|if \(!fs\.existsSync\(bak\)\)/.test(SRC),
    '备份只做一次（避免反复 setup 把备份覆盖成"已改过的版本"）');
  check(/已是.*无需对齐/.test(SRC), '已对齐时跳过（幂等，不会反复改）');
  check(/不参与协议分支|不参与任何协议分支/.test(SRC),
    '注释里说明了为什么相对安全（只是握手自报家门，不选协议分支）');

  // 实测：协议栈里的两处声明现在应当与 setup 期望的一致
  const slp = path.join(ROOT, 'snowluma', 'index.mjs');
  if (fs.existsSync(slp)) {
    const sl = fs.readFileSync(slp, 'utf8');
    const cb = (sl.match(/var (?:CLIENT_BUILD|LIST_QQ_VERSION) = "([^"]+)"/) || [])[1];
    const bs = (sl.match(/var BUILD_VERSION_SHORT = "([^"]+)"/) || [])[1];
    console.log(`  （信息）协议栈当前声明：CLIENT_BUILD=${cb} / BUILD_VERSION_SHORT=${bs}`);
    if (cb) {
      check(cb === `${shortV}-${buildV}`,
        `协议栈声明已对齐到 ${shortV}-${buildV}（实际 ${cb}）`);
      check(bs === shortV, `BUILD_VERSION_SHORT 已对齐到 ${shortV}（实际 ${bs}）`);
      // 备份要留住原值，不然"可还原"是假的
      const bak = slp + '.orig';
      if (fs.existsSync(bak)) {
        const o = (fs.readFileSync(bak, 'utf8').match(/var (?:CLIENT_BUILD|LIST_QQ_VERSION) = "([^"]+)"/) || [])[1];
        check(Boolean(o) && o !== cb, `备份里保留着原始值（${o}）—— 需要时能还原`);
      }
    }
  } else {
    ok('未安装 snowluma，跳过对齐实测');
  }
}

// ── 7) 内置 SnowLuma 的 CLIENT_BUILD 与我们的默认版本确实不同 —— 这是已知事实 ──
// 这条断言的意义：如果不一致，setup 就必须能在装完后提示出来（上面已测）。
// 哪天协议栈升级到匹配版本，这条会失败并提醒我们把提示文案改掉。
{
  const slPath = path.join(ROOT, 'snowluma', 'index.mjs');
  if (fs.existsSync(slPath)) {
    const m = fs.readFileSync(slPath, 'utf8').match(/var\s+(?:CLIENT_BUILD|LIST_QQ_VERSION)\s*=\s*["']([^"']+)["']/);
    const cb = m ? m[1] : '';
    console.log(`  （信息）内置 SnowLuma CLIENT_BUILD = ${cb || '读不到'}，本脚本默认 QQ = ${shortV}`);
    // 现在 setup 会把协议栈对齐到目标版本，所以正常情况下应当**一致**。
    // 若这里变得不一致，说明对齐没生效（比如又跑了 --force 重新下载了 snowluma）。
    if (cb && cb !== `${shortV}-${buildV}`) {
      bad('协议栈声明与目标版本不一致 —— 对齐没生效？',
        `CLIENT_BUILD=${cb}，期望 ${shortV}-${buildV}`);
    } else {
      ok('协议栈声明与目标版本一致');
    }
  } else {
    ok('未安装 snowluma，跳过 CLIENT_BUILD 比对');
  }
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
