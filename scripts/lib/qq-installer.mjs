// QQ 安装包类型识别与便携化辅助（纯逻辑，便于测试）。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────
// 原来安装那一步写死的是 NSIS 的开关：`installer.exe /s /D=<目录>`。
// 换成 QQ 9.9.33 之后这一步失效了（退出码取不到、QQ.exe 没出现），
// 而脚本只会说"可能安装器格式变化" —— 到底什么格式、下一步该试什么，全没头绪。
//
// 不同打包器的静默安装开关**完全不同**，用错的结果往往是：
// 安装器弹出 GUI 一直等人点，脚本等到超时被杀（表现就是"退出码 unknown"）。
// 所以先识别类型，再用对应的开关，比盲试快得多。
//
// 识别办法：在文件里找打包器留下的特征串。这些串是打包器自己的名字，
// 稳定性很好（打包器不会故意隐藏自己的标识）。

import fs from 'node:fs';

/** 各类打包器的特征串与对应的静默安装参数。 */
export const INSTALLER_TYPES = [
  {
    id: 'hummer',
    label: '腾讯 HummerSetup（自研安装器）',
    // HummerSetup 的标识：装完后会加载同名 dll，并在临时目录建 qq_setup_temp。
    // PDB 路径里也带 HummerSetup —— 这是它最硬的指纹。
    markers: ['HummerSetup', 'qq_setup_temp'],
    // ⚠️ 它**不支持** NSIS/Inno 的静默开关。给一组开关去试只会弹出 GUI 等人点，
    // 脚本一直等到超时被杀（表现就是"退出码取不到"）。
    // 所以这里故意返回 null：宁可明确说"不知道怎么静默装"，也不去盲试浪费几分钟。
    silentArgs: null,
    note: '不支持 NSIS/Inno 静默开关 —— 需要正常安装后复制，或用机器上已装的 QQ'
  },
  {
    id: 'nsis',
    label: 'NSIS',
    // NSIS 的头里一定有 Nullsoft 标识
    markers: ['Nullsoft', 'NSIS Error'],
    silentArgs: (dir) => ['/S', `/D=${dir}`],
    // NSIS 的 /D= 必须是**最后一个**参数且不能加引号，路径含空格也要原样给
    note: '/S + /D=目录'
  },
  {
    id: 'inno',
    label: 'Inno Setup',
    markers: ['Inno Setup', 'InnoSetupLdr', 'JR.Inno.Setup', 'This installation was built with Inno Setup'],
    silentArgs: (dir) => ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL', `/DIR=${dir}`],
    note: '/VERYSILENT + /DIR=目录'
  },
  {
    id: 'installshield',
    label: 'InstallShield',
    markers: ['InstallShield', 'Installshield'],
    silentArgs: (dir) => ['/s', `/v"/qn INSTALLDIR=${dir}"`],
    note: '/s /v"/qn INSTALLDIR=目录"'
  },
  {
    id: '7zsfx',
    label: '7-Zip 自解压',
    markers: ['7-Zip SFX', '7z SFX'],
    silentArgs: (dir) => [`-o${dir}`, '-y'],
    note: '可直接用 7z 解压'
  },
  {
    id: 'msi',
    label: 'MSI / 打包为 MSI',
    markers: ['Microsoft Installer', 'Windows Installer'],
    silentArgs: (dir) => ['/qn', `TARGETDIR=${dir}`],
    note: '/qn TARGETDIR=目录'
  }
];

/**
 * 从安装包内容识别打包器类型（纯函数，传 Buffer 即可测）。
 *
 * 只扫文件**头尾各 2MB**：特征串一定在这些位置（包头有标识、
 * 包尾有数据段目录），而中间是压缩数据 —— 全扫一遍对 300MB 的文件太慢。
 *
 * @param {Buffer} buf
 * @returns {{id:string,label:string,markers:string[],note:string}|null} 识别不出返回 null
 */
export function detectInstallerType(buf) {
  if (!buf || !buf.length) return null;
  const head = buf.subarray(0, Math.min(buf.length, 2 * 1024 * 1024)).toString('latin1');
  const tailStart = Math.max(0, buf.length - 2 * 1024 * 1024);
  const tail = buf.subarray(tailStart).toString('latin1');
  for (const t of INSTALLER_TYPES) {
    const hit = t.markers.find((m) => head.includes(m) || tail.includes(m));
    if (hit) return { id: t.id, label: t.label, matched: hit, note: t.note, silentArgs: t.silentArgs };
  }
  return null;
}

/** 从文件路径识别（只读头尾，不把整个文件读进内存）。 */
export function detectInstallerTypeFromFile(filePath) {
  const size = fs.statSync(filePath).size;
  const span = Math.min(size, 2 * 1024 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(span);
    fs.readSync(fd, head, 0, span, 0);
    const tailStart = Math.max(0, size - span);
    const tail = Buffer.alloc(Math.min(span, size - tailStart));
    fs.readSync(fd, tail, 0, tail.length, tailStart);
    return detectInstallerType(Buffer.concat([head, tail]));
  } finally {
    fs.closeSync(fd);
  }
}

/** QQ NT 常见的默认安装位置（静默开关被忽略时，它可能装到了这些地方）。 */
export function commonQqDirs(env = process.env) {
  const local = env.LOCALAPPDATA || '';
  const roaming = env.APPDATA || '';
  const pf = env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    local && `${local}\\Programs\\Tencent\\QQNT`,
    local && `${local}\\Tencent\\QQNT`,
    roaming && `${roaming}\\Tencent\\QQNT`,
    `${pf}\\Tencent\\QQNT`,
    `${pf86}\\Tencent\\QQNT`,
    'C:\\Program Files\\Tencent\\QQNT',
    'C:\\Program Files (x86)\\Tencent\\QQNT'
  ].filter(Boolean);
}

/** 版本目录名形如 9.9.33-260813；用于判断复制过来的 QQ 版本对不对得上。 */
export function parseVersionDir(name) {
  const m = String(name || '').match(/^(\d+\.\d+\.\d+)[-.](\d+)$/);
  return m ? { short: m[1], build: m[2] } : null;
}

// ── 从注册表找已安装的 QQNT ────────────────────────────────────────────
//
// 为什么值得查注册表：QQNT 安装后会把安装路径写进注册表，
// 而"用户机器上可能已经装了 QQ"是**很常见**的情况。
// 既然安装器不让我们静默装到指定目录，那就直接用已装好的那份 ——
// 反正便携运行靠的是 --user-data-dir，不需要一份"干净"的程序文件。

/** 注册表里可能出现安装路径的位置，按可靠性排序。 */
export const QQ_REGISTRY_KEYS = [
  { hive: 'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT', value: 'Install' },
  { hive: 'HKLM\\SOFTWARE\\Tencent\\QQNT', value: 'Install' },
  { hive: 'HKCU\\SOFTWARE\\Tencent\\QQNT', value: 'Install' },
  { hive: 'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQ', value: 'InstallPath' },
  { hive: 'HKCU\\SOFTWARE\\Tencent\\QQ', value: 'InstallPath' }
];

/**
 * 解析 \`reg query\` 的输出，取出某个值的字符串内容（纯函数，便于测试）。
 * 输出形如：
 *   HKEY_LOCAL_MACHINE\\...\\QQNT
 *       Install    REG_SZ    C:\\Softwares\\QQ
 */
export function parseRegQueryValue(output, valueName) {
  const re = new RegExp(`^\\s*${valueName}\\s+REG_[A-Z_]+\\s+(.+?)\\s*$`, 'mi');
  const m = String(output || '').match(re);
  if (!m) return '';
  return m[1].trim().replace(/^"|"$/g, '');
}

/**
 * 收集机器上**所有**能找到的 QQ 安装目录（注册表 + 常见路径），并读出各自版本。
 *
 * 为什么不能"查到第一个就用"：用户机器上很可能同时存在新旧两份 QQ
 * （老的 9.7 装在 D:\QQ，新的 9.9 装在别处）。
 * 随手挑一个的结果可能是**复制了一份 9.7** —— 协议栈完全对不上，
 * 表现是登录失败，而排查方向会完全跑偏。所以要把候选都列出来，按版本择优。
 *
 * @param {(args:string[])=>string} runCmd 执行命令并返回 stdout（注入以便测试）
 * @param {(p:string)=>boolean} exists
 * @returns {Array<{dir:string, version:{short:string,build:string}|null, source:'registry'|'common'}>}
 */
export function collectQqInstallCandidates(runCmd, exists = fs.existsSync, env = process.env) {
  const out = [];
  const seen = new Set();
  const push = (dir, source) => {
    const d = String(dir || '').trim().replace(/[\\/]+$/, '');
    if (!d || seen.has(d.toLowerCase())) return;
    try { if (!exists(d + '\\QQ.exe')) return; } catch { return; }
    seen.add(d.toLowerCase());
    out.push({ dir: d, version: readQqVersionFromDir(d), source });
  };

  for (const { hive, value } of QQ_REGISTRY_KEYS) {
    try { push(parseRegQueryValue(runCmd(['query', hive, '/v', value]) || '', value), 'registry'); }
    catch { /* 该键不存在，跳过 */ }
  }
  for (const dir of commonQqDirs(env)) push(dir, 'common');
  return out;
}

/**
 * 从候选里挑最合适的那个。
 *
 * 优先级：
 *   1. 短版本号与期望一致（如都是 9.9.33）—— 这是我们真正要的
 *   2. 读不到版本但有 QQ.exe —— 聊胜于无，会提示用户
 *   3. 版本不一致 —— 排最后，用之前会警告
 * 同一优先级里选 build 号最大的（越新越可能是用户在用的那份）。
 *
 * @returns {{pick:object|null, reason:string, mismatched:boolean}}
 */
export function chooseQqInstall(candidates, { wantShort = '' } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.dir) : [];
  if (!list.length) return { pick: null, reason: '没有找到任何已安装的 QQ', mismatched: false };

  const buildNum = (c) => (c.version ? Number(c.version.build) || 0 : 0);
  const matches = (c) => Boolean(c.version && wantShort && c.version.short === wantShort);
  const tier1 = list.filter(matches);
  const tier2 = list.filter((c) => !c.version);
  const tier3 = list.filter((c) => c.version && !matches(c));

  const best = (arr) => [...arr].sort((a, b) => buildNum(b) - buildNum(a))[0] || null;
  const pick = best(tier1) || best(tier2) || best(tier3);

  if (tier1.length) {
    return { pick, reason: `版本匹配（${pick.version.short}-${pick.version.build}）`, mismatched: false };
  }
  if (tier2.length && !tier3.length) {
    return { pick, reason: '读不到版本号，按"存在 QQ.exe"选中', mismatched: false };
  }
  const got = pick?.version ? `${pick.version.short}-${pick.version.build}` : '未知';
  return {
    pick,
    reason: `只有版本不匹配的安装：${got}（期望 ${wantShort || '?'}）`,
    mismatched: true
  };
}

/**
 * 兼容旧调用：返回选中的目录（内部已改为"收集候选 + 按版本择优"）。
 * @param {string} wantShort 期望的短版本号，如 '9.9.33'
 */
export function findQqInstallDir(runCmd, exists = fs.existsSync, wantShort = '') {
  const cands = collectQqInstallCandidates(runCmd, exists);
  return chooseQqInstall(cands, { wantShort }).pick?.dir || '';
}

/**
 * 从 versions/ 目录读出真实版本（QQ.exe 本身是启动器，版本号可能是旧的）。
 * 目录名形如 9.9.33-51802。
 */
export function readQqVersionFromDir(dir) {
  try {
    const vdir = dir + '\\versions';
    if (!fs.existsSync(vdir)) return null;
    // 只看版本号形态的目录；带 .zip 后缀的是更新包，不是已装版本
    const names = fs.readdirSync(vdir).filter((n) => parseVersionDir(n));
    if (!names.length) return null;
    // 取编号最大的（通常就是当前生效的）
    names.sort((a, b) => {
      const pa = parseVersionDir(a); const pb = parseVersionDir(b);
      return Number(pb.build) - Number(pa.build);
    });
    return parseVersionDir(names[0]);
  } catch {
    return null;
  }
}

/** 复制程序文件时应当跳过的目录：这些是**用户数据**，不该跟着搬。 */
export const SKIP_ON_COPY = new Set([
  'Tencent Files', 'MyFiles', 'Temp', 'Logs', 'Crashpad', 'cache'
]);

// ── 运行中检测 ──────────────────────────────────────────────────────────

/**
 * 解析 \`tasklist\` 的输出，数出 QQ 进程个数（纯函数，便于测试）。
 *
 * 为什么要管这个：QQ 运行时它的 exe/dll 是**被占用**的，复制会失败或拿到
 * 半截文件。而复制一份"正在运行的 QQ"正是最糟的结果 ——
 * 看起来装好了，启动时才发现缺文件，而且极难排查。
 * 所以宁可先让用户关掉 QQ，也不要产出半成品。
 *
 * tasklist 输出形如：
 *   QQ.exe                       12345 Console                    1     45,678 K
 *   （带 /NH 就没有表头；找不到时输出 "信息: 没有运行的任务匹配指定标准。"）
 */
export function countQqProcesses(tasklistOutput) {
  const text = String(tasklistOutput || '');
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    // 行首就是镜像名，后面跟 PID —— 只认这种结构，避免匹配到提示文字
    if (/^\s*QQ\.exe\s+\d+/i.test(line)) n += 1;
  }
  return n;
}
