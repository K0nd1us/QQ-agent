# QQ Agent 在 macOS 上运行

SnowLuma 官方 Release 只有 **Windows / Linux** 产物（它依赖 QQ NT 客户端），没有
macOS 原生包。本适配用 SnowLuma 官方
[`SnowLuma.Docker.Framework`](https://github.com/SnowLuma/SnowLuma.Docker.Framework)
的 Linux/arm64 镜像，在 Docker Desktop 里运行 **Linux QQ + Xvfb + noVNC + SnowLuma**：

```
┌──────────────────────── macOS ────────────────────────┐
│  QQ Agent（Electron 桌面壳 / 控制台）                  │
│        │ OneBot v11（WS 3001 / HTTP 3000）             │
│        ▼                                               │
│  Docker Desktop（linux/arm64）                         │
│   └─ qq-agent-snowluma 容器                            │
│        ├─ SnowLuma（OneBot 网关 + WebUI :5099）        │
│        ├─ Linux QQ（登录态在数据卷里）                 │
│        └─ Xvfb + x11vnc + noVNC（:6081，浏览器扫码）   │
└────────────────────────────────────────────────────────┘
```

所有端口只绑定 `127.0.0.1`，不对局域网暴露。

## 一、安装

前置：macOS 12+（Apple Silicon 或 Intel）、Node.js 20+、Docker Desktop。

```bash
cd qq-agent
npm install
npm run setup:macos     # 启动 Docker → 拉 SnowLuma 镜像（约 730MB）→ 建容器
npm start               # 或双击 scripts/start-macos.command
```

`npm run setup:macos` 做了什么：

1. Docker Desktop 没运行会自动 `open -a Docker` 并等待就绪；
2. 拉取 `motricseven7/snowluma:latest`（Docker Hub 不通时依次尝试
   `docker.1ms.run` / `docker.m.daocloud.io` / `hub.rat.dev` 等镜像站，拉到后打回原名）；
3. 创建容器 `qq-agent-snowluma`，映射
   `6081`(noVNC) / `5099`(WebUI) / `3000`(OneBot HTTP) / `3001`(OneBot WS)；
4. 打印 WebUI 初始登录密码。

常用命令：

```bash
npm run check:macos        # 只检查 Docker / 镜像 / 容器状态
npm run setup:macos -- --force   # 重拉镜像并重建容器（数据卷保留）
npm run uninstall:macos    # 删容器，保留登录态
npm run uninstall:macos -- --purge   # 连数据卷一起删（登录态丢失）
npm run build:mac          # 打 dmg 安装包（dist/）
```

## 二、首次登录（一次性）

1. 打开 QQ Agent → **SnowLuma** 页签；
2. 点「打开 WebUI」（`http://127.0.0.1:5099/`），输入页面上显示的**初始密码**；
3. 首次进入会要求：同意 EULA → 设置新访问密码（**EULA 需要你本人确认**）；
4. 回到 SnowLuma 页签 →「打开扫码桌面」（noVNC，密码 `qqagent`）；
   容器里的 QQ 登录窗口会显示二维码，用手机 QQ 扫码；
5. 登录成功后 SnowLuma 自动接入 OneBot，`3001` 开始监听，控制台顶部的
   「OneBot 已连接」会亮起。

> 提示：二维码有有效期。过期后在 noVNC 里点「刷新」重新生成。
> 如果 noVNC 一直停在「连接中…」，点页面上的「连不上？修复」重启 VNC 服务。

## 三、OneBot 令牌（自动处理）

SnowLuma 首次启动会为 WS/HTTP 生成随机 `accessToken`。适配层会：

1. 从容器读取 `/app/data/config/onebot.json`；
2. 镜像到 `runtime/macos/config/onebot_1.json`；
3. 复用项目原有的「令牌候选 + 401 自动轮换」逻辑，自动换成正确令牌。

一般不需要手填。若想手动指定，在设置页 OneBot 里填 WS/HTTP 令牌即可。

## 四、与 Windows 版的差异

| 能力 | Windows | macOS |
| --- | --- | --- |
| 协议端 | SnowLuma 原生 + 便携 QQ | SnowLuma 官方 Docker 镜像 |
| QQ 登录 | 便携 QQ 窗口扫码 | noVNC 里的 Linux QQ 扫码 |
| 便携 QQ 行 | 每个 run 自带 QQ | 容器内 Linux QQ（无需装 QQ.app） |
| 数据目录 | `data/` | `data/`（安装版：`~/Library/Application Support/QQ Agent/data`） |
| 协议端数据 | `snowluma/` | Docker 具名卷 `qq-agent-snowluma-*` |
| 开机自启 | 支持 | 仅安装版 `.app` 支持（开发模式跳过） |

`runtime/macos/` 只放 OneBot 配置镜像，容器数据在 Docker 卷里。

## 五、常见问题

**Docker 拉镜像失败 / 超时**
Docker Hub 在国内经常不可达。`setup:macos` 会自动尝试镜像站；都失败时可在
Docker Desktop → Settings → Docker Engine 里删掉失效的 `registry-mirrors`，
或用代理后重试。也可手动：

```bash
docker pull docker.m.daocloud.io/motricseven7/snowluma:latest
docker tag docker.m.daocloud.io/motricseven7/snowluma:latest motricseven7/snowluma:latest
npm run setup:macos
```

**控制台显示 `socket hang up` / OneBot 未连接**
多数情况是 QQ 还没登录：SnowLuma 登录成功前不会监听 3000/3001。打开 WebUI
完成首次引导，再在 noVNC 扫码。

**noVNC 一直「连接中…」**
容器里的 x11vnc 在客户端异常断开后偶发不再接受新连接。点控制台里的
「连不上？修复」（等价于重启容器内 x11vnc + novnc_proxy）。

**WebUI 初始密码找不到了**
初始密码只在全新数据卷首次启动时打印一次：

```bash
docker logs qq-agent-snowluma 2>&1 | grep 'initial credentials'
```

如果已经改过密码，用你自己设置的；忘了就
`npm run uninstall:macos -- --purge` 后重装（登录态会丢失）。

**端口被占用**
`6081/5099/3000/3001` 任一被占用时容器会创建失败。先 `docker ps` 检查是否有
旧的 SnowLuma 容器，或用 `npm run uninstall:macos` 清理后重试。

## 六、卸载

```bash
npm run uninstall:macos          # 停止并删除容器，保留数据卷
npm run uninstall:macos -- --purge   # 彻底删除数据卷
```

不会改动你安装的 QQ.app、Docker Desktop 或项目里的模型配置。
