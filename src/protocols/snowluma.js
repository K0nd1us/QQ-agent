// SnowLuma 适配器（默认协议端）。
//
// 这是本项目原本唯一支持的协议端，行为与改造前完全一致：
//   - 目录：配置值 → 项目内 ./snowluma/ → 安装版解包目录
//   - 启动：优先 node.exe index.mjs（日志进内置控制台），回退 launcher.bat 独立窗口
//   - 令牌：config/onebot_<uin>.json 里 networks.httpServers/wsServers 的 accessToken，
//           每个登录过的账号一份且永久保留 —— 所以收集成"候选集"，401 时轮换
//   - WebUI：config/runtime.json 的 webuiHost/webuiPort/webuiTls，读不到就从日志里捞
import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, listFiles, firstExisting } from "./util.js";

/** 从单个 SnowLuma 配置对象里提取 ws/http 令牌。 */
function extractTokens(data) {
  const pick = (list, port, name) =>
    (list || []).find((s) => s?.port === port || s?.name === name) ||
    (list || [])[0];
  const http = pick(data?.networks?.httpServers, 3000, "http-default");
  const ws = pick(data?.networks?.wsServers, 3001, "ws-default");
  return {
    wsToken: String(ws?.accessToken ?? ""),
    httpToken: String(http?.accessToken ?? ""),
  };
}

export default {
  id: "snowluma",
  label: "SnowLuma",
  homepage: "https://github.com/SnowLuma/SnowLuma",
  summary:
    "开箱即用的 OneBot v11 协议端，项目默认搭配。支持内置启动与日志查看。",
  caps: { launch: true, stop: true, tokens: true, webui: true, dir: true },

  // 常见默认端口（以协议端自身配置为准，这里只是切换时预填的起点）
  defaults: { wsUrl: "ws://127.0.0.1:3001", httpUrl: "http://127.0.0.1:3000" },

  setup: {
    note: "不随本仓库分发（自带 EULA）。从其官方渠道获取后解压到项目根目录，目录名保持 snowluma。",
    steps: [
      "下载 SnowLuma 并解压到项目根目录，目录名保持 snowluma",
      "本页点「启动」或双击其 launcher.bat，用机器人 QQ 号扫码登录",
      "登录后令牌会从 snowluma/config/onebot_*.json 自动同步，无需手填",
    ],
  },

  defaultDirs(root) {
    const bundled = path.join(root, "snowluma");
    return [
      bundled,
      // 安装版：asar 里的文件不可执行，electron-builder 会把它解包到这里
      bundled.replace("app.asar", "app.asar.unpacked"),
    ];
  },

  detect(dir) {
    const files = ["index.mjs", "node.exe", "launcher.bat"];
    const hit = files.filter((f) => {
      try {
        return fs.existsSync(path.join(dir, f));
      } catch {
        return false;
      }
    });
    if (!hit.length)
      return {
        ok: false,
        note: "目录里没有 index.mjs / node.exe / launcher.bat",
      };
    return { ok: true, note: `发现 ${hit.join("、")}` };
  },

  findLaunch(dir) {
    const indexMjs = path.join(dir, "index.mjs");
    const nodeExe = path.join(dir, "node.exe");
    // 内置模式：自带 node.exe 直接跑 index.mjs，stdout/stderr 能进内置控制台
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      return {
        kind: "node",
        command: nodeExe,
        args: [indexMjs],
        cwd: dir,
        piped: true,
      };
    }
    const launcher = firstExisting([path.join(dir, "launcher.bat")]);
    if (launcher) {
      // 回退：独立控制台窗口（此模式下日志不进内置控制台）
      return {
        kind: "bat",
        command: "cmd.exe",
        args: ["/c", launcher],
        cwd: dir,
        piped: false,
      };
    }
    return null;
  },

  readTokenCandidates(dir) {
    const out = [];
    const cfgDir = path.join(dir, "config");
    // onebot_0.json 是空令牌模板，单独兜底；per-uin 文件才是真令牌
    const files = listFiles(cfgDir, /^onebot_\d+\.json$/).filter(
      (f) => f !== "onebot_0.json",
    );
    for (const f of files) {
      const data = readJsonSafe(path.join(cfgDir, f));
      if (!data) continue;
      out.push({ ...extractTokens(data), source: path.join("config", f) });
    }
    // 空令牌兜底：SnowLuma 允许无 token 连接
    out.push({ wsToken: "", httpToken: "", source: "（无令牌）" });
    return out;
  },

  webuiUrl({ dir, logs = [] }) {
    const rtPath = path.join(dir, "config", "runtime.json");
    const rt = readJsonSafe(rtPath);
    if (rt) {
      const host = String(rt.webuiHost || "127.0.0.1");
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? "https" : "http"}://${host}:${port}/`;
    }
    // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
    for (const line of [...logs].reverse()) {
      const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || "");
      if (m) return m[1];
    }
    return "";
  },
};
