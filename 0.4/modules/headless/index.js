import { createApp } from '../../src/app.js';
import { getConfig, deepMerge } from '../../src/config.js';
import { BotConnection, connectionConfig } from './connection.js';
import { createConsoleAuth, serverOptions } from './console.js';

// Trusted, explicit bootstrap composition; never loaded as a chat Skill/plugin.
// The desktop entry does not import this module.
export function createHeadlessApp({ env = process.env, log = console.log } = {}) {
  const options = () => serverOptions(getConfig(), env);
  options();
  connectionConfig(getConfig());
  const auth = createConsoleAuth({ getOptions: options });
  let connection, orchestrator, emit, stopped = false;
  const runtime = {
    name: 'headless',
    listenOptions: () => options(),
    authorize: auth.authorize,
    originAllowed: auth.originAllowed,
    createConnection({ config, server, onEvent }) {
      connection = new BotConnection({ config: connectionConfig(config), server, onEvent });
      return connection;
    },
    attach(context) { ({ orchestrator, emit } = context); },
    status() {
      const cfg = connection.config;
      return {
        runtime: { name: 'headless', platform: process.platform, arch: process.arch, connectionSettingsPath: '/runtime/connection' },
        connection: { type: cfg.type, enabled: cfg.enabled, connected: connection.connected },
        onebot: {
          type: cfg.type, connected: connection.connected, everConnected: connection.everConnected,
          error: connection.lastConnectError,
          diagnosis: !cfg.enabled ? '协议接入未启用 / Connection disabled'
            : connection.connected ? '' : connection.lastConnectError || '等待协议连接 / Waiting for protocol connection',
          self: connection.selfInfo ? { userId: connection.selfId, nickname: connection.selfNickname } : null
        },
        snowluma: { external: true, running: false, dir: '', webuiUrl: '' },
        qqPortable: { external: true, installed: false, running: false }
      };
    },
    validateConfig(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Configuration patch must be an object');
      const merged = deepMerge(getConfig(), patch);
      serverOptions(merged, env);
      connectionConfig(merged);
    },
    async configChanged(next, before) {
      const config = connectionConfig(next);
      if (JSON.stringify(config) === JSON.stringify(connectionConfig(before))) return;
      // abortAll is a permanent shutdown gate in the core. Reconfiguration must
      // cancel old runs individually and then restore scheduling and timers.
      for (const id of orchestrator.activeRuns.values()) orchestrator.abortSession(id);
      await orchestrator.abortAll();
      if (stopped) return;
      try {
        connection.configure(config);
        await connection.connect();
      } finally {
        if (!stopped) {
          orchestrator.aborted = false;
          if (next.proactive?.enabled) orchestrator.startProactiveLoop();
          orchestrator.startReminderLoop();
        }
      }
      emit('onebot-status', { connected: connection.connected, type: connection.type });
    },
    async handleRequest(context) {
      if (await auth.handleRequest(context)) return true;
      const { req, res, url, json } = context;
      if (url.pathname === '/api/runtime/connection' && req.method === 'GET') {
        const config = connectionConfig(getConfig());
        const ob = { ...config.onebot }, qq = { ...config.qqbot };
        ob.hasAccessToken = Boolean(ob.accessToken);
        ob.hasHttpAccessToken = Boolean(ob.httpAccessToken);
        qq.hasAppSecret = Boolean(qq.appSecret);
        delete ob.accessToken;
        delete ob.httpAccessToken;
        delete qq.appSecret;
        json(res, 200, { ...config, onebot: ob, qqbot: qq });
        return true;
      }
      if (/^\/api\/(snowluma|qq-portable)(\/|$)/.test(url.pathname) || url.pathname === '/api/open-data-dir') {
        json(res, 409, { error: '外部运行模块不管理桌面 QQ 进程 / Manage the external protocol service separately' });
        return true;
      }
      return false;
    },
    stop() { stopped = true; connection?.close(); auth.close(); }
  };
  return createApp({ log, runtime });
}
