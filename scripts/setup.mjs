#!/usr/bin/env node
/**
 * QQ Agent 一键 setup 脚本：下载 SnowLuma + 安装固定版本 QQ 便携实例。
 *
 *   npm run setup              # 首次安装（已就绪则跳过）
 *   node scripts/setup.mjs --force     # 强制重新下载
 *   node scripts/setup.mjs --check     # 只检查是否就绪
 *   node scripts/setup.mjs --skip-qq   # 只装 SnowLuma，跳过 QQ 下载
 *
 * 不入库任何腾讯二进制。QQ 安装包从腾讯 CDN 实时下载（用户自行触发）。
 * SnowLuma 为独立第三方项目，按其许可分发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// 共用下载器（流式 + 进度条 + 增量哈希 + 原子改名），setup-napcat 用的是同一份
import { download as downloadFile, fileSha256 } from './lib/download.mjs';
import {
  detectInstallerTypeFromFile, commonQqDirs, parseVersionDir,
  findQqInstallDir, readQqVersionFromDir, SKIP_ON_COPY, countQqProcesses,
  collectQqInstallCandidates, chooseQqInstall
} from './lib/qq-installer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── 目录约定 ──
const SNOWLUMA_DIR = path.join(ROOT, 'snowluma');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const QQ_PORTABLE_DIR = path.join(RUNTIME_DIR, 'qq-portable');
const QQ_PORTABLE_DATA_DIR = path.join(RUNTIME_DIR, 'qq-portable-data');
const QQ_CACHE_DIR = path.join(RUNTIME_DIR, '.cache');

// ── SnowLuma 下载源 ──
// 官方 GitHub Release（固定版本保证可复现）。
// 2026-09-26 更新：仓库已从 SnowLumaDevs/SnowLuma 迁移到 SnowLuma/SnowLuma；
// Windows 产物命名也从 snowluma-win32-x64.zip 改为 SnowLuma-<版本>-win-x64.zip
// （完整版、内置 Node.js —— lite 版没有 node.exe，isSnowlumaReady 校验不过）。
const SNOWLUMA_DEFAULT_VERSION = 'v1.14.19';
const SNOWLUMA_REPO = process.env.SNOWLUMA_REPO || 'SnowLuma/SnowLuma';
const SNOWLUMA_VERSION = process.env.SNOWLUMA_VERSION || SNOWLUMA_DEFAULT_VERSION;
const SNOWLUMA_ASSET = `SnowLuma-${SNOWLUMA_VERSION}-win-x64.zip`;
// 供应链防线：官方 zip 的 SHA256 固定如下（GitHub Release 资产摘要，
// v1.14.19 win-x64 完整版，2026-09-26 核对）。换版本 / 换源时必须用
// SNOWLUMA_SHA256 环境变量显式给出新包的哈希，否则拒绝下载。
const SNOWLUMA_PINNED_SHA256 = '2c77f0bcbe1f828e2d5109d193e71d8dac995e715dd144222a0a2c60a783c5a5';
const SNOWLUMA_REPO_OVERRIDDEN = !!process.env.SNOWLUMA_REPO && process.env.SNOWLUMA_REPO !== 'SnowLuma/SnowLuma';
const SNOWLUMA_VERSION_OVERRIDDEN = !!process.env.SNOWLUMA_VERSION && process.env.SNOWLUMA_VERSION !== SNOWLUMA_DEFAULT_VERSION;
const SNOWLUMA_SHA256 = (process.env.SNOWLUMA_SHA256 || '').trim()
  || ((SNOWLUMA_REPO_OVERRIDDEN || SNOWLUMA_VERSION_OVERRIDDEN) ? '' : SNOWLUMA_PINNED_SHA256);

// ── QQ 下载源 ──
// 从自己的分发站下载（不依赖腾讯 CDN 的文件名规则，也不会因 CDN 清档而 404）。
// ── 目标版本 ──────────────────────────────────────────────────────────
// 我们希望协议栈打交道的客户端版本。免安装包里装的就是这一版。
// EXPECTED_CLIENT_BUILD 由它推导，用来和 SnowLuma 声明的版本比对。
const QQ_VERSION = process.env.QQ_PORTABLE_VERSION || '9.9.33.51802';
const QQ_VERSION_SHORT = QQ_VERSION.split('.').slice(0, 3).join('.');
const QQ_BUILD = QQ_VERSION.split('.').pop();

// ── 兜底安装包 ────────────────────────────────────────────────────────
// ⚠️ 这是一个**具体文件**，不是从 QQ_VERSION 推导出来的 —— 两者是不同的产物：
//   · 目标版本 9.9.33.51802 来自一份已装好的 QQ（没有对应的官方安装包）
//   · 分发站上现存的安装包文件名里带的是 260813
// 所以文件名写死。**别再用版本号拼**：拼错了兜底下载会 404，
// 而错误信息只会说"下载失败"，很难联想到是文件名压根不存在。
//
// 这个包只在"免安装包拿不到 + 机器上也没装 QQ"时才用到（且必须手动双击安装，
// 它是 HummerSetup，不支持静默安装）。
const QQ_INSTALLER_NAME = process.env.QQ_INSTALLER_NAME || 'QQ_9.9.33_260813_x64_01.exe';
const QQ_X64_URL = process.env.QQ_INSTALLER_URL ||
  `https://www.kondius.cn/netdisk/api/download/${QQ_INSTALLER_NAME}`;

// ── QQ 免安装包（首选路径）────────────────────────────────────────────
//
// 为什么需要它：QQ 9.9.x 的 HummerSetup 安装器**不支持静默安装**，
// 而且"让用户装一遍再复制"在真实场景里有两个硬伤：
//   1) 机器上已有更新版本 QQ 时，装低版本会被拒绝或直接升级掉 —— 降级不成立
//   2) 不该为了做个便携版去动用户日常用的 QQ
// 免安装包把"装"这一步整个去掉：解压即用，不碰系统里任何东西。
//
// 打包命令：npm run pack:qq   （生成后在 dist/ 下，上传到分发地址）
// 留空 QQ_PORTABLE_URL 则跳过这条路，退回"从已装的 QQ 复制"。
const QQ_PORTABLE_URL = (process.env.QQ_PORTABLE_URL
  || 'https://www.kondius.cn/netdisk/api/download/QQ_portable.zip').trim();
// 换包时**必须同步更新**，否则会以"SHA256 校验失败"告终。
// 打包脚本会把这两行直接打印出来，复制粘贴即可。
const QQ_PORTABLE_SHA256 = (process.env.QQ_PORTABLE_SHA256
  || '2B669AAE5237B2CE23FB092E4D8A226C3CCD50E87BF917D767C53226F33E8005').trim().toUpperCase();
// 安装包 SHA256（大写十六进制）。留空 = 不校验，但会在下载后**打印实际值**，
// 方便你填进来固定住。
//
// 为什么默认留空而不是写死一个值：换下载源时如果沿用旧包的哈希，
// 每次 setup 都会以"SHA256 校验失败"告终，比不校验还糟 —— 用户会以为文件坏了。
// 想固定就填这里，或用环境变量 QQ_X64_SHA256 传入。
// 上面那个**安装包**（QQ_9.9.33_260813_x64_01.exe，300.0 MB）的哈希。
// 2026-09-13 实测下载并校验过。
// 换版本时**必须同步换掉这里**，否则每次 setup 都会以"SHA256 校验失败"告终。
const QQ_X64_SHA256 = (process.env.QQ_X64_SHA256
  || 'B25C0D3CE9DF764074A9118D0DED927E1B2D7EBF60E306112E8DF18A040EC492').trim().toUpperCase();

// ⚠️ 版本匹配检查用：SnowLuma 的协议栈会声明一个 CLIENT_BUILD（形如 "9.9.26-44343"），
// 它决定了握手时自称的客户端版本。QQ 版本与它差太远时，登录可能被拒或行为异常。
// 安装完成后会读出来和 QQ_VERSION 比对并给出醒目提示（见 checkClientBuildMatch）。
const EXPECTED_CLIENT_BUILD = process.env.EXPECTED_CLIENT_BUILD || `${QQ_VERSION_SHORT}-${QQ_BUILD}`;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const CHECK_ONLY = args.includes('--check');
const SKIP_QQ = args.includes('--skip-qq');
// --from <目录>：直接从指定目录复制 QQ（用户在别处装好了、或装在自定义路径）
const FROM_DIR = (() => {
  const i = args.indexOf('--from');
  return i >= 0 ? String(args[i + 1] || '').trim() : '';
})();
// --run-installer：本机没有任何 QQ 可用时，帮忙把安装器跑起来（GUI），
// 装完再自动继续。这是"全新机器"最省事的路径 —— 用户点几下就行。
const RUN_INSTALLER = args.includes('--run-installer');
// --no-portable：不用免安装包，强制走"从已装的 QQ 复制"那条路
const NO_PORTABLE = args.includes('--no-portable');

const log = (...a) => console.log('[setup]', ...a);
const warn = (...a) => console.warn('[setup] ⚠', ...a);
const die = (msg) => { console.error('[setup] ❌', msg); process.exit(1); };

// ── 工具函数 ──

/**
 * 包一层，把日志接到共用下载器上。
 *
 * 下载实现放在 scripts/lib/download.mjs（与 setup-napcat 共用）：
 * 流式写盘 + 进度条 + 增量哈希 + .part 原子改名。
 * 原来这里是一次 arrayBuffer() 全读进内存 —— 几百 MB 的安装包
 * 既看不到进度也占内存，中断还得从头再来。
 */
async function download(url, dest, { expectedSha256 = null, label = '' } = {}) {
  log('下载', url);
  try {
    const r = await downloadFile(url, dest, {
      expectedSha256,
      label,
      // 各调用方的缓存目录不同，404 的提示由调用方给
      hint404: `可手动下载后放入 ${path.dirname(dest)}`
    });
    if (expectedSha256) log('SHA256 校验通过 ✓');
    log(`已保存 ${dest}（${(r.bytes / 1048576).toFixed(1)} MB）`);
    return r;
  } catch (error) {
    // 进度条刚画在 stderr 上，这里让出一条干净的行再打日志，避免两行糊在一起
    process.stderr.write('\n');
    throw error;
  }
}

/**
 * 解压归档。zip / tar.gz / tar.zst 都能吃 —— 交给 bsdtar 自己嗅探格式，
 * 我们不需要按扩展名分支（写成"看起来对但某个格式没覆盖"反而是隐患）。
 *
 * Windows 10+ 自带 bsdtar（就是 tar.exe），链接了 libzstd，能直接解 .tar.zst。
 * 所以选 zstd 不会给用户增加任何安装步骤。
 */
function unzip(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // 优先用 bsdtar：它同时支持 zip 与各种 tar 压缩，跨平台一致
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit', timeout: 900_000 });
    return;
  } catch (error) {
    // 退路：Linux 上有些环境没装 bsdtar 的 zstd 支持，试 unzip（只对 zip 有效）
    if (process.platform !== 'win32' && /\.zip$/i.test(archivePath)) {
      execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit', timeout: 900_000 });
      return;
    }
    throw error;
  }
}

// ── SnowLuma 安装/检查 ──

function isSnowlumaReady() {
  const indexMjs = path.join(SNOWLUMA_DIR, 'index.mjs');
  const nodeExe = path.join(SNOWLUMA_DIR, 'node.exe');
  return fs.existsSync(indexMjs) && fs.existsSync(nodeExe);
}

async function installSnowluma() {
  if (isSnowlumaReady() && !FORCE) {
    log('✅ SnowLuma 已就绪（', SNOWLUMA_DIR, '），跳过。需要重装请加 --force');
    return;
  }

  if (FORCE && fs.existsSync(SNOWLUMA_DIR)) {
    log('--force：删除旧 SnowLuma 目录');
    fs.rmSync(SNOWLUMA_DIR, { recursive: true, force: true });
  }

  fs.mkdirSync(SNOWLUMA_DIR, { recursive: true });

  // 尝试从 GitHub Release 下载
  const zipPath = path.join(QQ_CACHE_DIR, 'snowluma.zip');
  fs.mkdirSync(QQ_CACHE_DIR, { recursive: true });

  try {
    const apiUrl = `https://api.github.com/repos/${SNOWLUMA_REPO}/releases/tags/${SNOWLUMA_VERSION}`;
    log('查询 SnowLuma Release:', apiUrl);
    const res = await fetch(apiUrl, { headers: { 'User-Agent': 'qq-agent-setup' } });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const rel = await res.json();
    const asset = (rel.assets ?? []).find((a) => a.name === SNOWLUMA_ASSET);
    if (!asset) throw new Error(`Release ${SNOWLUMA_VERSION} 中没有 ${SNOWLUMA_ASSET}`);

    // ⚠️ 供应链防线：
    //  - 下载源被环境变量改写（SNOWLUMA_REPO / SNOWLUMA_VERSION）时**必须**同时给出
    //    SNOWLUMA_SHA256，否则拒绝下载 —— 否则任何人只要改一个环境变量，
    //    就能让安装脚本下载并执行任意 zip（而 zip 里就是将被 spawn 的代码）。
    //  - 走官方仓库 + 默认版本时，用常量里固定的官方资产摘要做完整性校验。
    if (!SNOWLUMA_SHA256 && (SNOWLUMA_REPO_OVERRIDDEN || SNOWLUMA_VERSION_OVERRIDDEN)) {
      die('检测到 SNOWLUMA_REPO / SNOWLUMA_VERSION 被覆盖，但未提供 SNOWLUMA_SHA256。\n'
        + '  为防供应链投毒，拒绝从非官方来源下载。请设置 SNOWLUMA_SHA256=<zip 的 sha256> 后重试。');
    }
    if (!SNOWLUMA_SHA256) {
      warn('未提供 SNOWLUMA_SHA256 —— 本次下载不做完整性校验。');
      warn('  建议把官方 zip 的 sha256 固定到 SNOWLUMA_SHA256 环境变量或本文件常量里。');
    }

    // 缓存命中：手动下载（或上次残留）的 zip 先用起来 —— 让报错提示里
    // 「手动下载后放入缓存目录」真的可操作（Node fetch 不走系统代理，
    // 走代理上网的环境下载常超时，手动下载是重要退路）。
    // 来源不论是缓存还是现场下载，都按同一份官方哈希做完整性校验。
    if (fs.existsSync(zipPath)) {
      const got = fileSha256(zipPath);   // 大写十六进制（见 lib/download.mjs）
      const expect = String(SNOWLUMA_SHA256 || '').trim().toUpperCase();
      if (expect && got !== expect) {
        warn(`缓存 zip 哈希不符（${got}），删除后重新下载`);
        fs.rmSync(zipPath, { force: true });
      } else {
        log(`使用缓存 zip（跳过下载）：${zipPath}`, expect ? `sha256=${got}` : '（未固定哈希，未校验）');
      }
    }
    if (!fs.existsSync(zipPath)) {
      await download(asset.browser_download_url, zipPath, {
        expectedSha256: SNOWLUMA_SHA256 || null,
        label: 'SnowLuma '
      });
    }

    log('解压到', SNOWLUMA_DIR);
    unzip(zipPath, SNOWLUMA_DIR);

    // 官方 zip 可能带一层嵌套目录，上提内容
    const entries = fs.readdirSync(SNOWLUMA_DIR);
    if (!fs.existsSync(path.join(SNOWLUMA_DIR, 'index.mjs'))) {
      const inner = entries.find((e) => fs.existsSync(path.join(SNOWLUMA_DIR, e, 'index.mjs')));
      if (inner) {
        log(`调整目录层级：${inner}/ -> ./`);
        for (const f of fs.readdirSync(path.join(SNOWLUMA_DIR, inner))) {
          fs.renameSync(path.join(SNOWLUMA_DIR, inner, f), path.join(SNOWLUMA_DIR, f));
        }
        fs.rmSync(path.join(SNOWLUMA_DIR, inner), { recursive: true, force: true });
      }
    }

    fs.rmSync(zipPath, { force: true });
  } catch (error) {
    warn(`自动下载 SnowLuma 失败：${error.message}`);
    warn(`请手动下载 SnowLuma ${SNOWLUMA_VERSION} 并解压到 ${SNOWLUMA_DIR}`);
    warn(`下载地址：https://github.com/${SNOWLUMA_REPO}/releases/tag/${SNOWLUMA_VERSION}`);

    if (!isSnowlumaReady()) {
      die('SnowLuma 目录不完整，无法继续。请下载后重跑 setup');
    }
  }

  if (!isSnowlumaReady()) die('SnowLuma 安装后校验失败：index.mjs 或 node.exe 缺失');
  log('✅ SnowLuma 安装完成');
}

/**
 * 把协议栈声明的客户端版本对齐到我们实际运行的 QQ 版本。
 *
 * ── 为什么做这件事 ────────────────────────────────────────────────────
 * SnowLuma 里写死了两处"我是谁"的声明：
 *   var CLIENT_BUILD = "9.9.26-44343";   → 自定义表情服务 inner.qqVersion
 *   var BUILD_VERSION_SHORT = "9.9.26";  → OrderCustomFace 的 env.buildVersion
 * 而我们实际跑的是 9.9.33-51802。**声明与实际不一致**本身就不对，
 * 而且会让 setup 一直报一条版本不匹配的警告 —— 那条警告是真话，
 * 但如果不去处理它，用户很快就会学会忽略它，这才是最危险的。
 *
 * ── 为什么相对安全 ────────────────────────────────────────────────────
 * 这两处都只是**握手时自报家门**，不参与任何协议分支选择
 * （全文只有这 2 处引用 CLIENT_BUILD，且都在自定义表情相关服务里，
 *   不在登录链路）。声明一个真实存在的版本号，比声明一个对不上的更合理。
 *
 * ── 为什么在 setup 里做，而不是手改文件 ──────────────────────────────
 * snowluma/ 是**下载来的**，重新 setup（或换 SnowLuma 版本）会把整个目录覆盖掉，
 * 手改的改动会静默丢失、警告又会冒出来。做成 setup 的一个步骤才是可重复的。
 *
 * 关掉：set QQ_ALIGN_CLIENT_BUILD=0
 * 还原：备份在 index.mjs.orig
 */
function alignClientBuild() {
  if (process.env.QQ_ALIGN_CLIENT_BUILD === '0') {
    log('QQ_ALIGN_CLIENT_BUILD=0：跳过协议栈版本对齐（那条版本不一致的警告会保留）');
    return;
  }
  const p = path.join(SNOWLUMA_DIR, 'index.mjs');
  if (!fs.existsSync(p)) { warn('找不到 snowluma/index.mjs，跳过版本对齐'); return; }

  const wantBuild = EXPECTED_CLIENT_BUILD;   // 形如 9.9.33-51802
  const wantShort = QQ_VERSION_SHORT;        // 形如 9.9.33
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch (e) { warn(`读不了 snowluma/index.mjs：${e.message}`); return; }

  // v1.14.19 起 CLIENT_BUILD 改名为 LIST_QQ_VERSION（同语义：握手自报的客户端 build），
  // 两个名字都认；替换各走各的字面量，避免误伤同名的引用处。
  const curBuild = (text.match(/var (?:CLIENT_BUILD|LIST_QQ_VERSION) = "([^"]+)"/) || [])[1];
  const curShort = (text.match(/var BUILD_VERSION_SHORT = "([^"]+)"/) || [])[1];
  if (!curBuild && !curShort) {
    warn('协议栈里没找到 CLIENT_BUILD / LIST_QQ_VERSION / BUILD_VERSION_SHORT —— 版本可能改名了，跳过对齐');
    return;
  }
  if (curBuild === wantBuild && curShort === wantShort) {
    log(`协议栈声明的版本已是 ${wantBuild}，无需对齐`);
    return;
  }

  // 只在第一次改之前备份，避免反复 setup 把备份覆盖成"已改过的版本"
  const bak = `${p}.orig`;
  if (!fs.existsSync(bak)) {
    try { fs.copyFileSync(p, bak); } catch { /* 备份失败不致命 */ }
  }
  let next = text;
  if (curBuild) {
    next = next.replace(/var CLIENT_BUILD = "[^"]+"/, `var CLIENT_BUILD = "${wantBuild}"`);
    next = next.replace(/var LIST_QQ_VERSION = "[^"]+"/, `var LIST_QQ_VERSION = "${wantBuild}"`);
  }
  if (curShort) next = next.replace(/var BUILD_VERSION_SHORT = "[^"]+"/, `var BUILD_VERSION_SHORT = "${wantShort}"`);
  if (next === text) { warn('替换没有生效（可能与预期格式不符），跳过'); return; }
  try {
    fs.writeFileSync(p, next, 'utf8');
    log(`协议栈版本已对齐：${curBuild || '?'} → ${wantBuild}（原文件备份在 index.mjs.orig）`);
    log('  只是握手时"自报家门"的字段，不参与协议分支；如需还原：把 index.mjs.orig 盖回去');
  } catch (e) { warn(`写入失败：${e.message}`); }
}

/** QQ 的来路：'archive'=免安装包解压 | 'copied'=从已装的 QQ 复制 | ''=未知 */
let QQ_SOURCE = '';

// ── QQ 版本与 SnowLuma 协议栈的兼容性检查 ──────────────────────────────
//
// 背景：SnowLuma 的协议栈里写死了一个 CLIENT_BUILD（形如 "9.9.26-44343"），
// 握手时用它自称"我是 QQ 9.9.26 build 44343"。如果实际装的便携 QQ 是别的版本，
// 两者对不上 —— 轻则某些接口行为异常，重则**扫码后登录被拒**。
//
// 这类问题的表现很误导：setup 全绿、QQ 也能打开，只是扫码登不上，
// 用户会去怀疑网络/账号，而真正的原因是版本不匹配。
// 所以这里在装完后主动读出来比对，并在不一致时把话说清楚。

/** 从 snowluma/index.mjs 里读出协议栈自报的客户端 build
 *  （旧名 CLIENT_BUILD；v1.14.19 起改名 LIST_QQ_VERSION）。读不到返回 null。 */
function readClientBuild() {
  try {
    const p = path.join(SNOWLUMA_DIR, 'index.mjs');
    if (!fs.existsSync(p)) return null;
    // 文件很大（20 万行+），只扫前面若干 MB 就够 —— 常量都在前面
    const text = fs.readFileSync(p, 'utf8');
    const m = text.match(/var\s+(?:CLIENT_BUILD|LIST_QQ_VERSION)\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 比对 QQ 版本与协议栈声明的 CLIENT_BUILD。
 * 不一致**不中止安装**（QQ 本身是能用的），但会给出醒目提示与处理建议。
 */
function checkClientBuildMatch() {
  const build = readClientBuild();
  if (!build) {
    warn('读不到 SnowLuma 的 CLIENT_BUILD，跳过版本匹配检查。');
    return;
  }
  // ⚠️ 比对的是**实际装好的**便携 QQ 版本，不是配置里期望的版本。
  // 两者可能不同 —— 比如"从机器上已装的 QQ 复制过来"时，拿到的是 9.9.33-51802，
  // 而配置里写的文件名对应 260813。报配置值等于在自欺欺人：
  // 用户看到"build 260813"以为对上了，实际跑的是另一个 build。
  // 如果这次没走过下载/复制流程（比如 setup:check），就用清单文件反推来源。
  // 有这个文件 = 免安装包解出来的（打包脚本才会写它）。
  if (!QQ_SOURCE) {
    try {
      if (fs.existsSync(path.join(QQ_PORTABLE_DIR, 'portable-info.json'))) QQ_SOURCE = 'archive';
    } catch { /* ignore */ }
  }
  const actual = readQqVersionFromDir(QQ_PORTABLE_DIR);
  const actualShort = actual ? actual.short : QQ_VERSION_SHORT;
  const actualBuild = actual ? actual.build : QQ_BUILD;
  const actualLabel = actual ? `${actual.short}-${actual.build}` : `${QQ_VERSION_SHORT}-${QQ_BUILD}（读不到已装版本，按配置显示）`;

  // CLIENT_BUILD 形如 "9.9.26-44343"；对比短版本 + build 两段
  const norm = (x) => String(x || '').replace(/[^0-9.]/g, '').replace(/\.$/, '');
  const same = build === EXPECTED_CLIENT_BUILD
    || build === actualLabel
    || norm(build.split('-')[0]) === norm(actualShort)
    || build.includes(actualBuild);

  if (same) {
    log(`✅ QQ 版本与 SnowLuma 协议栈匹配（CLIENT_BUILD ${build}）`);
    return;
  }
  warn('');
  warn('='.repeat(64));
  warn('⚠️  QQ 版本与 SnowLuma 协议栈声明的客户端版本不一致');
  warn(`   便携 QQ 版本      : ${actualLabel}${actual ? '' : '（未安装？）'}`);
  if (actual && (actual.short !== QQ_VERSION_SHORT || actual.build !== QQ_BUILD)) {
    warn(`   （注意：与配置里期望的 ${QQ_VERSION_SHORT}-${QQ_BUILD} 不同 ——`);
    // 说清"为什么不同"。来源不同，用户该采取的行动也不同：
    //   免安装包 → 这是发行版带的版本，所有人一样，要换得重新打包
    //   复制来的 → 是这台机器上那份 QQ 的版本，别人可能不一样
    if (QQ_SOURCE === 'archive') {
      warn('     这是免安装包里带的版本（发行方打包时用的那份），属于预期内的差异。');
      warn('     想让所有人用同一个版本，重新打包并更新 QQ_PORTABLE_URL/SHA256 即可）');
    } else if (QQ_SOURCE === 'copied') {
      warn('     这是从本机已装的 QQ 复制来的版本，属于预期内的差异。');
      warn('     换机器时版本可能又不一样 —— 想统一版本请用免安装包）');
    } else {
      warn('     与配置里期望的版本不同，属于预期内的差异）');
    }
  }
  warn(`   SnowLuma 声明     : ${build}`);
  warn('');
  warn('   后果：QQ 能正常打开，但**扫码登录可能被拒**或某些接口行为异常。');
  warn('   这属于协议栈与客户端版本的对齐问题，不是网络/账号问题。');
  warn('');
  warn('   处理办法（任选）：');
  warn('   1) 换用与协议栈匹配的 QQ 版本：');
  warn(`      set QQ_PORTABLE_VERSION=${build.replace('-', '.')} && npm run setup -- --force`);
  warn('   2) 或换一个与当前 QQ 版本匹配的 SnowLuma：');
  warn('      set SNOWLUMA_VERSION=vX.Y.Z && npm run setup');
  warn('   3) 若确认当前组合能正常登录，可忽略本提示。');
  warn('='.repeat(64));
  warn('');
}

// ── 便携 QQ 安装/检查 ──

function isQqPortableReady() {
  const qqExe = path.join(QQ_PORTABLE_DIR, 'QQ.exe');
  return fs.existsSync(qqExe);
}

async function installQqPortable() {
  if (isQqPortableReady() && !FORCE) {
    log('✅ 便携 QQ 已就绪（', QQ_PORTABLE_DIR, '），跳过。需要重装请加 --force');
    return;
  }

  // ══ 首选：免安装包 ═══════════════════════════════════════════════════
  // 解压即用，**完全不需要安装 QQ**，也不碰系统里已装的任何东西。
  // 这是唯一能绕开"机器上有更新版 QQ 就装不回指定版本"这个死结的路。
  if (QQ_PORTABLE_URL && !NO_PORTABLE) {
    const zipPath = path.join(QQ_CACHE_DIR, path.basename(new URL(QQ_PORTABLE_URL).pathname) || 'QQ_portable.zip');
    try {
      // 缓存命中就不重复下 650 MB
      if (fs.existsSync(zipPath) && QQ_PORTABLE_SHA256 && fileSha256(zipPath) === QQ_PORTABLE_SHA256) {
        log('免安装包：缓存命中（SHA256 校验通过），跳过下载');
      } else {
        if (fs.existsSync(zipPath)) log('免安装包：缓存 SHA256 不匹配，重新下载');
        await download(QQ_PORTABLE_URL, zipPath, {
          expectedSha256: QQ_PORTABLE_SHA256 || null,
          label: 'QQ 免安装包 '
        });
      }

      log(`解压到 ${QQ_PORTABLE_DIR}（约 1.5 GB，需要一点时间）…`);
      fs.mkdirSync(QQ_PORTABLE_DIR, { recursive: true });
      unzip(zipPath, QQ_PORTABLE_DIR);

      // 归档自己带了一份清单，读出来核对版本与来源
      const infoPath = path.join(QQ_PORTABLE_DIR, 'portable-info.json');
      if (fs.existsSync(infoPath)) {
        try {
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          log(`免安装包版本：${info.qqVersion || '未知'}（打包于 ${info.packedAt || '?'}）`);
          if (info.qqShort && info.qqShort !== QQ_VERSION_SHORT) {
            warn(`  归档版本 ${info.qqShort} 与本脚本期望的 ${QQ_VERSION_SHORT} 不同 ——`);
            warn('  属于预期内的差异（打包的是当时装好的那份），通常可用。');
          }
        } catch { /* 清单坏了不影响使用 */ }
      }

      if (!isQqPortableReady()) {
        warn('免安装包解压后没找到 QQ.exe，改走"从已装的 QQ 复制"这条路');
        fs.rmSync(QQ_PORTABLE_DIR, { recursive: true, force: true });
      } else {
        QQ_SOURCE = 'archive';
        log('✅ 便携 QQ 就绪（免安装，未触碰系统里已装的 QQ）');
        fs.mkdirSync(QQ_PORTABLE_DATA_DIR, { recursive: true });
        return;
      }
    } catch (error) {
      warn(`免安装包这条路失败：${error.message}`);
      warn('  退回"从机器上已装的 QQ 复制"。');
      warn('  （若反复失败，可手动下载该归档解压到：' + QQ_PORTABLE_DIR + '）');
    }
  } else if (NO_PORTABLE) {
    log('--no-portable：跳过免安装包，走"从已装的 QQ 复制"');
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(QQ_CACHE_DIR, { recursive: true });

  const installerPath = path.join(QQ_CACHE_DIR, QQ_INSTALLER_NAME);

  // 如果缓存里有之前下载的安装器，先校验
  if (fs.existsSync(installerPath)) {
    const hash = fileSha256(installerPath);
    if (!QQ_X64_SHA256) {
      // 没配哈希时不能判"不匹配" —— 那会导致每次 setup 都重下一遍几百 MB
      log(`缓存安装器已存在（SHA256 ${hash.slice(0, 16)}…），跳过下载`);
    } else if (hash === QQ_X64_SHA256) {
      log('缓存安装器 SHA256 校验通过，跳过下载');
    } else {
      log('缓存安装器 SHA256 不匹配，重新下载');
      fs.rmSync(installerPath, { force: true });
    }
  }

  // 下载 QQ 安装包
  if (!fs.existsSync(installerPath)) {
    try {
      const dl = await download(QQ_X64_URL, installerPath, {
        expectedSha256: QQ_X64_SHA256 || null,
        label: 'QQ 安装包 '
      });
      if (!QQ_X64_SHA256) {
        warn('安装包未做完整性校验（未配置 QQ_X64_SHA256）。');
        warn(`  本次下载到的 SHA256 = ${dl.sha256}`);
        warn('  确认来源可信后，可把它填进 scripts/setup.mjs 的 QQ_X64_SHA256，');
        warn('  或用环境变量 QQ_X64_SHA256 传入，之后每次都会校验。');
      }
    } catch (error) {
      warn(`自动下载 QQ 安装包失败：${error.message}`);
      warn(``);
      warn(`=== 手动放置指引 ===`);
      warn(`1. 手动下载 ${QQ_INSTALLER_NAME}（x64）`);
      warn(`   下载地址：${QQ_X64_URL}`);
      warn('   （官方安装包：https://im.qq.com/index/#/windows ，版本不限，装完脚本会复制过来）');
      warn(`2. 将下载的 ${QQ_INSTALLER_NAME} 放入：${QQ_CACHE_DIR}`);
      warn(`3. 重新运行：npm run setup`);
      warn(`==================`);
      die('QQ 安装包不可用');
    }
  }

  // ── 识别安装包类型：不同打包器的静默开关完全不同 ──
  // 原来写死 NSIS 的 `/s /D=`。用错开关的典型后果是安装器**弹出 GUI 等人点**，
  // 脚本一直等到超时被杀 —— 表现就是"退出码取不到"。
  let kind = null;
  try { kind = detectInstallerTypeFromFile(installerPath); } catch { /* ignore */ }
  if (kind) log(`安装包类型：${kind.label}（命中特征 ${kind.matched}）→ 使用 ${kind.note}`);
  else warn('安装包类型未识别（不是常见的 NSIS / Inno / InstallShield 之一）');

  // ── 决定"从哪里拿 QQ" ──
  // 便携运行靠的是 --user-data-dir，**并不需要一份干净的程序文件**，
  // 所以最优路径是：直接用机器上已经装好的那份。
  // 只有机器上压根没有 QQ 时，才需要用户先装一次。
  if (!foundQqExe()) {
    let source = null;
    let sourceReason = '';

    if (FROM_DIR) {
      // 用户显式指定（装在自定义路径、或从别处拷来的）
      if (!fs.existsSync(path.join(FROM_DIR, 'QQ.exe'))) {
        die(`--from 指定的目录里没有 QQ.exe：${FROM_DIR}`);
      }
      source = FROM_DIR;
      sourceReason = '（--from 指定）';
    } else {
      const cand = findInstalledQq();
      if (cand) { source = cand.dir; sourceReason = `（${cand.reason || '已安装'}）`; }
    }

    if (source) {
      if (sourceReason.includes('--from')) log(`使用指定目录：${source}`);
      // ⚠️ QQ 运行时它的 exe/dll 被占用，复制会失败或拿到半截文件 ——
      // 产出的是"看起来装好了、启动才发现缺文件"的便携 QQ，极难排查。
      // 宁可让用户花 10 秒关掉 QQ，也不要产半成品。
      const running = runningQqCount();
      if (running > 0 && !FORCE) {
        warn('');
        warn(`检测到 ${running} 个 QQ 进程正在运行，先不复制。`);
        warn('  正在运行的 QQ 其程序文件被占用，复制出来的便携版会缺文件。');
        warn('  请**完全退出 QQ**（托盘图标也要退出），然后重跑：npm run setup');
        warn('  （确实想带着运行中的状态复制，可加 --force，但可能得到不完整的副本）');
        warn('');
        die('QQ 正在运行，无法安全复制');
      }
      if (running > 0) warn(`--force：仍然有 ${running} 个 QQ 进程在运行，复制结果可能不完整`);
      copyInstalledQq(source);
      QQ_SOURCE = 'copied';
    } else {
      // ── 全新机器：机器上没有 QQ，安装器又不支持静默安装 ──
      warn('');
      warn('='.repeat(66));
      warn('这台机器上没有找到已安装的 QQ，需要先装一次。');
      warn('');
      warn('  安装包已经下载好了（上面的路径），它是腾讯自研的 HummerSetup，');
      warn('  **不支持静默安装**（会弹 GUI），所以这一步必须你点几下：');
      warn('');
      warn('  1) 双击运行：');
      warn(`     ${installerPath}`);
      warn('  2) 按默认路径装完（装到哪都行，脚本会自己找）');
      warn('  3) **完全退出 QQ**（托盘图标也要右键退出）');
      warn('  4) 重新运行：npm run setup     ← 一样要重新运行一次');
      warn('');
      warn('  然后脚本会把装好的 QQ 复制成便携版（这一步才开始不需要你动手）。');
      warn('');
      warn('  可选：加 --run-installer 让脚本帮你把安装器跑起来（省掉第 1 步）：');
      warn('        npm run setup -- --run-installer');
      warn('='.repeat(66));
      warn('');

      if (RUN_INSTALLER) {
        log('--run-installer：启动安装器，请在弹出的窗口里完成安装…');
        try {
          execFileSync(installerPath, [], { stdio: 'inherit', windowsHide: false, timeout: 600_000 });
        } catch (e) {
          warn(`安装器退出（${e.signal ? `信号 ${e.signal}` : `退出码 ${e.status ?? '未知'}`}）`);
        }
        // 装完再找一次 —— 这一步通常就能找到了
        warn('安装器已退出，重新查找…');
        const again = findInstalledQq();
        if (again) {
          if (runningQqCount() > 0) {
            die('QQ 安装完成，但 QQ 正在运行。请完全退出 QQ 后重跑：npm run setup');
          }
          copyInstalledQq(again.dir);
        } else {
          die('安装器已退出，但仍未找到已安装的 QQ。若你改了安装路径，用 --from <目录> 指定。');
        }
      } else {
        die('需要先手动安装 QQ（见上方四步），然后重跑 npm run setup');
      }
    }
  }

  const strategies = [];
  // HummerSetup 这类"不支持静默开关"的安装器：**不去盲试**。
  // 盲试的代价是弹 GUI 等人点、脚本卡到超时 —— 还不如直接说清楚。
  if (kind?.silentArgs) {
    strategies.push({ name: `${kind.label} 静默安装`, args: kind.silentArgs(QQ_PORTABLE_DIR) });
  } else if (kind) {
    warn(`${kind.label}：${kind.note}`);
  }
  // 识别不出来或静默开关无效时，才把常见打包器的开关试一遍
  if (!kind || !kind.silentArgs) {
    for (const t of INSTALLER_FALLBACKS) strategies.push({ name: t.name, args: t.args(QQ_PORTABLE_DIR) });
  }

  for (const st of strategies) {
    if (foundQqExe()) break;
    log(`尝试：${st.name}`);
    try {
      execFileSync(installerPath, st.args, {
        timeout: 120_000,
        stdio: 'inherit',
        windowsHide: false
      });
    } catch (error) {
      // 退出码非零不代表失败（有些安装器装完返回非零），所以这里只记不抛
      const why = error.signal ? `被信号 ${error.signal} 终止（多半是弹了 GUI 在等人操作）`
        : `退出码 ${error.status ?? '未知'}`;
      warn(`  ${st.name}：${why}`);
    }
    if (foundQqExe()) break;
    // 装到别处去了？查一下注册表想指向哪
    const elsewhere = findInstalledQq();
    if (elsewhere) {
      log(`检测到 QQ 已安装到 ${elsewhere}`);
      if (copyInstalledQq(elsewhere)) break;
    }
  }

  // ── 校验：递归找 QQ.exe（不再只认根目录）──
  if (!foundQqExe()) {
    warn('');
    warn('=== 自动便携化未成功 ===');
    warn('请手动完成（很简单，两步）：');
    warn('1. 双击运行这个安装包，按默认路径装一遍（或装到任意目录）：');
    warn(`   ${installerPath}`);
    warn('2. 把安装目录里的**所有文件**复制到：');
    warn(`   ${QQ_PORTABLE_DIR}`);
    warn('3. 重跑：npm run setup   （脚本会检测到并跳过安装）');
    warn('');
    warn(`常见默认位置：${commonQqDirs().join('  |  ')}`);
    warn('====================');
    die('QQ 便携化失败：找不到 QQ.exe');
  }

  // 清理安装器（可选：保留以供 --force 重装）
  // fs.rmSync(installerPath, { force: true });

  // 确保 data 目录存在
  fs.mkdirSync(QQ_PORTABLE_DATA_DIR, { recursive: true });

  if (!isQqPortableReady()) die('便携 QQ 安装校验失败：QQ.exe 缺失');
  log('✅ 便携 QQ 安装完成：', QQ_PORTABLE_DIR);
  log(`   数据目录：${QQ_PORTABLE_DATA_DIR}`);
  log(`   启动参数：QQ.exe --user-data-dir="${QQ_PORTABLE_DATA_DIR}"`);
}

// ── 便携化辅助 ────────────────────────────────────────────────────────

/**
 * 兜底策略：把常见打包器的开关都列出来，逐个试。
 *
 * 为什么值得试全：识别可能会落空（打包器自定义/加了壳），而试错的代价只是 2 分钟。
 * 顺序按"QQ NT 历史上实际用过"的先后来排 —— 先试最可能的。
 */
const INSTALLER_FALLBACKS = [
  {
    name: 'NSIS 风格（/S /D=）',
    args: (dir) => ['/S', `/D=${dir}`]
  },
  {
    name: 'Inno 风格（/VERYSILENT /DIR=）',
    args: (dir) => ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${dir}`]
  },
  {
    name: '静默参数 /quiet',
    args: (dir) => ['/quiet', `INSTALLDIR=${dir}`]
  }
];

/**
 * 在便携目录里递归找 QQ.exe。
 *
 * 找到了就把它所在目录的**内容上提到根**（保持 `runtime/qq-portable/QQ.exe`
 * 这个约定不变，否则启动脚本、进程匹配、user-data-dir 全都要跟着改）。
 */
function foundQqExe() {
  const direct = path.join(QQ_PORTABLE_DIR, 'QQ.exe');
  if (fs.existsSync(direct)) return true;
  if (!fs.existsSync(QQ_PORTABLE_DIR)) return false;
  const found = findFileRecursive(QQ_PORTABLE_DIR, 'QQ.exe');
  if (!found) return false;
  const dir = path.dirname(found);
  if (path.resolve(dir) === path.resolve(QQ_PORTABLE_DIR)) return true;
  log(`QQ.exe 在子目录 ${path.relative(QQ_PORTABLE_DIR, dir) || '.'}，上提到根目录`);
  try {
    for (const item of fs.readdirSync(dir)) {
      const dst = path.join(QQ_PORTABLE_DIR, item);
      if (fs.existsSync(dst)) continue;   // 不覆盖已存在的
      fs.renameSync(path.join(dir, item), dst);
    }
  } catch (e) {
    warn(`上提失败：${e.message}（可手动把 ${dir} 里的文件复制到 ${QQ_PORTABLE_DIR}）`);
  }
  return fs.existsSync(path.join(QQ_PORTABLE_DIR, 'QQ.exe'));
}

/**
 * QQ 是否在运行？返回进程数（0 = 没在跑；检测不了也返回 0，不阻塞流程）。
 */
function runningQqCount() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000
    });
    return countQqProcesses(out);
  } catch {
    return 0;
  }
}

/**
 * 找一个已经装好的 QQ。
 *
 * **注册表优先**：QQNT 安装后会把路径写进注册表，这是最可靠的来源
 * （比猜目录准得多 —— 用户完全可能装在 C:\Softwares\QQ 这种地方）。
 * 注册表查不到再退回到常见默认目录。
 */
function findInstalledQq() {
  const runReg = (a) => execFileSync('reg', a, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000
  });
  let cands = [];
  try { cands = collectQqInstallCandidates(runReg); } catch { cands = []; }
  const chosen = chooseQqInstall(cands, { wantShort: QQ_VERSION_SHORT });
  if (cands.length > 1) {
    log(`找到 ${cands.length} 个已安装的 QQ：`);
    for (const c of cands) {
      log(`  - ${c.dir}${c.version ? `（${c.version.short}-${c.version.build}）` : '（版本未知）'}`);
    }
  }
  if (!chosen.pick) return null;
  // 读不到版本的直接给出提示
  if (chosen.mismatched) {
    warn(`已安装的 QQ 版本与本脚本期望的不同：${chosen.reason}`);
    warn('  同大版本通常仍可用；若登录被拒，请装一份期望版本再重跑。');
  } else {
    log(`选中：${chosen.pick.dir}（${chosen.reason}）`);
  }
  return chosen.pick;
}

/**
 * 把已装好的 QQ 复制进便携目录。
 *
 * 跳过用户数据目录（Tencent Files / MyFiles 等）：我们要的是**程序文件**，
 * 把用户的聊天记录一起搬过来既慢又没必要（而且便携实例本来就该用自己的数据目录）。
 */
function copyInstalledQq(srcDir) {
  const skip = SKIP_ON_COPY;
  let copied = 0;
  let bytes = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const s1 = path.join(from, e.name);
      const s2 = path.join(to, e.name);
      if (e.isDirectory()) { walk(s1, s2); continue; }
      if (!e.isFile()) continue;
      try {
        fs.copyFileSync(s1, s2);
        copied += 1;
        bytes += fs.statSync(s2).size;
      } catch { /* 单个文件失败（被占用等）不中断整体 */ }
    }
  };
  log(`复制程序文件 ${srcDir} → ${QQ_PORTABLE_DIR}（已跳过用户数据目录）`);
  try {
    walk(srcDir, QQ_PORTABLE_DIR);
  } catch (e) {
    warn(`复制过程出错：${e.message}`);
  }
  log(`复制完成：${copied} 个文件，${(bytes / 1048576).toFixed(0)} MB`);
  return foundQqExe();
}

/** 尝试用 7zip 解压 NSIS 安装器（备选方案） */
function tryExtractWith7z(installerPath, destDir) {
  const sevenZ = ['7z', '7za', '7zz'];
  for (const cmd of sevenZ) {
    try {
      fs.mkdirSync(destDir, { recursive: true });
      execFileSync(cmd, ['x', installerPath, `-o${destDir}`, '-y'], {
        timeout: 120_000,
        stdio: 'pipe'
      });
      // 检查是否提取出 QQ.exe
      const qqExe = findFileRecursive(destDir, 'QQ.exe');
      if (qqExe) {
        // 如果 QQ.exe 在子目录里，上提
        const qqDir = path.dirname(qqExe);
        if (qqDir !== destDir) {
          log(`7zip 提取：将 ${qqDir}/ 内容上提到 ${destDir}/`);
          for (const item of fs.readdirSync(qqDir)) {
            fs.renameSync(path.join(qqDir, item), path.join(destDir, item));
          }
        }
        return true;
      }
    } catch {
      // 该命令不可用，尝试下一个
    }
  }
  return false;
}

function findFileRecursive(dir, filename) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) return full;
      if (entry.isDirectory()) {
        const found = findFileRecursive(full, filename);
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── 主流程 ──

async function main() {
  if (CHECK_ONLY) {
    const sl = isSnowlumaReady();
    const qq = isQqPortableReady();
    log(`SnowLuma: ${sl ? '✅ 就绪' : '❌ 缺失'}`);
    log(`便携 QQ:  ${qq ? '✅ 就绪' : '❌ 缺失'}`);
    const cb = readClientBuild();
    // 即使没装 snowluma 也把字段打出来：排查"版本不匹配"时，用户第一眼
    // 要能看到协议栈声明值；缺失也要显式说明，而不是整行消失。
    if (cb) log(`协议栈 CLIENT_BUILD: ${cb}（本脚本期望 ${EXPECTED_CLIENT_BUILD}）`);
    else log('协议栈 CLIENT_BUILD: （未安装 snowluma/）');
    if (process.platform === 'darwin') {
      log('macOS 提示：SnowLuma 走 Docker，请用 npm run check:macos');
    }
    if (sl && qq) { checkClientBuildMatch(); return; }
    process.exit(1);
  }

  log('=== QQ Agent Setup ===');
  log(`SnowLuma: ${SNOWLUMA_VERSION}`);
  log(`QQ:       ${QQ_VERSION}`);
  log(`工作目录: ${ROOT}`);
  log('');

  // 1. SnowLuma
  await installSnowluma();
  // 1.5 让协议栈声明的版本与实际运行的 QQ 一致（见 alignClientBuild 注释）
  alignClientBuild();

  // 2. 便携 QQ（可选跳过）
  if (!SKIP_QQ) {
    await installQqPortable();
  } else {
    log('跳过 QQ 安装（--skip-qq）');
  }

  // 3. 最终校验
  log('');
  log('=== 校验 ===');
  const checks = [
    ['SnowLuma index.mjs', fs.existsSync(path.join(SNOWLUMA_DIR, 'index.mjs'))],
    ['SnowLuma node.exe', fs.existsSync(path.join(SNOWLUMA_DIR, 'node.exe'))],
    ['QQ Agent src/app.js', fs.existsSync(path.join(ROOT, 'src', 'app.js'))],
  ];
  if (!SKIP_QQ) {
    checks.push(['便携 QQ QQ.exe', fs.existsSync(path.join(QQ_PORTABLE_DIR, 'QQ.exe'))]);
  }

  let allOk = true;
  for (const [name, ok] of checks) {
    log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    die('部分校验未通过，请检查上方输出');
  }

  // 版本兼容性检查放在最后：前面先保证"装上了"，这里再提示"装得对不对"。
  // 跳过 QQ 安装时也检查 —— 之前装好的便携 QQ 同样可能与协议栈不匹配。
  checkClientBuildMatch();

  log('');
  log('🎉 Setup 完成！现在可以启动：');
  log('   双击「启动QQ机器人.bat」或 npm start');
  log('');
  log('首次使用：');
  log('  1. 启动后在 SnowLuma 页签点「启动 QQ」');
  log('  2. 在弹出的便携 QQ 窗口扫码登录');
  log('  3. SnowLuma 会自动注入并连上 OneBot');
  log('  4. 机器人开始工作');
}

main().catch((e) => die(e.stack ?? e.message));
