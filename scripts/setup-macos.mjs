#!/usr/bin/env node
/**
 * macOS 协议端安装：SnowLuma（官方 Linux/arm64 Docker 镜像）。
 *
 *   npm run setup:macos              # 启动/检查 Docker → 拉镜像 → 建容器
 *   npm run setup:macos -- --force   # 强制重新拉镜像并重建容器（数据卷保留）
 *   npm run setup:macos -- --check   # 只检查，不安装
 *
 * 为什么是 Docker：
 *   SnowLuma 官方 Release 只有 Windows / Linux（依赖 QQ NT 客户端），没有
 *   macOS 原生包。官方 SnowLuma.Docker.Framework 把 Linux QQ + Xvfb +
 *   noVNC + SnowLuma 打进镜像，并提供 linux/arm64 —— Docker Desktop 在
 *   Apple Silicon 上原生运行，扫码/登录在浏览器 noVNC 里完成。
 *
 * 端口（只映射到 127.0.0.1）：
 *   6081 noVNC（QQ 窗口，扫码）  5099 SnowLuma WebUI
 *   3000 OneBot HTTP             3001 OneBot WebSocket
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SNOWLUMA_IMAGE, SNOWLUMA_CONTAINER, NOVNC_PORT, WEBUI_PORT,
  ONEBOT_HTTP_PORT, ONEBOT_WS_PORT, VNC_PASSWORD,
  dockerBin, ensureDocker, isDockerAvailable, imageExists,
  pullImage, createContainer, containerState, startContainer,
  webuiUrl, novncUrl, status, readWebuiInitialCredentials
} from '../src/snowluma-docker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = process.env.QQ_AGENT_RUNTIME_DIR || path.join(ROOT, 'runtime');
const MAC_DIR = path.join(RUNTIME_DIR, 'macos');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const CHECK_ONLY = args.includes('--check');
const FROM_UI = args.includes('--from-ui');

const log = (...a) => console.log('[setup-macos]', ...a);
const warn = (...a) => console.warn('[setup-macos]', ...a);
const die = (msg) => { console.error('[setup-macos] ❌', msg); process.exit(1); };

function platformCheck() {
  if (process.platform !== 'darwin') {
    die(`本脚本只用于 macOS（当前 ${process.platform}）。Windows 请用 npm run setup。`);
  }
  log(`macOS ${os.release()} / ${os.arch}，Docker：${dockerBin()}`);
  fs.mkdirSync(MAC_DIR, { recursive: true });
}

async function check() {
  platformCheck();
  const st = await status();
  log(`Docker      ：${st.dockerReady ? '✓ 运行中' : '✗ 未运行'}`);
  log(`镜像        ：${st.imageReady ? `✓ ${SNOWLUMA_IMAGE}` : '✗ 未拉取'}`);
  log(`容器        ：${st.exists ? `✓ ${SNOWLUMA_CONTAINER}（${st.running ? '运行中' : '已停止'}）` : '✗ 未创建'}`);
  log(`noVNC       ：${novncUrl()}（密码 ${VNC_PASSWORD}）`);
  log(`WebUI       ：${webuiUrl()}`);
  log(`OneBot      ：ws://127.0.0.1:${ONEBOT_WS_PORT}  /  http://127.0.0.1:${ONEBOT_HTTP_PORT}`);
  if (!st.dockerReady || !st.imageReady || !st.exists) {
    log('状态：尚未安装完整。运行 npm run setup:macos 安装。');
    process.exit(1);
  }
  log('状态：已就绪 ✓');
}

async function main() {
  if (CHECK_ONLY) return check();
  platformCheck();

  // 1) Docker Desktop
  if (!(await isDockerAvailable())) {
    log('Docker 未运行，尝试启动 Docker Desktop…');
    const d = await ensureDocker((line) => log(line));
    if (!d.ok) die(d.error);
  }
  log('Docker 已就绪');

  // 2) 镜像
  if (FORCE || !(await imageExists())) {
    const pulled = await pullImage((line) => log(line));
    if (!pulled.ok) die(pulled.error);
    log('SnowLuma 镜像就绪');
  } else {
    log(`镜像已存在：${SNOWLUMA_IMAGE}`);
  }

  // 3) 容器（--force 时重建，数据卷保留）
  if (FORCE) {
    const r = await new Promise((resolve) => {
      const c = spawn(dockerBin(), ['rm', '-f', SNOWLUMA_CONTAINER], { stdio: 'inherit' });
      c.on('exit', (code) => resolve(code));
      c.on('error', () => resolve(1));
    });
    if (r !== 0) warn('删除旧容器失败（可能本来就不存在），继续');
  }
  const created = await createContainer((line) => log(line));
  if (!created.ok) die(created.error);

  // 4) 启动（docker run 已经启动；这里兜底处理"容器已存在但停着"）
  const started = await startContainer((line) => log(line));
  if (!started.ok) die(started.error);

  const st = await status();
  log('✅ macOS 协议端（SnowLuma Docker）已就绪');
  log(`   容器：${SNOWLUMA_CONTAINER}（pid ${st.pid ?? '启动中'}）`);
  log(`   noVNC 扫码桌面：${novncUrl()}`);
  log(`     密码：${VNC_PASSWORD}`);
  log(`   SnowLuma WebUI：${webuiUrl()}`);
  log(`   OneBot：ws://127.0.0.1:${ONEBOT_WS_PORT} / http://127.0.0.1:${ONEBOT_HTTP_PORT}`);

  // 等 SnowLuma 首次启动把 WebUI 初始密码打进日志（只打印一次）
  let creds = null;
  for (let i = 0; i < 20 && !creds; i++) {
    creds = await readWebuiInitialCredentials().catch(() => null);
    if (!creds) await new Promise((r) => setTimeout(r, 1000));
  }
  if (creds) {
    log('');
    log(`🔑 WebUI 初始登录：用户 ${creds.user} / 密码 ${creds.password}`);
    log('   首次登录后请同意 EULA 并修改密码，然后按 WebUI 引导扫码登录 QQ。');
  } else {
    log('   （WebUI 初始密码尚未出现在日志里：docker logs qq-agent-snowluma 可查看）');
  }
  log('');
  log('下一步：打开 WebUI 完成首次引导并扫码登录 QQ；登录后 OneBot 自动在 3001 监听，');
  log('        QQ Agent 随即连上。首次启动容器需要几十秒，请耐心等待。');
  if (FROM_UI) log('（本脚本由控制台触发，完成后回到页面即可）');
}

main().catch((error) => die(error?.stack ?? error?.message ?? String(error)));
