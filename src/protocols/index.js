// 协议端注册表。
//
// 一个"协议端"= 提供 OneBot v11（正向 WebSocket 收事件 + HTTP API 发消息）的第三方程序。
// 本项目只跟标准协议打交道，各家的差异（目录结构、启动方式、令牌存在哪、有没有 WebUI）
// 全部收敛到适配器里，业务代码只认 adapter 的这几个方法：
//
//   id / label / homepage / summary      —— 展示用
//   caps                                 —— 能力声明，UI 据此决定显示哪些按钮
//   defaults                             —— 切换时预填的 WS/HTTP 地址（null = 不覆盖用户已填的值）
//   setup                                —— 安装引导文案
//   defaultDirs(root)                    —— 自动探测的项目内目录候选
//   detect(dir)                          —— 判断目录是否属于该协议端
//   findLaunch(dir)                      —— 怎么把它拉起来（null = 不支持启动）
//   readTokenCandidates(dir)             —— 尽力读出令牌候选（[] = 读不到，让用户手填）
//   webuiUrl({dir, logs})                —— 它自带控制台的地址（'' = 没有）
//
// 加新协议端：在 src/protocols/ 下加一个文件，实现上面需要的几个方法，然后在下面注册。
import snowluma from "./snowluma.js";
import napcat from "./napcat.js";
import lagrange from "./lagrange.js";
import llonebot from "./llonebot.js";
import custom from "./custom.js";

/** 顺序即设置页下拉框里的展示顺序；第一个是默认值。 */
export const PROTOCOLS = [snowluma, napcat, lagrange, llonebot, custom];

export const DEFAULT_PROTOCOL_ID = snowluma.id;

/** 按 id 取适配器；id 未知（用户手改坏了）时回退到 custom —— 它不做任何目录/进程假设，最安全。 */
export function getProtocol(id) {
  const key = String(id || "").trim();
  return PROTOCOLS.find((p) => p.id === key) || custom;
}

/** 给前端用的纯数据视图（不含函数，可直接 JSON 序列化）。 */
export function protocolList() {
  return PROTOCOLS.map((p) => ({
    id: p.id,
    label: p.label,
    homepage: p.homepage,
    summary: p.summary,
    caps: p.caps,
    defaults: p.defaults,
    setup: p.setup,
  }));
}

/** 切换协议端时要写进配置的默认连接地址；defaults 为 null 时返回 null（不改动）。 */
export function defaultsFor(id) {
  const p = getProtocol(id);
  return p.defaults
    ? { wsUrl: p.defaults.wsUrl, httpUrl: p.defaults.httpUrl }
    : null;
}
