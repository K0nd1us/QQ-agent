// 跨平台小工具：打开文件夹/网址、按命令行查进程、结束进程。
//
// 原实现把这些动作直接写死成 explorer.exe / cmd.exe / PowerShell / wmic，
// macOS 上不是报错就是"静默无反应"（spawn 一个不存在的命令）。集中到这里以后，
// 平台差异只有一份，UI 与路由层不必再判断 process.platform。
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const isMac = process.platform === 'darwin';
export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';
export const platformLabel = isMac ? 'macOS' : (isWin ? 'Windows' : 'Linux');

function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/** 在系统文件管理器里打开一个路径。 */
export function openPath(target) {
  const p = String(target || '');
  if (!p) throw new Error('路径为空');
  if (isMac) return spawnDetached('open', [p]);
  if (isWin) return spawnDetached('explorer.exe', [p]);
  return spawnDetached('xdg-open', [p]);
}

/** 用系统默认浏览器打开网址。 */
export function openUrl(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) throw new Error(`只允许打开 http(s) 网址：${u}`);
  if (isMac) return spawnDetached('open', [u]);
  if (isWin) return spawnDetached('cmd.exe', ['/c', 'start', '', u]);
  return spawnDetached('xdg-open', [u]);
}

/**
 * 列出命令行里包含 needle 的进程。返回 [{ pid, command }]。
 *
 * Windows 走 PowerShell Get-CimInstance（wmic 在 Win11 24H2 已移除，且 ANSI
 * 代码页会弄乱中文路径）；macOS/Linux 走 ps。匹配只做子串包含，调用方自己
 * 用绝对路径收窄范围，**绝不按进程名乱杀**。
 */
export async function listProcessesByCommand(needle) {
  const target = String(needle || '');
  if (!target) return [];
  if (isWin) {
    const ps = [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
        + 'Get-CimInstance Win32_Process | '
        + 'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
    ].join(' ');
    try {
      const { stdout } = await execFileAsync('powershell', ps.split(' '), {
        timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024
      });
      const txt = String(stdout).trim();
      if (!txt) return [];
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      return arr
        .map((p) => ({ pid: Number(p.ProcessId), command: String(p.CommandLine ?? '') }))
        .filter((p) => p.pid > 0 && p.command.includes(target));
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
      timeout: 15000, maxBuffer: 8 * 1024 * 1024
    });
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), command: m[2] }))
      .filter((p) => p.pid > 0 && p.command.includes(target));
  } catch {
    return [];
  }
}

/** 判断 pid 是否还活着（signal 0 只探测，不发信号）。 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 先礼后兵地结束一个进程：SIGTERM → 等待 → SIGKILL。
 * 返回 { stopped, forced }。进程本来就不在时返回 { stopped: false, missing: true }。
 */
export async function terminatePid(pid, { graceMs = 6000, pollMs = 250 } = {}) {
  const n = Number(pid);
  if (!isPidAlive(n)) return { stopped: false, missing: true };
  try { process.kill(n, 'SIGTERM'); } catch { /* 已退出 */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(n)) return { stopped: true, forced: false };
    await sleep(pollMs);
  }
  try { process.kill(n, 'SIGKILL'); } catch { /* 已退出 */ }
  for (let i = 0; i < 8; i++) {
    if (!isPidAlive(n)) return { stopped: true, forced: true };
    await sleep(pollMs);
  }
  return { stopped: false, forced: true, error: `进程 ${n} 未能结束` };
}
