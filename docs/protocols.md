# 协议端（OneBot 实现）

QQ Agent 不直接跟 QQ 服务器说话——它通过 **OneBot v11** 跟一个"协议端"程序通信：

- **正向 WebSocket**：协议端把群消息推给 QQ Agent（收事件）
- **HTTP API**：QQ Agent 调协议端把消息发出去（发消息 / 查询）

只要一个程序同时提供这两样并符合 OneBot v11 标准，就能拿来用。**不需要改代码**：在设置里选一个协议端，填好地址即可。

## 内置适配的协议端

| 协议端 | 能否由本程序启动 | 自动读令牌 | 自带控制台 | 形态 |
|---|---|---|---|---|
| **SnowLuma**（默认） | ✅ 内置日志模式 | ✅ | ✅ | 独立程序（自带 Node 运行时） |
| **NapCat** | ✅ 独立窗口 | ✅ | ✅ | 基于 QQNT 注入 |
| **Lagrange.OneBot** | ✅ 独立窗口 | ✅ | ❌ | .NET 独立进程，不依赖本机 QQ |
| **LLOneBot** | ❌ 随 QQ 启动 | ❌ | ❌ | LiteLoaderQQNT 插件 |
| **其他 / 自定义** | ❌ | ❌ | ❌ | 任何 OneBot v11 实现或网关 |

> ⚠️ 上表中的协议端**都是独立第三方项目**，各有自己的许可，不随本仓库分发。请从它们的官方渠道自行获取。

## 怎么选

| 你的情况 | 建议 |
|---|---|
| 只想快点跑起来 | **SnowLuma**（默认，日志能进内置控制台，排查最省事） |
| 想要功能全、更新快 | **NapCat** |
| 不想在本机装 QQ 客户端 | **Lagrange.OneBot** |
| 已经装了 LiteLoaderQQNT | **LLOneBot** |
| 自建网关 / 远程机器 / 别家协议端 | **其他 / 自定义** |

## 各家的接入步骤

### SnowLuma

1. 从官方渠道下载，解压到项目根目录，目录名保持 `snowluma`（也可以放别处，之后在设置里填路径）
2. 「协议端」页签点「启动」，或直接双击它自己的 `launcher.bat`
3. 用机器人 QQ 号扫码登录
4. 登录后令牌会自动从 `snowluma/config/onebot_*.json` 同步——不用手填

### NapCat

1. 下载 **NapCat.Shell**（Windows）解压到任意目录（例如项目内的 `napcat/`）
2. 在设置 →「协议端与连接」里把**协议端**选成 NapCat，填好程序目录
3. 「协议端」页签点「启动」（会弹出它自己的控制台窗口）
4. 首次启动按提示扫码登录；登录后在 NapCat 的 WebUI 里确认已开启 **HTTP 服务**与**正向 WebSocket**
5. 端口与令牌会尽量从 `config/onebot11_*.json` 自动读取；读不到就手填

默认端口：HTTP `3000` / WS `3001`（以你 NapCat WebUI 里显示的为准）。

### Lagrange.OneBot

1. 装好 .NET 运行时，下载 Lagrange.OneBot 发布包解压到任意目录
2. **先手动运行一次**生成 `appsettings.json`，在 `Implementations` 里配置 `ForwardWebSocket`：

   ```json
   {
     "Implementations": [
       { "Type": "ForwardWebSocket", "Host": "127.0.0.1", "Port": 8080, "AccessToken": "你的令牌" }
     ]
   }
   ```

3. 用机器人 QQ 号扫码登录一次
4. 在设置里把协议端选成 Lagrange，地址填 `ws://127.0.0.1:8080` 与 `http://127.0.0.1:8080`（**两者端口相同是正常的**，同一个实现端口同时提供 WS 与 HTTP）
5. 令牌会尽量从 `appsettings.json` 自动读取

> Lagrange 没有 WebUI，日志直接打在它自己的控制台里。

### LLOneBot

1. 装好 LiteLoaderQQNT，把 LLOneBot 作为插件放进插件目录
2. 在 QQ 的 LLOneBot 设置里开启「HTTP 服务」与「正向 WebSocket 服务」，记下端口
3. 在 QQ Agent 里把协议端选成 LLOneBot，把端口与**访问令牌**填进去（令牌需手动复制）
4. 因为 LLOneBot 随 QQ 一起运行，QQ Agent 不会（也无法）管理它的进程

### 其他 / 自定义

只需要填两个地址 + 令牌：

- **WebSocket 地址**：`ws://主机:端口`（收事件）
- **HTTP 地址**：`http://主机:端口`（发消息）

可选：如果对端要求 `Authorization: Bearer <token>`，填令牌即可。两者也可以配不同令牌。

## QQ Agent 帮你做了什么

| 能力 | 说明 |
|---|---|
| **目录自动探测** | 配置留空时，按适配器给的候选路径（如项目内 `snowluma/`、`napcat/`、`lagrange/`）自动找 |
| **进程管理** | 能内嵌接管日志的模式（SnowLuma + 自带 Node）会随 QQ Agent 退出；其余用独立窗口启动，不随本程序被杀 |
| **令牌自动同步** | 各家的配置文件位置与字段名不同，由适配器负责读取；**多账号时收集成候选集**，401 时自动轮换下一个，连上后钉住 |
| **WebUI 跳转** | 能识别地址的（SnowLuma `runtime.json`、NapCat `webui.json`）直接给按钮打开 |
| **端口探测** | 用 WS 端口判断"是不是已经在运行"，避免重复启动 |

## 配置结构

```jsonc
// data/config.json
{
  "onebot": {
    // 纯连接信息，与选了哪家协议端无关
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "",
    "httpAccessToken": ""
  },
  "protocol": {
    "type": "snowluma",   // snowluma | napcat | lagrange | llonebot | custom
    "dir": "",            // 协议端程序目录，留空 = 自动探测
    "autoLaunch": false    // QQ Agent 启动时自动拉起（适配器支持时）
  }
}
```

> **老配置会自动迁移**：v0.3 及更早版本把连接信息与协议端混在 `snowluma` 块里。
> 首次启动时 QQ Agent 会自动把它拆成 `onebot` + `protocol`（`type` 记为 `snowluma`），
> 迁移是幂等的，你手改过的新值不会被旧值覆盖。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/protocols` | 可选协议端列表（含能力与接入说明） |
| POST | `/api/protocol/select` | `{ id, applyDefaults? }` 切换协议端（默认按新适配器预填连接地址） |
| POST | `/api/protocol/launch` | 启动协议端 |
| POST | `/api/protocol/stop` | 关闭由本程序启动的协议端 |
| GET | `/api/protocol/logs` | 内置日志缓冲（最近 500 行） |
| POST | `/api/protocol/open-folder` | 打开程序目录 |
| POST | `/api/protocol/open-webui` | 打开它自带的控制台 |

> 旧路径 `/api/snowluma/*` 作为别名保留，行为一致。

## 自己加一个协议端

1. 在 `src/protocols/` 下新建一个文件，导出一个对象：

```js
export default {
  id: 'mybackend',
  label: '我的协议端',
  summary: '一句话说明',
  caps: { launch: false, stop: false, tokens: false, webui: false, dir: false },
  defaults: { wsUrl: 'ws://127.0.0.1:3000', httpUrl: 'http://127.0.0.1:3000' },
  setup: { note: '安装提示', steps: ['第一步', '第二步'] },
  defaultDirs(root) { return []; },       // 自动探测的项目内目录
  detect(dir) { return { ok: false, note: '' }; },
  findLaunch(dir) { return null; },        // { kind, command, args, cwd, piped }
  readTokenCandidates(dir) { return []; }, // [{ wsToken, httpToken, source, account? }]
  webuiUrl({ dir, logs }) { return ''; }
};
```

2. 在 `src/protocols/index.js` 的 `PROTOCOLS` 数组里注册它。

只需要实现用得上的方法——`caps` 声明为 `false` 的能力，管理器不会去调用，UI 也不会显示对应按钮。

## 排查

| 现象 | 检查 |
|---|---|
| 页签显示"未运行"但程序明明开着 | 端口不对：确认设置里的 WS 地址端口 = 协议端实际监听端口 |
| OneBot 一直"未连接" | ① 端口错 ② 令牌错（看日志里的 401）③ 协议端没开"正向 WebSocket"（反向/HTTP 上报不算） |
| HTTP 426 | HTTP 地址填成了 WebSocket 端口 |
| 换了账号后连不上 | 令牌变了。适配器支持会自动重新读取；不支持就手动更新令牌 |
| NapCat 点了启动没反应 | 它需要 QQ 客户端，确认 NapCat 的 QQ 路径配置正确；也可手动跑 `napcat.bat` 看报错 |
