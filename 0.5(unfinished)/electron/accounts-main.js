// 0.5 多账号桌面入口：账号中心 HUB + 每个 QQ 号一个隔离 worker。
//
// 为什么不改 electron/main.js：0.5 的原入口绑定了启动组合代、控制台令牌桥和
// 200+ 项桌面测试；多账号是"多个应用代并行"的另一种运行形态。这里单独一个
// 入口，保留原单号入口（electron/main.js）不动，互不影响。
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, resolveProfile } from '../src/kernel/env.js';
import { createSupervisor } from '../src/accounts/supervisor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_USER_MODEL_ID = 'cn.kondius.qq-agent';

app.disableHardwareAcceleration?.();
app.setAppUserModelId?.(APP_USER_MODEL_ID);

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  try { dialog.showErrorBox('QQ Agent 发生未捕获错误', String(error?.stack ?? error)); } catch { /* ignore */ }
  app.exit(1);
});

const profile = resolveProfile(process.env);
function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return path.resolve(process.env.QQ_AGENT_DATA_DIR);
  const suffix = profile.suffix;
  if (!app.isPackaged) return path.join(APP_ROOT, `data${suffix}`);
  return path.join(path.dirname(app.getPath('exe')), `data${suffix}`);
}
const DATA_DIR = resolveDataDir();
process.env.QQ_AGENT_DATA_DIR = DATA_DIR;
app.setPath('userData', path.join(DATA_DIR, 'electron-user-data'));

const DIAG = path.join(DATA_DIR, 'boot-diag.log');
function diag(stage, detail = '') {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(DIAG, `${new Date().toISOString()} ${stage}${detail ? ` ${detail}` : ''}\n`, 'utf8');
  } catch { /* 诊断不阻塞 */ }
}
diag('accounts-main loaded', `data=${DATA_DIR}`);

let supervisor = null;
let mainWindow = null;
let tray = null;
let quitting = false;
let shuttingDown = false;

function primaryConfig() {
  try { return supervisor?.getPrimaryConfig?.() || {}; } catch { return {}; }
}

function createWindow(hubPort) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '账号中心 · QQ Agent',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu?.(null);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[window] 加载失败', code, desc, url);
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(`http://127.0.0.1:${hubPort}/`).catch(() => {}); }, 1500);
  });
  win.webContents.on('render-process-gone', (_e, details) => console.error('[window] 渲染进程退出', details));
  // 账号中心会跳到各账号控制台（不同端口）；只要还是本机 HTTP 就放行。
  const isLocal = (u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(String(u || ''));
  const guard = (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(String(url || ''))) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (event) => {
    if (!quitting && primaryConfig().server?.closeToTray !== false) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { mainWindow = null; });
  win.loadURL(`http://127.0.0.1:${hubPort}/`).catch((error) => console.error('[window] loadURL 失败', error));
  return win;
}

function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else if (supervisor?.hubPort) {
    mainWindow = createWindow(supervisor.hubPort);
  }
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(APP_ROOT, 'assets', 'icon.png'));
    tray = new Tray(icon);
    tray.setToolTip('QQ Agent · 账号中心');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开账号中心', click: () => showWindow() },
      {
        label: '暂停 / 恢复全部账号',
        click: () => {
          const paused = supervisor?.pauseState?.().paused;
          supervisor?.pauseAll?.(!paused).catch(() => {});
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => showWindow());
  } catch (error) {
    console.error('[tray] 创建失败', error?.message ?? error);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  diag('single-instance-denied');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.whenReady().then(async () => {
  try {
    supervisor = createSupervisor({
      baseDataDir: DATA_DIR,
      log: (...args) => console.log(...args)
    });
    const hubPort = await supervisor.start();
    diag('hub started', `port=${hubPort}`);
    mainWindow = createWindow(hubPort);
    createTray();
  } catch (error) {
    diag('startup failed', String(error?.stack ?? error));
    try { dialog.showErrorBox('QQ Agent 启动失败', String(error?.stack ?? error)); } catch { /* ignore */ }
    app.exit(1);
  }
});

app.on('before-quit', (event) => {
  quitting = true;
  if (shuttingDown || !supervisor) return;
  event.preventDefault();
  shuttingDown = true;
  Promise.resolve()
    .then(() => supervisor.stop())
    .catch((error) => console.error('[electron] 退出清理失败', error?.message ?? error))
    .finally(() => app.quit());
});
