// 账号管理器：注册表 + 每个账号一个隔离 worker 的启停/状态/增删改。
//
// 这里刻意不 import 任何 0.4 的业务模块（config/store/memory…）：
// 主进程只负责"拉起哪些 worker、它们的数据目录在哪、状态如何"，
// 真正的 QQ 逻辑全部在 worker 里跑，互不共享模块单例。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  ACCOUNT_ID_RE, PRIMARY_ID, accountDataDir, findAccount, loadRegistry, nextAccountPort,
  normalizeBaseDataDir, readAccountConfig, sanitizeAccountName, saveRegistry, writeAccountConfig,
  writeJsonAtomic
} from './registry.js';
import { buildAccountConfig, readTemplateConfig, writeAccountReadme } from './template.js';
import { pickFreePort } from './ports.js';

const STATUS_FILE = 'account-runtime.json';
const READY_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 8_000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readRuntimeFile(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function publicOnebot(account, cfg, runtime) {
  const src = runtime?.onebot || {
    wsUrl: String(cfg?.onebot?.wsUrl || cfg?.snowluma?.wsUrl || ''),
    httpUrl: String(cfg?.onebot?.httpUrl || cfg?.snowluma?.httpUrl || ''),
    hasToken: Boolean(cfg?.onebot?.accessToken || cfg?.snowluma?.accessToken),
    hasHttpToken: Boolean(cfg?.onebot?.httpAccessToken || cfg?.onebot?.accessToken
      || cfg?.snowluma?.httpAccessToken || cfg?.snowluma?.accessToken)
  };
  return {
    wsUrl: String(src.wsUrl || ''),
    httpUrl: String(src.httpUrl || ''),
    hasToken: Boolean(src.hasToken),
    hasHttpToken: Boolean(src.hasHttpToken)
  };
}

export function createAccountManager({ baseDataDir, hubPort, log = () => {} } = {}) {
  const base = normalizeBaseDataDir(baseDataDir);
  // HUB 端口在账号管理器之后才真正监听成功，所以这里用可变值；
  // workerData 里的 hubPort 只是给账号控制台的"返回账号中心"链接用。
  let hubPortNow = Number(hubPort) || 0;
  const { registry, warnings } = loadRegistry(base, { defaultPort: 3210 });
  for (const warning of warnings) log(`[账号中心] ${warning}`);

  /** id -> { worker, status, stopping, exited, ready, resolved, restarts, timer } */
  const runtimes = new Map();
  /** 已停止账号的最后状态（错误/退出原因），用于卡片展示 */
  const lastStatuses = new Map();
  const listeners = new Set();

  const emit = () => {
    for (const fn of listeners) {
      try { fn(); } catch { /* 订阅方自己负责 */ }
    }
  };

  const onChange = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  function accountOrThrow(id) {
    const account = findAccount(registry, id);
    if (!account) throw new Error(`账号不存在：${id}`);
    return account;
  }

  function accountDirectory(account) {
    const dir = accountDataDir(base, account);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function save() {
    saveRegistry(base, registry);
    emit();
  }

  function rememberUin(account, uin) {
    const value = String(uin || '').replace(/[^0-9]/g, '');
    if (!value || account.uin === value) return;
    account.uin = value;
    account.updatedAt = Date.now();
    saveRegistry(base, registry);
  }

  function reconcilePort(account, port) {
    const value = Number(port);
    if (!Number.isInteger(value) || value <= 0 || account.port === value) return;
    account.port = value;
    account.updatedAt = Date.now();
    saveRegistry(base, registry);
    log(`[账号中心] ${account.name} 控制台端口已更新为 ${value}`);
  }

  function baseStatus(account) {
    return {
      id: account.id,
      name: account.name,
      running: false,
      starting: false,
      stopping: false,
      connected: false,
      paused: false,
      port: account.port,
      updatedAt: 0,
      lastError: '',
      error: ''
    };
  }

  function statusOf(account) {
    const rt = runtimes.get(account.id);
    if (rt?.status) return rt.status;
    const file = readRuntimeFile(accountDataDir(base, account));
    const last = lastStatuses.get(account.id);
    if (file && (last == null || Number(file.updatedAt) >= Number(last.updatedAt || 0))) {
      // worker 已不在：文件里 running:true 说明上次是被强杀/崩溃，不能显示成在线。
      return {
        ...baseStatus(account),
        ...file,
        running: false,
        stale: file.running === true,
        lastError: file.error || (file.running ? '上次运行未正常退出（可能是崩溃或强制结束）' : ''),
        updatedAt: Number(file.updatedAt) || 0
      };
    }
    return last ? { ...baseStatus(account), ...last } : baseStatus(account);
  }

  function summarize(account) {
    const dir = accountDataDir(base, account);
    const cfg = readAccountConfig(base, account) || {};
    const status = statusOf(account);
    const port = Number(status.port) || account.port;
    return {
      id: account.id,
      name: account.name,
      primary: account.primary === true,
      enabled: account.enabled !== false,
      uin: String(status.selfId || account.uin || ''),
      nickname: String(status.nickname || ''),
      port,
      dataDir: dir,
      consoleUrl: port ? `http://127.0.0.1:${port}/` : '',
      model: String(status.model || cfg.api?.model || ''),
      provider: String(status.provider || cfg.api?.provider || ''),
      onebot: publicOnebot(account, cfg, status),
      allowGroups: Number(status.allowGroups ?? (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0)),
      allowPrivate: Number(status.allowPrivate ?? (Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0)),
      allowAll: Boolean(status.allowAll ?? cfg.allowAllWhenEmpty === true),
      status: {
        running: status.running === true,
        starting: status.starting === true,
        stopping: status.stopping === true,
        connected: status.connected === true,
        paused: status.paused === true,
        stale: status.stale === true,
        restartInMs: Number(status.restartInMs) || 0,
        startedAt: Number(status.startedAt) || 0,
        updatedAt: Number(status.updatedAt) || 0,
        lastError: String(status.lastError || status.error || '')
      }
    };
  }

  function list() {
    return registry.accounts.map(summarize);
  }

  function get(id) {
    const account = accountOrThrow(id);
    return summarize(account);
  }

  function setTransient(id, status) {
    lastStatuses.set(id, { ...baseStatus(accountOrThrow(id)), ...status, updatedAt: Date.now() });
    emit();
  }

  function start(id) {
    const account = accountOrThrow(id);
    const current = runtimes.get(account.id);
    if (current?.worker) return current.ready;
    // 手动启动 = 重新纳入"随程序启动"的名单。
    if (account.enabled === false) {
      account.enabled = true;
      account.updatedAt = Date.now();
      saveRegistry(base, registry);
    }

    const dir = accountDirectory(account);
    let cfg = readAccountConfig(base, account);
    if (!cfg || typeof cfg !== 'object') {
      cfg = {};
      cfg.server = { ...(cfg.server || {}), port: account.port, token: '', autoStart: false };
      writeAccountConfig(base, account, cfg);
    }
    if (!Number(cfg.server?.port)) {
      cfg.server = { ...(cfg.server || {}), port: account.port };
      writeAccountConfig(base, account, cfg);
    }

    const rt = {
      id: account.id,
      worker: null,
      status: {
        ...baseStatus(account),
        running: false,
        starting: true,
        port: Number(cfg.server?.port) || account.port,
        dataDir: dir,
        startedAt: Date.now(),
        updatedAt: Date.now()
      },
      stopping: false,
      resolved: false,
      restarts: [],
      timer: null
    };

    rt.ready = new Promise((resolve, reject) => {
      rt.resolveReady = resolve;
      rt.rejectReady = reject;
    });
    // start() 的调用方有时不 await（启动全部账号），避免 PromiseRejection 噪音。
    rt.ready.catch(() => {});
    rt.exited = new Promise((resolve) => { rt.resolveExited = resolve; });
    runtimes.set(account.id, rt);

    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: {
        id: account.id,
        name: account.name,
        dataDir: dir,
        port: Number(cfg.server?.port) || account.port,
        hubPort: hubPortNow
      },
      // 让 worker 的 console 输出进入主进程控制台；日志本体仍写各自 data/logs。
      stdout: false,
      stderr: false
    });
    rt.worker = worker;

    const settleReady = (fn, value) => {
      if (rt.resolved) return;
      rt.resolved = true;
      rt.timer && clearTimeout(rt.timer);
      fn(value);
    };

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        rt.status = {
          ...rt.status,
          ...msg.status,
          running: true,
          starting: false,
          port: Number(msg.port) || rt.status.port
        };
        reconcilePort(account, msg.status?.port || msg.port);
        if (msg.status?.selfId) rememberUin(account, msg.status.selfId);
        settleReady(rt.resolveReady, rt.status.port);
        log(`[账号中心] ${account.name} 已启动：http://127.0.0.1:${rt.status.port}/`);
        emit();
        return;
      }
      if (msg.type === 'status' && msg.status) {
        rt.status = { ...rt.status, ...msg.status, running: true, starting: false };
        if (msg.status.port) reconcilePort(account, msg.status.port);
        if (msg.status.selfId) rememberUin(account, msg.status.selfId);
        emit();
        return;
      }
      if (msg.type === 'log') {
        log(`[${account.name}] ${msg.line}`);
        return;
      }
      if (msg.type === 'error') {
        rt.status = { ...rt.status, lastError: String(msg.error || '未知错误') };
        settleReady(rt.rejectReady, new Error(rt.status.lastError));
        emit();
        return;
      }
      if (msg.type === 'stopped') {
        rt.stopping = true;
        return;
      }
    });

    worker.on('error', (error) => {
      const message = String(error?.stack ?? error?.message ?? error);
      rt.status = { ...rt.status, running: false, lastError: message, error: message };
      settleReady(rt.rejectReady, new Error(message));
      log(`[账号中心] ${account.name} 运行出错：${message}`);
      emit();
    });

    worker.on('exit', (code) => {
      const wasStopping = rt.stopping;
      rt.status = {
        ...rt.status,
        running: false,
        starting: false,
        stopping: false,
        updatedAt: Date.now(),
        stoppedAt: Date.now()
      };
      lastStatuses.set(account.id, { ...rt.status, lastError: rt.status.lastError || (code ? `退出码 ${code}` : '') });
      runtimes.delete(account.id);
      rt.resolveExited?.();
      if (!rt.resolved) {
        settleReady(rt.rejectReady, new Error(rt.status.lastError || `账号进程已退出（code=${code}）`));
      }
      emit();
      if (!wasStopping) scheduleRestart(account.id, code);
    });

    rt.timer = setTimeout(() => {
      if (rt.resolved) return;
      const message = '启动超时（45 秒内没有就绪）。可查看该账号 data/logs 下的日志。';
      rt.status = { ...rt.status, running: false, starting: false, lastError: message };
      settleReady(rt.rejectReady, new Error(message));
      log(`[账号中心] ${account.name} ${message}`);
      emit();
    }, READY_TIMEOUT_MS);
    rt.timer.unref?.();

    emit();
    return rt.ready;
  }

  function scheduleRestart(id, code) {
    const account = findAccount(registry, id);
    if (!account || account.enabled === false) return;
    const now = Date.now();
    const runtime = runtimes.get(id);
    // 用 lastStatuses 里记录的重启历史做限流；runtime 已删除，所以挂在闭包 Map 上。
    const history = (restartHistory.get(id) || []).filter((t) => now - t < RESTART_WINDOW_MS);
    if (history.length >= MAX_RESTARTS) {
      setTransient(id, {
        running: false,
        lastError: `10 分钟内连续异常退出 ${MAX_RESTARTS} 次，已停止自动重启。请查看该账号日志。`
      });
      return;
    }
    history.push(now);
    restartHistory.set(id, history);
    const delay = Math.min(10_000, 1000 * (2 ** (history.length - 1)));
    setTransient(id, {
      running: false,
      lastError: `异常退出（code=${code ?? '?'}），${Math.round(delay / 1000)} 秒后自动重启…`,
      restartInMs: delay
    });
    const timer = setTimeout(() => {
      if (findAccount(registry, id)?.enabled === false) return;
      if (runtimes.get(id)?.worker) return;
      start(id).catch((error) => log(`[账号中心] ${id} 自动重启失败：${error?.message ?? error}`));
    }, delay);
    timer.unref?.();
    // 避免 Node 因未清理的定时器阻碍测试退出
    if (runtime) runtime.restartTimer = timer;
  }

  const restartHistory = new Map();

  async function stop(id, { disable = true } = {}) {
    const account = accountOrThrow(id);
    // 界面上的「停止」同时记入注册表：下次打开程序不再自动拉起这个号。
    // 程序整体退出（stopAll）和"重启"内部调用时传 disable:false，避免把用户
    // "本来要随程序启动"的号意外关掉。
    if (disable && account.enabled !== false) {
      account.enabled = false;
      account.updatedAt = Date.now();
      saveRegistry(base, registry);
    }
    const rt = runtimes.get(account.id);
    if (!rt?.worker) {
      setTransient(account.id, { running: false, stopping: false, stoppedAt: Date.now() });
      return { ok: true, alreadyStopped: true };
    }
    rt.stopping = true;
    rt.status = { ...rt.status, stopping: true };
    emit();
    try { rt.worker.postMessage({ type: 'stop' }); } catch { /* 可能已经退出 */ }
    const exited = await Promise.race([rt.exited.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)]);
    if (!exited) {
      log(`[账号中心] ${account.name} 停止超时，强制结束线程`);
      try { await rt.worker.terminate(); } catch { /* ignore */ }
      runtimes.delete(account.id);
    }
    setTransient(account.id, { running: false, stopping: false, connected: false, stoppedAt: Date.now() });
    return { ok: true };
  }

  async function restart(id) {
    await stop(id, { disable: false });
    return start(id);
  }

  async function pause(id, value) {
    const account = accountOrThrow(id);
    const rt = runtimes.get(account.id);
    if (!rt?.worker) return { ok: false, error: '账号未运行' };
    rt.worker.postMessage({ type: 'pause', value: !!value });
    rt.status = { ...rt.status, paused: !!value };
    emit();
    return { ok: true, paused: !!value };
  }

  async function pauseAll(value) {
    const results = [];
    for (const account of registry.accounts) {
      if (!runtimes.get(account.id)?.worker) continue;
      results.push(await pause(account.id, value));
    }
    return results;
  }

  function pauseState() {
    const running = registry.accounts.map((a) => runtimes.get(a.id)).filter((rt) => rt?.worker);
    return { running: running.length, paused: running.length > 0 && running.every((rt) => rt.status?.paused) };
  }

  async function createAccount({ name, copyFrom } = {}) {
    const displayName = sanitizeAccountName(name, `账号 ${registry.accounts.length + 1}`);
    if (displayName.length < 1) throw new Error('账号名称不能为空');
    if (registry.accounts.some((a) => a.name === displayName)) {
      throw new Error(`已存在同名账号：${displayName}`);
    }

    let id = '';
    do {
      id = `acc_${crypto.randomBytes(4).toString('hex')}`;
    } while (findAccount(registry, id));

    const preferred = nextAccountPort(registry, { hubPort: hubPortNow, start: 3212 });
    const usedPorts = registry.accounts.map((a) => Number(a.port)).filter(Boolean).concat(hubPortNow ? [Number(hubPortNow)] : []);
    const port = await pickFreePort(preferred, { exclude: usedPorts });
    if (!port) throw new Error('找不到可用的控制台端口，请检查本机端口占用');

    const templateAccount = findAccount(registry, copyFrom || PRIMARY_ID) || findAccount(registry, PRIMARY_ID);
    const template = templateAccount
      ? (readAccountConfig(base, templateAccount) || readTemplateConfig(base))
      : readTemplateConfig(base);
    const cfg = buildAccountConfig(template, { port });

    const account = {
      id,
      name: displayName,
      dir: `accounts/${id}`,
      port,
      enabled: true,
      primary: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      uin: '',
      templateFrom: templateAccount?.id || ''
    };

    const dir = accountDirectory(account);
    writeAccountConfig(base, account, cfg);
    writeAccountReadme(dir, { id, name: displayName, port });
    registry.accounts.push(account);
    save();
    log(`[账号中心] 已创建账号「${displayName}」（${id}），数据目录 ${dir}，控制台端口 ${port}`);

    // 默认立刻启动；失败不影响"账号已创建"，状态会显示在卡片上。
    start(account.id).catch((error) => log(`[账号中心] ${displayName} 首次启动失败：${error?.message ?? error}`));
    return summarize(account);
  }

  async function renameAccount(id, name) {
    const account = accountOrThrow(id);
    const displayName = sanitizeAccountName(name, account.name);
    if (displayName !== account.name && registry.accounts.some((a) => a.id !== id && a.name === displayName)) {
      throw new Error(`已存在同名账号：${displayName}`);
    }
    account.name = displayName;
    account.updatedAt = Date.now();
    save();
    return summarize(account);
  }

  async function setEnabled(id, enabled) {
    const account = accountOrThrow(id);
    account.enabled = enabled !== false;
    account.updatedAt = Date.now();
    save();
    if (account.enabled) await start(account.id).catch(() => {});
    else await stop(account.id, { disable: false });
    return summarize(account);
  }

  async function removeAccount(id, { confirmName } = {}) {
    const account = accountOrThrow(id);
    if (account.primary) throw new Error('1 号账号是原 data/ 目录，不能在界面里删除');
    if (String(confirmName || '') !== account.name) {
      throw new Error('删除确认名称不一致，已取消');
    }
    await stop(account.id, { disable: false }).catch(() => {});
    const dir = accountDataDir(base, account);
    const trash = path.join(base, 'accounts', '.trash');
    fs.mkdirSync(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(trash, `${account.id}-${stamp}`);
    try {
      fs.renameSync(dir, target);
    } catch (error) {
      throw new Error(`账号已停止，但移动数据目录失败：${error?.message ?? error}`);
    }
    registry.accounts = registry.accounts.filter((a) => a.id !== account.id);
    lastStatuses.delete(account.id);
    restartHistory.delete(account.id);
    save();
    log(`[账号中心] 已删除账号「${account.name}」，数据已移至 ${target}`);
    return { ok: true, movedTo: target };
  }

  function getPrimaryConfig() {
    const primary = findAccount(registry, PRIMARY_ID);
    return primary ? (readAccountConfig(base, primary) || {}) : {};
  }

  /** 只用于托盘"开机自启"这类主账号级设置；运行中优先走 worker 的内存配置。 */
  function updatePrimaryConfig(patch) {
    const primary = findAccount(registry, PRIMARY_ID);
    if (!primary) return {};
    const rt = runtimes.get(primary.id);
    if (rt?.worker) {
      rt.worker.postMessage({ type: 'config', patch });
      return { ...getPrimaryConfig(), ...patch };
    }
    const cfg = readAccountConfig(base, primary) || {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        cfg[key] = { ...(cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {}), ...value };
      } else {
        cfg[key] = value;
      }
    }
    writeAccountConfig(base, primary, cfg);
    return cfg;
  }

  function startAll() {
    const tasks = registry.accounts
      .filter((a) => a.enabled !== false)
      .map((a) => start(a.id).catch((error) => {
        log(`[账号中心] ${a.name} 启动失败：${error?.message ?? error}`);
        return null;
      }));
    return Promise.allSettled(tasks);
  }

  async function stopAll() {
    const ids = [...runtimes.keys()];
    await Promise.allSettled(ids.map((id) => stop(id, { disable: false })));
  }

  function openConsole(id) {
    const account = accountOrThrow(id);
    const port = Number(statusOf(account).port) || account.port;
    if (!port) throw new Error('该账号还没有可用的控制台端口');
    const token = String(readAccountConfig(base, account)?.server?.token || '');
    return `http://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  }

  function writeRawRegistry() {
    writeJsonAtomic(path.join(base, 'accounts.json'), registry);
  }

  function setHubPort(port) {
    hubPortNow = Number(port) || hubPortNow;
    return hubPortNow;
  }

  return {
    baseDataDir: base,
    get hubPort() { return hubPortNow; },
    setHubPort,
    registry,
    warnings,
    onChange,
    list,
    get,
    start,
    stop,
    restart,
    pause,
    pauseAll,
    pauseState,
    createAccount,
    renameAccount,
    setEnabled,
    removeAccount,
    startAll,
    stopAll,
    openConsole,
    getPrimaryConfig,
    updatePrimaryConfig,
    accountDirectory,
    _internal: { runtimes, registry, readRuntimeFile, writeRawRegistry }
  };
}
