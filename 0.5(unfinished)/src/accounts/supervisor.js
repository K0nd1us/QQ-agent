// 账号总监督：把"账号中心 HUB"和"各账号 worker"装成一个可启停的整体。
//
// Electron 主进程与 headless 入口都从这里启动，保证桌面端和命令行行为一致。
// 账号 worker 全部是**同一进程内的线程**；任务管理器里只有一个 QQ Agent。
import { createAccountManager } from './manager.js';
import { createHub } from './hub.js';

export function createSupervisor({ baseDataDir, log = () => {}, hubPort = 3211, autoStart = true } = {}) {
  const manager = createAccountManager({ baseDataDir, hubPort: 0, log });
  const hub = createHub({ manager, log });
  let started = false;
  let hubPortActual = 0;

  async function start() {
    if (started) return hubPortActual;
    hubPortActual = await hub.listen(hubPort);
    manager.setHubPort(hubPortActual);
    started = true;
    if (autoStart) {
      // 不阻塞窗口出现：账号在后台各自连接协议端，卡片会实时显示进度。
      manager.startAll().catch((error) => log(`[账号中心] 批量启动失败：${error?.message ?? error}`));
    }
    return hubPortActual;
  }

  async function stop() {
    if (!started) return;
    started = false;
    await hub.close().catch(() => {});
    await manager.stopAll().catch(() => {});
  }

  return {
    start,
    stop,
    manager,
    hub,
    get hubPort() { return hubPortActual; },
    get hubUrl() { return hubPortActual ? `http://127.0.0.1:${hubPortActual}/` : ''; },
    list: () => manager.list(),
    get: (id) => manager.get(id),
    openConsole: (id) => manager.openConsole(id),
    pause: (id, value) => manager.pause(id, value),
    pauseAll: (value) => manager.pauseAll(value),
    pauseState: () => manager.pauseState(),
    getPrimaryConfig: () => manager.getPrimaryConfig(),
    updatePrimaryConfig: (patch) => manager.updatePrimaryConfig(patch),
    baseDataDir: manager.baseDataDir
  };
}
