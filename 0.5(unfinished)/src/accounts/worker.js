// 单个 QQ 号的隔离运行空间（0.5 内核版）。
//
// 与 0.4 的 worker 思路相同：每个号一个 worker_threads 线程、自己的
// QQ_AGENT_DATA_DIR 与 QQ_AGENT_PORT；区别是 0.5 的内核本身就用工厂装配，
// 所以这里直接 createApplication({ env })，不需要改任何模块级常量。
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

if (!parentPort) throw new Error('accounts/worker.js 只能由账号中心以 worker_threads 方式启动');

const meta = workerData || {};
const dataDir = String(meta.dataDir || '');
const accountId = String(meta.id || '');
const accountName = String(meta.name || '');
const hubPort = Number(meta.hubPort) || 0;
const preferredPort = Number(meta.port) || 0;
if (!dataDir || !accountId) throw new Error('账号 worker 缺少 dataDir/id');

process.env.QQ_AGENT_DATA_DIR = dataDir;
process.env.QQ_AGENT_ACCOUNT_ID = accountId;
process.env.QQ_AGENT_ACCOUNT_NAME = accountName;
if (hubPort) process.env.QQ_AGENT_HUB_PORT = String(hubPort);
// 账号中心已经为该号分配了控制台端口；用 env 覆盖可以保证端口就是卡片上那个，
// 不会被其它号或旧配置顶到 3211+。
if (preferredPort) process.env.QQ_AGENT_PORT = String(preferredPort);

const STATUS_FILE = path.join(dataDir, 'account-runtime.json');
const startedAt = Date.now();
let app = null;
let port = 0;
let stopping = false;
let statusTimer = null;
let lastStatusLine = '';

function writeStatusFile(status) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${STATUS_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
    fs.renameSync(tmp, STATUS_FILE);
  } catch { /* 诊断文件失败不影响运行 */ }
}

function snapshot(extra = {}) {
  const cfg = (() => { try { return app?.config?.get?.() || {}; } catch { return {}; } })();
  const transport = (() => { try { return app?.transport?.status?.() || {}; } catch { return {}; } })();
  const orch = (() => { try { return app?.orchestrator?.status?.() || {}; } catch { return {}; } })();
  return {
    id: accountId,
    name: accountName,
    running: !!app,
    stopping,
    port,
    pid: process.pid,
    startedAt,
    updatedAt: Date.now(),
    connected: !!transport.connected,
    everConnected: !!transport.everConnected,
    lastError: transport.error ? String(transport.error) : '',
    selfId: String(transport.selfId || app?.transport?.selfId || ''),
    nickname: String(transport.selfNickname || app?.transport?.selfNickname || ''),
    model: cfg.api?.model || '',
    provider: cfg.api?.provider || '',
    paused: !!orch.paused,
    allowGroups: Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0,
    allowPrivate: Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0,
    allowAll: cfg.allowAllWhenEmpty === true,
    onebot: {
      wsUrl: String(cfg.onebot?.wsUrl || ''),
      httpUrl: String(cfg.onebot?.httpUrl || ''),
      hasToken: Boolean(cfg.onebot?.accessToken),
      hasHttpToken: Boolean(cfg.onebot?.httpAccessToken || cfg.onebot?.accessToken)
    },
    dataDir,
    ...extra
  };
}

function publish(extra = {}, { forceFile = false } = {}) {
  const status = snapshot(extra);
  try { parentPort.postMessage({ type: 'status', status }); } catch { /* 父线程可能已退出 */ }
  const line = JSON.stringify({ ...status, updatedAt: 0 });
  if (forceFile || line !== lastStatusLine) {
    lastStatusLine = line;
    writeStatusFile(status);
  }
}

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { parentPort.postMessage({ type: 'log', line }); } catch { /* ignore */ }
  console.log(`[账号 ${accountName || accountId}] ${line}`);
}

async function boot() {
  log(`启动中（数据目录 ${dataDir}）`);
  const { createApplication } = await import('../kernel/composition.js');
  app = await createApplication({
    headless: true,
    env: {
      ...process.env,
      QQ_AGENT_DATA_DIR: dataDir,
      QQ_AGENT_PORT: preferredPort ? String(preferredPort) : String(process.env.QQ_AGENT_PORT || '')
    }
  });
  port = await app.start();
  writeStatusFile(snapshot());
  parentPort.postMessage({ type: 'ready', port, status: snapshot() });
  statusTimer = setInterval(() => publish(), 2000);
  statusTimer.unref?.();
  log(`已就绪：http://127.0.0.1:${port}/`);
}

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'stop') {
    if (stopping) return;
    stopping = true;
    if (statusTimer) clearInterval(statusTimer);
    try {
      publish({ stopping: true }, { forceFile: true });
      await app?.stop?.();
      writeStatusFile(snapshot({ running: false, stopping: false, stoppedAt: Date.now() }));
      parentPort.postMessage({ type: 'stopped' });
    } catch (error) {
      parentPort.postMessage({ type: 'stopped', error: String(error?.message ?? error) });
    }
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (msg.type === 'pause') {
    try {
      if (msg.value) app?.orchestrator?.pause?.();
      else app?.orchestrator?.resume?.({ skipBacklog: false });
    } catch { /* ignore */ }
    publish({}, { forceFile: true });
    return;
  }
  if (msg.type === 'get-status') {
    publish({}, { forceFile: true });
    return;
  }
  if (msg.type === 'config' && msg.patch && typeof msg.patch === 'object') {
    try {
      // 0.5 的配置写入走 runtime.config 组件；优先用内核暴露的 update 方法。
      if (typeof app?.config?.update === 'function') app.config.update(msg.patch);
      else if (typeof app?.config?.set === 'function') app.config.set(msg.patch);
      publish({}, { forceFile: true });
      parentPort.postMessage({ type: 'config-applied' });
    } catch (error) {
      parentPort.postMessage({ type: 'error', error: String(error?.message ?? error) });
    }
  }
});

boot().catch((error) => {
  const message = String(error?.stack ?? error?.message ?? error);
  writeStatusFile(snapshot({ running: false, error: message, updatedAt: Date.now() }));
  try { parentPort.postMessage({ type: 'error', error: message }); } catch { /* ignore */ }
  setTimeout(() => process.exit(1), 100);
});

process.on('exit', () => {
  try { writeStatusFile(snapshot({ running: false, stoppedAt: Date.now() })); } catch { /* ignore */ }
});
