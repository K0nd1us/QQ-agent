# 可选 headless 运行模块

[English](README.en.md)

把 Linux/容器的启动、协议连接与控制台认证放在显式启用的运行模块中，复用 0.4 的消息存档、编排、模型、记忆、工具和界面。无需安装 Electron、Windows QQ 或内置 SnowLuma。QQ 登录由独立协议服务管理。

这不是放进 `plugins/` 或 `skills/` 后热加载的聊天扩展。监听地址、认证和协议端必须在应用启动前确定；只有受信任的启动代码能传入 `createApp({ runtime })`。普通插件的权限没有扩大。`npm start`、`npm run server`、Windows 安装脚本和默认客户端仍走原路径，`0.5(unfinished)/` 不受此模块影响。

## 入口与边界

```js
import { createHeadlessApp } from './modules/headless/index.js';
const app = createHeadlessApp();
await app.start();
// 关闭时调用 await app.stop()
```

| 文件 | 职责 |
| --- | --- |
| `index.js` | 显式装配、配置校验、连接重配与调度恢复 |
| `connection.js` | 稳定的连接引用、启用开关及传输选择 |
| `onebot.js` | OneBot 11 正向/反向 WS、WS/HTTP API、鉴权、echo 与断线清理 |
| `qqbot.js` | 可选官方 QQBot Gateway 适配器，独立于 OneBot 传输 |
| `console.js` | 令牌认证、HttpOnly 会话、SSE、Host/Origin 校验 |
| `server.js` | 独立进程入口、SIGINT/SIGTERM 及启动失败清理 |
| `Dockerfile`、`compose.yaml` | 非 root 运行、健康检查、持久化与日志轮转 |

核心只增加启动注入点：`createConnection`、`attach`、`listenOptions`、`authorize`、`originAllowed`、`handleRequest`、`status`、`validateConfig`、`configChanged`、`stop`。这些是当前 0.4 内部组合接口，不声明为跨版本稳定的插件 SDK。

## Node.js 启动

从仓库根目录进入 `0.4/`，使用 Node.js 22 或 24：

```sh
cd 0.4
npm ci --omit=dev --ignore-scripts
export QQ_AGENT_DATA_DIR=/absolute/private/data
export QQ_AGENT_TOKEN='replace-with-your-random-console-token'
npm run server:headless
```

先准备服务用户可写的私密数据目录。控制台默认监听 `127.0.0.1:3210`。打开 `/runtime/connection` 配置协议，打开 `/` 使用原控制台设置模型、白名单、人设等。首次访问先输入管理令牌，浏览器使用 HttpOnly Cookie；SSE 同样使用 Cookie，不把管理令牌放进 URL。

`QQ_AGENT_HOST`、`QQ_AGENT_PORT`、`QQ_AGENT_TOKEN`、`QQ_AGENT_ALLOWED_HOSTS` 覆盖运行选项，不写回 `config.json`。非 loopback 的访问 Host 必须列入 `QQ_AGENT_ALLOWED_HOSTS`，如 `bot.example.test:3210`；Origin/Referer 若存在还必须同源。远程访问可使用 SSH 隧道；公网反代应提供 HTTPS。

## Docker Compose

在 `0.4/` 目录执行：

```sh
umask 077
cp modules/headless/.env.example .env
# 编辑 .env，替换管理令牌；可用 openssl rand -hex 32 生成随机值
docker compose --env-file .env -f modules/headless/compose.yaml up -d --build --wait
docker compose --env-file .env -f modules/headless/compose.yaml logs -f agent
```

默认仅向宿主机 loopback 发布端口。若确需其他主机访问，同时设置发布地址与允许的 Host。`.env` 不提交到 Git。镜像默认使用 Node 22 Debian slim；`NODE_IMAGE` 构建参数可指定经过审核的镜像或固定摘要。

数据、用户插件、用户技能使用三个独立卷。镜像不包含 QQ、协议端、真实账号、API Key、聊天记录或任何私人服务配置。不能让桌面实例和容器同时读写同一份运行数据。扩展可能需要 ffmpeg 等额外依赖，此基础镜像不承诺所有第三方扩展都能直接运行。

### OneBot 连接

- 正向：协议端启动 WS 服务，填 `wsUrl`；API 可使用同一 WS 或独立 HTTP。
- 反向：QQ Agent 等待协议端连接，默认路径 `/onebot/v11/ws`；必须填写连接令牌。协议端设置 `Authorization: Bearer <协议令牌>`，并使用 Universal 角色。
- 两个 Compose 服务共用网络时，协议端连接 `ws://agent:3210/onebot/v11/ws`。分别部署的项目需要显式加入同一个 Docker 网络；容器里的 `127.0.0.1` 不代表另一个容器。
- 管理令牌与协议令牌分别设置。模块不扫描协议端的配置文件，也不启动、安装或停止外部 QQ 服务。旧版 `snowluma` 的显式凭据可以映射为正向 WS + HTTP 连接，不删除或重写旧字段；新安装默认关闭接入，需在连接页启用。

新配置独立存入 `connection`，示例只含占位值：

```json
{
  "connection": {
    "enabled": true,
    "type": "onebot",
    "onebot": {
      "mode": "reverse",
      "apiTransport": "ws",
      "reversePath": "/onebot/v11/ws",
      "accessToken": "replace-with-your-protocol-token"
    }
  }
}
```

使用核心的 `/api/config` 保存，模块在落盘前校验、保存后重连。已有运行被单独中止，随后恢复消息调度与定时器，避免“已连接、消息入库但永远不回复”。断线/超时的发送结果可能未知，不自动重发消息。

### 可选官方 QQBot

在连接页选择官方 QQBot，提供具有 Gateway 接入权限的 AppID/AppSecret。适配器包含凭据缓存、Identify/Resume、心跳和群/C2C/频道事件转换；只在收到消息后的回复窗口内发送。未实现 Webhook 接收、不保证账号具有 Gateway 权限；不支持的 OneBot 扩展会明确报错。聊天与成员标识保留 OpenID 字符串，和数字 QQ 号分开保存。测试只证明模拟协议契约，不代表真实账号联调或平台许可验收。

旧控制台的 SnowLuma/便携 QQ 进程管理接口在本模块下返回明确的 409；使用独立协议端管理页。模块不改变原有遥测、价格表、社区同步或扩展的外连行为。

## 验证与升级

```sh
npm run test:headless
docker build --target test -t qq-agent-headless-test -f modules/headless/Dockerfile .
docker run --rm --network none qq-agent-headless-test
```

测试使用合成身份、隔离临时目录、Mock OneBot 和 Mock LLM，拒绝非 loopback 的 fetch；覆盖鉴权/SSE、启用开关、OpenID 持久化、正反向 WS、API echo/错误/超时、连接重配后私聊与群聊回复、在途模型中止，以及 SIGTERM 清理。它们不登录真实 QQ、不发送真实消息、不调用付费模型。Docker 测试容器也断开外部网络。

真实上线仍要分别验证 QQ 在线、协议连接、收信、模型调用、实际发送、媒体路径和重启后的配置保留。先用独立目录/卷验收，再决定切换；不要覆盖旧 Windows 数据或把 0.4 数据直接交给 0.5。升级前保留应用版本和停止写入后的数据/扩展备份，回退时恢复匹配版本。
