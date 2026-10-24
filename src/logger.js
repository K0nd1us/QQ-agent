// 详尽日志系统：分级 + 落盘 + 内存环形缓冲（供 UI 查看）。
//
// 设计目标：
//   - 分级：debug / info / warn / error，可配置最低落盘级别
//   - 落盘：data/logs/qq-agent-YYYY-MM-DD.log，按天滚动，自动清理旧文件
//   - 内存缓冲：最近 N 条留在内存，UI「日志」页签实时查看（SSE 推送）
//   - 不丢 console：所有日志同时仍走原 console（开发期习惯不变）
//
// 用法：
//   import { logger } from './logger.js';
//   logger.info('模块', '消息', 可选额外对象);
//   logger.setLevel('debug');
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_MEMORY = 500;          // 内存里保留最近多少条（UI 查看）
const KEEP_DAYS = 7;             // 日志文件保留天数

function logsDir() {
  return path.join(DATA_DIR, 'logs');
}

function todayFile() {
  const d = new Date();
  const name = `qq-agent-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  return path.join(logsDir(), name);
}

class Logger {
  constructor() {
    this.level = LEVELS.info;         // 默认 info 及以上落盘
    this.memory = [];                 // 环形缓冲 [{ts, level, module, text}]
    this.listeners = new Set();       // onLog 监听（SSE 推送）
    this.mirrorConsole = true;        // 是否同时走 console
    this.writing = false;             // 重入标记：监听器若再打日志，直接丢弃（防递归爆炸）
    this.pendingDisk = '';
    this.flushTimer = null;
    this.flushInFlight = false;
    this.flushAgain = false;
    this.diskBatchBytes = 0;
  }

  setLevel(level) {
    if (LEVELS[level] != null) this.level = LEVELS[level];
  }

  getLevel() {
    return Object.keys(LEVELS).find((k) => LEVELS[k] === this.level) || 'info';
  }

  /** 订阅新日志（返回退订函数）。 */
  onLog(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 内存里最近的日志（UI 首次加载用）。 */
  recent(limit = 200) {
    return this.memory.slice(-Math.max(1, Number(limit) || 200));
  }

  #write(level, module, args) {
    /* 重入防护：onLog 监听器里如果再调 logger.*（例如把日志转发回 logger），
       会形成 #write → 监听器 → #write 的无限递归，每条递归都给文本包一层
       模块前缀 —— 曾经一次事故把单日日志写到 15GB（97.7% 都是重复前缀）。
       重入的调用直接丢弃：外层那条日志已经包含了全部信息。 */
    if (this.writing) return;
    this.writing = true;
    try {
      this.#writeInner(level, module, args);
    } finally {
      this.writing = false;
    }
  }

  #writeInner(level, module, args) {
    const lv = LEVELS[level] ?? LEVELS.info;
    const text = args.map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
    const entry = { ts: Date.now(), level, module: String(module || 'app'), text };

    // 内存环形缓冲（UI 查看 + SSE 推送）
    this.memory.push(entry);
    if (this.memory.length > MAX_MEMORY) this.memory.splice(0, this.memory.length - MAX_MEMORY);
    for (const fn of [...this.listeners]) {
      try { fn(entry); } catch { /* ignore */ }
    }

    // console 镜像（开发期）
    if (this.mirrorConsole) {
      const line = `[${entry.module}] ${text}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }

    // 落盘（达到最低级别才写）。先进入小批量缓冲，避免高频日志逐条同步 I/O
    // 阻塞事件循环；定时器使用 unref，退出时无需等待刷新。
    if (lv >= this.level) {
      const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false });
      const line = `${time} [${level.toUpperCase().padEnd(5)}] [${entry.module}] ${text}\n`;
      const capped = line.length > 64 * 1024 ? line.slice(0, 64 * 1024) + '…（过长已截断）\n' : line;
      this.pendingDisk += capped;
      this.diskBatchBytes += capped.length;
      if (this.diskBatchBytes >= 64 * 1024) this.#scheduleFlush(0);
      else this.#scheduleFlush(100);
    }
  }

  #scheduleFlush(delay = 100) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.#flushDisk();
    }, delay);
    this.flushTimer.unref?.();
  }

  #flushDisk() {
    if (this.flushInFlight) { this.flushAgain = true; return; }
    if (!this.pendingDisk) return;
    const payload = this.pendingDisk;
    this.pendingDisk = '';
    this.diskBatchBytes = 0;
    this.flushInFlight = true;
    try {
      fs.mkdirSync(logsDir(), { recursive: true });
      fs.appendFileSync(todayFile(), payload, 'utf8');
    } catch { /* 写盘失败不影响运行 */ }
    this.flushInFlight = false;
    if (this.flushAgain || this.pendingDisk) {
      this.flushAgain = false;
      this.#scheduleFlush(100);
    }
  }

  flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.#flushDisk();
  }

  debug(module, ...args) { this.#write('debug', module, args); }
  info(module, ...args) { this.#write('info', module, args); }
  warn(module, ...args) { this.#write('warn', module, args); }
  error(module, ...args) { this.#write('error', module, args); }

  /** 清理超过 KEEP_DAYS 的旧日志文件；同时给单个日志文件设上限（防爆盘）。 */
  prune() {
    try {
      const dir = logsDir();
      if (!fs.existsSync(dir)) return;
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.log')) continue;
        try {
          const fp = path.join(dir, f);
          const st = fs.statSync(fp);
          if (st.mtimeMs < cutoff) { fs.unlinkSync(fp); continue; }
          /* 单文件超过 256MB 即视为异常（正常一天 < 10MB）：
             截断保留尾部最近的内容，并留一行说明。
             曾经递归事故把单文件写到 15GB，97.7% 是重复前缀。 */
          if (st.size > 256 * 1024 * 1024) {
            const keep = 16 * 1024 * 1024;
            const fd = fs.openSync(fp, 'r');
            const buf = Buffer.alloc(keep);
            fs.readSync(fd, buf, 0, keep, st.size - keep);
            fs.closeSync(fd);
            const head = `（日志异常膨胀，已截断：原 ${(st.size / 1024 / 1024 / 1024).toFixed(2)}GB，保留尾部 16MB）\n`;
            fs.writeFileSync(fp, head + buf.toString('utf8'), 'utf8');
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

export const logger = new Logger();
