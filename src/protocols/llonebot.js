// LLOneBot 适配器。
//
// LLOneBot 是 LiteLoaderQQNT 插件（跑在 QQ 客户端内部），
// **没有独立进程**，所以这个适配器只能"连接"、不能启动/停止；
// 它的配置存在 QQ 的 LiteLoader 数据目录里，位置随安装方式变化很大，
// 因此这里不猜测令牌文件位置 —— 令牌请从 LLOneBot 设置页复制后手填。
export default {
  id: "llonebot",
  label: "LLOneBot",
  homepage: "https://github.com/LLOneBot/LLOneBot",
  summary: "LiteLoaderQQNT 插件形态，随 QQ 客户端一起运行，无需单独启动。",
  caps: { launch: false, stop: false, tokens: false, webui: true, dir: false },

  defaults: { wsUrl: "ws://127.0.0.1:3001", httpUrl: "http://127.0.0.1:3000" },

  setup: {
    note: "独立第三方项目，不随本仓库分发。安装为 LiteLoaderQQNT 插件，跟着 QQ 一起启动，因此 QQ Agent 无法（也不需要）管理它的进程。",
    steps: [
      "先装好 LiteLoaderQQNT，再把 LLOneBot 放进插件目录",
      "在 QQ 的 LLOneBot 设置里开启「HTTP 服务」与「正向 WebSocket 服务」，记下端口",
      "把端口与访问令牌填到下面；令牌直接从上一步的设置里复制",
    ],
  },

  // 没有独立目录概念，探测不到
  defaultDirs() {
    return [];
  },

  detect() {
    return {
      ok: false,
      note: "LLOneBot 运行在 QQ 客户端内部，没有独立程序目录",
    };
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
