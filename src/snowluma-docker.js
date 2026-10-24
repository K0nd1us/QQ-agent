// macOS 上的 SnowLuma：跑官方 Linux/arm64 Docker 镜像。
//
// ── 为什么是 Docker ───────────────────────────────────────────────────
// SnowLuma 官方 Release 只提供 Windows / Linux 产物（它依赖 QQ NT 客户端），
// 没有 macOS 原生包。官方 SnowLuma.Docker.Framework 把 Linux QQ + Xvfb +
// noVNC + SnowLuma 打进镜像，支持 linux/amd64 与 linux/arm64 —— Docker
// Desktop（Apple Silicon 原生 arm64）正好能跑。
//
// 端口（全部只映射到 127.0.0.1）：
//   6081 → noVNC（浏览器里的 QQ 窗口，扫码登录）
//   5099 → SnowLuma WebUI
//   3000 → OneBot HTTP
//   3001 → OneBot WebSocket
//
// 数据：三个具名 volume（gateway-data / client-config / client-data），
// 重装镜像不会丢登录态；卸载时用 scripts/uninstall-macos.mjs 一并清理。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isMac } from './platform.js';

const execFileAsync = promisify(execFile);

export const SNOWLUMA_IMAGE = process.env.SNOWLUMA_DOCKER_IMAGE || 'motricseven7/snowluma:latest';
export const SNOWLUMA_CONTAINER = process.env.SNOWLUMA_CONTAINER || 'qq-agent-snowluma';
export const NOVNC_PORT = 6081;
export const WEBUI_PORT = 5099;
export const ONEBOT_HTTP_PORT = 3000;
export const ONEBOT_WS_PORT = 3001;
export const VNC_PASSWORD = process.env.SNOWLUMA_VNC_PASSWD || 'qqagent';

const VOLUMES = {
  data: 'qq-agent-snowluma-data',
  config: 'qq-agent-snowluma-config',
  local: 'qq-agent-snowluma-local'
};

const DOCKER_CANDIDATES = [
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker'
];

/**
 * 需要“宿主机与容器同路径可见”的目录（只读语义，实际是 RW 挂载）。
 *
 * 为什么需要：macOS 上协议端只能跑在容器里，容器看不到宿主机路径 ——
 * 图片段有 base64 回退，但 upload_group_file / upload_private_file 的 `file`
 * 参数是路径，协议端会直接 stat/realpath，容器里不存在就 100% ENOENT。
 * 把扩展数据目录按**相同绝对路径**挂进去，现有代码一行都不用改。
 *
 * 只挂 extensions/data：绝不要把 data/（config.json、账号凭据）暴露给容器。
 */
function sharedHostDirs() {
  const ext = String(process.env.QQ_AGENT_EXTENSIONS_DIR || '').trim();
  if (!ext) return [];                       // 开发/原生协议端：与宿主机同机，无需挂载
  return [path.join(path.resolve(ext), 'data')];
}

/** Docker CLI 路径：Docker Desktop 的 CLI 不一定在 PATH 里。 */
export function dockerBin() {
  for (const p of DOCKER_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'docker';
}

async function runDocker(args, { timeout = 120_000, env = process.env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(dockerBin(), args, {
      timeout, maxBuffer: 8 * 1024 * 1024, env
    });
    return { ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || '').trim(),
      error: String(error?.message || error)
    };
  }
}

/** Docker daemon 是否可达（CLI 存在但 Desktop 没启动时会失败）。 */
export async function isDockerAvailable() {
  const r = await runDocker(['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
  return r.ok && Boolean(r.stdout);
}

/**
 * 确保 Docker Desktop 在跑；没跑就 `open -a Docker` 并最多等 120 秒。
 * 返回 { ok, started, error }。
 */
export async function ensureDocker(onLog = () => {}) {
  if (!isMac) return { ok: false, error: 'Docker 协议端只用于 macOS' };
  if (await isDockerAvailable()) return { ok: true, started: false };
  onLog('Docker 未运行，正在启动 Docker Desktop…');
  try {
    const child = spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (error) {
    return { ok: false, error: `无法启动 Docker Desktop：${error?.message ?? error}` };
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await isDockerAvailable()) {
      onLog('Docker Desktop 已就绪');
      return { ok: true, started: true };
    }
  }
  return { ok: false, error: '等待 Docker Desktop 超时（120s）。请手动打开 Docker 后重试。' };
}

export async function imageExists() {
  const r = await runDocker(['image', 'inspect', SNOWLUMA_IMAGE], { timeout: 30_000 });
  return r.ok;
}

export async function containerState(name = SNOWLUMA_CONTAINER) {
  const r = await runDocker([
    'inspect', '--format', '{{json .State}}', name
  ], { timeout: 20_000 });
  if (!r.ok || !r.stdout) return { exists: false, running: false, pid: null, status: 'missing' };
  try {
    const st = JSON.parse(r.stdout);
    return {
      exists: true,
      running: !!st.Running,
      pid: Number(st.Pid) || null,
      status: String(st.Status || ''),
      startedAt: st.StartedAt || ''
    };
  } catch {
    return { exists: true, running: false, pid: null, status: 'unknown' };
  }
}

// Docker Hub 在国内经常连不上；daemon.json 里配置的镜像站也可能早已失效。
// 按顺序试：原镜像（走 daemon 配置）→ 几个公共镜像站 → 拉下来后打回原名。
const IMAGE_MIRROR_HOSTS = [
  'docker.1ms.run',
  'docker.m.daocloud.io',
  'hub.rat.dev',
  'docker.1panel.live'
];

function spawnDockerPull(ref, onLog, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(dockerBin(), ['pull', ref], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, error: '拉取超时（20 分钟）' });
    }, timeoutMs);
    const forward = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        const t = line.trim();
        if (t) onLog(t);
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, error: String(error?.message ?? error) });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: code === 0, code });
    });
  });
}

/** 拉镜像并实时转发输出（首次约 1~2GB，取决于网络）。 */
export async function pullImage(onLog = () => {}) {
  const candidates = [SNOWLUMA_IMAGE, ...IMAGE_MIRROR_HOSTS.map((h) => `${h}/${SNOWLUMA_IMAGE}`)];
  const errors = [];
  for (const ref of candidates) {
    onLog(`拉取 SnowLuma 镜像：${ref}`);
    const r = await spawnDockerPull(ref, onLog);
    if (!r.ok) {
      errors.push(`${ref}: ${r.error || `exit ${r.code}`}`);
      onLog(`  失败：${r.error || `exit ${r.code}`}`);
      continue;
    }
    if (ref !== SNOWLUMA_IMAGE) {
      onLog(`镜像来自镜像站，打回本地标签：${SNOWLUMA_IMAGE}`);
      const tag = await runDocker(['tag', ref, SNOWLUMA_IMAGE], { timeout: 60_000 });
      if (!tag.ok) return { ok: false, error: `tag 失败：${tag.stderr || tag.error}` };
    }
    return { ok: true, ref };
  }
  return { ok: false, error: `所有镜像站均失败：\n${errors.join('\n')}` };
}

const CONTAINER_ARGS = () => ([
  'run', '-d',
  '--name', SNOWLUMA_CONTAINER,
  '--restart', 'no',
  '--shm-size=1g',
  '--ulimit', 'nofile=65536:1048576',
  '--cap-add', 'SYS_PTRACE',
  '--security-opt', 'seccomp=unconfined',
  '-e', 'TZ=Asia/Shanghai',
  '-e', 'SNOWLUMA_ONEBOT_HOST=0.0.0.0',
  '-e', 'SNOWLUMA_WEBUI_HOST=0.0.0.0',
  '-e', `SNOWLUMA_WEBUI_PORT=${WEBUI_PORT}`,
  '-e', `VNC_PASSWD=${VNC_PASSWORD}`,
  '-e', 'SNOWLUMA_QQ_FLAGS=--disable-gpu --disable-software-rasterizer --disable-gpu-compositing',
  // 只映射到回环地址：OneBot 没有鉴权，绝不能暴露到局域网
  '-p', `127.0.0.1:${NOVNC_PORT}:6081`,
  '-p', `127.0.0.1:${WEBUI_PORT}:${WEBUI_PORT}`,
  '-p', `127.0.0.1:${ONEBOT_HTTP_PORT}:3000`,
  '-p', `127.0.0.1:${ONEBOT_WS_PORT}:3001`,
  '-v', `${VOLUMES.data}:/app/data`,
  '-v', `${VOLUMES.config}:/app/.config`,
  '-v', `${VOLUMES.local}:/app/.local/share`,
  // 宿主机扩展数据目录“同路径”挂进容器：图片可以走 base64 回退，但
  // upload_group_file / upload_private_file 收的是**路径**，容器读不到就必然
  // `ENOENT ... realpath '<宿主路径>'`（PDF/视频/文件都发不出去）。
  // 只挂 extensions/data，不挂 data/（那里有 config.json、账号凭据）。
  ...sharedHostDirs().flatMap((dir) => ['-v', `${dir}:${dir}`]),
  SNOWLUMA_IMAGE
]);

/** 创建容器（不存在时）。返回 { ok, created, error }。 */
export async function createContainer(onLog = () => {}) {
  if (!(await imageExists())) {
    const pulled = await pullImage(onLog);
    if (!pulled.ok) return { ok: false, error: 'SnowLuma 镜像拉取失败（见日志）' };
  }
  const st = await containerState();
  if (st.exists) return { ok: true, created: false };
  for (const v of Object.values(VOLUMES)) {
    await runDocker(['volume', 'create', v], { timeout: 30_000 });
  }
  // 挂载源必须存在，否则 docker 会以 "invalid mount path" 拒绝创建容器
  for (const dir of sharedHostDirs()) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 交给下面的 docker 报错 */ }
  }
  onLog('创建 SnowLuma 容器…');
  const r = await runDocker(CONTAINER_ARGS(), { timeout: 180_000 });
  if (!r.ok) {
    return { ok: false, error: `创建容器失败：${r.stderr || r.error}` };
  }
  onLog('SnowLuma 容器已创建');
  return { ok: true, created: true };
}

export async function startContainer(onLog = () => {}) {
  const st = await containerState();
  if (st.running) return { ok: true, alreadyRunning: true, pid: st.pid };
  if (!st.exists) {
    const created = await createContainer(onLog);
    if (!created.ok) return created;
  }
  onLog('启动 SnowLuma 容器…');
  const r = await runDocker(['start', SNOWLUMA_CONTAINER], { timeout: 120_000 });
  if (!r.ok) return { ok: false, error: `启动失败：${r.stderr || r.error}` };
  const after = await containerState();
  return { ok: true, started: true, pid: after.pid };
}

export async function stopContainer() {
  const st = await containerState();
  if (!st.exists) return { ok: true, stopped: false, reason: 'missing' };
  if (!st.running) return { ok: true, stopped: false, reason: 'not_running' };
  const r = await runDocker(['stop', SNOWLUMA_CONTAINER], { timeout: 90_000 });
  if (!r.ok) return { ok: false, error: `停止失败：${r.stderr || r.error}` };
  return { ok: true, stopped: true };
}

export async function removeContainer() {
  const st = await containerState();
  if (!st.exists) return { ok: true, removed: false };
  const r = await runDocker(['rm', '-f', SNOWLUMA_CONTAINER], { timeout: 60_000 });
  return { ok: r.ok, removed: r.ok, error: r.ok ? undefined : (r.stderr || r.error) };
}

/** 跟随容器日志（docker logs -f）。返回子进程，调用方负责 kill。 */
export function followLogs(onLine, { tail = 120 } = {}) {
  const child = spawn(dockerBin(), ['logs', '-f', '--tail', String(tail), SNOWLUMA_CONTAINER], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  const forward = (stream) => (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (line.trim()) onLine(line, stream);
    }
  };
  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));
  return child;
}

export function webuiUrl(port = WEBUI_PORT) {
  return `http://127.0.0.1:${port}/`;
}

export function novncUrl(port = NOVNC_PORT) {
  // autoconnect + 预填密码，点开就能看到 QQ 窗口
  return `http://127.0.0.1:${port}/vnc.html?autoconnect=1&password=${encodeURIComponent(VNC_PASSWORD)}`;
}

/** 汇总状态（一次查 Docker + 容器）。 */
export async function status() {
  const docker = await isDockerAvailable();
  if (!docker) {
    return {
      dockerReady: false, imageReady: false, exists: false, running: false,
      pid: null, state: 'docker_down', container: SNOWLUMA_CONTAINER
    };
  }
  const [imageReady, st] = await Promise.all([imageExists(), containerState()]);
  return {
    dockerReady: true,
    imageReady,
    exists: st.exists,
    running: st.running,
    pid: st.pid,
    state: st.status,
    container: SNOWLUMA_CONTAINER,
    webuiUrl: webuiUrl(),
    novncUrl: novncUrl(),
    vncPassword: VNC_PASSWORD
  };
}


/** 读容器里的一个文件（docker exec）。失败返回 null。 */
export async function readContainerFile(filePath, { timeout = 15000 } = {}) {
  const r = await runDocker(['exec', SNOWLUMA_CONTAINER, 'cat', filePath], { timeout });
  if (!r.ok || !r.stdout) return null;
  return r.stdout;
}

/** 读 SnowLuma 的 OneBot 配置（含随机 accessToken）。 */
export async function readOneBotConfig() {
  const text = await readContainerFile('/app/data/config/onebot.json');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 从容器日志里取 WebUI 首次登录凭据。
 * SnowLuma 只在全新数据卷首次启动时打印一次；用户改密后这个值就失效了。
 * 返回 { user, password } 或 null。
 */
export async function readWebuiInitialCredentials() {
  const r = await runDocker([
    'logs', '--tail', '500', SNOWLUMA_CONTAINER
  ], { timeout: 20000 });
  if (!r.ok) return null;
  const text = `${r.stdout}\n${r.stderr}`;
  const all = [...text.matchAll(/initial credentials:\s*user=([^\s]+)\s+password=([^\s]+)/g)];
  if (!all.length) return null;
  const last = all[all.length - 1];
  return { user: last[1], password: last[2] };
}


/**
 * 修复 noVNC 扫码桌面。
 *
 * 容器里的 x11vnc 在第一个客户端断开后，偶发不再接受新客户端（websockify
 * 日志 "webSocketsHandshake: unknown connection error"，页面永远停在"连接中…"）。
 * 重启 x11vnc + novnc_proxy 即可恢复；每次容器重新启动后主动跑一遍。
 */
export async function repairVnc() {
  const script = [
    // ⚠️ 不能用 pkill -f novnc_proxy：当前的 sh -c 脚本命令行里也含这个字符串，
    // 会把自己杀掉（exit 143）。用锚定正则只匹配真正的代理进程。
    'pkill -x x11vnc >/dev/null 2>&1 || true',
    'pkill -f "^bash /opt/noVNC/utils/novnc_proxy" >/dev/null 2>&1 || true',
    'pkill -f "^python.*websockify" >/dev/null 2>&1 || true',
    'sleep 1',
    'setsid nohup x11vnc -display :1 -noxrecord -noxfixes -noxdamage -forever -threads -rfbauth /root/.vnc/passwd >/tmp/x11vnc.log 2>&1 </dev/null &',
    'sleep 1',
    'setsid nohup /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6081 --file-only >/var/log/novnc.log 2>&1 </dev/null &',
    'sleep 2',
    'ps aux | grep -E "[x]11vnc|[n]ovnc_proxy" | wc -l'
  ].join('\n');
  const r = await runDocker(['exec', '-u', 'root', SNOWLUMA_CONTAINER, 'sh', '-c', script], { timeout: 30000 });
  return { ok: r.ok, detail: r.stdout || r.stderr || r.error };
}

/** 运行时目录（给「打开文件夹」用：放日志/说明，不放容器数据）。 */
export function runtimeDir(root, envDir) {
  return path.join(envDir || path.join(root, 'runtime'), 'macos');
}
