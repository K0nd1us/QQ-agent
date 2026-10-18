# Linux headless 部署：Node.js + systemd + 外部 OneBot

`node src/server.js` 可在没有 Electron、图形桌面、Windows QQ 或便携 QQ 的 Linux 上运行。
本指南记录 Ubuntu x86_64 / Node.js 24 LTS / 2 vCPU、2 GiB 上验证过的部署方式，以及当前上游仍有的限制。
这不是一键安装器，也不保证每个第三方插件都兼容 Linux。

## 1. 分开管理应用与协议端

- QQ-agent：普通用户运行 Node，由 systemd 托管。
- 协议端：例如 NapCat，独立 Docker Compose 服务，固定已验证版本和架构对应的镜像摘要。
- QQ-agent 使用 OneBot v11 正向 WebSocket 接收事件，HTTP API 发送和查询。
- 不需要安装 Electron。按项目锁文件安装服务端依赖：`npm ci --omit=dev --ignore-scripts`。
  这不执行第三方安装脚本；若可选扩展确需原生依赖，须另行审核和安装。
- 使用受信任的软件源或 Node 官方发行物，并核对下载校验信息；不要无审核执行远程安装脚本。

固定应用 Git commit；不要在运行目录直接 `git pull`。保留旧程序与匹配的数据备份。

## 2. 目录与权限

建议：

```text
/opt/qq-agent/app/       固定版本应用，root拥有，服务用户只读
/srv/qq-agent/data/      QQ_AGENT_DATA_DIR；服务用户拥有，目录0700，私密配置0600
/srv/napcat/             协议端配置、QQ登录状态等，独立持久化
/var/backups/qq-agent/   有限保留的本地备份；还需另机/异地备份
```

创建专用无交互登录用户（示例名 `qqagent`），不要加入 Docker 组。Docker 管理权限等同于主机高权限，
应用不应挂载 `/var/run/docker.sock`。配置、数据库、会话、QQ登录状态和日志不要进入 Git。

应用识别 `QQ_AGENT_DATA_DIR`。使用环境变量指向数据目录，避免启动目录改变导致数据散落。

## 3. 协议端只监听本机

Compose 中端口发布必须写宿主机地址，例如：

```yaml
ports:
  - "127.0.0.1:3000:3000" # OneBot HTTP
  - "127.0.0.1:3001:3001" # OneBot正向WS
  - "127.0.0.1:6099:6099" # 协议端管理页，实际端口以使用版本为准
restart: unless-stopped
logging:
  driver: local
  options:
    max-size: "10m"
    max-file: "3"
```

HTTP/WS 服务在容器内监听 `0.0.0.0`，并不等于宿主机应向公网开放。
分别配置强随机协议 Token 和管理 Token；不要将它们放在URL或截图中。
不要直接照搬 `privileged`、`seccomp=unconfined` 或额外 capabilities：先按具体镜像和错误证据验证必要性。
共享内存与总内存上限也应以实际负载验证，不能把某一台机器的值视为协议通用要求。

QQ-agent 配置字段示意（实际凭据只在本机管理页面输入）：

```json
{
  "snowluma": {
    "autoLaunch": false,
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "<protocol-token>"
  },
  "allow": { "groups": [], "private": [] },
  "allowAllWhenEmpty": false,
  "maxConcurrentRuns": 1,
  "proactive": { "enabled": false }
}
```

字段名仍是 `snowluma`，但这些是外部 OneBot 连接配置，不表示需要安装 SnowLuma。
配置HTTP与WS不同Token时，填写 `httpAccessToken`；否则HTTP沿用 `accessToken`。
若手动配置外部协议端，避免假定 `snowluma.dir` 能自动找到 Docker 卷里的令牌。相关背景见 #23、#27。

## 4. systemd 示例

假定 Node 位于 `/usr/bin/node`，应用已部署至上述目录；若使用其他运行时位置，须修改绝对路径。

```ini
[Unit]
Description=QQ-agent headless
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=qqagent
Group=qqagent
WorkingDirectory=/opt/qq-agent/app
Environment=QQ_AGENT_DATA_DIR=/srv/qq-agent/data
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
# 当前headless入口实现SIGINT清理；不要假定已处理SIGTERM。
KillSignal=SIGINT
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/qq-agent/data

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now qq-agent` 后检查状态与实际日志。停止服务时确认正常退出及数据已刷新。
本示例有意让程序只读：原版口令安装写 `ROOT/skills`、`ROOT/plugins`，会被拒绝；
如果需要在线装扩展，必须另设计持久化模块目录、加载路径及兼容旧插件 `../../src` 导入的方式，
不要简单让整个程序目录可写。本指南不声称当前上游已实现这个目录拆分。

## 5. WebUI与模型

默认 WebUI 为 `127.0.0.1:3210`，保持loopback。Mac/Linux客户端可使用经过主机密钥核验的SSH隧道：

```sh
ssh -N -L 127.0.0.1:13210:127.0.0.1:3210 \
       -L 127.0.0.1:16099:127.0.0.1:6099 user@server
```

浏览器打开 `http://127.0.0.1:13210/` 和 `http://127.0.0.1:16099/webui/`。
只允许受限来源连接SSH；可使用仅允许指定端口转发、不能交互登录的专用账号。
远程命令工具不一定支持端口转发，必须实际测试浏览器访问。

当前控制台 `server.token` 的前端/SSE接线限制见 #20、#23，不能仅写入Token就声称认证已经完成。
不要因此把管理端口公开到互联网。需要公网反代时，先独立审查完整认证与Origin/Host行为。

模型配置前先从服务器检查DNS/TLS，不以开发电脑可访问为依据。密钥只在私密管理流程输入。
真实模型测试可能收费；先用Mock LLM/OneBot验收，再批准小范围真实测试。
最初仅放行测试群/账号；旧协议端退出后再登录同一QQ，避免双端登录或重复回复。

## 6. 本地媒体与默认外连

“同一台服务器”不代表宿主机和容器共享文件系统。`file:///srv/.../x.gif` 若只在宿主机存在，
NapCat会报 `ENOENT`。可选择明确的只读媒体目录同路径挂载，或在发送前桥接到共享媒体目录。
不要把整个私密data目录挂载给协议端；先验证容器内可读且字节相同，再做真实发图验收。

原版的遥测、社区名单同步/上报、价格表和第三方扩展有各自的外连行为。
Linux部署本身不会自动禁用它们；本文不引入或承诺不存在的隐私环境开关。
有隐私要求时须审查实际调用和配置，不能把“只在本机监听”当作阻止外发。

## 7. 备份、验收与资源

- 升级前先停止QQ-agent写入，再备份data与安装的扩展，记录应用commit、协议端镜像和校验和。
- 如果备份QQ客户端自身状态，另考虑其一致性；停止协议端可能需要重新扫码，须有维护窗口。
- `finally`/恢复步骤保证备份失败后服务也能启动；自动备份应安排在业务低峰。
- 单独验证归档可读、校验和和隔离恢复。恢复单文件必须保留当前文件，不能覆盖整库当作单文件恢复。
- 回滚恢复旧程序和匹配数据，不能只换镜像/commit。备份只放同一系统盘不算完整灾备。
- 2GiB下从并发1开始，检查 `free -m`、`df -h`、`df -i`、`docker stats --no-stream` 和日志占用。
  空闲启动成功不代表多群/大媒体负载足够。Swap不能替代物理内存，不无条件启用自动更新。
- 容器healthy、QQ `online=true`、WS已连接是不同层次；收不到消息时比较新消息的群历史和应用入库时间。
  实际收发、成员身份、记忆与重启保留仍须独立验收。

此指南不包含真实账号、IP、Token或业务数据，也不建议将当前私有运维策略直接合入所有用户的默认行为。
