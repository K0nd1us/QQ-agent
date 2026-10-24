#!/usr/bin/env node
/**
 * macOS 卸载：停止并删除 SnowLuma 容器。
 *
 *   npm run uninstall:macos            # 删容器，保留 QQ 登录态与配置（数据卷）
 *   npm run uninstall:macos -- --purge # 连三个数据卷一起删（登录态丢失）
 *
 * 不会碰用户安装的 QQ.app / Docker Desktop。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SNOWLUMA_CONTAINER, dockerBin, stopContainer, removeContainer, isDockerAvailable
} from '../src/snowluma-docker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = process.env.QQ_AGENT_RUNTIME_DIR || path.join(ROOT, 'runtime');
const MAC_DIR = path.join(RUNTIME_DIR, 'macos');
const PURGE = process.argv.includes('--purge');

const log = (...a) => console.log('[uninstall-macos]', ...a);

async function docker(args) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const c = spawn(dockerBin(), args, { stdio: 'inherit' });
      c.on('exit', (code) => resolve(code));
      c.on('error', () => resolve(1));
    });
  });
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('[uninstall-macos] 本脚本只用于 macOS');
    process.exit(1);
  }
  if (!(await isDockerAvailable())) {
    log('Docker 未运行，容器不会被自动删除。启动 Docker 后再运行，或手动 docker rm -f', SNOWLUMA_CONTAINER);
  } else {
    const stopped = await stopContainer();
    log(stopped.stopped ? `已停止容器 ${SNOWLUMA_CONTAINER}` : '容器本来就没在运行');
    const removed = await removeContainer();
    log(removed.removed ? `已删除容器 ${SNOWLUMA_CONTAINER}` : '容器不存在或删除失败');
    if (PURGE) {
      log('--purge：删除 SnowLuma 数据卷（登录态/配置会丢失）');
      for (const v of ['qq-agent-snowluma-data', 'qq-agent-snowluma-config', 'qq-agent-snowluma-local']) {
        await docker(['volume', 'rm', '-f', v]);
      }
    } else {
      log('数据卷已保留（含 QQ 登录态）；需要彻底清除请加 --purge');
    }
  }
  if (fs.existsSync(MAC_DIR)) {
    fs.rmSync(MAC_DIR, { recursive: true, force: true });
    log('已删除运行目录', MAC_DIR);
  }
  log('完成。用户安装的 QQ.app 与 Docker Desktop 未改动。');
}

main().catch((e) => { console.error(e); process.exit(1); });
