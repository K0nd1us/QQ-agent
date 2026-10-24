// 单个 QQ 号的"隔离运行空间"。
//
// 为什么用 worker_threads 而不是再改一遍核心：
//   · 0.4 的 config / store / memory / logger 等模块在 import 时就把 DATA_DIR 固定住了，
//     同一进程里 import 两次会共用同一份单例，做不到真正的数据隔离；
//   · worker_threads 是**同一进程内的独立 JS 运行环境**：每个 worker 有自己的模块表、
//     自己的 process.env 副本，因此只要在 import app.js 之前把 QQ_AGENT_DATA_DIR
//     指到该账号目录，原程序的全部读写路径天然就落在各自目录里，无需改核心。
//   · 任务管理器里仍然只有一个 QQ Agent 进程（worker 是线程，不是子进程）。
//
// 本文件只做四件事：设置环境 → 启动原应用 → 定时上报状态 → 优雅停止。
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

if (!parentPort) {
  throw new Error('accounts/worker.js 只能由账号中心以 worker_threads 方式启动');
}

const meta = workerData || {};
const dataDir = String(meta.dataDir || '');
const accountId = String(meta.id || '');
const accountName = String(meta.name || '');
const hubPort = Number(meta.hubPort) || 0;
if (!dataDir || !accountId) throw new Error('账号 worker 缺少 dataDir/id');

// ⚠️ 必须在 import app.js 之前设置：config.js 在模块求值时就读取它并导出 DATA_DIR。
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.env.QQ_AGENT_ACCOUNT_ID = accountId;
process.env.QQ_AGENT_ACCOUNT_NAME = accountName;
if (hubPort) process.env.QQ_AGENT_HUB_PORT = String(hubPort);

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
  } catch { /* 状态文件只是排障辅助，失败不影响运行 */ }
}

function snapshot(extra = {}) {
  const cfg = app?.getConfig?.() || {};
  const base = {
    id: accountId,
    name: accountName,
    running: !!app,
    stopping,
    port,
    pid: process.pid,
    threadId: meta.threadId ?? null,
    startedAt,
    updatedAt: Date.now(),
    connected: !!app?.onebot?.connected,
    everConnected: !!app?.onebot?.everConnected,
    lastError: String(app?.onebot?.lastConnectError || ''),
    selfId: app?.onebot?.selfId || '',
    nickname: app?.onebot?.selfNickname || '',
    model: cfg.api?.model || '',
    provider: cfg.api?.provider || '',
    paused: !!app?.orchestrator?.paused,
    allowGroups: Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0,
    allowPrivate: Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0,
    allowAll: cfg.allowAllWhenEmpty === true,
    onebot: {
      wsUrl: String(cfg.onebot?.wsUrl || cfg.snowluma?.wsUrl || ''),
      httpUrl: String(cfg.onebot?.httpUrl || cfg.snowluma?.httpUrl || ''),
      hasToken: Boolean(cfg.onebot?.accessToken || cfg.snowluma?.accessToken),
      hasHttpToken: Boolean(cfg.onebot?.httpAccessToken || cfg.onebot?.accessToken
        || cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken)
    },
    dataDir,
    ...extra
  };
  return base;
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
  // 同时留在主进程控制台，方便 Electron 启动失败时直接看到
  console.log(`[账号 ${accountName || accountId}] ${line}`);
}

async function boot() {
  log(`启动中（数据目录 ${dataDir}）`);
  const mod = await import('../app.js');
  app = mod.createApp({ log });
  port = await app.start();
  writeStatusFile(snapshot());
  parentPort.postMessage({ type: 'ready', port, status: snapshot() });

  // 状态：连接状态变化要尽快反映到账号中心，所以 2 秒一轮；
  // 状态文件只在内容变化时写，避免每 2 秒一次磁盘写。
  statusTimer = setInterval(() => publish(), 2000);
  statusTimer.unref?.();

  // 首次连接成功/失败也立即上报一次
  app.onebot.onStatus?.(() => publish({}, { forceFile: true }));
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
    // 释放实例锁 / 关闭 socket 后再退出线程
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (msg.type === 'pause') {
    try { app?.orchestrator?.setPaused?.(!!msg.value, 'account-center'); } catch { /* ignore */ }
    publish({}, { forceFile: true });
    return;
  }
  if (msg.type === 'get-status') {
    publish({}, { forceFile: true });
    return;
  }
  if (msg.type === 'config' && msg.patch && typeof msg.patch === 'object') {
    try {
      app?.updateConfig?.(msg.patch);
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

// 父线程被强杀时尽量留下"已停止"的状态，不要留下一个看起来还在运行的假状态。
process.on('exit', () => {
  try { writeStatusFile(snapshot({ running: false, stoppedAt: Date.now() })); } catch { /* ignore */ }
});
