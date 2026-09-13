// 协议端进程管理：所有跟"第三方协议端程序"打交道的事都收在这里。
//
// 业务代码（app.js / orchestrator / sender）只跟 OneBotClient 说话，
// 不关心对面是 SnowLuma 还是 NapCat；需要管理第三方进程时来找这个管理器，
// 由它按当前选中的适配器决定目录、启动方式、令牌来源、WebUI 地址。
//
// 设计原则：
//   - 适配器说"不支持"就不做，绝不猜测（比如 LLOneBot 没有独立进程，就不给启动按钮）
//   - 任何一步失败都只影响这一步：探测不到目录不影响连接已配置好的地址
//   - 日志环形缓冲留在内存里，UI 拉取即可，不写磁盘（第三方日志可能很大）
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getProtocol, protocolList } from "./protocols/index.js";
import { getConfig } from "./config.js";

const LOG_LIMIT = 500;

/** 端口是否已被监听（用来判断协议端是不是已经在跑）。 */
export function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/** 等端口就绪（启动协议端后轮询）。返回是否在超时前就绪。 */
export async function waitForPort(
  host,
  port,
  timeoutMs = 20000,
  stepMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(host, port)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

export class ProtocolManager {
  /** @param {{root:string, log?:Function, emit?:Function}} opts */
  constructor({ root, log = console.log, emit = () => {} } = {}) {
    this.root = root;
    this.log = log;
    this.emit = emit;
    this.logs = [];
    this.proc = null;
    this.stopping = false;
  }

  /** 当前选中的适配器。 */
  get adapter() {
    return getProtocol(getConfig().protocol?.type);
  }

  get id() {
    return this.adapter.id;
  }

  get label() {
    return this.adapter.label;
  }

  /** 协议端程序目录：配置值优先；留空则按适配器给的候选路径探测。 */
  dir() {
    const configured = String(getConfig().protocol?.dir || "").trim();
    if (configured) return configured;
    for (const candidate of this.adapter.defaultDirs(this.root) || []) {
      try {
        if (candidate && fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
    return "";
  }

  /** 从配置的 WS 地址里取端口（用于判断"已在运行"）。 */
  wsPort() {
    try {
      const wsUrl = String(getConfig().onebot?.wsUrl || "ws://127.0.0.1:3001");
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch {
      /* ignore */
    }
    return 3001;
  }

  /** 它自带的控制台地址（没有就返回空串）。 */
  webuiUrl() {
    if (!this.adapter.caps.webui) return "";
    try {
      return this.adapter.webuiUrl({ dir: this.dir(), logs: this.logs }) || "";
    } catch {
      return "";
    }
  }

  pushLog(text, stream = "stdout") {
    const line = {
      at: Date.now(),
      stream,
      text: String(text ?? "").replace(/\r?\n$/, ""),
    };
    if (!line.text) return;
    this.logs.push(line);
    if (this.logs.length > LOG_LIMIT)
      this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.emit("protocol-log", line);
    this.emit("snowluma-log", line); // 兼容旧事件名
  }

  /** 目录探测结果（给设置页显示"这个目录对不对"）。 */
  inspect() {
    const adapter = this.adapter;
    const dir = this.dir();
    const configured = String(getConfig().protocol?.dir || "").trim();
    if (!adapter.caps.dir) {
      return {
        dir: "",
        configured: "",
        exists: false,
        ok: false,
        auto: false,
        note: adapter.setup?.note || "",
      };
    }
    if (!dir) {
      return {
        dir: "",
        configured,
        exists: false,
        ok: false,
        auto: false,
        note: "没有找到程序目录",
      };
    }
    let exists = false;
    try {
      exists = fs.existsSync(dir);
    } catch {
      /* ignore */
    }
    if (!exists) {
      return {
        dir,
        configured,
        exists: false,
        ok: false,
        auto: !configured,
        note: "目录不存在",
      };
    }
    let detect = { ok: false, note: "" };
    try {
      detect = adapter.detect(dir) || detect;
    } catch (error) {
      detect = { ok: false, note: String(error?.message ?? error) };
    }
    return {
      dir,
      configured,
      exists: true,
      ok: !!detect.ok,
      auto: !configured,
      note: detect.note || "",
    };
  }

  /** 运行状态汇总（含展示用的适配器信息）。 */
  async status() {
    const adapter = this.adapter;
    const dir = this.dir();
    const wsPort = this.wsPort();
    const running = await isPortOpen("127.0.0.1", wsPort);
    return {
      id: adapter.id,
      label: adapter.label,
      homepage: adapter.homepage,
      caps: adapter.caps,
      dir,
      dirInfo: this.inspect(),
      wsPort,
      running,
      embedded: !!this.proc,
      pid: this.proc?.pid ?? null,
      webuiUrl: this.webuiUrl(),
      launchable: !!adapter.caps.launch,
      lowLevel: this.logs.slice(-200),
    };
  }

  /** 拉起协议端。返回 { ok, error?, alreadyRunning?, launched?, embedded?, pid? }。 */
  async launch() {
    const adapter = this.adapter;
    if (!adapter.caps.launch || !adapter.findLaunch) {
      return {
        ok: false,
        error: `${adapter.label} 不支持由 QQ Agent 启动，请手动启动后连接`,
      };
    }
    const dir = this.dir();
    if (!dir) {
      return {
        ok: false,
        error: `找不到 ${adapter.label} 目录：请确认已下载解压，或在设置里填写程序目录`,
      };
    }
    const check = this.inspect();
    if (!check.exists) return { ok: false, error: `目录不存在：${dir}` };

    const wsPort = this.wsPort();
    if (await isPortOpen("127.0.0.1", wsPort)) {
      this.pushLog(
        `${adapter.label} 已在运行（端口 ${wsPort} 已就绪），无需重复启动`,
      );
      return { ok: true, alreadyRunning: true };
    }

    let plan = null;
    try {
      plan = adapter.findLaunch(dir);
    } catch (error) {
      plan = null;
      this.pushLog(`解析启动方式失败：${error?.message ?? error}`, "stderr");
    }
    if (!plan) {
      return { ok: false, error: `目录里没有找到可用的启动文件：${dir}` };
    }

    try {
      const child = spawn(plan.command, plan.args || [], {
        cwd: plan.cwd || dir,
        stdio: plan.piped ? ["ignore", "pipe", "pipe"] : "ignore",
        windowsHide: !!plan.piped,
        // piped 模式让协议端随 QQ Agent 一起退出（能接管日志）；
        // 非 piped 模式给它自己的控制台窗口，detached 保证不被父进程拖走。
        detached: !plan.piped,
      });
      if (plan.piped) {
        this.proc = child;
        child.unref();
        this.pushLog(`${adapter.label} 启动中（内置模式，pid=${child.pid}）…`);
        child.stdout?.on("data", (d) => {
          for (const line of String(d).split(/\r?\n/))
            if (line.trim()) this.pushLog(line, "stdout");
        });
        child.stderr?.on("data", (d) => {
          for (const line of String(d).split(/\r?\n/))
            if (line.trim()) this.pushLog(line, "stderr");
        });
        child.on("exit", (code, signal) => {
          this.proc = null;
          this.pushLog(
            `${adapter.label} 进程已退出（code=${code ?? ""} signal=${signal ?? ""}）`,
            "stderr",
          );
          this.#emitStatus(false);
        });
        child.on("error", (error) => {
          this.pushLog(
            `${adapter.label} 启动失败：${error?.message ?? error}`,
            "stderr",
          );
        });
        this.#emitStatus(true, child.pid);
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      }
      // 独立窗口模式：拿不到日志，也无法精确停止
      child.unref();
      this.pushLog(
        `${adapter.label} 已用独立窗口启动（此模式下日志不进内置控制台）`,
      );
      return { ok: true, launched: true, embedded: false };
    } catch (error) {
      this.proc = null;
      this.pushLog(
        `${adapter.label} 启动失败：${error?.message ?? error}`,
        "stderr",
      );
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 关闭由本管理器启动的协议端进程。返回是否真的执行了关闭。 */
  stop() {
    const adapter = this.adapter;
    if (!adapter.caps.launch) {
      return { ok: false, error: `${adapter.label} 不支持由 QQ Agent 关闭` };
    }
    const proc = this.proc;
    if (!proc)
      return { ok: false, error: "当前没有由 QQ Agent 启动的协议端进程" };
    this.stopping = true;
    try {
      proc.kill();
      this.pushLog(`已请求关闭 ${adapter.label}。`);
      return { ok: true, stopped: true };
    } catch (error) {
      this.pushLog(
        `关闭 ${adapter.label} 失败：${error?.message ?? error}`,
        "stderr",
      );
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      this.stopping = false;
    }
  }

  /**
   * 收集令牌候选（按适配器能力）。返回 [{ wsToken, httpToken, source, account? }]。
   * 读不到就返回空数组 —— 调用方应保留用户手填的令牌。
   */
  tokenCandidates() {
    const adapter = this.adapter;
    if (!adapter.caps.tokens || !adapter.readTokenCandidates) return [];
    try {
      const dir = this.dir();
      if (!dir) return [];
      const list = adapter.readTokenCandidates(dir) || [];
      return list.filter((c) => c && typeof c === "object");
    } catch (error) {
      this.log(
        `[protocol] 读取 ${adapter.label} 令牌失败:`,
        error?.message ?? error,
      );
      return [];
    }
  }

  #emitStatus(running, pid = null) {
    const payload = { running, embedded: !!running, pid };
    this.emit("protocol-status", payload);
    this.emit("snowluma-status", payload); // 兼容旧事件名
  }

  /** 给前端用的适配器列表（含运行时选中项）。 */
  describe() {
    return {
      current: this.adapter.id,
      list: protocolList(),
    };
  }

  /** 应用退出时清理：只关我们自己拉起来的进程。 */
  close() {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}
