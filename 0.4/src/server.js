// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问账号中心）
//
// 与桌面端走同一条路径：账号中心 HUB + 每个 QQ 号一个隔离 worker（同一进程内的线程）。
// 1 号账号的控制台仍在原来的 3210；账号中心默认在 3211。
import { createSupervisor } from './accounts/supervisor.js';
import { DATA_DIR } from './config.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
// 未捕获异常后进程处于未定义状态（定时器丢失/连接悬空），记录后退出，
// 交给外层（systemd/脚本守护）重启 —— 只打印不退出会"半死不活"地挂着
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

const supervisor = createSupervisor({
  baseDataDir: DATA_DIR,
  log: (...args) => console.log(...args)
});

supervisor.start().then((hubPort) => {
  console.log(`\n  账号中心：http://127.0.0.1:${hubPort}/`);
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
