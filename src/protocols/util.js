// 协议端适配器共用的小工具。
// 每个适配器都要读第三方目录里的 JSON，而第三方文件随时可能缺失/损坏/换格式，
// 所以这里全部走"读不到就返回空值"的容错风格 —— 适配器失败绝不能拖垮主进程。
import fs from "node:fs";
import path from "node:path";

/** 安全读取 JSON：文件不存在 / 不是 JSON / 编码异常一律返回 null。 */
export function readJsonSafe(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 列出目录下匹配的文件名（排序后返回）；目录不存在返回空数组。 */
export function listFiles(dir, re) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** 返回第一个存在的路径，都不存在返回空串。 */
export function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** 目录是否像某个协议端（至少有一个候选启动文件）。 */
export function hasAny(dir, names) {
  for (const n of names) {
    try {
      if (fs.existsSync(path.join(dir, n))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * 从任意"网络配置对象"里尽力提取 ws/http 令牌。
 * 各协议端字段名不同（accessToken / token），结构也不同，这里统一兜住：
 *   - 顶层 accessToken / token
 *   - networks.{wsServers,httpServers}[]（SnowLuma）
 *   - network.{websocketServers,httpServers}[]（NapCat）
 *   - Implementations[] / Implementations.0（Lagrange）
 * @returns {{wsToken:string, httpToken:string}}
 */
export function extractTokensLoose(data) {
  const pick = (obj, keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== "")
        return String(v);
    }
    return "";
  };

  const wsGroups = [
    data?.networks?.wsServers,
    data?.network?.websocketServers,
    data?.network?.wsServers,
    Array.isArray(data?.Implementations) ? data.Implementations : null,
    data?.Implementations ? Object.values(data.Implementations) : null,
  ];
  const httpGroups = [
    data?.networks?.httpServers,
    data?.network?.httpServers,
    data?.network?.httpServers_v2,
  ];

  const firstToken = (groups) => {
    for (const g of groups) {
      if (!Array.isArray(g)) continue;
      for (const item of g) {
        const t = pick(item, ["accessToken", "token", "AccessToken"]);
        if (t) return t;
      }
    }
    return "";
  };

  return {
    wsToken:
      firstToken(wsGroups) ||
      pick(data, ["accessToken", "token", "AccessToken"]),
    httpToken:
      firstToken(httpGroups) ||
      pick(data, ["accessToken", "token", "AccessToken"]),
  };
}
