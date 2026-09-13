// Lagrange.OneBot 适配器。
//
// 特点：
//   - .NET 单体进程，Windows 下是 Lagrange.OneBot.exe，跨平台可用 dotnet Lagrange.OneBot.dll
//   - 配置文件 appsettings.json 里 "Implementations" 声明监听方式（ForwardWebSocket / Http 等），
//     同一个端口既可以是 WS 也可以是 HTTP —— 所以下面的默认值只是"起点"，务必按自己配置核对
//   - 没有 WebUI，也没有内置日志转发（它的日志直接打在自己的控制台里）
//
// 说明：appsettings.json 的字段名按 Lagrange 公开格式读取（AccessToken / Port / Host），
// 属于"尽力而为"；读不到就让用户手填令牌。
import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, firstExisting, extractTokensLoose } from "./util.js";

/** Lagrange 默认实现端口（ForwardWebSocket/Http 都用它），不同版本可能不同。 */
const DEFAULT_PORT = 8080;

export default {
  id: "lagrange",
  label: "Lagrange.OneBot",
  homepage: "https://github.com/LagrangeDev/Lagrange.Core",
  summary:
    "纯协议实现、不依赖本机 QQ 客户端，资源占用低。需要 .NET 运行时，无 WebUI。",
  caps: { launch: true, stop: false, tokens: true, webui: false, dir: true },

  defaults: {
    wsUrl: `ws://127.0.0.1:${DEFAULT_PORT}`,
    httpUrl: `http://127.0.0.1:${DEFAULT_PORT}`,
  },

  setup: {
    note: "独立第三方项目，不随本仓库分发。需要 .NET 运行时；首次运行会在目录里生成 appsettings.json。",
    steps: [
      "下载 Lagrange.OneBot 发布包，解压到任意目录（例如项目内的 lagrange/）",
      "先手动运行一次生成 appsettings.json，在 Implementations 里配置 ForwardWebSocket（含 Port / AccessToken）",
      "在下面填好 WS/HTTP 地址与令牌；端口两者相同是正常的",
    ],
  },

  defaultDirs(root) {
    return [
      path.join(root, "lagrange"),
      path.join(root, "Lagrange.OneBot"),
      path.join(root, "Lagrange"),
    ];
  },

  detect(dir) {
    const files = [
      "Lagrange.OneBot.exe",
      "Lagrange.OneBot",
      "Lagrange.OneBot.dll",
      "appsettings.json",
    ];
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
        note: "目录里没有 Lagrange.OneBot.exe / appsettings.json",
      };
    return { ok: true, note: `发现 ${hit.join("、")}` };
  },

  findLaunch(dir) {
    const exe = firstExisting([
      path.join(dir, "Lagrange.OneBot.exe"),
      path.join(dir, "Lagrange.OneBot"),
    ]);
    if (exe)
      return { kind: "exe", command: exe, args: [], cwd: dir, piped: false };
    // 源码/框架依赖发布：用 dotnet 跑 dll
    const dll = firstExisting([path.join(dir, "Lagrange.OneBot.dll")]);
    if (dll)
      return {
        kind: "exe",
        command: "dotnet",
        args: [dll],
        cwd: dir,
        piped: false,
      };
    return null;
  },

  readTokenCandidates(dir) {
    const out = [];
    const data = readJsonSafe(path.join(dir, "appsettings.json"));
    if (!data) return out;
    const t = extractTokensLoose(data);
    // Lagrange 把实现配置放在 Implementations（数组或 {"0":{...}} 两种历史形态都见过）
    const impls = Array.isArray(data.Implementations)
      ? data.Implementations
      : data.Implementations && typeof data.Implementations === "object"
        ? Object.values(data.Implementations)
        : [];
    const ports = impls
      .map((i) => Number(i?.Port))
      .filter((n) => Number.isFinite(n) && n > 0);
    out.push({ ...t, port: ports[0] || null, source: "appsettings.json" });
    return out;
  },

  /** Lagrange 没有 WebUI。返回空串，管理页会自动隐藏「打开控制台」。 */
  webuiUrl() {
    return "";
  },
};
