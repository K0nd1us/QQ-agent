// 通用适配器：任何实现了 OneBot v11 正向 WebSocket + HTTP API 的协议端。
//
// 这是"兜底选项"——不做目录探测、不管理进程、不猜令牌，
// 只需要用户把地址和令牌填对。别的平台（自研网关、别家协议端、远程机器）都用它。
export default {
  id: "custom",
  label: "其他 / 自定义",
  homepage: "",
  summary:
    "任何兼容 OneBot v11（正向 WebSocket + HTTP API）的协议端或网关，地址令牌全部手填。",
  caps: { launch: false, stop: false, tokens: false, webui: false, dir: false },

  // 保留用户当前填写的值：切换到这个选项时不做任何预填覆盖
  defaults: null,

  setup: {
    note: "只要求对方同时提供：正向 WebSocket（收事件）与 HTTP API（发消息），且符合 OneBot v11 标准。",
    steps: [
      "在协议端里开启正向 WebSocket 与 HTTP API，两者可以同端口也可以不同",
      "把两个地址和访问令牌（如有）填到下面",
      "保存后本页「连接状态」显示已连接即接入成功",
    ],
  },

  defaultDirs() {
    return [];
  },

  detect() {
    return { ok: false, note: "自定义协议端没有程序目录，只需填写地址" };
  },

  findLaunch() {
    return null;
  },

  readTokenCandidates() {
    return [];
  },

  webuiUrl() {
    return "";
  },
};
