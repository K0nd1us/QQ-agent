// 0.5 headless 多账号入口：node src/accounts/server.js
//
// 保留原 src/server.js（单号、启动组合入口）不动；多账号是另一种运行形态：
// 账号中心 HUB + 每个号一个隔离 worker（同一进程内的线程）。
import { createSupervisor } from './supervisor.js';
import { APP_ROOT, resolveDataDir } from '../kernel/env.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

const dataDir = resolveDataDir(process.env, APP_ROOT);
const supervisor = createSupervisor({
  baseDataDir: dataDir,
  log: (...args) => console.log(...args)
});

supervisor.start().then((hubPort) => {
  console.log(`\n  账号中心（控制台）：http://127.0.0.1:${hubPort}/`);
  for (const account of supervisor.list()) {
    console.log(`  ${account.name}：${account.consoleUrl || '（未分配端口）'}  ${account.dataDir}`);
  }
  console.log('');
}).catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

const shutdown = async (signal) => {
  console.log(`\n[${signal}] 退出中…`);
  try {
    await supervisor.stop();
    process.exit(0);
  } catch (error) {
    console.error('[退出清理失败]', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
