#!/usr/bin/env node
/**
 * NapCat 协议端安装脚本：下载、解压、补丁、验证，一条命令完成。
 *
 *   npm run setup:napcat          # 安装/修复（已存在则跳过，--force 强制重装）
 *   node scripts/setup-napcat.mjs --force    # 删除后重新下载
 *   node scripts/setup-napcat.mjs --check    # 只检查是否已安装
 *
 * 仓库不收录 NapCat / QQ 内核二进制（见 .gitignore 的 napcat/ 条目）。
 * 本脚本从 NapCat 官方 GitHub Releases 下载，用户自行触发下载，
 * 仓库与作者不分发任何腾讯二进制。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// 共用下载器（与 setup.mjs 同一份实现）
import { download as downloadFile } from './lib/download.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAPCAT_DIR = path.join(ROOT, 'napcat');
const SHELL_DIR = path.join(NAPCAT_DIR, 'shell');
const NAPCAT_MJS = path.join(SHELL_DIR, 'napcat', 'napcat.mjs');

const NAPCAT_REPO = 'NapNeko/NapCatQQ';
// 固定版本保证可复现；想升级改这里，或设环境变量 NAPCAT_VERSION=vx.y.z
const NAPCAT_VERSION = process.env.NAPCAT_VERSION || 'v4.18.19';
const ASSET = 'NapCat.Shell.Windows.Node.zip';
// 固定 zip 的 SHA256（64 位十六进制）。环境变量 NAPCAT_SHA256 可覆盖（改版本时用）。
// ⚠️ 曾经默认为空 —— 这个 zip 里的 napcat.mjs 会被就地补丁并**作为被执行的代码**，
//    下载却无完整性校验（对照 setup.mjs 的 QQ 包是硬编码 SHA 的）。
//    哈希来源：GitHub API v4.18.19 资产 digest（assets[].digest, sha256: 前缀去掉）。
//    换 NAPCAT_VERSION 时必须同步更新（GitHub API: /releases/tags/<tag>）。
const NAPCAT_DEFAULT_SHA256 = 'a08e7bebe49f656807f198bbf3a5d3f2fd6f840499728d665285323db4342d77';
const NAPCAT_SHA256 = (process.env.NAPCAT_SHA256 || '').trim() || NAPCAT_DEFAULT_SHA256;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const CHECK_ONLY = args.includes('--check');

const log = (...a) => console.log('[setup-napcat]', ...a);
const die = (msg) => { console.error('[setup-napcat] ❌', msg); process.exit(1); };

/** 已安装判定：wrapper.node（QQ 内核）与 napcat.mjs（NapCat 本体）都在位 */
function isInstalled() {
  return fs.existsSync(path.join(SHELL_DIR, 'wrapper.node')) && fs.existsSync(NAPCAT_MJS);
}

/** 打补丁：纯 node 环境下 worker 启动参数不能带 Chromium 的 --no-sandbox，
 *  否则 node 报 "bad option" 崩溃（NapCat Shell.Node 官方包的已知问题）。
 *  Electron 环境不受影响——补丁只在 execArgv 分支里删掉这个参数。
 *
 *  ⚠️ 这是**就地改写第三方源码**，安全前提是"下载的 zip 未被篡改"；
 *  请配合 NAPCAT_SHA256 使用（download() 会提示）。这里额外记录改动前后的
 *  文件哈希，便于事后核对。 */
function patchNoSandbox() {
  let text = fs.readFileSync(NAPCAT_MJS, 'utf8');
  const needle = 'execArgv: ["--no-sandbox"]';
  if (!text.includes(needle)) {
    log('补丁：未找到目标片段（可能官方已修复或已打过补丁），跳过');
    return false;
  }
  const before = createHash('sha256').update(text).digest('hex').slice(0, 12);
  text = text.replaceAll(needle, 'execArgv: []');
  fs.writeFileSync(NAPCAT_MJS, text);
  const after = createHash('sha256').update(text).digest('hex').slice(0, 12);
  log('补丁：已移除 worker execArgv 中的 --no-sandbox（纯 node 兼容）');
  log(`  napcat.mjs sha256 ${before}… → ${after}…（便于回溯本次改动）`);
  return true;
}

async function latestAssetUrl() {
  const res = await fetch(`https://api.github.com/repos/${NAPCAT_REPO}/releases/tags/${NAPCAT_VERSION}`);
  if (!res.ok) die(`查询 Release 失败：HTTP ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets ?? []).find((a) => a.name === ASSET);
  if (!asset) die(`Release ${NAPCAT_VERSION} 中没有 ${ASSET}。可用资源：${(rel.assets ?? []).map((a) => a.name).join(', ')}`);
  return asset.browser_download_url;
}

async function download(url, dest) {
  log('下载', url);
  // 供应链防线：下载源被 NAPCAT_VERSION 改写时必须给出 NAPCAT_SHA256。
  // 供应链防线：版本被环境变量改写时，SHA 也必须显式给出 ——
  // 默认哈希只对默认版本有效，换版本沿用旧哈希必挂。
  // （比较用 NAPCAT_VERSION 常量自身，别再硬编码一份版本字符串 —— 两处必失同步）
  if (process.env.NAPCAT_VERSION && process.env.NAPCAT_VERSION !== NAPCAT_VERSION && !process.env.NAPCAT_SHA256) {
    die(`检测到 NAPCAT_VERSION 被覆盖（${process.env.NAPCAT_VERSION}），但未提供 NAPCAT_SHA256。\n`
      + '  为防供应链投毒，拒绝从非官方固定版本下载。请设置 NAPCAT_SHA256=<zip 的 sha256> 后重试。');
  }
  try {
    // 共用下载器：流式写盘 + 进度条 + 增量哈希 + .part 原子改名。
    // 与 setup.mjs 是同一份实现，避免两边各自演化出不同行为。
    const r = await downloadFile(url, dest, {
      expectedSha256: NAPCAT_SHA256 || null,
      label: 'NapCat '
    });
    if (NAPCAT_SHA256) log('SHA256 校验通过 ✓');
    log(`已保存 ${dest}（${(r.bytes / 1048576).toFixed(1)} MB）`);
  } catch (error) {
    // 进度条画在 stderr 上，先让出干净的一行再打日志
    process.stderr.write('\n');
    die(error?.message ?? String(error));
  }
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // timeout：解压挂起（杀软扫描大文件等）曾让脚本永久卡死，无任何兜底
  // （对照 setup.mjs 的 900s 上限）。execFileSync 超时会杀掉子进程并抛错。
  const OPTS = { stdio: 'inherit', timeout: 900_000 };
  if (process.platform === 'win32') {
    // Windows 自带 tar 支持 zip；PowerShell Expand-Archive 慢且对长路径不稳
    execFileSync('tar', ['-xf', zipPath, '-C', destDir], OPTS);
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', destDir], OPTS);
  }
}

async function main() {
  if (CHECK_ONLY) {
    if (isInstalled()) { log('✅ NapCat 已安装于', SHELL_DIR); return; }
    log('未安装。运行: npm run setup:napcat');
    process.exit(1);
  }

  if (isInstalled() && !FORCE) {
    log('✅ NapCat 已存在（', SHELL_DIR, '），跳过下载。需要重装请加 --force');
    ensurePatched();
    return;
  }

  if (FORCE && fs.existsSync(NAPCAT_DIR)) {
    log('--force：删除旧目录', NAPCAT_DIR);
    fs.rmSync(NAPCAT_DIR, { recursive: true, force: true });
  }

  const url = await latestAssetUrl();
  const zipPath = path.join(NAPCAT_DIR, 'napcat-shell.zip');
  fs.mkdirSync(NAPCAT_DIR, { recursive: true });
  await download(url, zipPath);

  log('解压到', SHELL_DIR);
  unzip(zipPath, SHELL_DIR);
  fs.rmSync(zipPath, { force: true });

  // 官方 zip 解压后可能带一层目录，把内容上提
  const entries = fs.readdirSync(SHELL_DIR);
  if (!fs.existsSync(path.join(SHELL_DIR, 'wrapper.node'))) {
    const inner = entries.find((e) => fs.existsSync(path.join(SHELL_DIR, e, 'wrapper.node')));
    if (inner) {
      log(`调整目录层级：${inner}/ -> ./`);
      for (const f of fs.readdirSync(path.join(SHELL_DIR, inner))) {
        fs.renameSync(path.join(SHELL_DIR, inner, f), path.join(SHELL_DIR, f));
      }
      fs.rmSync(path.join(SHELL_DIR, inner), { recursive: true, force: true });
    }
  }

  if (!isInstalled()) die('安装后校验失败：wrapper.node 或 napcat.mjs 缺失');
  patchNoSandbox();
  log('✅ NapCat 安装完成：', SHELL_DIR);
  log('   启动方式： node napcat/shell/index.js  （或运行我们提供的 start 脚本）');
  log('   首次启动需用手机 QQ 扫码登录。');
}

function ensurePatched() {
  try { patchNoSandbox(); } catch (e) { die(`打补丁失败：${e.message}`); }
}

main().catch((e) => die(e.stack ?? e.message));
