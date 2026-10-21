// 在线状态守卫（确定性型插件）
//
// 判定依据 doc/extend_development/plugin-development.md §0：触发时机能写成 if → 插件。
// 本插件占两个时机：
//   ① 关闭前（核心的 before-shutdown 钩子）→ 把 QQ 状态设成「请勿打扰」
//   ② 上线时（activate 里起一个后台重试）→ 若记账显示上次是我们设的 DND，就改回「在线」
//
// 为什么"上线恢复"要重试：activate 可能在 OneBot 连上之前就跑完了；连不上时接口会抛错，
// 所以按 retryTimes/retryIntervalMs 重试，连上即恢复。
//
// 为什么不在钩子里自己发 HTTP：钩子契约禁止网络请求（§3.2），所以状态调用统一走
// 核心提供的 api.setPresence / api.restorePresenceIfDnd —— 那只是一次本地协议调用
// （onebot.call → 127.0.0.1），由核心收口。清单里声明了 permissions: ["presence_control"]。
//
// 另外：升级/禁用时必须清掉 activate 里起的定时器（§10 自检清单）。

let getConfig = () => ({});
let apiRef = null;
let retryTimer = null;
let stopped = false;

export function setup(api) {
  apiRef = api;
  getConfig = api.config;      // 读本插件设置（manifest.settings 已合并默认值）
  stopped = false;
}

/** 上线恢复：后台跑，绝不 await（否则会把控制台启动卡住） */
async function restoreLoop() {
  const cfg = getConfig() || {};
  if (cfg.enabled === false || cfg.restoreOnStart === false) return;

  const maxTries = Math.max(1, Number(cfg.retryTimes) || 20);
  const interval = Math.max(500, Number(cfg.retryIntervalMs) || 3000);

  for (let i = 1; i <= maxTries && !stopped; i += 1) {
    try {
      // 只有"记账里明确是请勿打扰"才动手；没有记账 / 不是 DND 一律不碰
      const record = apiRef.getPresence ? apiRef.getPresence() : null;
      if (!record || record.dnd !== true) return;

      const r = await apiRef.restorePresenceIfDnd({ source: 'plugin-activate' });
      if (r && r.restored) {
        apiRef.log('上线恢复：请勿打扰 → 在线');
        return;
      }
      if (r && r.reason && r.reason !== 'not-dnd' && r.reason !== 'no-record') {
        apiRef.warn('恢复在线失败（第 %d 次）：%s', i, r.reason);
      } else {
        return;   // 记账已经被处理掉了（或本来就不是 DND）
      }
    } catch (error) {
      apiRef.warn('恢复在线失败（第 %d 次）：%s', i, error?.message ?? error);
    }
    await new Promise((resolve) => {
      retryTimer = setTimeout(resolve, interval);
    });
  }
}

export function activate() {
  // 注意：**不要 await** 这个循环 —— activate 是被核心 await 的，等 60 秒会把启动卡住。
  void restoreLoop();
}

export function deactivate() {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

export function dispose() {
  deactivate();
}

export const hooks = {
  /**
   * 关闭前：把 QQ 状态设成「请勿打扰」。
   * 这是**本地**协议调用（几十毫秒），不是外部网络请求；钩子的 5 秒预算足够。
   * 失败只记日志、不抛 —— 退出流程不能被状态设置拖住（核心那边也做了 3 秒限时）。
   */
  'before-shutdown': async () => {
    const cfg = getConfig() || {};
    if (cfg.enabled === false || cfg.dndOnShutdown === false) return;
    try {
      const r = await apiRef.setPresence('dnd', { source: 'plugin-shutdown' });
      if (r && r.ok) apiRef.log('关闭前已把 QQ 状态设为「请勿打扰」（status=%d）', r.status);
      else apiRef.warn('设置「请勿打扰」失败：%s', r?.error ?? '未知原因');
    } catch (error) {
      apiRef.warn('设置「请勿打扰」失败：%s', error?.message ?? error);
    }
  }
};
