// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataDirName, describeInstance } from '../src/profile.js';


// Windows 上部分显卡驱动会导致渲染进程黑屏；禁用硬件加速是最稳妥的修复。
// macOS 的 Metal/ANGLE 路径稳定，禁用反而让动画发涩 —— 只在 Windows 上关。
if (process.platform === 'win32') app.disableHardwareAcceleration();

// 主进程兜底：未捕获异常不应静默吞掉。
// headless 入口（src/server.js）exit(1) 的理由在那里不成立 —— 那个有外层
// 守护重启。Electron 没有外层守护，进程挂掉后用户只能看到"托盘图标消失"。
// 折衷：拉起一个可见的错误对话框把异常亮给用户（至少知道为什么挂了），
// 确认后再退出 —— "半死不活地挂着"（定时器丢失/连接悬空但窗口还在）
// 是最难排查的状态，宁可死得明明白白。
process.on('unhandledRejection', (error) => {
  console.error('[未处理异常]', error);
});
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  try {
    // dialog 在 app ready 前也允许调用（Electron 文档保证）。
    dialog.showErrorBox(
      'QQ Agent 发生未捕获错误',
      '程序遇到无法恢复的错误，即将退出。\n\n' +
      String(error?.stack ?? error?.message ?? error) +
      '\n\n完整日志见 data/logs/ 下的当日日志文件。'
    );
  } catch { /* 弹窗失败不拦截退出 */ }
  app.exit(1);
});

// AppUserModelID：让 Windows 把窗口归到「QQ Agent」身份下（任务栏分组/图标/通知），
// 否则 dev 模式下会被当成裸 electron.exe，钉任务栏变成 electron 图标。
// macOS 没有这个机制（传了也无害，但没必要）。
if (process.platform === 'win32') app.setAppUserModelId('cn.kondius.qq-agent');

// ── 验证码网络诊断（2026-09-26）──
// 渲染层（Chromium 栈）访问 alicdn/aliyuncs 失败但 kondius.cn 通、系统 curl 直连却正常。
// 主进程 Node 层（undici，独立于 Chromium 网络服务）做同款探测：
//   Node 通 + Chromium 挂 → 问题锁定在 Chromium 网络栈（本机安全软件/WFP 过滤按进程压制），
//   两层都挂 → 机器出口对这些域有整体问题。
let captchaInterceptorActive = false;
ipcMain.handle('qqa-captcha-net-probe', async () => {
  const targets = [
    ['node:o.alicdn.com', 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'],
    ['node:aliyuncs验签', 'https://captcha.cn-shanghai.aliyuncs.com/'],
    ['node:aliyuncs-open', 'https://163stu.captcha-open.aliyuncs.com/'],
    ['node:kondius.cn', 'https://kondius.cn/api/community/health'],
  ];
  const out = [];
  for (const [name, url] of targets) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      out.push(`${name}:通(HTTP ${res.status},${Date.now() - t0}ms)`);
    } catch (e) {
      out.push(`${name}:失败(${String(e?.cause?.code || e?.message || e).slice(0, 60)},${Date.now() - t0}ms)`);
    }
  }
  return out.join(' ');
});
// 拦截器注册状态：渲染层报错时显示 —— 老进程（未重启）上它必然是"未注册"，
// 用来一眼区分"方案没生效"和"根本没跑到新代码"。
ipcMain.handle('qqa-captcha-interceptor-status', () =>
  captchaInterceptorActive ? '拦截器已注册' : '拦截器未注册（跑的是老进程，需托盘退出后重启）');

// ── 数据目录：始终固定在「应用根目录/data」──
// Kondius 钦定：所有数据都存在安装目录下，不往 %APPDATA% 塞。
//   压缩包用户：data 本来就在压缩包目录里，直接用（项目内 data/）；
//   安装版用户：安装目录/exe 旁边的 data/。选压缩包目录当安装目录时
//   天然接管里面的 data/（config、记忆、聊天记录、telemetry id 全保留），零迁移零 bug。
// NSIS 覆盖安装只替换它自己装的文件，运行时生成的 data/ 不在清单里 → 升级不丢数据。
// 兼容兜底：外置 %APPDATA% 时期（2026-09-06 短命版本）的数据自动搬回安装目录。
function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;
  // 开发模式（.bat / npm start 直起 node_modules 里的 electron + 项目目录）：项目内 data/
  if (!app.isPackaged) return path.resolve(fileURLToPath(import.meta.url), '..', '..', dataDirName());
  // macOS 安装版：.app 通常在 /Applications（可能只读），数据放用户目录的
  // Application Support 下 —— 这也是 macOS 的惯例位置，备份/迁移都好找。
  if (process.platform === 'darwin') {
    return path.join(app.getPath('appData'), 'QQ Agent', dataDirName());
  }
  const portable = path.join(path.dirname(app.getPath('exe')), dataDirName());
  try {
    if (!fs.existsSync(portable)) {
      // 仅主实例接管旧版遗留；第二实例绝不能把主实例旧数据复制进 data-2。
      if (dataDirName() !== 'data') return portable;
      // 接管旧版遗留：%APPDATA%/qq-agent/data（外置期版本）→ 搬回安装目录
      const legacy = path.join(app.getPath('userData'), 'data');
      if (fs.existsSync(legacy) && fs.readdirSync(legacy).length > 0) {
        fs.cpSync(legacy, portable, { recursive: true });
        console.log('[data] 已从 %APPDATA% 迁回安装目录:', legacy, '→', portable);
      }
    }
  } catch (error) {
    console.error('[data] 旧数据迁移失败（不影响启动，将从空数据开始）:', error?.message ?? error);
  }
  return portable;
}
process.env.QQ_AGENT_DATA_DIR = resolveDataDir();

// ── 运行时可写目录（macOS 协议端 NapCat 的 QQ 副本放这里）──
// 开发模式放在项目 runtime/；安装版放在数据目录旁边，保证普通用户可写。
process.env.QQ_AGENT_RUNTIME_DIR = app.isPackaged
  ? path.join(path.dirname(process.env.QQ_AGENT_DATA_DIR), 'runtime')
  : path.resolve(fileURLToPath(import.meta.url), '..', '..', 'runtime');

// ── 扩展目录：安装版的 App 包只读，skills/plugins 必须放到用户目录 ──
// 开发模式不设（用项目根目录，行为与原来一致）。
if (app.isPackaged) {
  process.env.QQ_AGENT_EXTENSIONS_DIR = path.join(path.dirname(process.env.QQ_AGENT_DATA_DIR), 'extensions');
  try {
    fs.mkdirSync(path.join(process.env.QQ_AGENT_EXTENSIONS_DIR, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(process.env.QQ_AGENT_EXTENSIONS_DIR, 'plugins'), { recursive: true });
  } catch (error) {
    console.warn('[extensions] 创建扩展目录失败（不影响启动）:', error?.message ?? error);
  }
}

// ── Chromium userData 落位（2026-09-23 修复"双击打不开"）──
// 原先 Electron 的 userData 用默认的 %APPDATA%\qq-agent。Chromium 的单实例
// 锁（lockfile）与网络服务缓存都写在那里；一旦该目录不可写（安全软件拦截 /
// ACL 损坏 / 低完整性上下文），启动链会两条腿同时断：
//   1. process_singleton_win.cc: "Lock file can not be created! Error code: 5"
//      → requestSingleInstanceLock() 返回 false → app.quit() → 窗口从未出现；
//   2. network_sandbox.cc: "Failed to grant sandbox access" → 一串 0x5 拒绝访问。
// 修复：userData 一律放应用自己的 data/ 下（与业务数据同源、同备份路径），
// 不再依赖 %APPDATA% 的可写性。app.setPath 必须在 app ready 之前调用。
app.setPath('userData', path.join(process.env.QQ_AGENT_DATA_DIR, 'electron-user-data'));

// ── 启动诊断（2026-09-23）：逐阶段写 data/boot-diag.log，排查"双击后毫无反应" ──
// appendFileSync 同步落盘：进程秒退/被强杀时日志也不会丢。问题解决后可整体删除。
const BOOT_DIAG_FILE = path.join(process.env.QQ_AGENT_DATA_DIR, 'boot-diag.log');
function bootDiag(msg) {
  try { fs.appendFileSync(BOOT_DIAG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}
bootDiag('main.js 已加载');

// 单实例锁：重复启动（双击 .bat）不产生第二个实例，而是唤出已有窗口。
// 没有锁的话第二个实例会双份连 SnowLuma，群消息会被双重回复。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 2026-09-23 修复：拿不到锁直接静默退出，用户看到的就是"双击没反应"。
  // 两种情况要区分：
  //   a) 真有主实例在跑 → 静默退出是正确行为（second-instance 已唤出主窗口）；
  //   b) 锁文件/锁管道创建失败（目录不可写、安全软件拦截）→ 之前同样静默退出，
  //      用户完全无从得知。现在把原因弹出来 + 写进 boot-diag.log。
  bootDiag('单实例锁获取失败，准备退出（可能已有实例，也可能锁创建失败）');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}
bootDiag('单实例锁已检查 gotLock=' + gotLock);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.resolve(__dirname, '..', 'assets', 'icon.png');

let mainWindow = null;

// 焦点回收（2026-09-26）：原生 alert/confirm 关闭后窗口不认领回键盘焦点
// （electron/electron#41602 —— "弹过任意弹窗后所有输入框打不了字"）。
// 渲染层的 focus() 救不回来，可靠解是这里做 OS 级 BrowserWindow.focus()。
// 触发者：ui/app/00-core.js 的对话框包装层（经 preload 的 qqAgentShell.refocus）。
ipcMain.on('app-refocus', () => {
  try {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.focus();
  } catch { /* 焦点回收失败不致命 */ }
});
let core = null;
let tray = null;
let quitting = false;

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  // macOS：开发模式（未打包）没有稳定的登录项身份，直接跳过；安装版才设置。
  // 另外 setLoginItemSettings(false) 也会触发一次系统检查（日志里的
  // "Unable to set login item: Operation not permitted"），所以只在需要开启时调用。
  if (process.platform === 'darwin' && !app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.server?.autoStart });
  } catch (error) {
    console.warn('[autostart] 设置开机自启失败:', error?.message ?? error);
  }
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow(core?.lastPort ?? 3210);
  }
}

function createTray() {
  let icon = nativeImage.createFromPath(ICON_PATH);
  // macOS 菜单栏图标按 18pt 渲染；彩色大图会糊成一团。缩到 18 并标记为
  // template（系统会自动适配明暗菜单栏）。
  if (process.platform === 'darwin') {
    icon = icon.resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip(describeInstance());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    { label: '暂停 / 恢复', click: () => core?.orchestrator.setPaused(!core.orchestrator.paused) },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!core.getConfig().server?.autoStart,
      click: (item) => {
        core.updateConfig({ server: { autoStart: item.checked } });
        applyAutoStart();
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => showWindow());
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: describeInstance(),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  if (process.platform === 'darwin') {
    // macOS 不能像 Windows 那样把菜单设为 null：Cmd+C/V/A、Cmd+Q、Cmd+M 等
    // 系统级快捷键都挂在应用菜单上，去掉后输入框连复制粘贴都失效。
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { role: 'windowMenu' }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  // F5 / Ctrl+R / Ctrl+Shift+R 刷新：应用菜单被移除后默认快捷键随之失效，
  // 用 before-input-event 手动接管（不恢复菜单条，外观不变）。
  // 开发改完 ui/ 下的前端文件后 F5 即可生效，不用重启整个程序。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const isF5 = key === 'f5';
    const isCtrlR = (input.control || input.metaKey) && key === 'r';
    if (isF5 || isCtrlR) {
      event.preventDefault();
      mainWindow?.webContents.reloadIgnoringCache();
    }
  });
  // 窗口打开先显示 loading 壳，等页面真正加载完成再亮相，避免白屏和用户反复双击
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[window] 页面加载失败:', code, desc, url);
    setTimeout(() => mainWindow?.loadURL(`http://127.0.0.1:${port}/`).catch(() => {}), 2000);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 渲染进程崩溃:', JSON.stringify(details));
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((error) => console.error('[window] loadURL 失败:', error));
  // 外部链接（金句墙/意见墙/上传成功提示里的网址等）一律交给系统默认浏览器，不在应用内弹新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 主窗口只应停留在本机控制台。没有这道拦截时，页面里一个普通 <a href> 或
  // location.href=... 就能把主窗口导航到外部站点（脱离 127.0.0.1 源、
  // 控制台也不再指向本机）。外链改走系统浏览器。
  const isLocalConsole = (u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(String(u || ''));
  const guardNavigation = (event, url) => {
    if (isLocalConsole(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(String(url || ''))) shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  // 关窗默认缩到托盘（真正退出走托盘菜单），符合"常驻机器人"的使用习惯
  mainWindow.on('close', (event) => {
    if (!quitting && core?.getConfig().server?.closeToTray !== false) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  bootDiag('whenReady 已触发');
  try {
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    // ── 验证码域重定向（2026-09-26）──
    // 部分用户机器上 Chromium 网络栈访问 *.alicdn.com / *.aliyuncs.com 被本机
    // 安全软件按进程+域名压制（同机 Node 层与系统 curl 均正常），而 kondius.cn 可达。
    // 在 session 层把这两族域的请求重定向到 kondius.cn 的白名单反代：
    //   /qq-agent/captcha-sdk/...  （SDK 主脚本）
    //   /qq-agent/captcha-api/...  （SDK 接口，nginx 按域名后缀转发到真实域）
    // webRequest 覆盖主文档/iframe/worker/XHR 的所有请求形态，比 Service Worker 可靠。
    // 只匹配这两族域名后缀（正则收尾锚定），其余请求一律放行。
    captchaInterceptorActive = true;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const m = /^https:\/\/([a-zA-Z0-9.-]+\.(?:aliyuncs|alicdn)\.com)(\/.*)$/.exec(details.url);
        if (m) {
          return callback({
            redirectURL: `https://kondius.cn/qq-agent/captcha-api/${m[1]}${m[2]}`
          });
        }
      } catch { /* 解析异常按放行处理 */ }
      callback({});
    });
    bootDiag('setProxy 完成');
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { createApp } = await import('../src/app.js');
    bootDiag('src/app.js 已导入');
    core = createApp({ log: (...args) => console.log(...args) });
    // 先启动服务拿到真实端口，再开窗口。
    // 原先是 createWindow(core.lastPort ?? 3210) 在前、core.start() 在后 ——
    // 此时 lastPort 尚未赋值，窗口恒按 3210 加载；若端口被占用顺延到 3211+，
    // 首屏必然加载失败，只能靠 did-fail-load 2 秒重试兜底。
    const port = await core.start();
    core.lastPort = port;
    bootDiag('核心已启动 port=' + port);
    await createWindow(port);
    // 只有配置里确实开启时才设置登录项：macOS 上即使传 false 也会触发
    // 一次「App 管理」权限检查，启动日志里就会多一条 Operation not permitted。
    if (core.getConfig().server?.autoStart) applyAutoStart();
    createTray();
    bootDiag('窗口与托盘就绪');
  } catch (error) {
    console.error('[electron] 启动失败:', error);
    bootDiag('启动失败: ' + String(error?.stack ?? error));
    // 2026-09-23：启动失败必须可见。之前只 quit，用户看到的是"双击没反应"。
    try {
      dialog.showErrorBox(
        'QQ Agent 启动失败',
        '核心服务启动失败，程序即将退出。\n\n' +
        String(error?.stack ?? error?.message ?? error) +
        '\n\n详细日志见 data/logs/ 下的当日日志与 data/boot-diag.log。'
      );
    } catch { /* 弹窗失败不拦截退出 */ }
    app.exit(1);
  }
});

// macOS 习惯：点 Dock 图标时若窗口已被关闭/隐藏，重新唤出主界面。
app.on('activate', () => {
  if (app.isReady() && core) showWindow();
});

// macOS 关掉最后一个窗口时不退出（菜单栏/Dock 常驻），Windows/Linux 保持原行为。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出清理：core.stop() 是 async（要 abortAll / 关 SSE / 关 server / 释放单实例锁），
// 而 before-quit 是同步事件 —— 直接调它会让进程在 await 让出后就被销毁，
// 清理链跑一半：锁文件可能残留、会话最后一次进度可能丢、SnowLuma 子进程可能变孤儿。
// 正确做法：拦下这次退出，等 stop() 真正跑完再 app.quit()。
let shuttingDown = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (shuttingDown || !core) return;      // 第二次进入（自己触发的 quit）直接放行
  event.preventDefault();
  shuttingDown = true;
  Promise.resolve()
    .then(() => core.stop())
    .catch((error) => console.error('[electron] 退出清理失败:', error?.message ?? error))
    .finally(() => app.quit());
});
