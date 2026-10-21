// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR } from './config.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes } from './onebot.js';
import { isAtMe } from './prompt.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { ReminderStore } from './reminders.js';
import { VideoReader } from './video-reader.js';
import { cacheHitRate } from './llm.js';
import { isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel, UNKNOWN_VENDOR } from './model-prices.js';
import { initPriceFeed } from './price-feed.js';
import { startTelemetryLoop } from './telemetry.js';
import { loadPlugins, watchPlugins } from './plugin-loader.js';
import { setPresenceClient } from './presence.js';
import { skillManager } from './skills/manager.js';
import { extractCandidateUrls, dispatchMediaLinks } from './media-links.js';
import { createRoutes } from './routes.js';
import * as instanceLockModule from './instance-lock.js';
import { logger } from './logger.js';
import { startCommunitySync, isGloballyBlocked, FIXED_PRICE_FEED_URL } from './community.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

// ── 版本更新检查 ─────────────────────────────────────────────────────
// 线上版本信息只有一份：kondius.cn/qq-agent/version.json（发版时手动改）。
// 由后端代取而不是前端直连：绕过 CORS，且失败信息能统一回给 UI。
const UPDATE_INFO_URL = 'https://kondius.cn/qq-agent/version.json';

function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch { return '0.0.0'; }
}

/** x.y.z 三段数字比较；返回 1 / 0 / -1。非数字段按 0 处理，够用。 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/* createApp 产生的所有 appLog 函数（模块级 WeakSet）。
   用于识别"调用方传入的 log 是不是上一次 createApp 留下的 appLog"，
   防止监听器链式递归（见 createApp 内的递归护栏注释）。 */
const appLogFns = new WeakSet();

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();

  // 详尽日志：把 createApp 的 log 接到分级日志系统（落盘 + 内存缓冲 + SSE）。
  // 关键：logger 的 mirrorConsole 已经会走 console，所以这里**只写 logger、不再调原 log**，
  // 否则 appLog → logger.info → console(log) → 若 log 又被指回 appLog 就会无限递归（selftest 就是这么挂的）。
  // logger.mirrorConsole = true 时 console 输出不丢；调用方传入的自定义 log（如测试的静默 log）
  // 通过 logger 的 onLog 监听器另行转发，不经过 console。
  const appLog = (...args) => {
    logger.info('app', ...args);
  };
  // 把调用方传入的 log（如 Electron 的 console.log 或测试的静默 log）挂到 logger 的监听器上，
  // 与 mirrorConsole 解耦：mirrorConsole 管 console，监听器管调用方的 log。
  //
  // ⚠️ 递归护栏（15GB 日志事故根因）：
  //   若调用方传入的 log 本身就是上一次 createApp 留下的 appLog
  //   （同进程内二次 createApp：Electron 重启核心 / 测试串行多轮），
  //   监听器链会形成 appLog→logger→监听器→appLog 的无限递归，
  //   每轮递归给文本再包一层 [app] 前缀 —— 一条日志膨胀成几千条、
  //   每条带几千个 [app] 前缀，几个小时内日志文件就能写到 15GB。
  //   这里用 WeakSet 识别"这个 log 是不是 appLog"，是则跳过挂载。
  let removeAppLogListener = null;
  if (!appLogFns.has(log)) {
    removeAppLogListener = logger.onLog((entry) => {
      try { log(`[${entry.module}] ${entry.text}`); } catch { /* ignore */ }
    });
  }
  appLogFns.add(appLog);
  // 关掉 logger 的 console 镜像，避免与上面的监听器重复打印（调用方 log 通常就是 console.log）。
  logger.mirrorConsole = false;
  // 后续内部调用统一指向 appLog（关键事件落盘 + 走调用方 log）
  log = appLog;
  // 启动时清理过期日志文件
  logger.prune();

  // ── 进程单实例锁（防止桌面端 + headless 双开导致重复回复群消息）──
  // 与 Electron 的 requestSingleInstanceLock 互补：那只管 Electron 进程之间，
  // 这里管"同一数据目录下任何形态的 QQ Agent 核心"（含 node src/server.js）。
  const { acquireInstanceLock, releaseInstanceLock } = instanceLockModule;
  const lockResult = acquireInstanceLock();
  if (!lockResult.ok) {
    // 不抛异常上抛让进程退出 —— 创建期的失败应当让整个启动失败。
    throw new Error(`[单实例] ${lockResult.reason}。如需多开测试，请用不同的 QQ_AGENT_DATA_DIR。`);
  }
  /* 抢到锁后立刻注册退出清理：正常 exit / SIGINT / SIGTERM 都会释放锁文件。
     曾经只在 stop() 里释放 —— 进程被直接杀掉（任务管理器结束、控制台叉掉）
     时锁文件残留，下次启动要靠"PID 已死"探测才能清掉，多一层失败面。 */
  instanceLockModule.registerLockCleanup();
  const sseClients = new Set();

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    if (fs.existsSync(bundled)) return bundled;
    // 安装版：asar 里的文件不可执行，electron-builder 会把 snowluma/ 解包到
    // resources/app.asar.unpacked/snowluma（见 package.json asarUnpack）
    const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
    if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
    return '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** SnowLuma 的 WebUI 端口：进程一启动就监听，与是否登录无关。
   * 用来判定「SnowLuma 进程活着」。 */
  function snowlumaWebuiPort() {
    try {
      const dir = snowlumaDir();
      if (dir) {
        const rtPath = path.join(dir, 'config', 'runtime.json');
        if (fs.existsSync(rtPath)) {
          const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
          if (Number(rt.webuiPort)) return Number(rt.webuiPort);
        }
      }
    } catch { /* ignore */ }
    return 5099;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaLaunching = false;   // SnowLuma 启动互斥标记（防连点「运行」按钮并发拉起多个）
  let snowlumaStopping = false;
  let pluginWatcher = null;        // 开发模式热重载 watcher（stop() 时要 close，否则句柄泄漏）
  let obPortPollTimer = null;      // OneBot WS 端口就绪轮询（stop() 时要 clear，start() 里赋值）

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭 SnowLuma。内置拉起的直接 kill；外部启动的（launcher.bat / 手动 node）按
   *  「命令行含 <snowluma目录>\index.mjs」匹配进程后 taskkill —— 否则 UI 的「停止」
   *  对外启动实例毫无作用，用户只能去任务管理器，而残留实例会继续抢占管道与端口。
   *  返回是否执行了关闭动作。 */
  async function stopSnowluma() {
    const proc = snowlumaProc;
    if (proc) {
      try {
        proc.kill();
        pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
        return true;
      } catch (error) {
        pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
        throw error;
      }
    }
    // 外部启动的实例：通过 WMIC 查命令行匹配（只杀 SnowLuma 自己的 node，
    // 决不按进程名乱杀）。WMIC 输出按 ANSI 代码页读会乱码（qqPortable 的教训），
    // 这里只用纯 ASCII 匹配路径（snowluma 目录路径若含中文，Windows 上 WMIC
    // 的 PUT 扩展拿不到命令行——返回未找到，UI 如实显示"未在运行"，安全降级）。
    try {
      const queryCmd = 'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:list';
      const { exec } = await import('node:child_process');
      const list = await new Promise((resolve) => {
        exec(queryCmd, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
      });
      const target = [];
      const blocks = String(list || '').split(/\r?\n\s*\r?\n/);
      const dirNorm = path.resolve(String(snowlumaDir() || '')).toLowerCase();
      for (const b of blocks) {
        const cmdM = /CommandLine=(.*)/i.exec(b);
        const pidM = /ProcessId=(\d+)/i.exec(b);
        if (!cmdM || !pidM) continue;
        const cmdline = cmdM[1].trim();
        if (!/index\.mjs/i.test(cmdline)) continue;
        if (dirNorm && !cmdline.toLowerCase().includes(dirNorm)) continue;
        target.push(Number(pidM[1]));
      }
      if (!target.length) return false;
      for (const pid of target) {
        try { process.kill(pid); } catch { /* 已退出 */ }
      }
      pushSnowlumaLog(`已请求关闭外部启动的 SnowLuma（pid=${target.join(',')}）。`, 'stdout');
      snowlumaProc = null;
      emit('snowluma-status', { running: false, embedded: false, pid: null });
      return true;
    } catch (error) {
      pushSnowlumaLog(`关闭外部 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      return false;
    }
  }

  // ── 便携 QQ 进程管理 ──
  // 便携 QQ 与用户日常 QQ 完全隔离：独立安装目录 + 独立 user-data-dir。
  // 绝不 taskkill QQ.exe 全名——只杀路径匹配 runtime/qq-portable 的进程。
  const qqPortableLogs = [];
  let qqPortableProc = null;
  let qqPortableLaunching = false;   // 便携 QQ 启动互斥标记（防连点「启动 QQ」并发拉起）

  function qqPortableDir() {
    return path.join(ROOT, 'runtime', 'qq-portable');
  }

  function qqPortableDataDir() {
    return path.join(ROOT, 'runtime', 'qq-portable-data');
  }

  function qqPortableExe() {
    return path.join(qqPortableDir(), 'QQ.exe');
  }

  function pushQqLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    qqPortableLogs.push(line);
    if (qqPortableLogs.length > 500) qqPortableLogs.splice(0, qqPortableLogs.length - 500);
    emit('qq-portable-log', line);
  }

  /** 检查便携 QQ 是否已安装 */
  function qqPortableReady() {
    return fs.existsSync(qqPortableExe());
  }

  /** 列出所有 QQ.exe 进程，返回 [{ pid, path }]（Windows only） */
  /**
   * 列出所有 QQ.exe 进程，返回 [{ pid, path }]（Windows only）。
   *
   * ── 这里踩过一个很隐蔽的坑，务必别再改回去 ──────────────────────────
   * 原来首选 `wmic process ... /format:csv`。它有两个问题：
   *
   * 1. **编码**：wmic 按**系统 ANSI 代码页（中文系统是 GBK）**输出，
   *    而 Node 按 UTF-8 读 —— 路径里的中文会变成乱码。
   *    实测：`qq-agent - 副本` → `qq-agent - ????`。
   *    于是拿乱码路径去和真实路径比，**永远比不上**，
   *    表现就是"QQ 明明在跑，界面却说未启动"。
   *    ⚠️ 纯英文路径下这个 bug 完全不暴露，所以特别难查。
   * 2. **CSV**：路径里有逗号就会错位。
   * 3. 而且 wmic 在 Win11 24H2+ 已被移除，本来也不能当主路径。
   *
   * 现在改用 PowerShell + **显式强制 UTF-8 输出** + JSON。
   * ⚠️ 只写 PowerShell 是不够的：PS 5.1 默认同样按 ANSI 输出，
   *    必须带上 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`
   *    （这行是实测对比出来的，去掉就又是乱码）。
   * 用 JSON 而不是 CSV，顺带解决逗号错位。
   */
  async function listQqProcesses() {
    if (process.platform !== 'win32') return [];
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
          + 'Get-CimInstance Win32_Process -Filter "name=\'QQ.exe\'" | '
          + 'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress'
      ], { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const txt = String(stdout).trim();
      if (!txt) return [];
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      return arr
        .map((p) => ({ pid: Number(p.ProcessId), path: String(p.ExecutablePath ?? '') }))
        .filter((p) => p.pid > 0);
    } catch {
      // 查不到就当没有。**不要**在这里退回 wmic —— 它给的乱码路径会导致
      // "误判为别的 QQ"或"漏判本机的便携 QQ"，比返回空更糟。
      return [];
    }
  }

  /** 检查便携 QQ 是否在运行（按路径匹配，不碰用户 QQ） */
  // 进程查询（PowerShell Get-CimInstance）可达数秒；SnowLuma 页/SSE/轮询会反复打
  // /api/status，每次都查一遍会把整页拖死。结果缓存 3 秒。
  let qqPidCache = { at: 0, pid: undefined };
  async function qqPortableRunningPid() {
    // 1) 本进程拉起过的那个：spawn 时就拿到 pid 了，不用查系统 ——
    //    最快，也不受任何编码/权限问题影响。
    if (qqPortableProc && !qqPortableProc.killed) {
      try {
        process.kill(qqPortableProc.pid, 0);   // signal 0 = 只探测存活
        qqPidCache = { at: Date.now(), pid: qqPortableProc.pid };
        return qqPortableProc.pid;
      } catch { /* 已退出，往下走 */ }
    }
    // 缓存：3 秒内复用上次结果（启动/关闭后靠 SSE 状态事件立即刷新）
    if (qqPidCache.pid !== undefined && Date.now() - qqPidCache.at < 3000) {
      return qqPidCache.pid;
    }
    // 2) 查系统：覆盖"上次启动的 QQ 还在跑，但应用重启过"的情况
    const portableDir = qqPortableDir().toLowerCase();
    const procs = await listQqProcesses();
    const match = procs.find((p) => p.path.toLowerCase().startsWith(portableDir));
    const pid = match?.pid ?? null;
    qqPidCache = { at: Date.now(), pid };
    return pid;
  }

  /** 启动便携 QQ（如已在运行则跳过） */
  async function launchPortableQQ() {
    if (!qqPortableReady()) {
      return { ok: false, error: '便携 QQ 未安装：请先运行 npm run setup' };
    }
    // 启动互斥：连点「启动 QQ」时，第一次还在 spawn，第二次直接拒绝
    if (qqPortableLaunching) {
      pushQqLog('便携 QQ 正在启动中，忽略重复的启动请求');
      return { ok: true, alreadyRunning: true, launching: true };
    }
    const existingPid = await qqPortableRunningPid();
    if (existingPid) {
      pushQqLog(`便携 QQ 已在运行（pid=${existingPid}），无需重复启动`);
      return { ok: true, alreadyRunning: true, pid: existingPid };
    }

    qqPortableLaunching = true;
    try {
      const exe = qqPortableExe();
      const dataDir = qqPortableDataDir();
      fs.mkdirSync(dataDir, { recursive: true });

      try {
        const child = spawn(exe, [`--user-data-dir=${dataDir}`], {
          cwd: qqPortableDir(),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: false, // QQ 需要显示窗口让用户扫码
          detached: true
        });
        qqPortableProc = child;
        child.unref();
        pushQqLog(`便携 QQ 启动中（pid=${child.pid}），数据目录：${dataDir}`);
        child.stdout?.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushQqLog(line, 'stdout');
          }
        });
        child.stderr?.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushQqLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          qqPortableProc = null;
          pushQqLog(`便携 QQ 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('qq-portable-status', { running: false, pid: null });
        });
        child.on('error', (error) => {
          pushQqLog(`便携 QQ 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('qq-portable-status', { running: true, pid: child.pid });
        return { ok: true, launched: true, pid: child.pid };
      } catch (error) {
        pushQqLog(`便携 QQ 启动失败：${error?.message ?? error}`, 'stderr');
        return { ok: false, error: String(error?.message ?? error) };
      }
    } finally {
      qqPortableLaunching = false;
    }
  }

  /** 关闭便携 QQ（只杀路径匹配的 PID，绝不碰用户 QQ） */
  async function stopPortableQQ() {
    const pid = await qqPortableRunningPid();
    if (!pid) {
      pushQqLog('便携 QQ 未在运行');
      return { ok: true, stopped: false, reason: 'not_running' };
    }
    try {
      process.kill(pid, 'SIGTERM');
      pushQqLog(`已请求关闭便携 QQ（pid=${pid}）`);
      // 等待进程退出
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const still = await qqPortableRunningPid();
        if (!still) {
          pushQqLog('便携 QQ 已退出');
          emit('qq-portable-status', { running: false, pid: null });
          return { ok: true, stopped: true, pid };
        }
      }
      // 还没退，强制 kill
      process.kill(pid, 'SIGKILL');
      pushQqLog(`便携 QQ 已强制结束（pid=${pid}）`);
      emit('qq-portable-status', { running: false, pid: null });
      return { ok: true, stopped: true, pid, forced: true };
    } catch (error) {
      pushQqLog(`关闭便携 QQ 失败：${error?.message ?? error}`, 'stderr');
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 便携 QQ 状态摘要 */
  async function qqPortableStatus() {
    const pid = await qqPortableRunningPid();
    return {
      ready: qqPortableReady(),
      running: pid !== null,
      pid,
      dir: qqPortableDir(),
      dataDir: qqPortableDataDir()
    };
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行（日志进内置控制台）；失败再回退到独立窗口 launcher.bat。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    // ⚠️ 端口探测必须用 WebUI 端口（2026-09-19）：WS 3001 是 OneBot 实例开的，
    // OneBot 实例只有**账号登录后**才创建 —— "SnowLuma 起了但还没登录"是常态
    // （用户先启动 QQ Agent，再扫码）。用 3001 判"运行中"会把正常状态误判成
    // "未运行"，于是又拉起第二个 SnowLuma 实例 → 两个进程抢 mojo 管道与端口，
    // 用户看到的是"管道异常/连接不上/时好时坏"这类无法自圆其说的现象。
    // WebUI 端口进程一启动就监听，与登录无关，才是"进程活着"的准确信号。
    const probePort = snowlumaWebuiPort();

    // ── 启动互斥（防多次点击「运行 SnowLuma」端口冲突 / 多实例）──
    // 三道防线，按成本从低到高：
    //   1. 本进程正在启动中（用户连点按钮）→ 直接拒绝
    //   2. 本进程已拉起过 SnowLuma（snowlumaProc 活着）→ 已在运行
    //   3. 端口已被任何进程占用（包括上次残留 / 别的实例）→ 已在运行
    if (snowlumaLaunching) {
      pushSnowlumaLog('SnowLuma 正在启动中，忽略重复的启动请求', 'stdout');
      return { ok: true, alreadyRunning: true, launching: true };
    }
    if (snowlumaProc && !snowlumaProc.killed) {
      pushSnowlumaLog(`SnowLuma 已由本实例拉起（pid=${snowlumaProc.pid}），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true, pid: snowlumaProc.pid };
    }
    if (await isPortOpen('127.0.0.1', probePort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（WebUI 端口 ${probePort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }

    snowlumaLaunching = true;
    try {
      const indexMjs = path.join(dir, 'index.mjs');
      const nodeExe = path.join(dir, 'node.exe');
      if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
        try {
          // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
          // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
          const child = spawn(nodeExe, [indexMjs], {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: false
          });
          snowlumaProc = child;
          child.unref();
          pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
          child.stdout.on('data', (d) => {
            for (const line of String(d).split(/\r?\n/)) {
              if (line.trim()) pushSnowlumaLog(line, 'stdout');
            }
          });
          child.stderr.on('data', (d) => {
            for (const line of String(d).split(/\r?\n/)) {
              if (line.trim()) pushSnowlumaLog(line, 'stderr');
            }
          });
          child.on('exit', (code, signal) => {
            snowlumaProc = null;
            pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
            emit('snowluma-status', { running: false, embedded: false, pid: null });
          });
          child.on('error', (error) => {
            pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
          });
          emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
          return { ok: true, launched: true, embedded: true, pid: child.pid };
        } catch (error) {
          pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
          snowlumaProc = null;
        }
      }
      // 回退：launcher.bat 独立控制台窗口（老行为，日志无法内置）
      const launcher = path.join(dir, 'launcher.bat');
      if (!fs.existsSync(launcher)) return { ok: false, error: `目录里没有 index.mjs / node.exe，也没有 launcher.bat：${dir}` };
      const child = spawn('cmd.exe', ['/c', launcher], {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false // 保留 SnowLuma 自己的控制台窗口
      });
      child.unref();
      pushSnowlumaLog('SnowLuma 已用独立控制台窗口启动（此模式下日志不进内置控制台）', 'stdout');
      return { ok: true, launched: true, embedded: false };
    } finally {
      // 启动动作结束后释放互斥标记（端口就绪与否由上面的端口探测兜底）
      snowlumaLaunching = false;
    }
  }

  const emit = (type, payload) => {
    // 说明：这里曾经先走一个进程内事件总线（createEventBus），但全项目**没有任何订阅者**，
    // 属于纯空转；更糟的是它给人"存在进程内订阅者"的错觉。真正的消费者只有 SSE。
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      // 同步异常 + 已经不可写的连接都要清理，否则集合只增不减、每次都白写
      if (res.writableEnded || res.destroyed) { sseClients.delete(res); continue; }
      try {
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  const stickers = new StickerManager(onebot);
  const sender =   new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`),
    log
  });
  const reminders = new ReminderStore();
  const videoReader = new VideoReader(onebot);
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit, reminders, videoReader });

  // 远程价格表固定为官网公开地址；不从用户配置读取，避免被页面/配置篡改。
  initPriceFeed(FIXED_PRICE_FEED_URL);

  // 云端统一屏蔽名单：启动先用 data 缓存，后台同步；网络失败不影响本地拦截。
  const communitySyncTimer = startCommunitySync(log);
  communitySyncTimer.unref?.();

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 给每个登录过的账号生成独立随机 token（config/onebot_<uin>.json），
  // 且**永久保留**——不表示"当前在线"。多账号场景下"取第一个文件"会拿错 token
  // （WS 401 无限重试）。策略改为：收集所有 per-uin 文件的 token 作为候选，
  // 401 时轮换下一个重连，连上后记住生效的那个（天然支持 SnowLuma 里切账号）。
  let lastSyncTokenSig = '';

  /** 从单个配置对象里提取 ws/http token（找不到网络段时返回 null）。 */
  function extractTokens(data) {
    const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
    const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
    return { wsToken: String(ws?.accessToken ?? ''), httpToken: String(http?.accessToken ?? '') };
  }

  /** 收集所有候选 token（含 onebot_0.json 的空令牌兜底），按"最可能正确"排序。
   *
   * ⚠️ 排序规则（2026-09-19 修订）：以前按文件名排序，多账号时 candidates[0]
   * 几乎总是错的（账号A的QQ号 < 账号B的QQ号，但在线的是后者），每次启动都要
   * 先吃一轮 401 再轮换到正确令牌。现在排序：
   *   1. 当前配置里已保存的 token（上次连成功过的，最可信）
   *   2. 文件序的其余候选
   *   3. 空令牌兜底（SnowLuma 允许无 token 连接，永远排最后）
   * 去重保持首次出现的顺序。
   */
  function readSnowlumaTokenCandidates() {
    const out = [];
    const seen = new Set();
    const push = (c) => {
      const key = `${c.wsToken}|${c.httpToken}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };
    try {
      const dir = snowlumaDir();
      if (!dir) return out;
      const cfgDir = path.join(dir, 'config');
      // 当前配置的令牌优先：上次连接成功时 applyTokens 已把它写进 data/config.json。
      const cur = getConfig().snowluma || {};
      const curWs = String(cur.accessToken || '');
      const curHttp = String(cur.httpAccessToken || cur.accessToken || '');
      if (curWs || curHttp) push({ wsToken: curWs, httpToken: curHttp });
      let files = [];
      try {
        files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      } catch { /* ignore */ }
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8'));
          push(extractTokens(data));
        } catch { /* 单个文件坏了跳过，不影响其他候选 */ }
      }
      // 空令牌兜底：SnowLuma 允许无 token 连接（onebot_0.json 模板就是空）
      push({ wsToken: '', httpToken: '' });
    } catch (error) {
      log('[onebot] 读取 SnowLuma OneBot 配置失败:', error?.message ?? error);
    }
    return out;
  }

  /** 候选游标：401 时递增轮换。连上后会钉住当前生效下标。 */
  let tokenCandidateIndex = 0;

  function applyTokens({ wsToken, httpToken }) {
    onebot.accessToken = wsToken;
    onebot.httpToken = httpToken || wsToken;
    const cur = getConfig();
    if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== (httpToken || wsToken)) {
      updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken || wsToken } });
      log(`[onebot] 应用 OneBot 访问令牌（WS ${wsToken ? '有' : '无'} / HTTP ${httpToken ? '有' : '无'}）`);
    }
  }

  /** 把候选列表同步进配置 + 挂到 onebot 实例（不立即连接）。返回是否有变化。 */
  function syncSnowlumaTokens() {
    try {
      const candidates = readSnowlumaTokenCandidates();
      if (!candidates.length) return false;
      const sig = candidates.map((c) => `${c.wsToken}|${c.httpToken}`).join(';');
      if (sig === lastSyncTokenSig) return false;
      // 游标重置：候选集变化了，从头开始试
      tokenCandidateIndex = 0;
      applyTokens(candidates[0]);
      onebot.tokenCandidates = candidates;   // 401 轮换用
      lastSyncTokenSig = sig;
      log(`[onebot] 已收集 ${candidates.length} 个 OneBot 令牌候选（当前配置令牌优先，401 时自动轮换）`);
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时：轮换下一个候选 token 重连（3 秒重连循环已有，轮换成本为零）
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    // ⚠️ 先重读磁盘：全新安装是"先启动后登录"，候选集是启动时的 [空令牌]；
    // 登录后 per-uin 文件才带着真令牌落盘。不回读就会拿空令牌 401 到天荒地老。
    const refreshed = syncSnowlumaTokens();
    const candidates = onebot.tokenCandidates || [];
    if (!candidates.length) return;
    if (refreshed) {
      // 候选集变了（sig 变化时内部已重置游标并应用候选[0]）→ 直接拿新集合的第一个试
      onebot.reconnect();
      return;
    }
    // 磁盘没变化：指向下一个候选（首次触发也从 0→1 开始换：刚被 401 拒的就是当前这个）
    tokenCandidateIndex = (tokenCandidateIndex + 1) % candidates.length;
    const c = candidates[tokenCandidateIndex];
    applyTokens(c);
    onebot.reconnect();
  }
  // 在线状态模块需要一个 OneBot 客户端引用（它不反向依赖 app）
  setPresenceClient(onebot);

  onebot.onStatus((status) => {
    if (status.connected) {
      // 连上了：把当前生效的候选钉住 —— 写进游标，并把该令牌挪到候选列表首位，
      // 这样下次断线重连（无论是否 401）第一个试的就是它，不再无谓地先撞错误令牌。
      const cands = onebot.tokenCandidates || [];
      const cur = { wsToken: String(onebot.accessToken || ''), httpToken: String(onebot.httpToken || '') };
      const hit = cands.findIndex((c) => c.wsToken === cur.wsToken && c.httpToken === cur.httpToken);
      tokenCandidateIndex = hit >= 0 ? hit : 0;
      if (cands.length > 1) log('[onebot] 连接成功，当前令牌候选已生效');
      return;
    }
    if (String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      // senderId 一并带回：引用块显示为 名字(QQ:xxx)，与发言人标签同口径 ——
      // 没有它，模型分不清引用的是"哪个张三"
      return { sender: String(senderName), senderId: String(msg?.sender?.user_id ?? ''), text: String(text).slice(0, 120) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    // 两道屏蔽：全局（所有群+私聊）优先，其次按群。
    if (senderId) {
      const globalBlocked = isGloballyBlocked(senderId);
      if (globalBlocked) return;
      if (kind === 'group' && (cfgNow.blocklist?.[id] || []).map(String).includes(senderId)) return;
    }
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    const atMarks = [];   // @ 段收集（qq + 渲染原文）：档位判定的权威依据（2026-09-26）
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null,
        onAt: (m) => atMarks.push(m),
        // 语音转写（`media.transcribe`）要用它去 get_record 取音频
        onebot
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 实测结论（2026-09-05，SnowLuma/NapCat）：get_forward_msg 只认 message_id；
    // res_id（转发卡片里那个 id）会过期，报 "payload is empty"。
    // 媒体里的 url 此时是新鲜的，一并收进 media（取图/金句都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    if (segments && (text.includes('[合并转发') || text.includes('[转发消息')) && event.message_id != null) {
      try {
        const r = await onebot.call('get_forward_msg', { message_id: Number(event.message_id) });
        const nodes = Array.isArray(r?.messages) ? r.messages : (Array.isArray(r?.data?.messages) ? r.data.messages : []);
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${e?.message ?? e}`);
      }
    }

    if (!text && !media.length) return;

    // ── @ 判定标记（2026-09-26）────────────────────────────────────────
    // 根治两类误判：① 群友 @ 的人与机器人**重名** —— 文本包含匹配必然把
    // 它误判为 @机器人（1 档误响应）；② @ 别人的名字里带关键词 —— 关键词
    // 判定误命中（2 档误响应）。所以：
    //   atMe    有 @ 段时以 QQ 号为准（区分同名的唯一可靠依据）；
    //           没有 @ 段（纯文本/字符串消息）才回落文本匹配 —— 手打"@昵称"
    //           仍是事实上的召唤，不能把它的语义改掉；
    //   atNames 记录渲染进 text 的 @ 片段原文，关键词判定据此剔除。
    const selfIdNow = onebot.selfId || '';
    const atMe = atMarks.length
      ? atMarks.some((m) => m.qq !== 'all' && selfIdNow && String(m.qq) === String(selfIdNow))
      : isAtMe(text, {
        selfId: selfIdNow,
        selfNickname: onebot.selfNickname,
        botName: getConfig().persona?.botName || ''
      });
    const atNames = atMarks.map((m) => String(m?.text || '')).filter(Boolean);

    // ── 指令禁言：群内任何人 @机器人 + 发送指定指令 → 该群暂时固定 1 档（仅艾特）──
    // 在存档前处理：指令本身也要留档（让机器人知道被禁言了），但先设置禁言状态。
    if (kind === 'group') {
      maybeTriggerCommandMute(id, text, event, atMe);
    }

    const entry = store.appendIncoming(`${kind}:${id}`, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media,
      atMe,
      atNames
    });
    emit('chat-update', `${kind}:${id}`);
    // 逐条触发判定：把刚入库的条目交给编排器（entry 让它能精确标这一条已读）
    orchestrator.onIncoming(`${kind}:${id}`, entry);

    // 链接媒体转发（确定性）：刻意不 await —— 百兆级下载/上传不能卡住 ingest 热路径。
    // 内部已把错误全部收口（含 provider 抛错），这里再挂一次 catch 只为防漏网。
    forwardLinkedMedia(kind, id, text).catch((e) => log(`[media] 链接转发失败：${e?.message ?? e}`));
  }

  /**
   * 指令禁言：检测"@机器人 + 指定指令"，命中则把该群响应档位暂时固定为 1 档。
   * 禁言状态写入 config.commandMute.active[群号] = 到期时间戳（0 = 直到手动解除）。
   */
  function maybeTriggerCommandMute(groupId, text, event, atMeMark = null) {
    const cm = getConfig().commandMute;
    if (!cm || cm.enabled !== true) return;
    const command = String(cm.command || '').trim();
    if (!command) return;
    // 必须同条消息里既 @机器人 又含指令。
    // 2026-09-26：有 @ 段标记时以标记为准（QQ 号判定，能区分同名）——
    // 文本包含匹配会把"@" 与机器人重名的另一个人"误判成召唤，进而误禁言。
    const selfId = onebot.selfId;
    const botName = getConfig().persona?.botName || '';
    const selfNick = getConfig().persona?.selfNickname || onebot.selfNickname || '';
    const atMe = (typeof atMeMark === 'boolean')
      ? atMeMark
      : (text.includes(`@${selfNick}`) || (botName && text.includes(`@${botName}`))
        || (selfId && new RegExp(`\\[CQ:at(?:,[^\\]]*?)?qq=${selfId}[^\\]]*\\]`).test(text)));
    if (!atMe) return;
    if (!text.includes(command)) return;
    // 设置禁言：durationMin>0 则到期时间戳，否则 0（直到手动解除）
    const durationMs = Math.max(0, Number(cm.durationMin) || 0) * 60000;
    const until = durationMs > 0 ? Date.now() + durationMs : 0;
    const active = { ...(getConfig().commandMute?.active || {}) };
    active[String(groupId)] = until;
    updateConfig({ commandMute: { active: { __replace__: active } } });
    const untilStr = until ? new Date(until).toLocaleTimeString('zh-CN', { hour12: false }) : '直到手动解除';
    log(`[指令禁言] 群 ${groupId} 已被「${command}」禁言，响应档位临时固定为 1 档（仅艾特），${untilStr} 解除`);
    emit('chat-update', `group:${groupId}`);
  }

  // ── 链接媒体转发（确定性触发） ──────────────────────────────────────────

  /**
   * 确定性触发：消息里出现 B站/抖音链接 → 下载并转发。
   *
   * 与 LLM 型（注册工具）的区别正在这里：插件开着，条件满足就一定会跑，
   * 模型想忽略也忽略不掉 —— 整条链路上没有任何"让模型决定"的环节。
   *
   * 一个提供者都不在（插件未装/未启用）时立刻返回 —— 零网络请求、零副作用。
   * 调度细节（候选链接提取、多提供者协商、失败文案）在 src/media-links.js，
   * 那部分是纯逻辑、可被测试直接驱动；这里只负责从 skillManager 取提供者。
   */
  async function forwardLinkedMedia(kind, id, text) {
    const providers = skillManager.getCapabilityProviders('media.download');
    if (!providers.length) return;
    await dispatchMediaLinks({
      urls: extractCandidateUrls(text),
      providers,
      ctx: { onebot, sender, kind, chatId: id, text },
      log
    });
  }

  async function ingestPoke(event) {    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）：全局优先，其次按群
    if (operatorId) {
      if (isGloballyBlocked(operatorId)) return;
      if (isGroup && (cfgNow.blocklist?.[id] || []).map(String).includes(operatorId)) return;
    }
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"317183522 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    // 目标名字同样补齐（被拍者的群名片；解析不到就留 QQ 号，formatEntry 会拼 (QQ:xxx)）
    const targetName = (isGroup && String(targetId) !== String(selfId))
      ? ((await resolveAtName(id, targetId)) || targetId)
      : targetId;
    // 展示名：管理员备注 > 群名片（与消息历史同口径）
    const notes = cfgNow.memberNotes || {};
    const opLabel = notes[operatorId] || operatorName || operatorId;
    const tgtLabel = String(targetId) === String(selfId)
      ? '我'
      : (notes[targetId] || targetName || targetId);
    // 文案统一为「X 拍了拍 Y」视角（机器人被拍时 Y=我）。
    // 旧文案"你拍了拍（来自 张三）"视角混乱（读起来像"我拍了别人"），
    // 是机器人被拍时识别错乱的主因。名字带 QQ 号，与发言人标签同口径。
    const opWithId = String(operatorId) ? `${opLabel}(QQ:${operatorId})` : opLabel;
    const tgtWithId = (String(targetId) === String(selfId) || !String(targetId)) ? tgtLabel : `${tgtLabel}(QQ:${targetId})`;
    const text = operatorId === targetId
      ? `[拍一拍] ${opWithId} 拍了拍自己`
      : `[拍一拍] ${opWithId} 拍了拍 ${tgtWithId}`;
    // 拍一拍是"轻量召唤"信号：作为触发批发给模型（isPoke 标记让档位判定
    // 按 1 档响应），但**不进【已读信息】历史**——buildPastState 会跳过 isPoke，
    // 存档里只留一条轻量记录（聊天记录页仍可见，模型历史里不出现）。
    const entry = store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: [],
      isPoke: true
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`, entry);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // 撤回事件：群撤回 group_recall / 好友撤回 friend_recall
    // 用户撤回的消息，后续会话不再发给大模型（从存档里标记/删除）。
    if (event.post_type === 'notice' && (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall')) {
      return handleRecall(event);
    }
    // 群禁言通知：把"机器人自己被禁言/解禁"写进 ban-state 插件。
    // ban-state 的 note-muted/note-unmuted 原本没有任何调用方（插件头注释宣称
    // "写：协议层（收到 OneBot 的 group_ban 通知）"，但这条线从未接上）——
    // 状态永远是空的，#checkSelfMuted 的快路径（known=true 才跳过）形同虚设。
    // OneBot v11：notice_type=group_ban，sub_type=ban（duration=0 表示解禁）。
    if (event.post_type === 'notice' && event.notice_type === 'group_ban') {
      return handleGroupBan(event);
    }
    // meta/心跳等事件忽略
  }

  /**
   * 处理群禁言通知（OneBot group_ban）。
   * 只关心机器人自己被禁言/解禁 —— 别的群员互禁与"发不出消息"无关。
   * duration 秒；OneBot 语义：sub_type=lift_ban 或 duration=0 = 解禁。
   * 插件没装/未启用时这里是空操作，行为与从前完全一致。
   */
  function handleGroupBan(event) {
    const groupId = String(event.group_id ?? '');
    const targetId = String(event.user_id ?? '');
    const selfId = onebot.selfId || '';
    if (!groupId || !selfId || targetId !== selfId) return;
    const chatKey = `group:${groupId}`;
    try {
      for (const p of skillManager.getCapabilityProviders('chat.ban-state', { chatKey, kind: 'group' })) {
        const durationSec = Math.max(0, Number(event.duration) || 0);
        if (event.sub_type === 'lift_ban' || durationSec === 0) {
          p.fn({ chatKey, action: 'note-unmuted' });
          log(`[ban-state] 群 ${groupId} 已解除对机器人的禁言`);
        } else {
          p.fn({ chatKey, action: 'note-muted', durationSec });
          log(`[ban-state] 群 ${groupId} 禁言机器人 ${durationSec} 秒，期间跳过处理`);
        }
      }
    } catch (error) {
      log(`[ban-state] 记录禁言通知失败：${error?.message ?? error}`);
    }
  }

  /** 处理消息撤回：把对应 mid 的存档消息标记为已撤回（后续提示词过滤掉）。 */
  function handleRecall(event) {
    const isGroup = event.notice_type === 'group_recall';
    const chatKey = isGroup ? `group:${String(event.group_id)}` : `private:${String(event.user_id)}`;
    const mid = event.message_id;
    if (mid == null) return;
    const marked = store.markRecalled(chatKey, mid);
    if (marked) {
      log(`[撤回] ${chatKey} 消息 #${mid} 已被撤回，后续不再发给模型`);
      emit('chat-update', chatKey);
    }
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  // ── 请求体读取 ──────────────────────────────────────────────────────────
  // 抛出的错误必须是**可暴露的 HTTP 错误**（带 .expose 标记），由 /api 分发层
  // 统一转成 4xx。否则：JSON.parse 异常会冒成 500；"超限直接 throw" 会让没读完的
  // socket 变脏 —— 客户端连接池下次复用这条连接就是 ECONNRESET。
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  const HARD_BODY_LIMIT = 16 * 1024 * 1024;   // 超此值不再排空，直接断链
  function httpError(status, message) {
    const e = new Error(message);
    e.expose = true;
    e.status = status;
    return e;
  }

  async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        throw httpError(413, '请求体过大');
      }
      if (size > maxBytes) {
        tooLarge = true;          // 继续读干净（内容丢弃），保证连接可复用
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
    if (tooLarge) throw httpError(413, `请求体过大（上限 ${Math.round(maxBytes / 1024)}KB）`);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw httpError(400, '请求体不是合法 JSON');
    }
  }

  // ── 来源校验（CSRF / DNS rebinding 防护）────────────────────────────────
  // 服务只监听回环，但**浏览器里的任意网页都能向 127.0.0.1 发简单请求**，
  // 而 CORS 只挡"读响应"、挡不住"副作用"（改配置、暂停、重置数据…）。
  // 所以所有 /api/* 都必须来自回环 Host；带 Origin/Referer 时必须同源。
  function isLoopbackHostHeader(host) {
    return /^127\.0\.0\.1(:\d+)?$/.test(host)
      || /^localhost(:\d+)?$/.test(host)
      || /^\[::1\](:\d+)?$/.test(host);
  }

  function originAllowed(req) {
    const host = String(req.headers.host ?? '');
    if (!isLoopbackHostHeader(host)) return false;
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const u = new URL(origin);
        return isLoopbackHostHeader(u.host) && u.host === host;
      } catch { return false; }
    }
    const referer = String(req.headers.referer ?? '');
    if (referer) {
      try { return new URL(referer).host === host; } catch { return false; }
    }
    // 无来源信息（curl / 本机脚本 / 地址栏直达）—— 放行
    return true;
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password / cookie …
  // ⚠️ cookie 必须在内：media-download 插件的 bilibiliCookie / douyinCookie
  //    是登录凭据，曾经 pattern 不认导致 /api/config 明文返回。
  // ⚠️ server.token（控制台管理令牌）也在内：它只用于 x-console-token 校验，
  //    GET /api/config 没有任何理由把明文管理令牌回传给浏览器（2026-09-26 审查发现
  //    裸 "token" 键名不命中原 pattern，配置了 token 的实例会在每次打开设置页时泄露它）。
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key|^token$)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线是「校验请求来源」。
   *
   * ⚠️ 历史实现里有一句 `if (req.headers['x-console-token']) return true`：
   *    只看"有没有这个头"、不看值，等于任何人加个头就能读明文密钥。
   *    已删除 —— 来源校验交由 originAllowed() 统一负责。
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.headers['x-console-token'] === token || url.searchParams.get('token') === token) return true;
    }
    return originAllowed(req);
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  // 声明式路由表（src/routes.js）：把所有依赖一次性注入。
  // 路由 handler 通过闭包取用这些依赖，handleHttp 只负责匹配分发。
  const apiRoutes = createRoutes({
    store, memory, sessions, onebot, orchestrator,
    emit, log,
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    snowlumaDir, snowlumaWsPort, snowlumaWebuiUrl, snowlumaWebuiPort, snowlumaStatus, snowlumaLogs,
    launchSnowluma, stopSnowluma,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    visionScan, isPortOpen,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      if (!originAllowed(req)) return json(res, 403, { error: '请求来源不被信任' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      // 心跳：半开 TCP（拔网线 / NAT 超时，没有 FIN）不会触发 req 'close'，
      // 少了心跳这些客户端会永久留在 sseClients 里，之后每次 emit 都白写一遍。
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 下面 error/close 会清理 */ }
      }, 15000);
      heartbeat.unref?.();
      const cleanup = () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      };
      // 异步写错误不会走 try/catch，必须显式兜住，否则会变成 uncaughtException
      res.on('error', cleanup);
      res.on('close', cleanup);
      req.on('close', cleanup);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      // 来源校验：挡住"恶意网页借浏览器打 127.0.0.1"（CSRF / DNS rebinding）。
      // 必须在 authorize 之后、路由分发之前。
      if (!originAllowed(req)) {
        return json(res, 403, { error: '请求来源不被信任（仅接受本机控制台的同源请求）' });
      }
      const method = req.method;

      // 声明式路由分发（路由表在 src/routes.js）
      try {
        for (const route of apiRoutes) {
          if (route.method !== '*' && route.method !== method) continue;
          let match = null;
          if (typeof route.pattern === 'string') {
            if (route.pattern !== pathname) continue;
          } else {
            match = route.pattern.exec(pathname);
            if (!match) continue;
          }
          return await route.handler({ req, res, url, pathname, method, match, json });
        }
      } catch (error) {
        // readBody 等抛出的"可暴露错误"统一转 4xx；其余记日志、返回 500 而不是让连接挂掉
        if (error?.expose && Number.isInteger(error.status)) {
          return json(res, error.status, { error: String(error.message || '请求无效') });
        }
        log(`[api] ${method} ${pathname} 处理失败：${error?.stack ?? error?.message ?? error}`);
        return json(res, 500, { error: '服务器内部错误' });
      }
      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }


    // 静态 UI
    if (req.method === 'GET') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        // jpg/jpeg/webp/gif/ico：设置页群二维码彩蛋（group-qrcode.jpg）与
        // 市场页图片要用 —— 曾经只认 png/svg，jpg 会以 octet-stream 下载而非显示
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
        const headers = { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' };
        if (ext === '.html') {
          // CSP 用 HTTP 头再声明一次：header 里的 frame-ancestors 才生效
          // （meta 版本会被浏览器忽略该指令），同时给不解析 meta 的场景兜底。
          // ⚠️ script-src 与 index.html 的 meta 版本同款（sha256 hash 精确放行
          //    首屏主题预置脚本，不含 unsafe-inline）—— 两处口径必须一致，
          //    否则 meta 被剥离的场景下 unsafe-inline 立即生效。
          // 2026-09-26：验证码 SDK 需要动态加载 o.alicdn.com（及 kondius.cn 反代）、
          //    XHR 到 *.aliyuncs.com —— 与 meta 版本同步放行；**meta 与 HTTP 头两份
          //    CSP 浏览器取交集执行，只改一处等于没改**（本次 alicdn 加载失败即漏改此处）。
          headers['content-security-policy'] = [
            "default-src 'self'",
            "script-src 'self' 'sha256-xBF5qExTuqfXHlYtKYaaldGJshQgQOr5zvcGHjbPL7w=' https://o.alicdn.com https://kondius.cn",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: http: https:",
            "media-src 'self' data: blob:",
            "connect-src 'self' https://kondius.cn https://*.aliyuncs.com https://*.alicdn.com",
            "frame-src https://*.aliyuncs.com https://*.alicdn.com https://kondius.cn",
            "worker-src 'self' blob: https://*.alicdn.com https://kondius.cn",
            "font-src 'self' data:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
          ].join('; ');
          headers['x-content-type-options'] = 'nosniff';
          headers['referrer-policy'] = 'no-referrer';
        }
        res.writeHead(200, headers);
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // ── 启动顺序（2026-09-18 按耗时画像重排）────────────────────────────
    // 旧顺序的瓶颈：HTTP → 遥测 → Skill加载(串行import) → SnowLuma启动(最长20s等端口)
    //              → OneBot连接 → 就绪日志。Skill 与 SnowLuma 互不依赖却串行，
    //              白白把两段等待加在一起。
    // 新顺序：HTTP（页面先活）→ 遥测(纯后台) → **Skill 与 SnowLuma 并行** →
    //         OneBot 连接 → 就绪。会话索引的磁盘对账（reconcileInBackground）
    //         在 HTTP 起来后就排上，不占启动关键路径。
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 匿名用量遥测：启动 90 秒后发第一次，之后每 6 小时一次；失败静默不影响使用
    startTelemetryLoop(log);

    // 会话索引后台对账：启动读的是毫秒级缓存，这里异步补扫磁盘修正差异
    // （缓存缺失的新文件/外部删除的文件）。不 await —— 不挡任何启动步骤。
    sessions.reconcileInBackground();

    // 用量档案预热：首次打开用量页的卡顿来自"冷 parse 全部会话文件"
    //（2290 个 / 178MB 实测 1.3~1.9 秒）。启动后台先预热一次（collectUsageRows
    // 内部分片让步，不阻塞事件循环），用户点开用量页时档案已就绪，
    // 只剩窗口过滤（毫秒级）。不 await；失败静默（用量页会自己再算）。
    collectUsageRows({ range: '7' }).catch(() => {});

    // ── Skill 加载 与 SnowLuma 拉起并行（互不依赖）──
    const skillsReady = (async () => {
      try {
        const pluginResult = await reloadSkills({ reason: 'boot' });
        const okCount = pluginResult.loaded.length;
        const failCount = pluginResult.failed.length;
        if (okCount > 0) log(`[skill] 已加载 ${okCount} 个 Skill`);
        for (const f of pluginResult.failed) {
          log(`[skill] ❌ ${f.id || '(未知)'}：${f.error}`);
        }
        if (failCount > 0) log(`[skill] ${failCount} 个 Skill 加载失败`);

        const toolCount = orchestrator.refreshToolDefs();
        log(`[skill] 工具集已刷新：${toolCount} 个工具`);

        // 热重载日志：reloadSkills({reason:'boot'}) 里已经把 watcher 建好了
        // （默认开 config.extensions.hotReload，QQ_AGENT_DEV=1 可强制打开）
        if (pluginWatcher) {
          // 明确告知"落地的代码会被执行"，让用户知道这个行为的边界
          log('[skill] 热重载已启用：放入 plugins/ 或 skills/ 的目录会自动加载并执行'
            + '（要关闭请设 config.extensions.hotReload=false）');
        } else {
          log('[skill] 热重载未启用（config.extensions.hotReload=false）：改动后需重启');
        }
      } catch (error) {
        log('[skill] 加载失败:', error?.message ?? error);
      }
    })();

    const snowlumaReady = (async () => {
      if (!getConfig().snowluma?.autoLaunch) return;
      try {
        // 等待就绪用 WebUI 端口（进程即起即听）；OneBot WS 端口要等账号登录，
        // 在这里等 3001 是"永远等不到"的（没人扫码就一直挂着 20 秒）。
        const webuiPort = snowlumaWebuiPort();
        if (!(await isPortOpen('127.0.0.1', webuiPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', webuiPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    })();

    await Promise.all([skillsReady, snowlumaReady]);

    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      // accessToken/httpToken 已由 applyTokens 直接挂到实例（候选[0]）
    }
    await onebot.connect();

    // ── OneBot 端口就绪轮询（2026-09-19）────────────────────────────────────
    // WS 3001 只有「QQ 登录 → Hook 检出 → OneBot 实例拉起」后才监听。常见时序：
    // QQ Agent 先启动（此时 3001 未开）→ connectLoop 吃 ECONNREFUSED → 退避
    // 涨到 30 秒 → 用户在这中间扫码登录 → 3001 开了，但下一次重试可能还要等
    // 二十多秒，用户看到的就是"登录了半天连不上 / 重启就好了"。
    // 这里加一个主动轮询：每 2 秒探一次 WS 端口，端口一开立即触发重连（走
    // connectLoop 的代际互斥，不会产生并发连接）。已连接后轮询自动停止；
    // 断线（SnowLuma 重启等）时轮询自动恢复 —— 恢复延迟从"最多 30 秒"降到
    // "最多 2 秒 + 一次连接建立"。
    const obWsPort = snowlumaWsPort();
    obPortPollTimer = setInterval(async () => {
      if (onebot.connected) return;          // 连着：无事可做（轮询本身极廉价）
      const open = await isPortOpen('127.0.0.1', obWsPort);
      if (open && !onebot.connected) {
        // 端口从关到开：立即重连（reconnect 会重置退避，秒级恢复）
        onebot.reconnect();
      }
    }, 2000);
    obPortPollTimer.unref?.();
    // ── WS 就绪后的账号信息兜底（2026-09-19）────────────────────────────────
    // SnowLuma 重启/换号后，QQ Agent 侧的 WS 可能先于 OneBot 实例完全就绪连上，
    // open 时的 get_login_info 失败 → selfInfo 恒空 → UI"检测不到账号"。
    // onebot.js 里已有 15 秒延迟补拉；这里再挂一道 45 秒后的终检：
    // 连着但仍没有 selfInfo 就强制补一次并广播状态（长期运行的兜底，幂等）。
    setTimeout(() => {
      if (!onebot.connected || onebot.selfInfo) return;
      onebot.call('get_login_info').then((info) => {
        if (info) {
          onebot.selfInfo = info;
          emit('onebot-status', { connected: true, everConnected: true, error: '' });
          log('[onebot] 账号信息延迟恢复成功');
        }
      }).catch(() => { /* 仍失败：连接层已尽力，UI 状态如实反映 */ });
    }, 45_000).unref?.();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startReminderLoop();   // 提醒（闹钟）调度：到点往群里发提醒
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  // ── Skill 重扫：UI「刷新」按钮的唯一后端入口 ──────────────────────────
  // 之前「刷新」只重读内存注册表（GET /api/skills），不碰磁盘 —— watcher 丢事件
  // （目录删除重建后 fs.watch 句柄失效、网络盘、杀毒软件）时，点多少次刷新都
  // 看不到新插件。这里把"重扫磁盘 + 激活 + 刷工具 + 重建 watcher"做成一个
  // 幂等函数，启动流程和手动重扫共用，行为完全一致。
  async function reloadSkills({ reason = 'manual' } = {}) {
    const result = await loadPlugins({ log });
    for (const st of skillManager.list()) {
      if (st.enabled && st.loaded) {
        try { skillManager.activate(st.id); } catch (error) { log(`[skill] 激活 ${st.id} 失败：${error?.message ?? error}`); }
      }
    }
    try { orchestrator.refreshToolDefs(); } catch { /* 刷新失败不影响主流程 */ }

    // watcher 自愈：fs.watch 监听的目录被删除再重建后收不到任何事件，
    // 这里关掉旧的重新建。热重载关闭时保持关闭（尊重用户配置）。
    const hotReloadOn = process.env.QQ_AGENT_DEV === '1'
      || getConfig().extensions?.hotReload !== false;
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    if (hotReloadOn) pluginWatcher = watchPlugins({ log, onReload: () => reloadSkills({ reason: 'watch' }) });

    if (reason !== 'boot') {
      log(`[skill] 重扫完成（${reason}）：${result.loaded.length} 成功，${result.failed.length} 失败`
        + (result.pruned?.length ? `，卸载 ${result.pruned.length} 个已删除的 Skill` : ''));
      emit('status', { configUpdated: true });
    }
    return result;
  }

  async function stop() {
    // 退出前给插件一次机会（before-shutdown 钩子）：目前用于把 QQ 状态设成"请勿打扰"。
    // 必须在 onebot.close() 之前跑，且限时 —— 退出不能被插件拖住。
    // 注意：被计划任务 taskkill /F 杀掉时没有任何 JS 钩子会跑，那条路由脚本直接调
    //       POST /api/presence 兜住（见 停止脚本）。
    try {
      await Promise.race([
        skillManager.runHook('before-shutdown', { reason: 'app-stop' }),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
    } catch (error) {
      log('[presence] before-shutdown 钩子执行失败：' + (error?.message ?? error));
    }
    // 先停掉热重载 watcher：否则 stop() 之后文件变动仍会触发重载 + 广播
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    await orchestrator.abortAll();
    orchestrator.stopReminderLoop();
    if (communitySyncTimer) clearInterval(communitySyncTimer);
    if (obPortPollTimer) clearInterval(obPortPollTimer);
    // 索引缓存立刻落盘：正常运行中靠防抖（5s），退出前必须写一次，
    // 否则最后的会话变动丢失、下次启动要靠后台对账补（慢路径）
    sessions.flushIndexCache();
    // 关闭所有 SSE 长连接，避免 server.close() 一直等它们
    for (const c of [...sseClients]) {
      try { c.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程。
    // 注意：SnowLuma 退出时不一定能立刻把 config 落盘，但我们的 stop 不会再去读它，
    // 下次启动会读到完整文件。
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
    // 便携 QQ：默认保留运行（避免误杀用户登录态），如需清理可在 UI 手动关闭
    // try { await stopPortableQQ(); } catch { /* ignore */ }
    logger.flush();
    // 解绑本次 createApp 的日志转发器，避免 Electron/测试重复创建 app 时监听器累积。
    try { removeAppLogListener?.(); } catch { /* ignore */ }
    releaseInstanceLock();
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus, launchPortableQQ, stopPortableQQ, qqPortableStatus, reloadSkills };
}

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  // 前端"全部"按钮：不设起始时间。曾经静默回落"近 7 天"（Number('all')||7），
  // 用户以为在看全量历史实际被截断 —— 与"求和一致"的产品口径冲突。
  if (s === 'all') {
    return { mode: 'all', start: 0, end: now, label: '全部' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
//
// ⚠️ 数据量增长后的实测（2026-09-17，真实部署 2144 个会话 / 172MB）：
//    全量 parse 需要 ~1.9s —— 20 秒 TTL 到期后的每次重算都会把主进程
//    event loop 阻塞近 2 秒，期间 HTTP/SSE/消息处理全部排队 —— 前端表现
//    就是"用量页卡住、整个控制台无响应"。两条治理（同步进 collectUsageRows）：
//    A. **增量解析**：目录快照没变时复用上一轮解析结果（不只 TTL 内 ——
//       sig 相同就复用，只是重做时间窗过滤与派生字段），冷启动只在
//       真有新会话落盘时才发生。TTL 仍然保留，兜"内容被改写"的边缘情况。
//    B. **流式分片解析**：真要冷启动时，把 172MB 的同步 parse 拆成
//       每 50 个文件一让步（setImmediate）的异步流水线 —— 单次让步前的
//       阻塞 <100ms，消息处理/界面请求不再被长阻塞。
//      会话文件"结束写一次、之后不改"的语义不变，A 的复用与原缓存同样安全。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;
// 已解析会话的档案（增量解析的持久层）：sig（目录快照）→ 每会话的展开行/计数。
// 与 usageRowsCache 的区别：后者是"某个时间窗的最终 rows"，前者是
// "全部会话的原始素材" —— 换 range 时不必重新读盘。
const usageArchive = { sig: '', at: 0, sessions: null };   // sessions: Map(file -> {rows[], searchCount, toolCounts})
// 让步前最多同步解析的文件数（B 方案的切片粒度）
const USAGE_PARSE_CHUNK = 50;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs + ':' + files.reduce((a, f) => a + f.length, 0);
  } catch {
    return '';
  }
}

/**
 * 读盘解析单个会话文件 → { rows, searchCount, toolCounts, started }。
 * 纯函数（不含时间窗过滤）：窗口过滤在 collectUsageRows 里做 —— 这样
 * 换 range（今天/7天/全部）时可以完全复用这份解析结果。
 */
function parseUsageSessionFile(dir, f) {
  const out = { rows: [], searchCount: 0, toolCounts: Object.create(null), started: 0, mtime: 0 };
  try {
    const fp = path.join(dir, f);
    out.mtime = fs.statSync(fp).mtimeMs;
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const started = Number(s.startedAt) || 0;
    out.started = started;
    // ⚠️ 不能因缺 startedAt 就整文件丢弃：行上的 raw.created 仍有时间戳，
    // 否则老会话/异常会话的 token 会整体消失。
    out.searchCount = Number(s.webSearchCount) || 0;
    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const exactRows = [];
    for (const m of (s.messages || [])) {
      const name = m && m.toolCall && m.toolCall.name;
      if (name) out.toolCounts[String(name)] = (out.toolCounts[String(name)] || 0) + 1;
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      exactRows.push({
        promptTokens: rp,
        completionTokens: rc,
        cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }
    if (exactRows.length) {
      for (const c of exactRows) {
        out.rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (p || c) {
        out.rows.push({
          promptTokens: p,
          completionTokens: c,
          cachedTokens: Number(u.cachedTokens) || 0,
          at: started,
          model: String(s.model || '') || '(未知)',
          chatKey: String(s.chatKey || '(未知)'),
          vendor: String(s.vendor || ''),
          sessionId: s.id,
          exact: false
        });
      }
    }
  } catch { /* 坏文件跳过（与旧行为一致） */ }
  return out;
}

/**
 * （异步）刷新"已解析档案"到当前目录快照。
 * 只重读**变化过的文件**（新文件 + mtime 变了的文件），其余复用 ——
 * 2144 个文件只有几个新增时，重读量从 172MB 降到几 MB。
 * 解析按 USAGE_PARSE_CHUNK 分片、片间 setImmediate 让步，不长阻塞事件循环。
 */
async function refreshUsageArchive(dir, files, sig) {
  if (usageArchive.sessions && usageArchive.sig === sig) return usageArchive.sessions;
  const prev = (usageArchive.sessions && usageArchive.sig.split(':').slice(0, 2).join(':') === sig.split(':').slice(0, 2).join(':'))
    ? usageArchive.sessions : new Map();
  const next = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const old = prev.get(f);
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (old && old.mtime === st.mtimeMs) {
      next.set(f, old);   // 文件没变：复用上次的解析结果（零读盘）
      continue;
    }
    next.set(f, parseUsageSessionFile(dir, f));
    // 分片让步：单文件最大 ~1MB，50 个一批的同步解析 < 100ms
    if ((i + 1) % USAGE_PARSE_CHUNK === 0) await new Promise((r) => setImmediate(r));
  }
  usageArchive.sessions = next;
  usageArchive.sig = sig;
  usageArchive.at = Date.now();
  return next;
}

async function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      // 深拷贝：曾经 slice() 只是浅拷贝，调用方往行对象上写字段（如 dayKey）
      // 会写穿到缓存对象；当前写入恰好幂等无害，但承诺的"防污染"并不成立
      rows: usageRowsCache.rows.map((r) => ({ ...r })),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  // ── 数据量治理（2026-09-17，见"用量行缓存"注释的 A/B 方案）──
  // 档案层增量解析 + 分片让步；时间窗过滤只对窗口内的素材做。
  const archive = await refreshUsageArchive(dir, files, sig.split('@')[0]);

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    const parsed = archive.get(f);
    if (!parsed) continue;
    // started 只用于工具/搜索归窗；调用行一律按 r.at 过滤，started 缺失不再丢行
    const started = Number(parsed.started) || Number(parsed.mtime) || 0;
    if (started >= win.start && started <= win.end) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts || {})) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    // 逐次调用行：窗口内才收进 rows（行自带 at，可精确到调用时刻）
    for (const r of (parsed.rows || [])) {
      if (r.at < win.start || r.at > win.end) continue;
      rows.push(r);
    }
  }
  // 模型身份 = 渠道 + 模型 id。
  // 渠道取**会话自己记录的** vendor（创建会话时由当时的配置派生）。
  // 老会话没这个字段 → 标为「未知渠道」，绝不拿当前配置去倒推历史 ——
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  // ⚠️ rows 里的对象来自档案层（可能被多个 range 的缓存共享引用）——
  //    上面 vendor/modelKey 的改写是幂等的，但调用方还会写 dayKey，
  //    所以缓存里也存一份浅拷贝行（同 range 复用时的防污染，与旧行为一致）。
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.map((r) => ({ ...r }));
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

// ── 按日快照（2026-09-19）──────────────────────────────────────────
//
// 问题：collectUsageRows 即使有档案层缓存，冷启动（2144 文件 / 172MB）仍要
// 全量流式解析；"今天之前的每一天"的数据是**不可变的**（会话结束写一次、
// 之后不改），每次打开用量页都从头统计它们是纯浪费。
//
// 方案：把"已完结自然日"（今天之前）的聚合结果固化到
// data/usage-daily.json。读取路径优先快照；只有快照缺失/失效的日才回退
// 到"从档案聚合"。写快照时机：每次统计完顺手补齐（异步、不阻塞响应）。
//
// 有效性判据：每条日快照带生成时的目录快照 sig。sig 没变 → 该日必然没
// 新增会话（会话文件不改写），直接用。sig 变了 → 重算该日（分片解析会
// 复用 mtime 相同的旧解析结果，增量代价很小）。"今天"永远不进快照。
//
// ⚠️ 成本口径：快照存 costOfRows 聚合结果。价格表（自定义价/远程价）变化
//    会让历史成本跟着变 —— 快照固定的是"生成当时的计价"。这是刻意取舍：
//    量级收益（秒→毫秒）远大于"改价后历史成本不联动"的小误差；想重算
//    任何一天，删掉快照文件对应条目即可。
const USAGE_DAILY_FILE = path.join(DATA_DIR, 'usage-daily.json');
const USAGE_DAILY_VERSION = 1;

function loadUsageDaily() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_DAILY_FILE, 'utf8'));
    if (parsed?.version === USAGE_DAILY_VERSION && parsed.days && typeof parsed.days === 'object') {
      return parsed.days;
    }
  } catch { /* 无文件/坏文件 = 全部重算 */ }
  return {};
}

function saveUsageDaily(days) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${USAGE_DAILY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: USAGE_DAILY_VERSION, savedAt: Date.now(), days }, null, 1), 'utf8');
    fs.renameSync(tmp, USAGE_DAILY_FILE);
  } catch { /* 快照写失败只是慢一点，绝不能影响统计主流程 */ }
}

/* ── 按天预聚合文件（data/usage-days/YYYY-MM-DD.json）────────────────
   设计：已完结日固化成小文件；点用量页 = 读日文件之和 + 只实时算今天。
   不再每次全量扫 sessions/。日文件缺失时才按需回算该日并落盘。 */
const USAGE_DAYS_DIR = path.join(DATA_DIR, 'usage-days');
const USAGE_DAY_VERSION = 1;

/** 一天是否完全没量（调用/成本/token/搜索都为 0）——空日不进柱图与按天表。 */
function isEmptyDayAgg(agg) {
  const t = agg?.totals || {};
  return !(Number(t.runs) || 0)
    && !(Number(t.cost) || 0)
    && !(Number(t.promptTokens) || 0)
    && !(Number(agg?.searchCount) || 0);
}

function usageDayFile(dayKey) {
  return path.join(USAGE_DAYS_DIR, `${dayKey}.json`);
}

function loadUsageDayFile(dayKey) {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageDayFile(dayKey), 'utf8'));
    if (parsed?.version === USAGE_DAY_VERSION && parsed.day === dayKey && parsed.aggregates) {
      return parsed.aggregates;
    }
  } catch { /* 缺失/损坏 → 回算 */ }
  // 一次性迁移：旧的单文件快照 usage-daily.json
  try {
    const snap = loadUsageDaily()[dayKey];
    if (snap?.aggregates) {
      saveUsageDayFile(dayKey, snap.aggregates);
      return snap.aggregates;
    }
  } catch { /* ignore */ }
  return null;
}

function saveUsageDayFile(dayKey, aggregates) {
  // 空日不落盘：曾因 completedDayKeys(0) 从 1970 枚举，给每一天都写了空壳文件
  // （两万多个 463 字节 JSON），把 usage-days 目录和统计全部打乱。
  if (isEmptyDayAgg(aggregates)) return;
  try {
    fs.mkdirSync(USAGE_DAYS_DIR, { recursive: true });
    const tmp = `${usageDayFile(dayKey)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: USAGE_DAY_VERSION, day: dayKey, savedAt: Date.now(), aggregates
    }, null, 1), 'utf8');
    fs.renameSync(tmp, usageDayFile(dayKey));
  } catch { /* 写失败只是下次再算，不影响主流程 */ }
}

/**
 * 只解析「在 fromTs 之后写过」的会话文件。
 * 行的时间戳不可能晚于文件最后一次写入，因此 mtime < fromTs 的文件
 * 不可能包含该窗口内的调用行 —— 直接跳过，不 readFileSync / JSON.parse。
 */
async function collectArchiveForWindow(dir, files, fromTs) {
  const map = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (fromTs && st.mtimeMs < fromTs) continue;
    map.set(f, parseUsageSessionFile(dir, f));
    if ((i + 1) % USAGE_PARSE_CHUNK === 0) await new Promise((r) => setImmediate(r));
  }
  return map;
}

/**
 * 已完结自然日列表：从窗口起点（或快照里最早的日）到昨天。
 * 今天永远实时算（数据还在长）。
 */
function completedDayKeys(fromTs) {
  const out = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // 昨天的 0 点（今天之前最后一个已完结日）
  d.setDate(d.getDate() - 1);
  // ⚠️ all 模式曾经传 0 → 从 1970 年逐日枚举两万多天，
  // 每天还去 loadUsageDayFile 试读 —— 点「全部」卡死的主因。
  let startMs = Number(fromTs) || 0;
  if (!startMs) {
    const keys = listUsageDayKeys();
    startMs = keys.length
      ? (new Date(keys[0] + 'T00:00:00')).getTime()
      : (Date.now() - 29 * 24 * 60 * 60 * 1000);
  }
  const start = new Date(startMs);
  start.setHours(0, 0, 0, 0);
  while (d.getTime() >= start.getTime()) {
    out.push(dayKeyOf(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/** 已落盘的按天文件日期列表（升序）。 */
function listUsageDayKeys() {
  try {
    return fs.readdirSync(USAGE_DAYS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch { return []; }
}

/**
 * 从档案层聚合出"某一个自然日"的统计（不使用快照 —— 这是重算路径）。
 * 返回与 buildUsageStats 的 days/chats/models 三段同构的聚合体。
 */
function aggregateDayFromArchive(archive, dayKey) {
  const dayStart = new Date(dayKey + 'T00:00:00');
  if (isNaN(dayStart.getTime())) return null;
  const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000 - 1;
  const rows = [];
  let searchCount = 0;
  const toolCounts = Object.create(null);
  for (const parsed of archive.values()) {
    if (!parsed) continue;
    // started 只用于工具/搜索归日；调用行一律按 r.at 入桶（started 缺失不再连坐丢行）
    const started = Number(parsed.started) || Number(parsed.mtime) || 0;
    if (started >= dayStart.getTime() && started <= dayEnd) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts || {})) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    for (const r of (parsed.rows || [])) {
      if (r.at >= dayStart.getTime() && r.at <= dayEnd) rows.push(r);
    }
  }
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  const totals = costOfRows(rows);
  const chats = groupBy(rows, 'chatKey', 0);
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  // 按小时桶（今日 spark / 悬停提示）；搜索按会话 start 落到对应小时
  const hourSearch = Array(24).fill(0);
  for (const parsed of archive.values()) {
    if (!parsed) continue;
    const started = Number(parsed.started) || Number(parsed.mtime) || 0;
    if (started >= dayStart.getTime() && started <= dayEnd) {
      const sc = Number(parsed.searchCount) || 0;
      if (sc) hourSearch[new Date(started).getHours()] += sc;
    }
  }
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const hs = dayStart.getTime() + h * 60 * 60 * 1000;
    const he = hs + 60 * 60 * 1000 - 1;
    const ht = costOfRows(rows.filter((r) => r.at >= hs && r.at <= he));
    hours.push({
      hour: h, cost: ht.cost, runs: ht.runs, searchCount: hourSearch[h] || 0,
      promptTokens: ht.promptTokens, completionTokens: ht.completionTokens,
      cachedTokens: ht.cachedTokens, cacheHitRate: ht.cacheHitRate, totalTokens: ht.totalTokens
    });
  }
  return { totals, chats, models, searchCount, toolCounts, hours };
}

/**
 * 快照加速版统计：days 维度全部走快照 + 今天实时聚合。
 * 其余维度（chats/models/totals）= 各日快照聚合 + 今天实时。
 * 任一需要的日快照缺失/失效 → 重算该日并回写快照。
 *
 * @returns {Promise<{stats: object, usedSnapshotDays: number, recomputedDays: number}>}
 */
async function buildUsageStatsWithSnapshots({ range = '7' } = {}) {
  const win = resolveRange(range);
  const todayKey = dayKeyOf(Date.now());
  const todayStart = new Date(todayKey + 'T00:00:00').getTime();
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }

  // 已完结日：直接读按天文件；缺失的才记入待回算
  const fromTs = win.mode === 'all' ? 0 : win.start;
  const wantedDays = completedDayKeys(fromTs);
  const dayAggs = [];   // { day, aggregates }
  const needDays = [];
  for (const dayKey of wantedDays) {
    const agg = loadUsageDayFile(dayKey);
    if (agg && !isEmptyDayAgg(agg)) dayAggs.push({ day: dayKey, aggregates: agg });
    else if (!agg) needDays.push(dayKey);
  }

  // 只有「缺日文件」或「窗口含今天」才碰 sessions/；且按 mtime 裁剪
  const includesToday = win.end >= todayStart;
  let archive = null;
  let recomputed = 0;
  if (needDays.length) {
    const minNeed = Math.min(...needDays.map((d) => new Date(d + 'T00:00:00').getTime()));
    archive = await collectArchiveForWindow(dir, files, minNeed);
    for (const dayKey of needDays) {
      const agg = aggregateDayFromArchive(archive, dayKey);
      if (!agg) continue;
      saveUsageDayFile(dayKey, agg);   // 固化，下次点用量页不再扫
      // 空日不进列表：30 天窗口会把「窗口起点→有数据那天」之间的空白日全枚举，
      // 全 0 的日子既不该占柱图也不该进按天表
      if (isEmptyDayAgg(agg)) continue;
      dayAggs.push({ day: dayKey, aggregates: agg });
      recomputed++;
    }
    dayAggs.sort((a, b) => a.day.localeCompare(b.day));
  }

  // 今天（窗口含今天才需要）：实时聚合，只解析今天 0 点后写过的文件
  let todayAgg = null;
  if (includesToday) {
    if (!archive) archive = await collectArchiveForWindow(dir, files, todayStart);
    todayAgg = aggregateDayFromArchive(archive, todayKey);
  }

  // days 行带 searchCount：搜索是会话级计数，原先只在聚合顶层 → 柱图恒 0
  const byDay = dayAggs.map(({ day, aggregates }) => ({
    day, ...aggregates.totals, searchCount: Number(aggregates.searchCount) || 0
  }));
  // 今天也进 days 表：否则「近 7 天」最后一行永远缺今天（空日除外）
  if (todayAgg?.totals && !isEmptyDayAgg(todayAgg)) {
    byDay.push({ day: todayKey, ...todayAgg.totals, searchCount: Number(todayAgg.searchCount) || 0 });
    byDay.sort((a, b) => a.day.localeCompare(b.day));
  }

  // 合并各维度：已完结日按天文件 + 今天实时
  const mergeGroups = (groupsList) => {
    const map = new Map();
    for (const groups of groupsList) {
      for (const g of groups || []) {
        const key = String(g.key ?? '');
        if (!map.has(key)) map.set(key, { key, ...g, runs: 0, exactCalls: 0, cost: 0 });
        const t = map.get(key);
        t.cost += Number(g.cost) || 0;
        t.peakCost += Number(g.peakCost) || 0;
        t.offPeakCost += Number(g.offPeakCost) || 0;
        t.peakTokens += Number(g.peakTokens) || 0;
        t.offPeakTokens += Number(g.offPeakTokens) || 0;
        t.promptTokens += Number(g.promptTokens) || 0;
        t.completionTokens += Number(g.completionTokens) || 0;
        t.cachedTokens += Number(g.cachedTokens) || 0;
        t.totalTokens += Number(g.totalTokens) || 0;
        t.runs += Number(g.runs) || 0;
        t.exactCalls += Number(g.exactCalls) || 0;
      }
    }
    let out = [...map.values()];
    out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    return out;
  };

  const snapAggs = dayAggs.map((x) => x.aggregates);
  const totalsAggs = snapAggs.map((a) => a.totals);
  if (todayAgg) totalsAggs.push(todayAgg.totals);
  const totals = totalsAggs.reduce((acc, t) => {
    if (!acc) return { ...t, runs: t.runs, exactCalls: t.exactCalls };
    return {
      cost: (acc.cost || 0) + (t.cost || 0),
      peakCost: (acc.peakCost || 0) + (t.peakCost || 0),
      offPeakCost: (acc.offPeakCost || 0) + (t.offPeakCost || 0),
      peakTokens: (acc.peakTokens || 0) + (t.peakTokens || 0),
      offPeakTokens: (acc.offPeakTokens || 0) + (t.offPeakTokens || 0),
      promptTokens: (acc.promptTokens || 0) + (t.promptTokens || 0),
      completionTokens: (acc.completionTokens || 0) + (t.completionTokens || 0),
      cachedTokens: (acc.cachedTokens || 0) + (t.cachedTokens || 0),
      totalTokens: (acc.totalTokens || 0) + (t.totalTokens || 0),
      runs: (acc.runs || 0) + (t.runs || 0),
      exactCalls: (acc.exactCalls || 0) + (t.exactCalls || 0),
      hasPeakModel: Boolean(acc.hasPeakModel || t.hasPeakModel)
    };
  }, null) || { cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cacheHitRate: 0, peakRatio: 0, exactCalls: 0, hasPeakModel: false, runs: 0 };
  // 派生比率不能相加，重算
  totals.cacheHitRate = totals.promptTokens ? Math.min(1, totals.cachedTokens / totals.promptTokens) : 0;
  totals.peakRatio = (totals.peakTokens + totals.offPeakTokens) ? totals.peakTokens / (totals.peakTokens + totals.offPeakTokens) : 0;

  const chats = mergeGroups([...snapAggs.map((a) => a.chats), ...(todayAgg ? [todayAgg.chats] : [])]);
  const models = mergeGroups([...snapAggs.map((a) => a.models), ...(todayAgg ? [todayAgg.models] : [])])
    .map((m) => {
      const { vendor, model } = splitModelLabel(m.key);
      return { ...m, vendor, model };
    });
  let searchCount = snapAggs.reduce((a, x) => a + (x.searchCount || 0), 0) + (todayAgg?.searchCount || 0);
  const toolCounts = {};
  for (const a of snapAggs) {
    for (const [k, v] of Object.entries(a.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;
  }
  for (const [k, v] of Object.entries(todayAgg?.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;

  // 日文件已在回算时逐个落盘，这里不再写 usage-daily.json

  return {
    stats: {
      range: String(range),
      rangeLabel: win.label,
      mode: win.mode,
      totals,
      searchCount: searchCount || 0,
      toolCounts: toolCounts || {},
      days: byDay,
      hours: todayAgg?.hours || [],
      chats,
      models
    },
    recomputedDays: recomputed,
    usedSnapshotDays: wantedDays.length - recomputed
  };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查 —— 用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  const cfg = getConfig();
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * tier.in + (cached / 1_000_000) * tier.cached + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。
 * 2026-09-19 起优先走"按日快照"路径（历史日聚合固化在 data/usage-daily.json，
 * 只实时算今天），快照层出错时自动回落到旧的实时聚合 —— 用量页绝不能白屏。 */
async function buildUsageStats({ range = '7' } = {}) {
  try {
    const { stats } = await buildUsageStatsWithSnapshots({ range });
    if (stats && stats.totals) return stats;
  } catch (error) {
    console.warn('[usage] 快照统计路径失败，回落实时聚合：', error?.message ?? error);
  }
  const { rows, win, searchCount, toolCounts } = await collectUsageRows({ range });
  const totals = costOfRows(rows);
  // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
  // 按天分桶需要 dayKey 字段
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // 按天 / 按小时都算出来：回退路径曾经没有 hours，前端 spark 退化成单柱实心块
  const byDayMap = new Map();
  for (const r of rows) {
    const k = r.dayKey;
    if (!byDayMap.has(k)) byDayMap.set(k, []);
    byDayMap.get(k).push(r);
  }
  const byDay = [...byDayMap.entries()]
    .map(([day, list]) => ({ day, ...costOfRows(list) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const todayKey2 = dayKeyOf(Date.now());
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const hs = new Date(todayKey2 + 'T00:00:00').getTime() + h * 60 * 60 * 1000;
    const he = hs + 60 * 60 * 1000 - 1;
    const ht = costOfRows(rows.filter((r) => r.at >= hs && r.at <= he));
    hours.push({
      hour: h, cost: ht.cost, runs: ht.runs,
      promptTokens: ht.promptTokens, completionTokens: ht.completionTokens,
      cachedTokens: ht.cachedTokens, cacheHitRate: ht.cacheHitRate, totalTokens: ht.totalTokens
    });
  }
  const chats = groupBy(rows, 'chatKey', 0);
  // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
  // 行数多时由前端滚动容器处理。
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return {
    range: String(range),
    rangeLabel: win.label,
    mode: win.mode,
    totals,
    searchCount: searchCount || 0,
    toolCounts: toolCounts || {},
    days: byDay,
    hours: hours || [],
    chats,
    models
  };
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
/**
 * 明细弹窗走按天文件：dim=day 读该日文件；dim=chat/model 跨日取同 key 分组。
 * 对不上（缺文件）返回 null，回落全量扫。
 */
function tryBreakdownFromDayFiles({ range, dim, key, by }) {
  if (!dim) return null;
  // 日文件只有「按会话」「按模型」两份平行聚合，没有 chat×model 交叉表。
  // 交叉下钻（会话→各模型 / 模型→各群聊）必须回落全量扫 ——
  // 否则会把 dim 自己的 key 再当成 by 的行（表现为「各模型」里出现群号）。
  if ((dim === 'chat' && by === 'model') || (dim === 'model' && by === 'chat')) return null;
  const win = resolveRange(range);
  const fromTs = win.mode === 'all' ? 0 : win.start;
  const wantedDays = completedDayKeys(fromTs);
  const aggs = [];
  for (const dayKey of wantedDays) {
    const agg = loadUsageDayFile(dayKey);
    if (agg) aggs.push({ day: dayKey, aggregates: agg });
  }
  if (!aggs.length) return null;
  const emptyTotals = () => ({
    cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0,
    promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0,
    runs: 0, exactCalls: 0, cacheHitRate: 0, hasPeakModel: false
  });
  const addTotals = (acc, t) => {
    const o = { ...acc };
    for (const k of ['cost', 'peakCost', 'offPeakCost', 'peakTokens', 'offPeakTokens',
      'promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens', 'runs', 'exactCalls']) {
      o[k] = (Number(acc[k]) || 0) + (Number(t[k]) || 0);
    }
    o.hasPeakModel = Boolean(acc.hasPeakModel || t.hasPeakModel);
    o.cacheHitRate = o.promptTokens ? Math.min(1, o.cachedTokens / o.promptTokens) : 0;
    return o;
  };
  const pack = (sum, groups) => ({
    range: String(range), dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key, cost: g.cost,
      promptTokens: g.promptTokens, completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens, totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate, runs: g.runs, exactCalls: g.exactCalls
    }))
  });

  if (dim === 'day') {
    const hit = aggs.find((x) => x.day === key);
    if (!hit) return null;
    const src = by === 'model' ? hit.aggregates.models : hit.aggregates.chats;
    const groups = (src || []).map((g) => ({ ...g }));
    const sum = groups.reduce((acc, g) => addTotals(acc, g), emptyTotals());
    return pack(sum, groups);
  }
  const field = dim === 'model' ? 'models' : 'chats';
  const map = new Map();
  for (const { day, aggregates } of aggs) {
    for (const g of (aggregates[field] || [])) {
      const gk = String(g.key ?? '');
      if (gk !== String(key)) continue;
      const bk = by === 'day' ? day : gk;
      if (!map.has(bk)) map.set(bk, { key: bk, ...emptyTotals() });
      map.set(bk, addTotals(map.get(bk), g));
    }
  }
  if (!map.size) return null;
  // by=day 按日期升序（时间序）；其余维度仍按成本降序
  const groups = [...map.values()].sort(by === 'day'
    ? (a, b) => String(a.key).localeCompare(String(b.key))
    : (a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  const sum = groups.reduce((acc, g) => addTotals(acc, g), emptyTotals());
  return pack(sum, groups);
}

async function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  // 能走按天文件就走：避免每次点明细行都全量扫 sessions/
  const dayFileHit = tryBreakdownFromDayFiles({ range, dim, key, by });
  if (dayFileHit) return dayFileHit;
  const { rows, win } = await collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  // by=day 按日期升序；groupBy 默认按成本降序，这里纠偏
  if (by === 'day') groups.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}

// ── 测试钩子（仅测试 import；生产代码不得依赖）──────────────────────
export function __testUsageDaily() {
  return {
    buildUsageStatsWithSnapshots,
    buildUsageStats,
    buildUsageBreakdown,
    collectUsageRows,
    loadUsageDaily,
    saveUsageDaily,
    completedDayKeys,
    aggregateDayFromArchive,
    USAGE_DAILY_FILE
  };
}
