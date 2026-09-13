// NapCat（NapCatQQ）适配器。
//
// 与 SnowLuma 的差异：
//   - 目录里是 napcat.bat / launcher.bat / NapCatWinBootMain.exe，不是 index.mjs
//   - 无法把日志接进内置控制台（它是带自己控制台的 Windows 启动器）→ 用独立窗口启动
//   - 令牌在 config/onebot11_<QQ号>.json 的 network.httpServers / network.websocketServers 里
//   - 自带 WebUI，默认 http://127.0.0.1:6099（config/webui.json 可改）
//
// 说明：这里的字段名按 NapCat 公开的 onebot11 配置格式读取，属于"尽力而为"——
// 读不到就让用户在设置里手填令牌，绝不猜测。
import fs from "node:fs";
import path from "node:path";
import {
  readJsonSafe,
  listFiles,
  firstExisting,
  extractTokensLoose,
} from "./util.js";

const LAUNCH_FILES = [
  "napcat.bat",
  "launcher.bat",
  "NapCatWinBootMain.exe",
  "napcat.exe",
];

export default {
  id: "napcat",
  label: "NapCat",
  homepage: "https://github.com/NapNeko/NapCatQQ",
  summary:
    "目前最活跃的 QQ 协议端之一，基于 QQNT 注入。功能全、更新快，但没有内置日志窗口。",
  caps: { launch: true, stop: false, tokens: true, webui: true, dir: true },

  defaults: { wsUrl: "ws://127.0.0.1:3001", httpUrl: "http://127.0.0.1:3000" },

  setup: {
    note: "独立的第三方项目，不随本仓库分发。下载 NapCat.Shell 后解压到一个目录，把该目录填到下面即可。",
    steps: [
      "下载 NapCat.Shell（Windows）并解压到任意目录（例如项目内的 napcat/）",
      "在设置里把该目录填进来，或点「启动」由 QQ Agent 拉起",
      "首次启动按提示扫码登录；然后在 NapCat WebUI 里确认已开启 HTTP 与正向 WebSocket",
      "端口与令牌会尽量从 config/onebot11_*.json 自动同步；读不到就手填",
    ],
  },

  defaultDirs(root) {
    return [
      path.join(root, "napcat"),
      path.join(root, "NapCat.Shell"),
      path.join(root, "NapCat"),
    ];
  },

  detect(dir) {
    const hit = LAUNCH_FILES.filter((f) => {
      try {
        return fs.existsSync(path.join(dir, f));
      } catch {
        return false;
      }
    });
    const looksLikeNapcat =
      fs.existsSync(path.join(dir, "config")) || hit.length > 0;
    if (!hit.length) {
      return {
        ok: false,
        note: looksLikeNapcat
          ? "目录像 NapCat，但没找到启动文件（napcat.bat / launcher.bat）"
          : "目录里没有 NapCat 启动文件",
      };
    }
    return { ok: true, note: `发现 ${hit.join("、")}` };
  },

  findLaunch(dir) {
    // 优先 .bat：NapCat 的启动器需要先拉起 QQ，直接跑 exe 往往缺参数
    const bat = firstExisting(
      LAUNCH_FILES.filter((f) => f.endsWith(".bat")).map((f) =>
        path.join(dir, f),
      ),
    );
    if (bat) {
      return {
        kind: "bat",
        command: "cmd.exe",
        args: ["/c", bat],
        cwd: dir,
        piped: false,
      };
    }
    const exe = firstExisting(
      LAUNCH_FILES.filter((f) => f.endsWith(".exe")).map((f) =>
        path.join(dir, f),
      ),
    );
    if (exe) {
      return { kind: "exe", command: exe, args: [], cwd: dir, piped: false };
    }
    return null;
  },

  readTokenCandidates(dir) {
    const out = [];
    const cfgDir = path.join(dir, "config");
    const files = listFiles(cfgDir, /^onebot11(_\d+)?\.json$/);
    for (const f of files) {
      const data = readJsonSafe(path.join(cfgDir, f));
      if (!data) continue;
      const t = extractTokensLoose(data);
      const uin = /^onebot11_(\d+)\.json$/.exec(f)?.[1] || "";
      out.push({ ...t, account: uin, source: path.join("config", f) });
    }
    return out;
  },

  webuiUrl({ dir }) {
    const webui = readJsonSafe(path.join(dir, "config", "webui.json"));
    if (webui) {
      // 监听 0.0.0.0 时对本机浏览器来说就是 127.0.0.1
      const raw = String(webui.host || "127.0.0.1");
      const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
      const port = Number(webui.port) || 6099;
      return `http://${host}:${port}/webui`;
    }
    return "http://127.0.0.1:6099/webui";
  },
};
